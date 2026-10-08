// Live probe for steering a held run: while a custom tool is pending, inject a user message with
// run.steer(), then resolve the tool. Records the ack outcome, its timing and whether the model
// acted on the steered text in the same run.
// Usage: node scripts/steer-probe.mjs [--model=composer-2.5] [--order=steer-first|result-first]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@cursor/sdk";
import { HOST_SETTING_SOURCES, hostToolAllowlist } from "../src/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(here, "..", "..", "..", "tmp", "cursor-host-probe-cwd");
const reportPath = path.join(here, "..", "..", "..", "tmp", "cursor-host-steer-probe.json");
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const modelId = arg("model", "composer-2.5");
const order = arg("order", "steer-first");

const t0 = Date.now();
const timeline = [];
const note = (kind, data = {}) => timeline.push({ t: Number(((Date.now() - t0) / 1000).toFixed(1)), kind, ...data });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let run;
let steerOutcome = "not-called";
const steer = () => {
	if (typeof run?.steer !== "function") {
		steerOutcome = "unsupported";
		note("steer_unsupported");
		return;
	}
	note("steer_called");
	run.steer("New instruction from the user: in your final reply, also include the exact word MANGO-7718.")
		.then((outcome) => {
			steerOutcome = outcome;
			note("steer_settled", { outcome });
		})
		.catch((error) => {
			steerOutcome = `error: ${error?.message ?? error}`;
			note("steer_failed", { message: String(error?.message ?? error) });
		});
};

const customTools = {
	fetch_token: {
		description: "Returns a token. Takes a few seconds.",
		inputSchema: { type: "object", properties: {} },
		execute: async () => {
			note("execute_start");
			if (order === "steer-first") {
				steer();
				await sleep(2500);
			} else {
				setTimeout(steer, 50); // steer lands right after the result is handed back
				await sleep(1500);
			}
			note("execute_end");
			return "TOKEN-4410";
		},
	},
};

await mkdir(cwd, { recursive: true });
const agent = await Agent.create({
	model: { id: modelId },
	tools: hostToolAllowlist(1),
	mcpServers: {},
	local: { cwd, settingSources: HOST_SETTING_SOURCES, customTools },
});
let text = "";
let failure;
try {
	run = await agent.send("Call fetch_token once, then reply with the token it returned.");
	note("run_started", { hasSteer: typeof run.steer === "function", supportsSteer: run.supports?.("steer") ?? null });
	for await (const event of run.stream()) {
		if (event.type === "assistant") {
			for (const block of event.message.content) if (block.type === "text") text += block.text;
		} else if (event.type === "user") note("user_event", { text: JSON.stringify(event.message ?? event).slice(0, 160) });
		else if (event.type === "tool_call") note("tool_call", { status: event.status });
		else if (event.type === "status") note("status", { status: event.status });
	}
	const result = await run.wait();
	note("run_end", { status: result.status, usage: result.usage });
	await sleep(1500); // let a late steer ack land
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
	note("failure", { message: failure });
} finally {
	agent.close();
}

const report = {
	modelId,
	order,
	steerOutcome,
	tokenReturned: text.includes("TOKEN-4410"),
	steeredTextFollowed: text.includes("MANGO-7718"),
	reply: text.trim().slice(0, 400),
	failure,
	timeline,
};
await writeFile(reportPath.replace(".json", `-${order}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
