// Live probe for the held-run transport: a customTools.execute that stays pending for a long time,
// parallel tool calls, call-id correlation, and context retention across sends on one agent.
// Usage: node scripts/hold-probe.mjs [--hold=75] [--model=composer-2.5]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@cursor/sdk";
import { HOST_SETTING_SOURCES, hostToolAllowlist } from "../src/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(here, "..", "..", "..", "tmp", "cursor-host-probe-cwd");
const reportPath = path.join(here, "..", "..", "..", "tmp", "cursor-host-hold-probe.json");
const arg = (name, fallback) =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const holdSeconds = Number(arg("hold", "75"));
const modelId = arg("model", "composer-2.5");

const t0 = Date.now();
const at = () => Number(((Date.now() - t0) / 1000).toFixed(1));
const timeline = [];
const note = (kind, data = {}) => timeline.push({ t: at(), kind, ...data });

const customTools = {
	slow_echo: {
		description: "Echo text back after a delay. Takes a while; wait for it.",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		execute: async (args, context) => {
			note("execute_start", { tool: "slow_echo", toolCallId: context?.toolCallId ?? null });
			await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
			note("execute_end", { tool: "slow_echo" });
			return `ECHO:${args.text}:7391`;
		},
	},
	ping: {
		description: "Returns a fixed token immediately.",
		inputSchema: { type: "object", properties: {} },
		execute: async (_args, context) => {
			note("execute_start", { tool: "ping", toolCallId: context?.toolCallId ?? null });
			return "PING-TOKEN-2204";
		},
	},
};

async function drain(run, label) {
	let text = "";
	for await (const event of run.stream()) {
		if (event.type === "assistant") {
			for (const block of event.message.content) {
				if (block.type === "text") text += block.text;
				if (block.type === "tool_use") note("assistant_tool_use", { label, id: block.id, name: block.name });
			}
		} else if (event.type === "tool_call") {
			note("tool_call", { label, status: event.status, name: event.name, call_id: event.call_id, args: event.args });
		} else if (event.type === "usage") {
			note("usage", { label, usage: event.usage });
		} else if (event.type === "status") {
			note("status", { label, status: event.status, message: event.message });
		} else if (event.type === "system") {
			note("system", { label, tools: event.tools ?? null });
		}
	}
	const result = await run.wait();
	note("run_end", { label, status: result.status, error: result.error?.message, usage: result.usage });
	return text.trim();
}

await mkdir(cwd, { recursive: true });
const agent = await Agent.create({
	model: { id: modelId },
	tools: hostToolAllowlist(2),
	mcpServers: {},
	local: { cwd, settingSources: HOST_SETTING_SOURCES, customTools },
});
note("agent_created", { agentId: agent.agentId });
let first = "";
let second = "";
let failure;
try {
	first = await drain(
		await agent.send(
			"Call slow_echo with text=alpha and call ping, both in the same step if you can. " +
				"slow_echo is slow: wait for it, do not retry it. Then reply with both results verbatim.",
		),
		"send1",
	);
	second = await drain(
		await agent.send("Without calling any tool: what exact string did slow_echo return earlier? Reply with only that string."),
		"send2",
	);
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
	note("failure", { message: failure });
} finally {
	agent.close();
}

const executes = timeline.filter((e) => e.kind === "execute_start");
const report = {
	modelId,
	holdSeconds,
	first,
	second,
	failure,
	heldRunSurvived: first.includes("ECHO:alpha:7391"),
	contextRetained: second.includes("ECHO:alpha:7391"),
	slowEchoExecutions: executes.filter((e) => e.tool === "slow_echo").length,
	executeIdsMatchStream: executes.every((e) => timeline.some((x) => x.kind === "tool_call" && x.call_id === e.toolCallId)),
	timeline,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const { timeline: _t, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
