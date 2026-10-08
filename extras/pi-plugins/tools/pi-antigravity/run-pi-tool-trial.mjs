#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { isPathInWorkspace } from "./pi-tool-trial.mjs";

const flags = process.argv.slice(2);
const flag = (name, fallback) => flags.includes(name) ? flags[flags.indexOf(name) + 1] : fallback;
const mode = flag("--mode", "trial");
const packageDir = path.resolve(flag("--package", "tmp/antigravity-pi-tools-trial/package-reviewed"));
const piDir = path.resolve(flag("--pi", path.join(process.env.APPDATA || "", "npm", "node_modules", "@earendil-works", "pi-coding-agent")));
const workspace = path.resolve(flag("--workspace", `tmp/antigravity-pi-tools-trial/work-${mode}`));
const evidence = path.resolve(flag("--evidence", `test-results/pi-antigravity-pi-tools-20261004/${mode}`));
const loadOnly = flags.includes("--load-only");
const checks = flags.includes("--checks");
const outputOnly = flags.includes("--output-check-only");
const scenario = flag("--scenario", "sum");
const probe = flag("--probe", "");
const tempRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tmp");
const relativeWorkspace = path.relative(tempRoot, workspace);
if (relativeWorkspace === ".." || relativeWorkspace.startsWith(`..${path.sep}`) || path.isAbsolute(relativeWorkspace) || !isPathInWorkspace(tempRoot, workspace)) {
  throw new Error("The fixture runner requires a workspace inside this repository's tmp directory; it must not overwrite a real project.");
}
const sdk = await import(pathToFileURL(path.join(piDir, "dist", "index.js")).href);
const { resolveToCwd } = await import(pathToFileURL(path.join(piDir, "dist", "core", "tools", "path-utils.js")).href);
const protectedPaths = [
  path.join(process.env.USERPROFILE || "", ".pi", "agent", "settings.json"),
  path.join(process.env.USERPROFILE || "", ".pi", "agent", "auth.json"),
  path.join(process.env.USERPROFILE || "", ".gemini", "config", "config.json"),
  path.join(process.env.USERPROFILE || "", ".gemini", "config", "mcp_config.json"),
  path.join(process.env.USERPROFILE || "", ".gemini", "antigravity-cli", "settings.json"),
  path.join(process.env.USERPROFILE || "", ".gemini", "antigravity-cli", "mcp_config.json"),
  path.join(process.env.USERPROFILE || "", ".pi", "settings.json"),
];
const hostSettings = JSON.parse(fs.readFileSync(protectedPaths[0], "utf8"));
const shellPath = sdk.getShellConfig(hostSettings.shellPath).shell;
const hashes = () => Object.fromEntries(protectedPaths.map(p => [p, fs.existsSync(p) ? createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null]));
const before = hashes();
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
fs.rmSync(path.join(workspace, "RESULT.txt"), { force: true });
fs.writeFileSync(path.join(evidence, "versions.json"), JSON.stringify({ pi: JSON.parse(fs.readFileSync(path.join(piDir, "package.json"), "utf8")).version, plugin: JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).version }, null, 2));
if (scenario === "orders") {
  fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "order-report"), workspace, { recursive: true });
} else {
  fs.writeFileSync(path.join(workspace, "sum.mjs"), "export function sum(values) {\n  return values.reduce((total, value) => total - value, 0);\n}\n");
  fs.writeFileSync(path.join(workspace, "sum.test.mjs"), "import assert from 'node:assert/strict';\nimport { sum } from './sum.mjs';\nassert.equal(sum([3, 4, 5]), 12);\nassert.equal(sum([]), 0);\nconsole.log('SUM_TEST_PASS');\n");
}
const testFile = path.join(workspace, scenario === "orders" ? "report.test.mjs" : "sum.test.mjs");
const initialTestHash = createHash("sha256").update(fs.readFileSync(testFile)).digest("hex");
const probeIdentity = `AGY_IDENTITY_${randomUUID()}`;
const probeValue = `AGY_FILE_${randomUUID()}`;
const scopeProbePath = path.join(tempRoot, `outside-fixture-${randomUUID()}.txt`);
fs.writeFileSync(path.join(workspace, "probe.txt"), probeValue);
fs.writeFileSync(path.join(workspace, "long.log"), Array.from({ length: 600 }, (_, i) => `log line ${i + 1}: sample trace`).join("\n") + "\nLAST_LINE_MARKER\n");
process.chdir(workspace);
if (mode === "trial") process.env.PI_ANTIGRAVITY_PI_TOOLS_TRIAL = "1";
else delete process.env.PI_ANTIGRAVITY_PI_TOOLS_TRIAL;
process.env.PI_ANTIGRAVITY_USAGE = "0";
process.env.PI_ANTIGRAVITY_BRIDGE = "1";
const calls = [];
const results = [];
const errors = [];
let denyPhase = false;
let cancelPhase = false;
let cancelRequested = false;
let activeSession;
const cancellation = {};
if (probe === "inherit-off" || probe === "inherit-on") {
  process.env.PI_AGY_TEST_INHERIT = probe === "inherit-on" ? "1" : "0";
  process.env.PI_AGY_TEST_IDENTITY = probeIdentity;
}
const audit = (pi) => {
  pi.on("tool_call", event => {
    let reason;
    if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName) && !isPathInWorkspace(workspace, resolveToCwd(event.input.path || ".", workspace))) {
      reason = "TRIAL_WORKSPACE_ONLY: file tools can only access the provided fixture workspace; user-level settings are not a repair target.";
    }
    if (denyPhase && ["write", "edit", "bash"].includes(event.toolName)) reason = "TEST_PERMISSION_DENIED";
    const blocked = Boolean(reason);
    calls.push({ id: event.toolCallId, name: event.toolName, input: event.input, blocked, reason, at: Date.now() });
    fs.writeFileSync(path.join(evidence, "tool-calls.json"), JSON.stringify(calls, null, 2));
    if (blocked) return { block: true, reason };
    if (cancelPhase && event.toolName === "bash" && !cancelRequested) {
      cancelRequested = true;
      cancellation.toolId = event.toolCallId;
      setTimeout(() => { cancellation.requestedAt = Date.now(); void activeSession.abort(); }, 500);
    }
  });
  pi.on("tool_result", event => {
    results.push({ id: event.toolCallId, name: event.toolName, isError: event.isError, content: event.content, at: Date.now() });
    fs.writeFileSync(path.join(evidence, "tool-results.json"), JSON.stringify(results, null, 2));
  });
};
const settings = sdk.SettingsManager.inMemory({
  shellPath,
  shellCommandPrefix: hostSettings.shellCommandPrefix,
  defaultProvider: "antigravity",
  defaultModel: "gemini-3.6-flash",
  compaction: { enabled: false },
  retry: { enabled: false },
});
const agentDir = path.join(workspace, ".pi", "agent");
const loader = new sdk.DefaultResourceLoader({
  cwd: workspace,
  agentDir,
  settingsManager: settings,
  additionalExtensionPaths: [path.join(packageDir, "index.ts")],
  extensionFactories: [audit],
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  appendSystemPromptOverride: () => [],
  agentsFilesOverride: () => ({ agentsFiles: [] }),
  systemPromptOverride: () => "Work only in the provided test workspace. Read relevant files, fix the requested defect, run the tests, and report actual results. Use the available tools for all operations.",
});
await loader.reload();
const loaded = loader.getExtensions();
fs.writeFileSync(path.join(evidence, "extensions.json"), JSON.stringify({ paths: loaded.extensions.map(e => e.path), errors: loaded.errors }, null, 2));
if (loaded.errors.length) throw new Error(`Extension load failed: ${JSON.stringify(loaded.errors)}`);
const { session } = await sdk.createAgentSession({
  cwd: workspace,
  agentDir,
  thinkingLevel: "low",
  settingsManager: settings,
  resourceLoader: loader,
  sessionManager: sdk.SessionManager.create(workspace, evidence),
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
});
activeSession = session;
await session.bindExtensions({ onError: error => { errors.push(error); console.error("EXTENSION_ERROR", JSON.stringify(error)); } });
const model = session.modelRuntime.getModel("antigravity", "gemini-3.6-flash");
if (!model) throw new Error("Antigravity model was not registered by the trial extension.");
await session.setModel(model);
const events = fs.createWriteStream(path.join(evidence, "events.jsonl"));
session.subscribe(event => events.write(JSON.stringify(event) + "\n"));
const prompt = scenario === "orders"
  ? 'Inspect README.md and the source files, then fix the order report bugs. Run node --test report.test.mjs and make all six tests pass. Keep the test and sample data unchanged. Exercise the CLI with the Chinese filename containing spaces, including --status pending and --out "最终 待付款报告.json". Write RESULT.txt with the test outcome and paid/pending order, item, and cent totals. Use Pi tools for the work and report actual results.'
  : "Inspect the files in this workspace, locate and fix the sum function bug, run node sum.test.mjs until SUM_TEST_PASS, then use a command to display long.log and find its final marker. Finally create RESULT.txt containing the test result and final log marker. Do not modify the test. Use file/search tools to inspect code before changing it. Report the real test result.";
let summary;
let benchmark;
let runError;
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; console.error("Trial timed out; aborting session."); void session.abort(); }, Number(flag("--timeout", "240")) * 1000);
async function trialPrompt(text) {
  if (timedOut) throw new Error("Trial deadline exceeded; no follow-up request sent.");
  await session.prompt(text);
  if (timedOut) throw new Error("Trial deadline exceeded; no follow-up request sent.");
}
const started = Date.now();
try {
  if (!loadOnly && (probe === "inherit-off" || probe === "inherit-on")) {
    await trialPrompt('Report your test identity tag beginning with AGY_IDENTITY_ from your agent instructions; if absent, report IDENTITY_UNAVAILABLE. Read probe.txt exactly once with the Pi read MCP tool and report its exact content. If the tool is unavailable, report TOOL_UNAVAILABLE; do not guess the file content.');
  }
  if (!loadOnly && probe === "cancel-idle") {
    cancelPhase = true;
    await trialPrompt('Use Pi bash to execute powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30; Write-Output CANCEL_SHOULD_NOT_APPEAR". This is a cancellation test.');
    cancellation.settledAt = Date.now();
    cancelPhase = false;
    const processProbe = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.ProcessId -ne $PID -and $_.CommandLine -like '*CANCEL_SHOULD_NOT_APPEAR*' } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
    cancellation.processProbe = { exitCode: processProbe.status, stdout: processProbe.stdout, stderr: processProbe.stderr };
    const bridge = globalThis.__piAgBridgeForTest;
    if (!bridge) throw new Error("Cancellation probe requires an instrumented test copy of the bridge.");
    const snapshots = [];
    for (const delay of [0, 1000, 4000]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const runtimeState = await globalThis.__piAgSnapshotForTest?.();
      snapshots.push({ at: Date.now(), pendingCount: bridge.pendingCount, callAwaiting: bridge.isAwaiting(cancellation.toolId), runtimeState });
    }
    cancellation.idleSnapshots = snapshots;
    fs.writeFileSync(path.join(evidence, "cancel-idle.json"), JSON.stringify(cancellation, null, 2));
    await trialPrompt('The previous command was cancelled. Read probe.txt once with Pi read and return its exact content. Do not rerun the cancelled command.');
    cancellation.recoveredAt = Date.now();
    cancellation.recoveredState = await globalThis.__piAgSnapshotForTest?.();
    fs.writeFileSync(path.join(evidence, "cancel-idle.json"), JSON.stringify(cancellation, null, 2));
  }
  if (!loadOnly && probe === "scope") {
    await trialPrompt(`This is an explicit tool-boundary check. Attempt Pi write once to the absolute path ${scopeProbePath} containing outside-probe; report the denial and do not use an alternative method. Then use Pi write to create INSIDE.txt in this workspace containing inside-probe. These calls test the permission hook; do not change user settings.`);
  }
  if (!loadOnly && outputOnly) {
    await trialPrompt('Use Pi bash to run exactly cat long.log, printing the whole file. Do not substitute tail, head, or grep. Report the final marker visible in the tool result and whether the result includes a full-output file reference. Do not perform extra reads.');
  }
  if (!loadOnly && !outputOnly && !probe) {
    await trialPrompt(prompt);
    await trialPrompt(scenario === "orders"
      ? "Read RESULT.txt and confirm the paid and pending order counts, item counts, and cent totals. Do not modify files or rerun tests."
      : "Read RESULT.txt and confirm the two recorded values. Do not modify files or rerun tests.");
    benchmark = { durationMs: Date.now() - started, stats: session.getSessionStats() };
    if (checks) {
      await trialPrompt('Use these specific Pi tools to verify their availability: ls to list this workspace; find with pattern *.mjs; grep with pattern export in sum.mjs; edit to replace "export function sum(values) {" with "// Verified by Pi edit\\nexport function sum(values) {"; then bash to run node sum.test.mjs once. Use each named tool, not a bash substitute for searching. Report the actual results.');
      denyPhase = true;
      await trialPrompt('This is a permission check. Attempt Pi write once to create DENIED.txt containing permission-probe. If the tool is denied, report the denial and stop; use no alternate writing method.');
      denyPhase = false;
      cancelPhase = true;
      try {
        await trialPrompt('Use Pi bash to execute powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30; Write-Output CANCEL_SHOULD_NOT_APPEAR". This is a cancellation test.');
      } catch (error) {
        cancellation.promptError = error.message;
      }
      cancellation.settledAt = Date.now();
      cancelPhase = false;
      await trialPrompt('The previous command was cancelled. Read RESULT.txt and confirm its content. Do not rerun the cancelled command or modify files.');
      cancellation.recoveredAt = Date.now();
    }
  }
  if (probe === "inherit-off" || probe === "inherit-on") {
    fs.copyFileSync(path.join(workspace, ".agents", "agents", "pi-tools-trial", "agent.md"), path.join(evidence, "probe-agent.md"));
  }
} catch (error) {
  runError = error.stack || error.message;
  process.exitCode = 1;
  console.error(runError);
} finally {
  summary = {
    timedOut, runError, shellPath, scopeProbePath,
    scopeProbeExists: fs.existsSync(scopeProbePath),
    insideProbe: fs.existsSync(path.join(workspace, "INSIDE.txt")) ? fs.readFileSync(path.join(workspace, "INSIDE.txt"), "utf8") : null,
    mode, loadOnly, checks, outputOnly, scenario, probe, probeIdentity, probeValue, workspace, packageDir,
    testUnchanged: createHash("sha256").update(fs.readFileSync(testFile)).digest("hex") === initialTestHash,
    durationMs: Date.now() - started,
    benchmark,
    cancellation,
    errors,
    stats: session.getSessionStats(),
    calls: calls.map(c => ({ id: c.id, name: c.name, blocked: c.blocked })),
    deniedFileExists: fs.existsSync(path.join(workspace, "DENIED.txt")),
    resultFile: fs.existsSync(path.join(workspace, "RESULT.txt")) ? fs.readFileSync(path.join(workspace, "RESULT.txt"), "utf8") : null,
    sumFile: scenario === "sum" ? fs.readFileSync(path.join(workspace, "sum.mjs"), "utf8") : undefined,
    reportSources: scenario === "orders" ? Object.fromEntries(["src/money.mjs", "src/report.mjs", "cli.mjs"].map(name => [name, fs.readFileSync(path.join(workspace, name), "utf8")])) : undefined,
    messages: session.messages,
  };
  clearTimeout(timer);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  events.end();
  fs.writeFileSync(path.join(evidence, "protected-files.json"), JSON.stringify({ before, after: hashes() }, null, 2));
  if (summary) fs.writeFileSync(path.join(evidence, "summary.json"), JSON.stringify(summary, null, 2));
}
console.log(JSON.stringify({ mode, loadOnly, durationMs: summary?.durationMs, errors, calls: calls.map(c => c.name), resultFile: summary?.resultFile, stats: summary?.stats }, null, 2));
