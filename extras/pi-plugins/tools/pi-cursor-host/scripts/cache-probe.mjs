import { mkdir, writeFile } from "node:fs/promises";
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
	for await (const _event of run.stream()) {
		// usage is on wait()
	}
	return run.wait();
}

const cwd = path.join(outDir, "cwd");
await mkdir(cwd, { recursive: true });

const options = {
	apiKey: process.env.CURSOR_API_KEY?.trim() || undefined,
	model: {
		id: modelId,
		params: modelId.startsWith("grok") ? [{ id: "effort", value: effort }] : undefined,
	},
	tools: [],
	mcpServers: {},
	local: { cwd, settingSources: [] },
};

const agent = await Agent.create(options);
const rows = [];
try {
	for (let i = 1; i <= turns; i++) {
		const run = await agent.send(`Reply with only the number ${i}.`);
		const result = await drain(run);
		const input = result.usage?.inputTokens ?? 0;
		const cacheRead = result.usage?.cacheReadTokens ?? 0;
		rows.push({
			turn: i,
			status: result.status,
			input,
			cacheRead,
			output: result.usage?.outputTokens ?? 0,
			hit: Number(ratio(cacheRead, input).toFixed(4)),
		});
		console.error(JSON.stringify(rows.at(-1)));
	}
} finally {
	agent.close();
}

const afterWarm = rows.slice(5);
const warmHit =
	afterWarm.length === 0
		? null
		: afterWarm.reduce((sum, row) => sum + row.hit, 0) / afterWarm.length;
const report = { modelId, effort, turns, warmHitFromTurn6: warmHit, rows };
await writeFile(path.join(outDir, `${modelId.replace(/[^\w.-]+/g, "_")}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
