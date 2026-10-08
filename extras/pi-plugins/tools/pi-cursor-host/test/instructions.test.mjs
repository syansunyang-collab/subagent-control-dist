import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { instructionSidecarRoot, stripCursorLoadedInstructions, writeInstructionSidecar } from "../src/instructions.ts";

const cwd = process.platform === "win32" ? "E:\\work\\proj" : "/work/proj";
const sep = process.platform === "win32" ? "\\" : "/";
const block = (path, body) => `<project_instructions path="${path}">\n${body}\n</project_instructions>\n\n`;

test("the instruction sidecar lives in a directory private to the current user", () => {
	const saved = process.env.PI_CURSOR_HOST_INSTR_DIR;
	delete process.env.PI_CURSOR_HOST_INSTR_DIR;
	try {
		const root = resolve(instructionSidecarRoot());
		assert.equal(relative(resolve(homedir()), root).startsWith(".."), false, root);
		assert.equal(/[\\/]Users[\\/]Public[\\/]/i.test(root), false);
		assert.equal(root.startsWith(resolve(tmpdir())), false);
	} finally {
		if (saved !== undefined) process.env.PI_CURSOR_HOST_INSTR_DIR = saved;
	}
});

test("writing a sidecar creates AGENTS.md under a content-addressed directory", () => {
	const scratch = mkdtempSync(join(tmpdir(), "pi-cursor-host-test-"));
	const saved = process.env.PI_CURSOR_HOST_INSTR_DIR;
	process.env.PI_CURSOR_HOST_INSTR_DIR = scratch;
	try {
		const first = writeInstructionSidecar("rules A");
		const again = writeInstructionSidecar("rules A");
		const other = writeInstructionSidecar("rules B");
		assert.equal(first, again);
		assert.notEqual(first, other);
		assert.equal(readFileSync(join(first, "AGENTS.md"), "utf8"), "rules A\n");
		assert.ok(existsSync(join(other, "AGENTS.md")), "a fresh directory is never pruned");
	} finally {
		if (saved === undefined) delete process.env.PI_CURSOR_HOST_INSTR_DIR;
		else process.env.PI_CURSOR_HOST_INSTR_DIR = saved;
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("the files Cursor loads itself from the working directory are dropped from the sidecar text, other files stay", () => {
	const prompt =
		"You are Pi.\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n" +
		block(`${cwd}${sep}AGENTS.md`, "repo rules\nmore") +
		block(`${cwd}${sep}AGENTS.override.md`, "override rules") +
		block(`${cwd}${sep}..${sep}AGENTS.md`, "parent rules") +
		`</project_context>\nCurrent working directory: ${cwd}`;
	const stripped = stripCursorLoadedInstructions(prompt, cwd);
	assert.equal(stripped.includes("repo rules"), false);
	assert.equal(stripped.includes("override rules"), true);
	assert.equal(stripped.includes("parent rules"), true);
	assert.equal(stripped.includes("You are Pi."), true);
	assert.equal(stripped.includes("Current working directory"), true);
});

test("CLAUDE.md in the working directory is loaded by Cursor too; the same name in a parent directory is not", () => {
	const parent = block(`${cwd}${sep}..${sep}CLAUDE.md`, "parent claude");
	const prompt = "<project_context>\n\n" + parent + block(`${cwd}${sep}CLAUDE.md`, "claude rules") + "</project_context>\n";
	assert.equal(stripCursorLoadedInstructions(prompt, cwd), "<project_context>\n\n" + parent + "</project_context>\n");
});

test("a closing tag quoted inside the file does not cut the block short", () => {
	const body = "how Pi embeds files:\n</project_instructions>\n\nand then more repo rules SECRET_TAIL";
	const kept = block(`${cwd}${sep}..${sep}CLAUDE.md`, "claude rules");
	const prompt = "<project_context>\n\n" + block(`${cwd}${sep}AGENTS.md`, body) + kept + "</project_context>\n";
	const stripped = stripCursorLoadedInstructions(prompt, cwd);
	assert.equal(stripped.includes("SECRET_TAIL"), false);
	assert.equal(stripped, "<project_context>\n\n" + kept + "</project_context>\n");
});

test("an empty block and a last block are both handled", () => {
	const kept = block(`${cwd}${sep}..${sep}CLAUDE.md`, "keep");
	const prompt = "<project_context>\n\n" + kept + block(`${cwd}${sep}AGENTS.md`, "") + "</project_context>\n";
	assert.equal(stripCursorLoadedInstructions(prompt, cwd), "<project_context>\n\n" + kept + "</project_context>\n");
});
