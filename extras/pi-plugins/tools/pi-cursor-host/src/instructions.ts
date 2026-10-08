import { createHash } from "node:crypto";
import { homedir, platform } from "node:os";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const STATE_PATH = join(homedir(), ".pi", "agent", "cursor-host.json");

export type InstructionMode = "system-slot" | "project-rules";

export function loadSystemPromptAllowed(): boolean | undefined {
	try {
		const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { systemPromptAllowed?: unknown };
		if (typeof raw.systemPromptAllowed === "boolean") return raw.systemPromptAllowed;
	} catch {
		// Missing or foreign-shaped state is treated as unknown.
	}
	return undefined;
}

export function saveSystemPromptAllowed(allowed: boolean): void {
	mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
	writeFileSync(`${STATE_PATH}`, `${JSON.stringify({ systemPromptAllowed: allowed }, null, 2)}\n`);
}

/**
 * The sidecar holds the full Pi system prompt and is loaded by Cursor as project rules, so it has to
 * sit where only the current user can read or replace it. Shared locations such as
 * `C:\Users\Public` grant Modify to every interactive account.
 */
export function instructionSidecarRoot(): string {
	const override = process.env.PI_CURSOR_HOST_INSTR_DIR?.trim();
	if (override) return resolve(override);
	if (platform() === "win32") {
		const local = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
		return resolve(local, "pi-cursor-host", "instr");
	}
	return resolve(process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "pi-cursor-host", "instr");
}

export function writeInstructionSidecar(text: string): string {
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
	const dir = join(instructionSidecarRoot(), hash);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "AGENTS.md"), text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
	// Rewriting an existing file does not refresh the directory time on Windows; pruning goes by it.
	const now = new Date();
	utimesSync(dir, now, now);
	pruneSidecars(dir);
	return dir;
}

const KEPT_SIDECARS = 8;
/** Another Pi process may have an agent loading a directory it wrote moments ago; leave recent ones alone. */
const PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Each distinct system prompt gets its own directory; drop old ones beyond the most recent few. */
function pruneSidecars(current: string): void {
	try {
		const root = instructionSidecarRoot();
		const cutoff = Date.now() - PRUNE_MIN_AGE_MS;
		const stale = readdirSync(root)
			.map((name) => join(root, name))
			.filter((dir) => dir !== current)
			.map((dir) => ({ dir, mtime: statSync(dir).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime)
			.slice(KEPT_SIDECARS - 1)
			.filter((entry) => entry.mtime < cutoff);
		for (const { dir } of stale) rmSync(dir, { recursive: true, force: true });
	} catch {
		// Housekeeping only; a concurrent Pi process may be pruning the same directory.
	}
}

/**
 * In project-rules mode Cursor reads `AGENTS.md` and `CLAUDE.md` from its working directory on its own
 * (`scripts/rules-probe.mjs`; parent directories are not read). Pi's system prompt carries one of them
 * as a `<project_instructions>` block; drop that block so the text is not paid for twice on every model
 * step. Files Cursor does not load (other names, other directories) stay.
 *
 * A block ends at a closing tag that is followed by the next block, the end of `<project_context>` or
 * the end of the text, so a closing tag quoted inside the file's own content does not cut it short.
 */
export function stripCursorLoadedInstructions(systemPrompt: string, cwd: string): string {
	const same = (a: string, b: string) =>
		platform() === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
	const loadedByCursor = [join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md")];
	return systemPrompt.replace(
		/<project_instructions path="([^"]*)">\n[\s\S]*?\n?<\/project_instructions>\n*(?=<project_instructions path="|<\/project_context>|$)/g,
		(block, path: string) => (loadedByCursor.some((file) => same(path, file)) ? "" : block),
	);
}
