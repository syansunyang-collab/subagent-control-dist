// Regression probe: Cursor's built-in skills (~/.cursor/skills-cursor) are loaded from disk by the
// SDK in project-rules mode, but must not reach the model as a catalog. Pi's <available_skills> is the
// only skill list the model should see. Run after every @cursor/sdk upgrade.
// Usage: node scripts/skills-probe.mjs [--model=composer-2.5]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@cursor/sdk";
import { hostToolAllowlist, instructionSettingSources } from "../src/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..", "..", "tmp", "cursor-host-skills-probe");
const modelId = process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? "composer-2.5";
// Distinctive names only; generic ones such as "review" or "shell" would match ordinary prose.
const CURSOR_BUILTIN = ["create-rule", "create-subagent", "deploy-with-vercel", "migrate-to-skills", "review-bugbot", "split-to-prs", "update-cursor-settings"];
const PI_SKILL = "zebra-report-probe";

const cwd = path.join(root, "ws");
const instr = path.join(root, "instr");
await mkdir(cwd, { recursive: true });
await mkdir(instr, { recursive: true });
await writeFile(
	path.join(instr, "AGENTS.md"),
	`<available_skills>\n<skill><name>${PI_SKILL}</name><description>Probe skill.</description><location>${cwd}/SKILL.md</location></skill>\n</available_skills>\n`,
);

const agent = await Agent.create({
	model: { id: modelId },
	tools: hostToolAllowlist(1),
	mcpServers: {},
	local: {
		cwd,
		settingSources: instructionSettingSources("project-rules"),
		dirs: [instr],
		customTools: { ping: { description: "Returns a token.", inputSchema: { type: "object", properties: {} }, execute: async () => "T" } },
	},
});
let text = "";
try {
	const run = await agent.send("Do not call tools. List the name of every agent skill that appears anywhere in your context, one per line. If none, say NONE.");
	for await (const event of run.stream()) {
		if (event.type === "assistant") for (const block of event.message.content) if (block.type === "text") text += block.text;
	}
	await run.wait();
} finally {
	agent.close();
}

const leaked = CURSOR_BUILTIN.filter((name) => text.includes(name));
const report = { modelId, piCatalogVisible: text.includes(PI_SKILL), leakedCursorSkills: leaked, ok: leaked.length === 0 && text.includes(PI_SKILL), reply: text.trim().slice(0, 800) };
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
