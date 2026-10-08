#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = path.resolve(import.meta.dirname, "../..");
const runtime = path.resolve(flag("--package", path.join(root, ".runtime/pi-antigravity-native")));
const evidence = path.resolve(flag("--evidence", path.join(root, "test-results/pi-antigravity-native-20261006/smoke")));
const workspace = path.resolve(flag("--workspace", path.join(root, "tmp/antigravity-native-smoke")));
const loadOnly = args.includes("--load-only");
// Second turn after the extension changes the system: the CLI keeps a resumed conversation's original system, so the provider must start a new one and restore history.
const systemSwitch = args.includes("--system-switch");
// Claude models behind Antigravity reject a one-pixel grayscale PNG ("Could not process image"); this RGB image passes on Gemini and Claude.
const probeImage = fs.readFileSync(flag("--probe-image", path.join(root, "tools/pi-antigravity/fixtures/probe-rgb64.png"))).toString("base64");
const agentDir = path.join(process.env.USERPROFILE, ".pi/agent");
const piDir = path.join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent");
const sdk = await import(pathToFileURL(path.join(piDir, "dist/index.js")));
const { Type } = createRequire(path.join(agentDir, "npm/package.json"))("@sinclair/typebox");
const configuration = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
const token = `NATIVE_FILE_${randomUUID()}`;
const projectRule = `NATIVE_PROJECT_${randomUUID()}`;
let dynamicRule = `NATIVE_EXTENSION_${randomUUID()}`;
fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(workspace, "probe.txt"), token);
fs.writeFileSync(path.join(workspace, "AGENTS.md"), `# 项目规则\n\n项目标记：${projectRule}\n所有文件操作使用 Pi 工具。\n`);
const protectedFiles = [path.join(agentDir, "settings.json"), path.join(agentDir, "auth.json"), path.join(process.env.USERPROFILE, ".gemini/antigravity-cli/settings.json")];
const hashes = () => Object.fromEntries(protectedFiles.map((file) => [file, fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null]));
const before = hashes();
const calls = [], results = [], errors = [];
let capturedSystem = "";
const audit = (pi) => {
  pi.registerTool({ name: "native_runtime_probe", label: "Native runtime probe", description: "Read-only test fixture. Returns the provided value and a one-pixel PNG.", parameters: Type.Object({ value: Type.String() }), async execute(_id, parameters) {
    return { content: [{ type: "text", text: `NATIVE_EXTENSION_RESULT:${parameters.value}` }, { type: "image", data: probeImage, mimeType: "image/png" }], details: { nativeProbe: true } };
  } });
  pi.on("before_agent_start", (event) => {
    capturedSystem = `${event.systemPrompt}\n扩展标记：${dynamicRule}\n`;
    fs.writeFileSync(path.join(evidence, "pi-system.txt"), capturedSystem);
    return { systemPrompt: capturedSystem };
  });
  pi.on("tool_call", (event) => { calls.push({ name: event.toolName, id: event.toolCallId, input: event.input }); fs.writeFileSync(path.join(evidence, "tool-calls.json"), JSON.stringify(calls, null, 2)); });
  pi.on("tool_result", (event) => {
    results.push({ name: event.toolName, id: event.toolCallId, isError: event.isError, content: event.content });
    fs.writeFileSync(path.join(evidence, "tool-results.json"), JSON.stringify(results, null, 2));
    if (event.toolName === "native_runtime_probe") return { content: [...event.content, { type: "text", text: "NATIVE_HOST_HOOK_SEEN" }] };
  });
};
const packages = configuration.packages.map((entry) => {
  const source = typeof entry === "string" ? entry : entry.source;
  if (source?.startsWith("npm:@tian.zuo/pi-antigravity") || source?.includes("pi-antigravity-native")) return typeof entry === "string" ? runtime : { ...entry, source: runtime };
  return entry;
});
const settings = sdk.SettingsManager.inMemory({ ...configuration, packages, compaction: { enabled: false }, retry: { enabled: false } });
process.env.PI_ANTIGRAVITY_USAGE = "0";
process.chdir(workspace);
const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings, extensionFactories: [audit] });
await loader.reload();
const loaded = loader.getExtensions();
fs.writeFileSync(path.join(evidence, "extensions.json"), JSON.stringify({ paths: loaded.extensions.map((e) => e.path), errors: loaded.errors }, null, 2));
assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
const { session } = await sdk.createAgentSession({ cwd: workspace, agentDir, settingsManager: settings, resourceLoader: loader, sessionManager: sdk.SessionManager.create(workspace, evidence), thinkingLevel: "low" });
await session.bindExtensions({ onError(error) { errors.push(error); console.error("EXTENSION_ERROR", JSON.stringify(error)); } });
const definitions = session.getAllTools();
fs.writeFileSync(path.join(evidence, "tools.json"), JSON.stringify(definitions, null, 2));
const modelId = flag("--model", "gemini-3.6-flash");
const model = session.modelRuntime.getModel("antigravity", modelId);
assert.ok(model, `Missing antigravity/${modelId}`);
await session.setModel(model);
fs.writeFileSync(path.join(evidence, "active-tools.json"), JSON.stringify(session.getActiveToolNames(), null, 2));
const events = fs.createWriteStream(path.join(evidence, "events.jsonl"));
session.subscribe((event) => events.write(JSON.stringify(event) + "\n"));
let timedOut = false;
let switchResult;
const finalText = (messages) => messages.filter((m) => m.role === "assistant").at(-1).content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
const parseJson = (text) => JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
const conversationStates = () => session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "pi-antigravity-conversation-state").map((e) => e.data);
const timeout = setTimeout(() => { timedOut = true; void session.abort(); }, systemSwitch ? 360_000 : 180_000);
try {
  if (!loadOnly) {
    await session.prompt('用 Pi 的 read 读取 probe.txt；用 Pi 的 bash 运行 node -e "console.log(\'NATIVE_BASH_OK\')"；调用 native_runtime_probe，value 必须使用读到的文件内容；再调用 mcp，参数为空对象，仅查看本机 MCP 状态，不执行浏览器操作。不要写文件。最终只返回 JSON，字段 token 为文件内容、hook 为返回结果中的宿主钩子标记、summary 为简体中文完成说明。');
    assert.equal(timedOut, false);
    assert.ok(calls.some((c) => c.name === "read"));
    assert.ok(calls.some((c) => c.name === "bash"));
    assert.ok(calls.some((c) => c.name === "native_runtime_probe"));
    assert.ok(calls.some((c) => c.name === "mcp"));
    const messages = session.agent.state.messages;
    const final = finalText(messages);
    fs.writeFileSync(path.join(evidence, "response.txt"), final);
    const result = parseJson(final);
    assert.equal(result.token, token);
    assert.equal(result.hook, "NATIVE_HOST_HOOK_SEEN");
    assert.ok(results.find((r) => r.name === "native_runtime_probe").content.some((c) => c.type === "image"));
    assert.ok(capturedSystem.includes(projectRule), "Project context missing from final Pi system");
    assert.ok(capturedSystem.includes(dynamicRule), "Dynamic extension system missing");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    if (systemSwitch) {
      const first = conversationStates().at(-1);
      assert.ok(first?.conversationId, "No Antigravity conversation state after the first turn");
      const firstRule = dynamicRule;
      dynamicRule = `NATIVE_EXTENSION_${randomUUID()}`;
      await session.prompt("这一轮不要调用任何工具。只返回 JSON：token 为上一轮读到的 probe.txt 内容，marker 为当前系统提示里「扩展标记：」后面的值。");
      assert.equal(timedOut, false);
      const switched = finalText(session.agent.state.messages);
      fs.writeFileSync(path.join(evidence, "response-switch.txt"), switched);
      const second = conversationStates().at(-1);
      switchResult = { firstConversation: first.conversationId, secondConversation: second.conversationId, firstHash: first.systemPromptHash, secondHash: second.systemPromptHash, ...parseJson(switched), firstRule, expectedMarker: dynamicRule };
      assert.notEqual(second.conversationId, first.conversationId, "System change resumed the old CLI conversation");
      assert.notEqual(second.systemPromptHash, first.systemPromptHash);
      assert.equal(switchResult.marker, dynamicRule, "New system not seen by the model");
      assert.equal(switchResult.token, token, "History not restored into the new conversation");
      await session.prompt("这一轮不要调用任何工具。只返回 JSON：marker 为当前系统提示里「扩展标记：」后面的值。");
      assert.equal(timedOut, false);
      const unchanged = parseJson(finalText(session.agent.state.messages));
      switchResult.thirdConversation = conversationStates().at(-1).conversationId;
      assert.equal(switchResult.thirdConversation, second.conversationId, "Unchanged system did not resume the conversation");
      assert.equal(unchanged.marker, dynamicRule);
      assert.equal(errors.length, 0, JSON.stringify(errors));
    }
  }
  fs.writeFileSync(path.join(evidence, "summary.json"), JSON.stringify({ passed: true, loadOnly, model: `antigravity/${modelId}`, systemSwitch: switchResult, toolCount: definitions.length, toolNames: definitions.map((t) => t.name), calls: calls.map((c) => c.name), projectContextPresent: capturedSystem.includes(projectRule), extensionContextPresent: capturedSystem.includes(dynamicRule), skillsCount: loader.getSkills().skills.length, rootSettingsUnchanged: JSON.stringify(before) === JSON.stringify(hashes()) }, null, 2));
} finally {
  clearTimeout(timeout);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  await new Promise((resolve) => events.end(resolve));
  assert.deepEqual(hashes(), before, "Smoke changed protected configuration");
}
