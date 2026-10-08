import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@cursor/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "..", "..", "tmp", "cursor-host-cache-probe");
const turns = Number(process.argv.find((arg) => arg.startsWith("--turns="))?.slice(8) || 8);
const modelId = process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) || "grok-4.6";
const effort = process.argv.find((arg) => arg.startsWith("--effort="))?.slice(9) || "xhigh";

function ratio(cacheRead, input) {
	if (!input) return 0;
	return cacheRead / input;
}

async function drain(run) {
	const steps = [];
	for await (const event of run.stream()) {
		if (event.type === "usage" && event.usage) {
			steps.push({
				input: event.usage.inputTokens ?? 0,
				cacheRead: event.usage.cacheReadTokens ?? 0,
				output: event.usage.outputTokens ?? 0,
			});
		}
	}
	const result = await run.wait();
	return { result, steps };
}

const cwd = path.join(outDir, "tools-cwd");
await mkdir(cwd, { recursive: true });
for (let i = 1; i <= turns; i++) {
	await writeFile(path.join(cwd, `f${i}.txt`), `TOKEN-${modelId}-${i}\n`);
}

const agent = await Agent.create({
	apiKey: process.env.CURSOR_API_KEY?.trim() || undefined,
	model: {
		id: modelId,
		params: modelId.startsWith("grok") ? [{ id: "effort", value: effort }] : undefined,
	},
	tools: ["mcp"],
	mcpServers: {},
	local: {
		cwd,
		settingSources: [],
		customTools: {
			read: {
				description: "Read a utf-8 file relative to the workspace.",
				inputSchema: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
				},
				execute: async (args) => {
					const name = path.basename(String(args.path || ""));
					const body = await readFile(path.join(cwd, name), "utf8");
					return body;
				},
			},
		},
	},
});

const rows = [];
try {
	for (let i = 1; i <= turns; i++) {
		const run = await agent.send(
			`Call read with path=f${i}.txt. Reply with only the file contents. Do not call other tools.`,
		);
		const { result, steps } = await drain(run);
		const input = result.usage?.inputTokens ?? 0;
		const cacheRead = result.usage?.cacheReadTokens ?? 0;
		rows.push({
			turn: i,
			status: result.status,
			input,
			cacheRead,
			output: result.usage?.outputTokens ?? 0,
			hit: Number(ratio(cacheRead, input).toFixed(4)),
			stepHits: steps.map((step) => ({
				input: step.input,
				cacheRead: step.cacheRead,
				hit: Number(ratio(step.cacheRead, step.input).toFixed(4)),
			})),
		});
		console.error(JSON.stringify(rows.at(-1)));
	}
} finally {
	agent.close();
}

const afterWarm = rows.slice(1);
const warmHit =
	afterWarm.length === 0
		? null
		: afterWarm.reduce((sum, row) => sum + row.hit, 0) / afterWarm.length;
const allStepHits = rows.flatMap((row) => row.stepHits);
const stepWarm = allStepHits.slice(1);
const report = {
	modelId,
	effort,
	turns,
	warmHitFromTurn2: warmHit,
	stepHitFromSecondCall:
		stepWarm.length === 0 ? null : stepWarm.reduce((sum, step) => sum + step.hit, 0) / stepWarm.length,
	rows,
};
await mkdir(outDir, { recursive: true });
await writeFile(
	path.join(outDir, `${modelId.replace(/[^\w.-]+/g, "_")}-tools.json`),
	`${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
