// Live probe for the SDK's transport auto-retry: while a custom tool is pending, every TLS socket
// to Cursor is destroyed in-process. Records whether `execute` is invoked again, with which
// toolCallId, and whether assistant text is duplicated after the reconnect.
// Usage: node scripts/retry-probe.mjs [--model=composer-2.5] [--drop=pending|after-result|streaming] [--hold=20] [--delay=0]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const sockets = new Set();
const originalConnect = tls.connect;
tls.connect = function trackedConnect(...args) {
	const socket = originalConnect.apply(this, args);
	const options = args.find((a) => a && typeof a === "object") ?? {};
	socket.__host = options.servername ?? options.host ?? "";
	sockets.add(socket);
	socket.once("close", () => sockets.delete(socket));
	return socket;
};
syncBuiltinESMExports();

const { Agent } = await import("@cursor/sdk");
const { HOST_SETTING_SOURCES, hostToolAllowlist } = await import("../src/contract.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(here, "..", "..", "..", "tmp", "cursor-host-probe-cwd");
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const modelId = arg("model", "composer-2.5");
const dropAt = arg("drop", "pending");
const holdSeconds = Number(arg("hold", "20"));
const dropDelayMs = Number(arg("delay", "0"));
const reportPath = path.join(here, "..", "..", "..", "tmp", `cursor-host-retry-probe-${dropAt}.json`);

const t0 = Date.now();
const timeline = [];
const note = (kind, data = {}) => {
	const entry = { t: Number(((Date.now() - t0) / 1000).toFixed(1)), kind, ...data };
	timeline.push(entry);
	console.error(JSON.stringify(entry));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dropConnections(reason) {
	const hosts = [];
	for (const socket of sockets) {
		if (!/cursor/i.test(socket.__host)) continue;
		hosts.push(socket.__host);
		socket.destroy(new Error(`probe: connection dropped (${reason})`));
	}
	note("connections_dropped", { reason, hosts });
}

const executions = [];
const customTools = {
	fetch_token: {
		description: "Returns a token. Takes a while.",
		inputSchema: { type: "object", properties: {} },
		execute: async (_args, context) => {
			const n = executions.push(context?.toolCallId ?? null);
			note("execute_start", { n, toolCallId: context?.toolCallId ?? null });
			if (n === 1 && dropAt === "pending") setTimeout(() => dropConnections("tool pending"), 3000);
			if (dropAt === "after-result") {
				// The result is on its way back when the connection dies.
				await sleep(1000);
				if (n === 1) setTimeout(() => dropConnections("result just returned"), dropDelayMs);
				note("execute_end", { n });
				return `TOKEN-4410 (execution ${n})`;
			}
			await sleep(holdSeconds * 1000);
			note("execute_end", { n });
			return `TOKEN-4410 (execution ${n})`;
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
let result;
let dropped = false;
try {
	const prompt =
		dropAt === "streaming"
			? "Count from 1 to 120, one number per line, nothing else. After that call fetch_token once and reply with the token."
			: "Call fetch_token once, then reply with the token it returned.";
	const run = await agent.send(prompt);
	note("run_started");
	for await (const event of run.stream()) {
		if (event.type === "assistant") {
			for (const block of event.message.content) if (block.type === "text") text += block.text;
			if (dropAt === "streaming" && !dropped && text.split("\n").length > 25) {
				dropped = true;
				dropConnections("assistant streaming");
			}
		} else if (event.type === "tool_call") note("tool_call", { status: event.status, call_id: event.call_id, name: event.name });
		else if (event.type === "status") note("status", { status: event.status });
		else if (event.type !== "thinking") note(event.type, { keys: Object.keys(event).join(",") });
	}
	result = await run.wait();
	note("run_end", { status: result.status, usage: result.usage });
} catch (error) {
	failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	note("failure", { message: failure });
} finally {
	agent.close();
}

const numbers = text.split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
const report = {
	modelId,
	dropAt,
	executions,
	sameIdReplayed: executions.length > 1 && new Set(executions).size === 1,
	distinctIds: new Set(executions).size,
	duplicatedNumbers: numbers.length - new Set(numbers).size,
	status: result?.status,
	reply: text.trim().slice(-400),
	failure,
	timeline,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, timeline: undefined }, null, 2));
process.exit(0);
