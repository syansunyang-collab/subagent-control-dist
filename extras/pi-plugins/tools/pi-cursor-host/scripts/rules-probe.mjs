// Live probe: which instruction files does Cursor load on its own in project-rules mode?
// A scratch workspace gets one canary per candidate file; the model lists the canaries it can see.
// Pi already embeds the files it reads in its system prompt, so anything Cursor also loads arrives twice.
// Usage: node scripts/rules-probe.mjs [--model=composer-2.5] [--sources=project|none] [--root=<scratch dir>]
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "@cursor/sdk";
import { hostToolAllowlist, instructionSettingSources } from "../src/contract.js";

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const modelId = arg("model", "composer-2.5");
const sources = arg("sources", "project");
// Outside any repository, so that the walk towards a repository root is observable.
const root = arg("root", path.join(tmpdir(), "pi-cursor-host-rules-probe"));

const repo = path.join(root, "repo");
const cwd = path.join(repo, "ws");
const instr = path.join(root, "instr");
const rule = (label, token) => `# ${label}\n\nCanary rule: the codeword for this file is ${token}.\n`;
const mdc = (front, label, token) => `---\n${front}\n---\n\n${rule(label, token)}`;
const skill = (name, token, bodyToken) => `---\nname: ${name}\ndescription: Probe skill, codeword ${token}.\n---\n\nSkill body codeword ${bodyToken}.\n`;

/** label -> [file, content]. Tokens are derived from the position so every file has its own. */
const files = [
	["above-repo AGENTS.md", path.join(root, "AGENTS.md")],
	["repo-root AGENTS.md (parent of cwd)", path.join(repo, "AGENTS.md")],
	["repo-root CLAUDE.md (parent of cwd)", path.join(repo, "CLAUDE.md")],
	["repo-root .cursor/rules always.mdc", path.join(repo, ".cursor", "rules", "root-always.mdc"), "alwaysApply: true"],
	["cwd AGENTS.md", path.join(cwd, "AGENTS.md")],
	["cwd AGENT.md", path.join(cwd, "AGENT.md")],
	["cwd CLAUDE.md", path.join(cwd, "CLAUDE.md")],
	["cwd CLAUDE.local.md", path.join(cwd, "CLAUDE.local.md")],
	["cwd GEMINI.md", path.join(cwd, "GEMINI.md")],
	["cwd .cursorrules", path.join(cwd, ".cursorrules")],
	["cwd .windsurfrules", path.join(cwd, ".windsurfrules")],
	["cwd .clinerules", path.join(cwd, ".clinerules")],
	["cwd .github/copilot-instructions.md", path.join(cwd, ".github", "copilot-instructions.md")],
	["cwd .claude/CLAUDE.md", path.join(cwd, ".claude", "CLAUDE.md")],
	["cwd .cursor/rules always.mdc", path.join(cwd, ".cursor", "rules", "always.mdc"), "alwaysApply: true"],
	["cwd .cursor/rules plain.md", path.join(cwd, ".cursor", "rules", "plain.md")],
	["cwd .cursor/rules glob.mdc body", path.join(cwd, ".cursor", "rules", "glob.mdc"), "globs: **/*.ts\nalwaysApply: false"],
	["cwd .cursor/rules requested.mdc body", path.join(cwd, ".cursor", "rules", "requested.mdc"), "description: Probe rule, codeword CANARY-DESC-7001.\nalwaysApply: false"],
	["cwd sub/AGENTS.md (nested)", path.join(cwd, "sub", "AGENTS.md")],
	["cwd README.md (control)", path.join(cwd, "README.md")],
	["dirs AGENTS.md (the sidecar channel)", path.join(instr, "AGENTS.md")],
	["dirs CLAUDE.md", path.join(instr, "CLAUDE.md")],
];
const canaries = new Map();
await rm(root, { recursive: true, force: true });
for (const [index, [label, file, front]] of files.entries()) {
	const token = `CANARY-${String(index + 11).padStart(2, "0")}${(index * 37 + 1013) % 9000}`;
	canaries.set(token, label);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, front ? mdc(front, label, token) : rule(label, token));
}
canaries.set("CANARY-DESC-7001", "cwd .cursor/rules requested.mdc description");
for (const [dir, n] of [[".cursor", 1], [".claude", 2], [".agents", 3]]) {
	const file = path.join(cwd, dir, "skills", `probe-skill-${n}`, "SKILL.md");
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, skill(`probe-skill-${n}`, `CANARY-SKILL-${n}00${n}`, `CANARY-SKILLBODY-${n}11${n}`));
	canaries.set(`CANARY-SKILL-${n}00${n}`, `cwd ${dir}/skills description`);
	canaries.set(`CANARY-SKILLBODY-${n}11${n}`, `cwd ${dir}/skills body`);
}
await writeFile(path.join(cwd, "sub", "note.ts"), "export const x = 1;\n");
execFileSync("git", ["init", "-q"], { cwd: repo });

const agent = await Agent.create({
	model: { id: modelId },
	tools: hostToolAllowlist(1),
	mcpServers: {},
	local: {
		cwd,
		settingSources: sources === "none" ? [] : instructionSettingSources("project-rules"),
		dirs: [instr],
		customTools: { ping: { description: "Returns a token.", inputSchema: { type: "object", properties: {} }, execute: async () => "T" } },
	},
});
let text = "";
let usage;
try {
	const run = await agent.send(
		"Do not call tools. List every codeword of the form CANARY-... that appears anywhere in your context (rules, instructions, skill lists, anything), one per line, nothing else. If there are none, say NONE.",
	);
	for await (const event of run.stream()) {
		if (event.type === "assistant") for (const block of event.message.content) if (block.type === "text") text += block.text;
	}
	usage = (await run.wait()).usage;
} finally {
	agent.close();
}

const seen = [...text.matchAll(/CANARY-[A-Z0-9-]+/g)].map((match) => match[0]);
const report = {
	modelId,
	sources,
	loaded: [...canaries].filter(([token]) => seen.includes(token)).map(([, label]) => label),
	notLoaded: [...canaries].filter(([token]) => !seen.includes(token)).map(([, label]) => label),
	unknownTokens: seen.filter((token) => !canaries.has(token)),
	usage,
	reply: text.trim().slice(0, 1200),
};
await writeFile(path.join(root, `report-${sources}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(0);
