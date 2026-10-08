import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The package is generated from tools/pi-antigravity/pi-antigravity-0.10.3-native.patch, not committed.
const nativeRoot = path.resolve(process.env.PI_TEST_ANTIGRAVITY_NATIVE_ROOT ?? path.join(import.meta.dirname, "../../.runtime/pi-antigravity-native"));
if (!fs.existsSync(path.join(nativeRoot, "native-manifest.json"))) {
  throw new Error(`No native Antigravity package at ${nativeRoot}; run: node tools/pi-antigravity/manage-pi-antigravity.mjs native-build --json`);
}
const load = (file) => import(pathToFileURL(path.join(nativeRoot, file)).href);
const { cliServerName, cliToolName, NativeWorkspaceRegistration } = await load("lib/native-workspace.mjs");
const { AgyPiBridge, resolveBridgeResultsFromContext, selectBridgedTools } = await load("lib/bridge.ts");
const { piUserRequestText, latestUserPrompt, piHistoryBootstrap, streamAntigravity } = await load("src/provider.ts");
const { AntigravityRuntime, createAntigravityRuntime } = await load("src/runtime.ts");

const temporaryDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-agy-native-"));
const hash = (letter) => letter.repeat(64);

async function postMcp(bridge, token, body) {
  const response = await fetch(bridge.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pi-bridge-token": token,
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("workspace agent gets the Pi snapshot; only this process/session registration is removed", () => {
  const cwd = temporaryDirectory();
  const agentsRoot = path.join(cwd, ".agents");
  fs.mkdirSync(agentsRoot, { recursive: true });
  const configPath = path.join(agentsRoot, "mcp_config.json");
  const original = '{\n  "mcpServers": {\n    "project-owned": { "command": "keep-me" }\n  },\n  "projectOption": true\n}\n';
  fs.writeFileSync(configPath, original);
  fs.mkdirSync(path.join(agentsRoot, "agents", "project-agent"), { recursive: true });
  fs.writeFileSync(path.join(agentsRoot, "agents", "project-agent", "agent.md"), "keep this agent");

  const workspace = new NativeWorkspaceRegistration({ cwd, id: "p1234-session7", serverName: "pi-bridge-p1234-session7" });
  const systemPrompt = "# Pi rules\n\nUse the active Pi tools and project instructions.";
  try {
    workspace.registerMcpServer("http://127.0.0.1:41234/mcp", "session-only-token");
    workspace.writeSystemPrompt(systemPrompt);
    const registered = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(registered.mcpServers["project-owned"], { command: "keep-me" });
    assert.equal(registered.mcpServers[workspace.serverName].serverUrl, "http://127.0.0.1:41234/mcp");
    assert.equal(registered.mcpServers[workspace.serverName].headers["x-pi-bridge-token"], "session-only-token");
    const agent = fs.readFileSync(workspace.agentPath, "utf8");
    assert.match(agent, /excludeDefaultComponents: true/);
    assert.match(agent, /inheritCustomizations: false/);
    assert.match(agent, /tools: \[\]/);
    assert.ok(agent.includes(`${systemPrompt}\n\n<pi_tool_bridge>`));
    assert.equal(agent.includes("Current Pi instructions"), false);
  } finally {
    workspace.dispose();
  }

  assert.equal(fs.readFileSync(configPath, "utf8"), original);
  assert.equal(fs.readFileSync(path.join(agentsRoot, "agents", "project-agent", "agent.md"), "utf8"), "keep this agent");
  assert.equal(fs.existsSync(workspace.agentPath), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("CLI names fit its 64-character limit for tools owned by other plugins", () => {
  const id = `p${process.pid}-abcdefabcdef`;
  const workspace = new NativeWorkspaceRegistration({ cwd: process.cwd(), id });
  assert.equal(workspace.serverName, cliServerName(id));
  assert.equal(workspace.serverName.startsWith("pi-bridge"), false);
  for (const name of ["native_runtime_probe", "subagent_server_info", "get_search_content", "pi_claude_code_provider_web_search"]) {
    const cliName = cliToolName(workspace.serverName, name, workspace.toolPrefix);
    assert.match(cliName, /^[a-zA-Z0-9_-]{1,64}$/, cliName);
  }
  const crowded = `mcp_pi-bridge-${id}_pi_claude_code_provider_web_search`;
  assert.equal(crowded.length > 64, true);
});

test("a Pi tool that cannot fit the CLI limit is refused before the agent file is written", () => {
  const cwd = temporaryDirectory();
  const workspace = new NativeWorkspaceRegistration({ cwd, id: "p1234-abcdefabcdef" });
  assert.throws(
    () => workspace.writeSystemPrompt("rules", [{ name: "x".repeat(60), description: "too long" }]),
    /too long/,
  );
  assert.equal(fs.existsSync(workspace.agentPath), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("workspace cleanup preserves project MCP changes made while the session is live", () => {
  const cwd = temporaryDirectory();
  const workspace = new NativeWorkspaceRegistration({ cwd, id: "p2-session8" });
  try {
    workspace.registerMcpServer("http://127.0.0.1:41235/mcp", "private-token");
    const configPath = workspace.configPath;
    const current = JSON.parse(fs.readFileSync(configPath, "utf8"));
    current.mcpServers["new-project-server"] = { command: "project-update" };
    fs.writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`);
    workspace.writeSystemPrompt("Pi system prompt");
  } finally {
    workspace.dispose();
  }
  const remaining = JSON.parse(fs.readFileSync(workspace.configPath, "utf8"));
  assert.deepEqual(remaining.mcpServers, { "new-project-server": { command: "project-update" } });
  assert.equal(fs.existsSync(workspace.agentPath), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("every active Pi tool is bridged except the recursive Antigravity wrapper", () => {
  const active = ["read", "bash", "ordinary_extension", "mcp_search", "dispatch_prepare", "antigravity"];
  const tools = active.map((name) => ({
    name,
    description: `${name} description`,
    parameters: { type: "object", properties: {} },
  }));
  const bridgeTools = selectBridgedTools(tools, active);
  assert.deepEqual(bridgeTools.map((tool) => tool.name), [
    "read", "bash", "ordinary_extension", "mcp_search", "dispatch_prepare",
  ]);
  assert.ok(bridgeTools.every((tool) => tool.parameters.type === "object"));
});

test("MCP bridge returns Pi image and text results through the host tool-result path", async () => {
  const bridge = new AgyPiBridge("pi-bridge-test");
  const token = "test-bridge-token";
  const tool = { name: "read_image", description: "Read an image", parameters: { type: "object" } };
  bridge.requireToken(token);
  bridge.setToolPrefix("pi__test__");
  bridge.setToolSource(() => [tool]);
  bridge.refreshTools();
  bridge.setOnCall((call) => {
    assert.deepEqual(call, { id: "pi-bridge-1", tool: "read_image", args: { path: "fixture.png" } });
    setTimeout(() => {
      resolveBridgeResultsFromContext(bridge, [{
        role: "toolResult",
        toolCallId: call.id,
        isError: false,
        content: [
          { type: "text", text: "image read through Pi" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      }]);
    }, 0);
    return true;
  });
  await bridge.start();
  try {
    const listed = await postMcp(bridge, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.deepEqual(listed.result.tools.map((entry) => entry.name), ["pi__test__read_image"]);
    const result = await postMcp(bridge, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "pi__test__read_image", arguments: { path: "fixture.png" } },
    });
    assert.deepEqual(result.result.content, [
      { type: "text", text: "image read through Pi" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
    assert.equal(bridge.pendingCount, 0);
  } finally {
    await bridge.close();
  }
});

test("cancel settles an in-flight bridge call without leaving it awaiting", async () => {
  const bridge = new AgyPiBridge("pi-bridge-cancel-test");
  const token = "cancel-token";
  bridge.requireToken(token);
  bridge.setToolPrefix("pi__cancel__");
  bridge.setToolSource(() => [{ name: "slow", parameters: { type: "object" } }]);
  bridge.refreshTools();
  bridge.setOnCall(() => {
    setTimeout(() => bridge.cancelPending("Pi turn cancelled."), 0);
    return true;
  });
  await bridge.start();
  try {
    const result = await postMcp(bridge, token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "pi__cancel__slow", arguments: {} },
    });
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /Pi turn cancelled/);
    assert.equal(bridge.pendingCount, 0);
  } finally {
    await bridge.close();
  }
});

test("known Pi host envelope is removed without editing ordinary or unrecognized user text", () => {
  const wrapped = "<USER_REQUEST>\nDo the task.\nKeep this body.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-06T19:51:38+08:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nModel Selection changed.\n</USER_SETTINGS_CHANGE>";
  assert.equal(piUserRequestText(wrapped), "Do the task.\nKeep this body.");
  assert.equal(piUserRequestText("Keep my 2026-10-06 heading."), "Keep my 2026-10-06 heading.");
  const unknownTail = `${wrapped}\nextra text`;
  assert.equal(piUserRequestText(unknownTail), unknownTail);
});

test("Pi history bootstrap excludes host time/settings notices but retains user and assistant history", () => {
  const context = {
    messages: [
      { role: "system", content: "SYSTEM_CONTENT_NOT_USER", sections: { rules: "SYSTEM_SECTIONS_NOT_USER" }, timestamp: 0 },
      { role: "user", content: "<USER_REQUEST>\nOld task\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-06T19:51:38+08:00.\n</ADDITIONAL_METADATA>" },
      { role: "assistant", content: [{ type: "text", text: "Old response" }] },
      { role: "user", content: "<USER_REQUEST>\nNew task\n</USER_REQUEST>\n<SYSTEM_MESSAGE>\nNotice\n</SYSTEM_MESSAGE>" },
    ],
    systemPrompt: "Pi rules",
  };
  assert.equal(latestUserPrompt(context).prompt, "New task");
  const history = piHistoryBootstrap(context);
  assert.match(history, /Old task/);
  assert.match(history, /Old response/);
  assert.doesNotMatch(history, /current local time|SYSTEM_MESSAGE|SYSTEM_CONTENT_NOT_USER|SYSTEM_SECTIONS_NOT_USER/);
});

test("provider sends the Pi snapshot only through its native agent and forwards task-only user content", async () => {
  const requests = [];
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    const conversationId = request.conversationId ?? "conversation-native";
    request.onConversation?.(conversationId);
    request.onActivity?.({ type: "result", status: "OK", response: "Task completed.", error: undefined, usage: undefined });
    return { status: "OK", response: "Task completed.", conversationId, usage: undefined };
  });
  const service = await runtime.runPromise(AntigravityRuntime);
  const cwd = process.cwd();
  const modelId = "gemini-3.6-flash";
  await runtime.runPromise(service.setSession(cwd, modelId, true));
  const bridge = new AgyPiBridge("pi-bridge-provider-test");
  bridge.setToolSource(() => []);
  bridge.refreshTools();
  const systemPrompt = "Complete Pi system instructions: never expose the hidden timestamp.";
  const prepared = [];
  const model = { id: modelId, provider: "antigravity", api: "antigravity", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const context = {
    messages: [{ role: "system", content: "", sections: { rules: systemPrompt }, timestamp: 0 }, { role: "user", content: "<USER_REQUEST>\nDo requested work.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-06T19:51:38+08:00.\n</ADDITIONAL_METADATA>" }],
  };
  const stream = streamAntigravity(
    runtime,
    service,
    { record() {} },
    bridge,
    () => {},
    () => true,
    () => {},
    undefined,
    undefined,
    () => ({}),
    () => "revision-1",
    async (snapshot) => { prepared.push(snapshot); return "pi-native-agent-test"; },
  )(model, context, {});
  try {
    const events = [];
    for await (const event of stream) events.push(event);
    assert.ok(events.some((event) => event.type === "done"), JSON.stringify(events));
    assert.deepEqual(prepared, [systemPrompt]);
    assert.notEqual((await runtime.runPromise(service.snapshot)).systemPromptHash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(requests[0].agent, "pi-native-agent-test");
    assert.equal(requests[0].prompt, "Do requested work.");
    assert.doesNotMatch(requests[0].prompt, /Pi system instructions|local time|ADDITIONAL_METADATA/);
  } finally {
    await runtime.dispose();
  }
});

test("system snapshot changes start a fresh CLI conversation with Pi history; unchanged turns resume", async () => {
  const requests = [];
  let nextId = 0;
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    const conversationId = request.conversationId ?? `conversation-${++nextId}`;
    request.onConversation?.(conversationId);
    return { status: "OK", response: "done", conversationId };
  });
  try {
    const service = await runtime.runPromise(AntigravityRuntime);
    const cwd = process.cwd();
    const modelId = "antigravity/gemini-3.6-flash";
    await runtime.runPromise(service.setSession(cwd, modelId, true));

    const runTurn = async (request) => {
      const controller = await runtime.runPromise(service.beginStreamTurn(request));
      assert.equal(await controller.next(), null);
      await runtime.runPromise(service.finishTurn);
    };

    await runTurn({
      prompt: "first task",
      historyBootstrap: "prior Pi history",
      systemPromptHash: hash("a"),
      modelId,
      cwd,
    });
    assert.equal(requests[0].conversationId, undefined);
    assert.match(requests[0].prompt, /prior Pi history/);
    assert.match(requests[0].prompt, /first task/);

    await runTurn({
      prompt: "second task",
      historyBootstrap: "Pi history to restore",
      systemPromptHash: hash("b"),
      modelId,
      cwd,
    });
    assert.equal(requests[1].conversationId, undefined);
    assert.match(requests[1].prompt, /Pi history to restore/);
    assert.match(requests[1].prompt, /second task/);
    assert.doesNotMatch(requests[1].prompt, /Pi rules|systemPromptHash/);

    await runTurn({ prompt: "third task", systemPromptHash: hash("b"), modelId, cwd });
    assert.equal(requests[2].conversationId, "conversation-2");
    assert.equal(requests[2].prompt, "third task");
  } finally {
    await runtime.dispose();
  }
});
