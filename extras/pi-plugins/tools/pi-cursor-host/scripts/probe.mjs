import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, Cursor } from "@cursor/sdk";
import { HOST_SETTING_SOURCES, hostToolAllowlist } from "../src/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(here, "..", "..", "..", "tmp", "cursor-host-probe-cwd");
const reportPath = path.join(here, "..", "..", "..", "tmp", "cursor-host-probe.json");

const LEAKED = new Set([
	"shell",
	"read",
	"edit",
	"write",
	"grep",
	"glob",
	"ls",
	"delete",
	"task",
]);

function parseArgs(argv) {
	return {
		login: argv.includes("--login"),
		model: argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) || "composer-2.5",
	};
}

async function resolveReady() {
	if (process.env.CURSOR_API_KEY?.trim()) return { mode: "env" };
	const status = await Cursor.auth.status();
	if (status.status === "logged-in") return { mode: "sdk-login", email: status.email };
	return { mode: "none" };
}

async function login() {
	const result = await Cursor.auth.login({
		openBrowser: true,
		apiKeyName: "pi-cursor-host-probe",
		onLoginUrl: (url) => {
			console.error(`Open this URL to login:\n${url}`);
		},
	});
	console.error(`Logged in${result.email ? ` as ${result.email}` : ""}.`);
}

async function probe(modelId) {
	const pingCalls = [];
	const customTools = {
		ping: {
			description: "Echo a token. Call this once with token=ok.",
			inputSchema: {
				type: "object",
				properties: { token: { type: "string" } },
				required: ["token"],
			},
			execute: async (args) => {
				pingCalls.push(args.token);
				return JSON.stringify({ pong: args.token });
			},
		},
	};

	const options = {
		model: { id: modelId },
		tools: hostToolAllowlist(1),
		systemPrompt:
			"You are a probe. Call ping with token=ok. Then reply with the single word PONG. Do not use other tools.",
		local: {
			cwd,
			settingSources: HOST_SETTING_SOURCES,
			customTools,
		},
	};

	let offeredTools = [];
	let assistantText = "";
	let systemPromptOk = true;
	let agent;

	const runAgent = async (agentOptions) => {
		agent = await Agent.create(agentOptions);
		const run = await agent.send("Call ping with token=ok, then reply PONG.");
		for await (const event of run.stream()) {
			if (event.type === "system" && Array.isArray(event.tools)) offeredTools = event.tools;
			if (event.type === "assistant") {
				for (const block of event.message.content) {
					if (block.type === "text") assistantText += block.text;
				}
			}
		}
		const result = await run.wait();
		if (result.status === "error") {
			throw new Error(result.error?.message || "Cursor run failed");
		}
	};

	try {
		await runAgent(options);
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		if (!/system-prompt/i.test(text)) throw error;
		systemPromptOk = false;
		agent?.close();
		assistantText = "";
		offeredTools = [];
		pingCalls.length = 0;
		const { systemPrompt: _ignored, ...withoutPrompt } = options;
		await runAgent(withoutPrompt);
	} finally {
		agent?.close();
	}

	const leaked = offeredTools.filter((name) => LEAKED.has(String(name).toLowerCase()));
	return {
		modelId,
		systemPromptOk,
		offeredTools,
		leaked,
		pingCalls,
		assistantText: assistantText.trim().slice(0, 500),
		ok: leaked.length === 0 && pingCalls.includes("ok"),
	};
}

const args = parseArgs(process.argv.slice(2));
if (args.login) await login();

const ready = await resolveReady();
if (ready.mode === "none") {
	console.error(
		"No Cursor SDK credential. Set CURSOR_API_KEY, run `npm run probe -- --login`, or use /login cursor-host in Pi.",
	);
	process.exit(2);
}

await mkdir(cwd, { recursive: true });
const report = await probe(args.model);
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
