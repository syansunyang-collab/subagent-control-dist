import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { bindSessionLifecycle } from "../src/index.ts";
import { Agent, Cursor } from "@cursor/sdk";
import { createCursorHostStream, disposeAllSessions, disposeSession, registerSessionDirectory, toProviderModels } from "../src/runtime.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
}
const context = { systemPrompt: "", tools: [{ name: "read", description: "fixture", parameters: { type: "object", properties: {} } }], messages: [{ role: "user", content: "go", timestamp: 1 }] };
const model = toProviderModels([{ id: "fixture", name: "fixture" }])[0];
function agent(send = async () => { throw new Error("LOCAL_SEND_BOUNDARY"); }) {
	return { send, close() { this.closed = true; }, closed: false };
}
async function isolated(t) {
	const dir = await mkdtemp(join(tmpdir(), "cursor-runtime-"));
	const saved = { create: Agent.create, status: Cursor.auth.status, env: process.env.PI_CURSOR_HOST_SYSTEM_PROMPT, instr: process.env.PI_CURSOR_HOST_INSTR_DIR, key: process.env.CURSOR_API_KEY };
	process.env.PI_CURSOR_HOST_SYSTEM_PROMPT = "0";
	process.env.PI_CURSOR_HOST_INSTR_DIR = dir;
	delete process.env.CURSOR_API_KEY;
	t.after(async () => {
		disposeAllSessions();
		Agent.create = saved.create;
		Cursor.auth.status = saved.status;
		for (const [key, value] of [["PI_CURSOR_HOST_SYSTEM_PROMPT", saved.env], ["PI_CURSOR_HOST_INSTR_DIR", saved.instr], ["CURSOR_API_KEY", saved.key]]) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(dir, { recursive: true, force: true });
	});
	return dir;
}
const request = (options = {}, ctx = context) => createCursorHostStream()(model, ctx, { apiKey: "fixture-key", ...options }).result();

for (const phase of ["credentials", "create", "send"]) {
	test(`cancellation settles during ${phase} and releases late resources`, { timeout: 3000 }, async t => {
		await isolated(t);
		const entered = gate(), blocked = gate();
		const controller = new AbortController();
		let sends = 0, creates = 0, cancels = 0;
		const lateRun = { async cancel() { cancels++; } };
		const created = agent(async () => { sends++; if (phase === "send") { entered.resolve(); return blocked.promise; } throw new Error("unexpected send"); });
		Cursor.auth.status = async () => { entered.resolve(); return blocked.promise; };
		Agent.create = async () => { creates++; if (phase === "create") { entered.resolve(); return blocked.promise; } return created; };
		const resultPromise = request({ signal: controller.signal, ...(phase === "credentials" ? { apiKey: "cursor-sdk" } : {}) });
		await entered.promise;
		controller.abort();
		const result = await resultPromise;
		assert.equal(result.stopReason, "aborted");
		if (phase === "credentials") blocked.resolve({ status: "logged-in" });
		else if (phase === "create") blocked.resolve(created);
		else blocked.resolve(lateRun);
		await tick();
		if (phase === "credentials") assert.equal(creates, 0);
		else assert.equal(created.closed, true);
		assert.equal(sends, phase === "send" ? 1 : 0);
		assert.equal(cancels, phase === "send" ? 1 : 0);
	});
}

test("already cancelled requests do not resolve credentials or create/send", async t => {
	await isolated(t);
	let calls = 0;
	Cursor.auth.status = Agent.create = async () => { calls++; throw new Error("must not start"); };
	const controller = new AbortController();
	controller.abort();
	assert.equal((await request({ apiKey: "cursor-sdk", signal: controller.signal })).stopReason, "aborted");
	assert.equal(calls, 0);
});

test("real Pi 0.99.1 SDK lifecycle aligns Cursor rules and relative Pi read with session cwd", { timeout: 30000 }, async t => {
	const dir = await isolated(t);
	const cwd = join(dir, "session-B"), agentDir = join(dir, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(cwd, "fixture.txt"), "CONTENT_FROM_B");
	await writeFile(join(cwd, "AGENTS.md"), "RULES_FROM_B");
	const sdkRoot = process.env.PI_TEST_SDK_ROOT ?? join(homedir(), "AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent");
	const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")));
	const settingsManager = sdk.SettingsManager.inMemory({ packages: [], retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false } });
	const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
		extensionFactories: [pi => {
			bindSessionLifecycle(pi);
			pi.registerProvider(model.provider, { baseUrl: "cursor-host://fixture", apiKey: "fixture-key", api: model.api,
				models: [model], streamSimple: createCursorHostStream() });
		}],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
	const sessionManager = sdk.SessionManager.inMemory(cwd);
	const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, sessionManager, resourceLoader, modelRuntime, model, tools: ["read"] });
	t.after(() => { session.dispose(); disposeSession(sessionManager.getSessionId()); });
	await session.bindExtensions({});
	const read = session.state.tools.find(tool => tool.name === "read");
	assert(read, "Pi must bind the relative-path read tool");
	const readResult = await read.execute("fixture-call", { path: "fixture.txt" });
	assert.match(readResult.content.find(block => block.type === "text").text, /CONTENT_FROM_B/);
	let captured;
	Agent.create = async options => { captured = options; throw new Error("LOCAL_CREATE_BOUNDARY"); };
	await session.prompt("fixture");
	assert(captured, "the real SDK prompt must reach the offline Agent.create boundary");
	assert.equal(captured.local.cwd, cwd);
	const sidecar = await readFile(join(captured.local.dirs[0], "AGENTS.md"), "utf8");
	assert.doesNotMatch(sidecar, /RULES_FROM_B/, "Cursor-loaded B rules are deduplicated from the sidecar");
	assert.notEqual(process.cwd(), cwd);
});

test("session directory is used for conversation and tool-less requests, shutdown forgets it", async t => {
	const dir = await isolated(t);
	assert.notEqual(dir, process.cwd());
	registerSessionDirectory("session-B", dir);
	const seen = [];
	Agent.create = async options => { seen.push(options.local.cwd); throw new Error("LOCAL_CREATE_BOUNDARY"); };
	await request({ sessionId: "session-B" });
	await request({ sessionId: "session-B" }, { ...context, tools: [] });
	assert.deepEqual(seen, [dir, dir]);
	disposeSession("session-B");
	await request({ sessionId: "session-B" });
	assert.equal(seen[2], process.cwd());
});
