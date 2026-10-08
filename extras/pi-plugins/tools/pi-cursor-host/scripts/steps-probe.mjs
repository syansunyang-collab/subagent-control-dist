// Live probe for the low-level update channel (`send(..., { onDelta })`): which updates mark model steps,
// how many `turn-ended` usages one run carries, and how they relate to the run's cumulative usage.
// First a run with two tool calls, then plain chat turns on the same agent; a chat turn whose usage
// looks doubled against the previous one is flagged with its update sequence.
// Usage: node scripts/steps-probe.mjs [--model=composer-2.5] [--turns=8]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@cursor/sdk";
import { HOST_SETTING_SOURCES, hostToolAllowlist } from "../src/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(here, "..", "..", "..", "tmp", "cursor-host-probe-cwd");
const reportPath = path.join(here, "..", "..", "..", "tmp", "cursor-host-steps-probe.json");
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const modelId = arg("model", "composer-2.5");
const chatTurns = Number(arg("turns", "8"));
const QUIET = new Set(["text-delta", "thinking-delta", "tool-call-delta", "partial-tool-call"]);

await mkdir(cwd, { recursive: true });
const agent = await Agent.create({
	model: { id: modelId },
	tools: hostToolAllowlist(1),
	mcpServers: {},
	local: {
		cwd,
		settingSources: HOST_SETTING_SOURCES,
		customTools: {
			fetch_token: {
				description: "Returns a token for a name.",
				inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
				execute: async (args) => `TOKEN-${String(args?.name ?? "x").toUpperCase()}-4410`,
			},
		},
	},
});

const runs = [];
async function turn(label, prompt) {
	const updates = [];
	const counts = {};
	const run = await agent.send(prompt, {
		onDelta: ({ update }) => {
			counts[update.type] = (counts[update.type] ?? 0) + 1;
			if (QUIET.has(update.type)) return;
			const { type, ...rest } = update;
			updates.push({ type, ...(type === "turn-ended" || type.startsWith("step-") || type === "token-delta" ? rest : {}) });
		},
	});
	let streamUsageEvents = 0;
	let streamThinkingDone = 0;
	for await (const event of run.stream()) {
		if (event.type === "usage") streamUsageEvents++;
		if (event.type === "thinking" && event.thinking_duration_ms !== undefined) streamThinkingDone++;
	}
	const result = await run.wait();
	const entry = {
		label,
		status: result.status,
		runUsage: result.usage,
		streamUsageEvents,
		steps: counts["step-started"] ?? 0,
		thinkingCompleted: counts["thinking-completed"] ?? 0,
		streamThinkingDone,
		turnEnded: updates.filter((u) => u.type === "turn-ended").map((u) => u.usage),
		tokenDeltaSum: updates.filter((u) => u.type === "token-delta").reduce((sum, u) => sum + (u.tokens ?? 0), 0),
		counts,
		sequence: updates.filter((u) => u.type !== "token-delta").map((u) => (u.stepId !== undefined ? `${u.type}#${u.stepId}` : u.type)),
	};
	runs.push(entry);
	console.error(JSON.stringify({ label, steps: entry.steps, runInput: result.usage?.inputTokens, cacheRead: result.usage?.cacheReadTokens, turnEnded: entry.turnEnded.length }));
	return entry;
}

try {
	await turn("tools", "Call fetch_token with name alpha. After you get the result, call fetch_token with name beta. Then reply with both tokens.");
	for (let i = 1; i <= chatTurns; i++) await turn(`chat-${i}`, `Reply with the single word WORD${i}.`);
} finally {
	agent.close();
}

for (let i = 1; i < runs.length; i++) {
	const previous = runs[i - 1].runUsage?.inputTokens ?? 0;
	const current = runs[i].runUsage?.inputTokens ?? 0;
	runs[i].looksDoubled = runs[i].label.startsWith("chat") && runs[i - 1].label.startsWith("chat") && current > previous * 1.6;
}
await writeFile(reportPath, `${JSON.stringify({ modelId, runs }, null, 2)}\n`);
for (const r of runs) {
	console.log(
		`${r.label.padEnd(8)} thinkingCompleted=${r.thinkingCompleted} streamThinkingDone=${r.streamThinkingDone} perCall=${Math.round((r.runUsage?.inputTokens ?? 0) / Math.max(1, r.thinkingCompleted))} input=${r.runUsage?.inputTokens} cacheRead=${r.runUsage?.cacheReadTokens} turnEnded=${JSON.stringify(r.turnEnded.map((u) => u?.inputTokens))} tokenDeltaSum=${r.tokenDeltaSum}${r.looksDoubled ? "  <-- doubled" : ""}`,
	);
}
console.log("sequence of the tool run:", runs[0].sequence.join(" "));
const doubled = runs.find((r) => r.looksDoubled);
if (doubled) console.log("sequence of the doubled run:", doubled.sequence.join(" "));
process.exit(0);
