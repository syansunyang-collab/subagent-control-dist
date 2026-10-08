// Live probe: does the release sequence of HeldSession.dispose (reject waiting calls, run.cancel(),
// agent.close()) make the run's stream and wait() return, including when the network is wedged?
// Modes: pending (tool waiting), pending-keep (the execute promise is never settled),
// streaming (assistant text in flight), wedged (connections dropped and new ones black-holed first),
// wedged-wait (same dead network, nobody cancels: how long until the SDK gives up on its own).
// Usage: node scripts/cancel-probe.mjs [--model=composer-2.5] [--mode=pending] [--deadline=90]
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const sockets = new Set();
let blackholePort;
const originalConnect = tls.connect;
tls.connect = function trackedConnect(...args) {
	const options = args.find((a) => a && typeof a === "object") ?? {};
	const host = options.servername ?? options.host ?? "";
	const wedge = blackholePort !== undefined && /cursor/i.test(host);
	// A wedged network: the TCP connection opens, the TLS handshake never gets an answer.
	const socket = wedge ? originalConnect.call(this, { host: "127.0.0.1", port: blackholePort, servername: host }) : originalConnect.apply(this, args);
	socket.__host = host;
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
const mode = arg("mode", "pending");
const reportPath = path.join(here, "..", "..", "..", "tmp", `cursor-host-cancel-probe-${mode}.json`);
const DEADLINE_MS = Number(arg("deadline", "90")) * 1000;

const t0 = Date.now();
const seconds = () => Number(((Date.now() - t0) / 1000).toFixed(1));
const timeline = [];
const note = (kind, data = {}) => {
	const entry = { t: seconds(), kind, ...data };
	timeline.push(entry);
	console.error(JSON.stringify(entry));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function wedgeNetwork() {
	const silent = net.createServer(() => {});
	await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
	silent.unref();
	blackholePort = silent.address().port;
	const hosts = [];
	for (const socket of sockets) {
		if (!/cursor/i.test(socket.__host)) continue;
		hosts.push(socket.__host);
		socket.destroy(new Error("probe: network wedged"));
	}
	note("network_wedged", { hosts });
}

let agent;
let run;
let rejectExecute;
const measured = {};
async function release() {
	note("release_start");
	const started = Date.now();
	if (mode !== "pending-keep") rejectExecute?.(new Error("Cursor host session closed"));
	run.cancel().then(
		() => {
			measured.cancelSettledAfterMs = Date.now() - started;
			note("cancel_settled");
		},
		(error) => {
			measured.cancelSettledAfterMs = Date.now() - started;
			measured.cancelError = String(error?.message ?? error);
			note("cancel_failed", { message: measured.cancelError });
		},
	);
	try {
		agent.close();
		note("agent_closed");
	} catch (error) {
		measured.closeError = String(error?.message ?? error);
	}
	measured.releaseAt = started;
}

const customTools = {
	fetch_token: {
		description: "Returns a token. Takes a while.",
		inputSchema: { type: "object", properties: {} },
		execute: (_args, context) =>
			new Promise((resolve, reject) => {
				note("execute_start", { toolCallId: context?.toolCallId ?? null });
				rejectExecute = reject;
				if (mode === "wedged") {
					setTimeout(() => void wedgeNetwork(), 3000);
					setTimeout(() => void release(), 8000);
				} else if (mode === "wedged-wait") {
					// Nobody cancels: the tool result is handed back into a dead network.
					setTimeout(() => void wedgeNetwork(), 3000);
					setTimeout(() => {
						measured.releaseAt = Date.now();
						note("result_returned");
						resolve("TOKEN-4410");
					}, 5000);
				} else {
					setTimeout(() => void release(), 5000);
				}
			}),
	},
};

await mkdir(cwd, { recursive: true });
agent = await Agent.create({
	model: { id: modelId },
	tools: hostToolAllowlist(1),
	mcpServers: {},
	local: { cwd, settingSources: HOST_SETTING_SOURCES, customTools },
});

let text = "";
const outcome = (async () => {
	const prompt =
		mode === "streaming"
			? "Count from 1 to 300, one number per line, nothing else."
			: "Call fetch_token once, then reply with the token it returned.";
	run = await agent.send(prompt);
	note("run_started");
	let released = false;
	try {
		for await (const event of run.stream()) {
			if (event.type === "assistant") {
				for (const block of event.message.content) if (block.type === "text") text += block.text;
				if (mode === "streaming" && !released && text.split("\n").length > 20) {
					released = true;
					void release();
				}
			} else if (event.type === "tool_call") note("tool_call", { status: event.status });
			else if (event.type === "status") note("status", { status: event.status });
		}
		measured.streamEndedAfterMs = Date.now() - (measured.releaseAt ?? Date.now());
		note("stream_ended");
	} catch (error) {
		measured.streamEndedAfterMs = Date.now() - (measured.releaseAt ?? Date.now());
		measured.streamError = String(error?.message ?? error);
		note("stream_threw", { message: measured.streamError });
	}
	try {
		const result = await run.wait();
		measured.waitStatus = result.status;
		measured.waitSettledAfterMs = Date.now() - (measured.releaseAt ?? Date.now());
		note("wait_settled", { status: result.status });
	} catch (error) {
		measured.waitError = String(error?.message ?? error);
		measured.waitSettledAfterMs = Date.now() - (measured.releaseAt ?? Date.now());
		note("wait_threw", { message: measured.waitError });
	}
	return "returned";
})().catch((error) => {
	note("failure", { message: String(error?.message ?? error) });
	return "failed";
});

const verdict = await Promise.race([outcome, sleep(DEADLINE_MS).then(() => "hung")]);
await sleep(3000);
const handles = process._getActiveHandles?.().map((handle) => handle?.constructor?.name ?? "unknown") ?? [];
const report = { modelId, mode, verdict, ...measured, releaseAt: undefined, activeHandlesAfter: handles, textLines: text.split("\n").length, timeline };
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, timeline: undefined }, null, 2));
process.exit(0);
