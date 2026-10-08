import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

// pi-scheduler-native (tools/pi-scheduler/native/) is the source of truth for the
// scheduler extension the user's settings.json actually loads
// (local-packages/pi-scheduler-native, installed from this exact source — see
// notes/verify/scheduler-native-deploy-20260923.md). It replaced the patched
// @jl1990/pi-scheduler@0.3.0 usage this file used to exercise; see
// docs/decisions/change-rationale/20260928-retire-pi-scheduler-patch-tool.md.

const projectRoot = new URL("../../", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/u, "$1");
const nativeRoot = join(projectRoot, "tools", "pi-scheduler", "native");
const indexFile = join(nativeRoot, "extensions", "scheduler", "index.ts");
const shellFile = join(nativeRoot, "extensions", "scheduler", "shell.cjs");
const coreFile = join(nativeRoot, "extensions", "scheduler", "core.cjs");
const globalPiPackage = process.env.PI_SCHEDULER_TEST_PI_ROOT || "C:\\Users\\67570\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent";
const globalPiEntries = {
  bundled: join(globalPiPackage, "dist/bundle/cli.js"),
  modular: join(globalPiPackage, "dist/cli.js"),
};

test("pi-scheduler-native rejects foreign session tasks when the current session is ephemeral", () => {
  const require = createRequire(import.meta.url);
  const core = require(coreFile);
  const foreign = { scope: "session", sessionFile: "C:\\foreign\\session.jsonl" };
  assert.equal(core.taskMatchesScope(foreign, { cwd: "E:\\work", sessionFile: undefined }), false);
  assert.equal(core.taskMatchesScope(foreign, { cwd: "E:\\work", sessionFile: "C:\\other\\session.jsonl" }), false);
  assert.equal(core.taskMatchesScope(foreign, { cwd: "E:\\work", sessionFile: foreign.sessionFile }), true);
});

test("pi-scheduler-native resolves the configured shellPath when Bash is absent from PATH", async (t) => {
  const indexSource = await readFile(indexFile, "utf8");
  const shellSource = await readFile(shellFile, "utf8");
  assert.match(indexSource, /import \{ SettingsManager, getAgentDir, getShellConfig \} from "@earendil-works\/pi-coding-agent"/);
  assert.match(indexSource, /agentDir: getAgentDir\(\)/);
  assert.match(indexSource, /settingsManagerClass: SettingsManager,/);
  assert.match(shellSource, /settingsManagerClass\.create\(cwd, agentDir, \{ projectTrusted \}\)/);
  assert.match(shellSource, /getShellConfig\(shellPath \?\? undefined\)/);
  assert.match(shellSource, /exec\(shellConfig\.shell, \[\.\.\.shellConfig\.args, command\]/);
  assert.doesNotMatch(indexSource, /"bash",\s*\["-lc"/);
  assert.doesNotMatch(shellSource, /"bash",\s*\["-lc"/);

  const home = await mkdtemp(join(tmpdir(), "pi-scheduler-native-shellpath-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, ".pi", "agent");
  const configuredShell = "D:\\Dev\\Git\\bin\\bash.exe";
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ shellPath: configuredShell }, null, 2)}\n`);

  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  isolatedEnv[pathKey] = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

  // Resolve inside a fresh, PATH-scrubbed process: this test process's own PATH
  // still has Git Bash, so getShellConfig()'s host-PATH discovery must be
  // isolated in a child, the same way pi-scheduler-native's own scheduled
  // commands run in a separate process from the TUI/RPC host.
  const piEntry = pathToFileURL(join(globalPiPackage, "dist", "index.js")).href;
  const shellEntry = pathToFileURL(shellFile).href;
  const probe = [
    `const { getShellConfig, SettingsManager } = await import(${JSON.stringify(piEntry)});`,
    `const shell = await import(${JSON.stringify(shellEntry)});`,
    `let defaultError;`,
    `try { getShellConfig(); } catch (error) { defaultError = error.message; }`,
    `const settings = SettingsManager.create(${JSON.stringify(projectRoot)}, ${JSON.stringify(agentDir)}, { projectTrusted: true });`,
    `const resolved = shell.resolveShellConfig({ cwd: ${JSON.stringify(projectRoot)}, agentDir: ${JSON.stringify(agentDir)}, projectTrusted: true, settingsManagerClass: SettingsManager, getShellConfig });`,
    `console.log(JSON.stringify({ defaultError, configured: settings.getShellPath(), resolved }));`,
  ].join("\n");
  const resolution = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
    encoding: "utf8",
    windowsHide: true,
    env: isolatedEnv,
  });
  assert.equal(resolution.status, 0, resolution.stderr || resolution.stdout);
  const resolvedOut = JSON.parse(resolution.stdout);
  assert.match(resolvedOut.defaultError, /No bash shell found/);
  assert.equal(resolvedOut.configured, configuredShell);
  assert.equal(resolvedOut.resolved.ok, true);
  assert.equal(resolvedOut.resolved.shell, configuredShell);
  assert.equal(resolvedOut.resolved.source, "settings");

  const require = createRequire(import.meta.url);
  const shell = require(shellFile);
  const out = await shell.executeShellCommand({
    shellConfig: resolvedOut.resolved,
    command: "printf SCHEDULER_SHELLPATH_OK",
    cwd: projectRoot,
    exec: (command, args, options) => new Promise((resolve) => {
      const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, env: isolatedEnv, ...options });
      resolve({ code: result.status, stdout: result.stdout, stderr: result.stderr, killed: false });
    }),
  });
  assert.equal(out.ok, true, out.error || out.stderr);
  assert.equal(out.stdout, "SCHEDULER_SHELLPATH_OK");
});

test("pi-scheduler-native tool prompts keep bounded end-of-response handoffs without an absolute polling ban", async () => {
  const source = await readFile(indexFile, "utf8");
  const handoffPhrase = /Schedule after immediate work is complete, then finish your response\./g;
  assert.equal((source.match(handoffPhrase) ?? []).length, 2, "wake_agent and schedule_command should both gate on finishing the response");
  assert.match(source, /requires maxRuns/i);
  assert.doesNotMatch(source, /never.{0,20}poll/i);
  assert.doesNotMatch(source, /Never use it .*poll local background commands/);
});

for (const [runtime, piEntry] of Object.entries(globalPiEntries)) {
  test(`pi-scheduler-native leaves an overdue global task pending in ${runtime} print mode`, async (t) => {
    const require = createRequire(import.meta.url);
    const core = require(coreFile);
    const home = await mkdtemp(join(tmpdir(), `pi-scheduler-native-${runtime}-print-test-`));
    t.after(() => rm(home, { recursive: true, force: true }));
    const statePath = join(home, ".pi", "agent", "state", "pi-scheduler-native", "tasks.json");
    await mkdir(dirname(statePath), { recursive: true });

    const created = core.createTask({ kind: "wake", after: "1s", reason: "SAFE_SCHEDULER_TEST", scope: "global" }, new Date("2020-01-01T00:00:00.000Z"));
    assert.equal(created.ok, true, created.error);
    const task = created.task;
    task.createdAt = "2020-01-01T00:00:00.000Z";
    task.nextRun = "2020-01-01T00:00:01.000Z";
    await writeFile(statePath, `${JSON.stringify({ version: 1, updatedAt: task.createdAt, tasks: [task] }, null, 2)}\n`);

    const result = spawnSync(
      process.execPath,
      [
        piEntry,
        "--no-extensions",
        "--extension",
        indexFile,
        "--no-session",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--offline",
        "--print",
        "/wakes",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const after = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(after.tasks.length, 1);
    const [survivor] = after.tasks;
    assert.equal(survivor.id, task.id);
    assert.equal(survivor.status, "pending", "a print-mode startup must not fire, deliver or otherwise settle a due global task");
    assert.equal(survivor.runCount, 0);
    assert.equal(survivor.pendingDelivery, null);
    assert.doesNotMatch(result.stderr, /Agent is already processing|stale after session replacement/);
  });
}

test("pi-scheduler-native delivers every recurring command result to an idle SDK session", { timeout: 20_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-scheduler-native-repeat-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const require = createRequire(join(globalPiPackage, "package.json"));
  const sdkEntry = join(globalPiPackage, "dist", "index.js");
  const aiEntry = join(globalPiPackage, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js");
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const ai = await import(pathToFileURL(aiEntry).href);
  const { createJiti } = require("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
    "@earendil-works/pi-coding-agent": sdkEntry,
    "@earendil-works/pi-ai": aiEntry,
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    typebox: require.resolve("typebox"),
  } });
  const { default: scheduler } = await jiti.import(indexFile);
  const core = require(coreFile);
  const statePath = join(home, "tasks.json");
  const store = core.createStateStore({ stateFile: statePath });
  const created = core.createTask({
    kind: "command", command: "printf REPEAT_DELIVERY_OK", repeat: "1s", maxRuns: 3,
    wakeOn: "always", shell: "D:\\Dev\\Git\\bin\\bash.exe", scope: "global", cwd: home,
  }, new Date("2020-01-01"));
  assert.equal(created.ok, true, created.error);
  store.updateSync(state => state.tasks.push(created.task));
  const originalFetch = globalThis.fetch;
  const savedStatePath = process.env.PI_SCHEDULER_NATIVE_STATE_FILE;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  let session;
  let calls = 0;
  const idleAtExec = [];
  const errors = [];
  globalThis.fetch = () => { throw new Error("network forbidden in scheduler regression"); };
  process.env.PI_SCHEDULER_NATIVE_STATE_FILE = statePath;
  process.env.PI_CODING_AGENT_DIR = home;
  try {
    const loader = new sdk.DefaultResourceLoader({
      cwd: home, agentDir: home, noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, extensionFactories: [pi => {
        const exec = pi.exec;
        pi.exec = (...args) => { idleAtExec.push(session.isIdle); return exec(...args); };
        scheduler(pi);
      }],
    });
    await loader.reload();
    const modelRuntime = await sdk.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false,
    });
    const model = {
      id: "offline", name: "Offline", api: "openai-responses", provider: "scheduler-fixture",
      baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1000,
    };
    modelRuntime.registerProvider(model.provider, {
      api: model.api, baseUrl: model.baseUrl, apiKey: "fixture", models: [model],
    });
    ({ session } = await sdk.createAgentSession({
      cwd: home, agentDir: home, model, modelRuntime, resourceLoader: loader, tools: [],
      sessionManager: sdk.SessionManager.inMemory(),
      settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    }));
    session.agent.streamFunction = () => {
      calls += 1;
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "offline" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = new ai.EventStream(event => event.type === "done", event => event.message);
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    };
    await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
    const deadline = Date.now() + 12_000;
    let saved;
    while (Date.now() < deadline) {
      saved = store.loadSync().tasks[0];
      if (saved.status === "done" && calls === 3 && session.isIdle) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const messages = session.sessionManager.getBranch().filter(entry =>
      entry.type === "custom_message" && entry.customType === "pi-scheduler");
    assert.deepEqual(errors, []);
    assert.deepEqual(idleAtExec, [true, true, true]);
    assert.equal(saved.runCount, 3);
    assert.equal(saved.status, "done", saved.lastError);
    assert.equal(saved.pendingDelivery, null);
    assert.equal(calls, 3, "each idle command result must wake the offline model");
    assert.equal(messages.length, 3);
    assert.equal(new Set(messages.map(entry => entry.details.deliveryId)).size, 3);
    assert.deepEqual(messages.map(entry => entry.details.runCount), [1, 2, 3]);
    for (const message of messages) assert.match(message.content, /stdout: REPEAT_DELIVERY_OK/);
    assert.equal(saved.lastDelivery.id, messages.at(-1).details.deliveryId);
  } finally {
    try {
      try {
        if (session) {
          try { await session.abort(); } finally { session.dispose(); }
        }
      } finally { ai.cleanupSessionResources(); }
    } finally {
      globalThis.fetch = originalFetch;
      if (savedStatePath === undefined) delete process.env.PI_SCHEDULER_NATIVE_STATE_FILE;
      else process.env.PI_SCHEDULER_NATIVE_STATE_FILE = savedStatePath;
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    }
  }
});

test("pi-scheduler-native executes a shell task through the configured shellPath in RPC mode", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-scheduler-native-rpc-shell-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, ".pi", "agent");
  const statePath = join(agentDir, "state", "pi-scheduler-native", "tasks.json");
  const sessionDir = join(home, "sessions");
  await mkdir(agentDir, { recursive: true });
  const configuredShell = "D:\\Dev\\Git\\bin\\bash.exe";
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ shellPath: configuredShell }, null, 2)}\n`);

  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  isolatedEnv[pathKey] = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  isolatedEnv.HOME = home;
  isolatedEnv.USERPROFILE = home;

  const child = spawn(
    process.execPath,
    [
      globalPiEntries.modular,
      "--mode",
      "rpc",
      "--no-extensions",
      "--extension",
      indexFile,
      "--session-dir",
      sessionDir,
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--offline",
    ],
    { cwd: projectRoot, env: isolatedEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  t.after(() => {
    if (!child.killed) child.kill();
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ id: "wake-shell-1", type: "prompt", message: "/wake-shell 1s :: printf SCHEDULER_RPC_SHELLPATH_OK" })}\n`);

  const deadline = Date.now() + 15_000;
  let task;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      task = state.tasks.find((candidate) => candidate.kind === "command");
      if (task?.status === "done" || task?.status === "failed") break;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.stdin.end();
  child.kill();
  assert.ok(task, `scheduled task did not persist; stderr=${stderr}`);
  assert.equal(task.status, "done", task.lastError || stderr);
  assert.equal(task.lastRun?.stdout, "SCHEDULER_RPC_SHELLPATH_OK");
  assert.equal(task.lastRun?.code, 0);
  assert.equal(task.lastRun?.shell, configuredShell);
});
