import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { resolveDeclaredEntrypointByNames } from "./consumer-root.mjs";
import {
  WORK_TEXT, createDelegateWorkCore, createWorkStore, workBranchBinding, workBranchBindings,
} from "./delegate-work-core.mjs";

export const DELEGATE_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const DELEGATE_PICKS = ["luna_xhigh", "luna_max", "sol_high"];
export const delegateWorkParameters = {
  type: "object", required: ["goal"], additionalProperties: false,
  properties: {
    goal: { type: "string", minLength: 1, description: "交给分身的明确目标" },
    pick: { type: "string", description: "三档推荐之一（luna_xhigh / luna_max / sol_high）；与 model 互斥；省略且不指定 model 时使用 luna_xhigh" },
    model: { type: "string", minLength: 1, description: "完整 provider/model；必须与 effort 同时给出；与 pick 互斥；不限于分身推荐池，也不受推荐行档位范围约束，只校验 effort 在该模型可选档位内；来源运行时必须能解析该模型" },
    effort: { type: "string", enum: DELEGATE_EFFORTS, description: "与 model 同时给出才是显式选型，须在该模型可选档位内；只填 effort 会报错并列出三档。与 pick 同填时覆盖该推荐档位" },
  },
};
const choiceText = () => DELEGATE_PICKS.join(", ");
function selectionError(message) {
  const error = new Error(`${message} Choices: ${choiceText()}.`);
  error.alternatives = [...DELEGATE_PICKS];
  return error;
}
function sourcePackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

const HOST_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

function framePath(fileName) {
  if (!fileName || fileName.startsWith("node:")) return null;
  try {
    return fileName.startsWith("file:") ? fileURLToPath(fileName) : fileName;
  } catch {
    return null;
  }
}

function packageRootFromFile(filePath) {
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, "utf8")).name === HOST_SDK_PACKAGE) return dir;
      } catch { /* keep walking; a nearby package.json is not the host SDK */ }
    }
    dir = path.dirname(dir);
  }
  return null;
}

function pushEntry(entries, entry) {
  if (!entry || !existsSync(entry)) return;
  const resolved = realpathSync(entry);
  if (!entries.includes(resolved)) entries.push(resolved);
}

/** Synchronous probe: the host getAllTools stack names the loaded SDK file. Restore before yielding. */
function captureHostSdkFiles(pi) {
  if (typeof pi?.getAllTools !== "function") return [];
  const original = Map.prototype.values;
  const files = [];
  Map.prototype.values = function valuesProbe(...args) {
    if (files.length === 0) {
      const previous = Error.prepareStackTrace;
      Error.prepareStackTrace = (_, frames) => frames;
      const frames = new Error().stack;
      Error.prepareStackTrace = previous;
      for (const frame of frames ?? []) {
        const file = framePath(frame.getFileName());
        if (file) files.push(file);
      }
    }
    return original.apply(this, args);
  };
  try {
    pi.getAllTools();
  } catch {
    // Runtime not bound yet; execute retries after session_start.
  } finally {
    Map.prototype.values = original;
  }
  return files;
}

function hostSdkError(cliPath, tried) {
  const shown = cliPath ? path.basename(cliPath) : "(missing)";
  const attempted = tried.length ? ` Tried ${tried.join(", ")}.` : "";
  return new Error(`Cannot locate the host Pi SDK from the active extension runtime; argv[1] is ${shown}, not cli.js.${attempted} Inject sdk and sourceSession from the same @earendil-works/pi-coding-agent module that created this session, then retry delegate_work.`);
}

export function hostSdkEntries(cliPath = process.argv[1], pi = null) {
  const entries = [];
  if (cliPath && path.basename(cliPath) === "cli.js") {
    pushEntry(entries, path.join(path.dirname(cliPath), "index.js"));
  }
  if (!pi) return entries;
  for (const file of captureHostSdkFiles(pi)) {
    const root = packageRootFromFile(file);
    if (!root) continue;
    const bundled = file.replaceAll("\\", "/").includes("/dist/bundle/");
    const ordered = bundled
      ? [path.join(root, "dist", "bundle", "index.js"), path.join(root, "dist", "index.js")]
      : [path.join(root, "dist", "index.js"), path.join(root, "dist", "bundle", "index.js")];
    for (const entry of ordered) pushEntry(entries, entry);
  }
  return entries;
}

export async function loadHostPiSdk(cliPath = process.argv[1], options = {}) {
  const pi = options?.pi ?? null;
  const entries = hostSdkEntries(cliPath, pi);
  const tried = [];
  let lastError = null;
  for (const entry of entries) {
    tried.push(entry);
    let sdk;
    try {
      sdk = await import(pathToFileURL(entry).href);
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!sdk?.ModelRuntime || !sdk?.AgentSession) {
      lastError = new Error(`Host SDK at ${entry} lacks ModelRuntime/AgentSession; inject the matching host sdk, not another copy.`);
      continue;
    }
    if (!pi) return sdk;
    try {
      captureSourceSession(pi, sdk);
      return sdk;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? hostSdkError(cliPath, tried);
}

/** Pi 0.86 compatibility seam. Synchronous call only: never yield while the prototype is patched. */
export function captureSourceSession(pi, sdk) {
  const prototype = sdk.AgentSession.prototype;
  const original = prototype.getAllTools;
  let source;
  try {
    prototype.getAllTools = function (...args) { source = this; return original.apply(this, args); };
    pi.getAllTools();
  } finally { prototype.getAllTools = original; }
  if (!source) throw new Error("Pi source capture failed; inject the active sourceSession and matching SDK.");
  return source;
}

export function nativeWorkSource(session) {
  return {
    session,
    sessionManager: session.sessionManager,
    id: session.sessionManager.getSessionId(),
    entries: () => session.sessionManager.getEntries(),
    isIdle: () => session.isIdle,
    // Direct SDK Promise + transcript acknowledgement, not fire-and-forget pi.sendMessage enqueue.
    deliver: message => session.sendCustomMessage(message, { deliverAs: "followUp", triggerTurn: true }),
  };
}

const resultSchema = {
  type: "object", additionalProperties: false,
  required: ["status", "summary", "evidence", "residuals"],
  properties: {
    status: { type: "string", enum: ["completed", "needs_decision", "failed"] },
    summary: { type: "string", minLength: 1 },
    evidence: { type: "array", items: { type: "string" } },
    residuals: { type: "array", items: { type: "string" } },
    next_step: { type: "string" },
  },
};
export function createSubmitWorkResultTool(binding) {
  return {
    name: "submit_work_result", label: "Submit Work Result", description: WORK_TEXT.submit,
    // 不设 promptSnippet 就不进系统提示词的工具清单；交付类工具另加点名 guideline。
    promptSnippet: "Submit this delegated work's result; this is how the work is delivered",
    promptGuidelines: ["When the delegated work is finished, deliver it by calling submit_work_result; submit_work_result is a tool call, not a shell command."],
    parameters: resultSchema, executionMode: "sequential",
    async execute(_id, result) {
      const receipt = await binding.submit(result);
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt, terminate: true };
    },
  };
}

/** Rebuild factories, never copy extension tool definitions or share a provider runtime. */
export function createNativeBranchFactory({ sdk, rebuildResourceLoader = null, rebuildCustomTools = null, createModelRuntime = null } = {}) {
  if (!sdk?.ModelRuntime || !sdk?.DefaultResourceLoader) throw new Error("Pi 0.86 SDK is required for native delegate_work.");
  return async ({ record, source, store, binding, resume }) => {
    const parent = source.session;
    const cwd = parent.sessionManager.getCwd();
    const agentDir = parent.resourceLoader.agentDir;
    let manager, session;
    const branchFile = record.session_file ?? path.join(store.root, `${record.work_id}.session.jsonl`);
    if (resume) {
      if (!existsSync(branchFile)) throw new Error(`Saved branch missing: ${branchFile}; restore its file rather than opening an empty session.`);
      manager = sdk.SessionManager.open(branchFile);
    } else {
      // Persist even a first-turn branch with no assistant. Opening a not-yet-created SDK fork loses context.
      mkdirSync(store.root, { recursive: true });
      const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd,
        parentSession: parent.sessionManager.getSessionFile() };
      writeFileSync(branchFile, [header, ...(record.branch_entries ?? [])].map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" });
      manager = sdk.SessionManager.open(branchFile);
      record.branch_entries = undefined;
    }
    record.session_file = branchFile;
    // Persist inherited ids before createAgentSession/setModel so a later establishment failure can resume this file.
    if (!record.inherited_entry_ids?.length) {
      record.inherited_entry_ids = manager.getEntries().map(entry => entry.id);
    }
    store.save(record);
    workBranchBindings.set(manager.getSessionId(), binding);
    const monitorFactory = pi => {
      pi.registerTool(createSubmitWorkResultTool(binding));
      pi.on("agent_settled", () => binding.settled());
      pi.on("tool_call", () => binding.active ? undefined : { block: true, terminate: true, reason: "This work execution is stopped; resume it from the originating session." });
    };
    try {
      const resourceLoader = rebuildResourceLoader
        ? await rebuildResourceLoader({ source: parent, monitorFactory })
        : (() => {
          if (!(parent.resourceLoader instanceof sdk.DefaultResourceLoader)) {
            throw new Error("Custom ResourceLoader requires rebuildResourceLoader; cannot silently replace source capabilities.");
          }
          return new sdk.DefaultResourceLoader({ ...parent.resourceLoader,
            extensionFactories: [...(parent.resourceLoader.extensionFactories ?? []), monitorFactory] });
        })();
      await resourceLoader.reload();
      const errors = resourceLoader.getExtensions().errors;
      if (errors.length) throw new Error(`Branch extension rebuild failed: ${errors.map(error => `${error.path}: ${error.error}`).join("; ")}; repair the listed factory and retry.`);
      const modelRuntime = createModelRuntime ? await createModelRuntime(parent)
        : await sdk.ModelRuntime.create({ credentials: parent.modelRuntime.credentials,
          modelsPath: parent.modelRuntime.modelsPath ?? null, allowModelNetwork: false });
      if (modelRuntime === parent.modelRuntime) throw new Error("Branch ModelRuntime must be independent to avoid parent provider callback rebinding.");
      const customTools = rebuildCustomTools ? await rebuildCustomTools(parent)
        : (parent._customTools ?? []).filter(tool => tool.name !== "submit_work_result");
      session = (await sdk.createAgentSession({ cwd, agentDir, settingsManager: parent.settingsManager,
        modelRuntime, resourceLoader, sessionManager: manager, customTools,
        scopedModels: parent.scopedModels,
      })).session;
      await session.bindExtensions({ uiContext: parent._extensionUIContext, mode: parent._extensionMode,
        onError: error => { record.last_extension_error = String(error?.error ?? error); store.save(record); } });
      const missing = parent.getAllTools().filter(tool => !session.getAllTools().some(item => item.name === tool.name));
      if (missing.length) throw new Error(`Branch is missing source tools: ${missing.map(tool => tool.name).join(", ")}; rebuild the owning factories.`);
      // 分身自己准备、派叶、跟进与交接；不再开分身，否则嵌套 work 会重复注册 submit_work_result。
      session.setActiveToolsByName([...new Set([...parent.getActiveToolNames().filter(name => name !== "delegate_work"), "submit_work_result"])]);
      const selection = record.selection;
      if (!selection?.provider || !selection.model_id || !selection.effort) {
        throw new Error("Saved delegate selection is missing; retry from the source with model and effort together.");
      }
      const model = modelRuntime.getModel(selection.provider, selection.model_id);
      if (!model) throw new Error(`Saved delegate model ${selection.provider}/${selection.model_id} is unavailable; restore the model and retry resume from source.`);
      await session.setModel(model, { persist: false });
      session.setThinkingLevel(selection.effort, { persist: false });
      if (session.model?.provider !== selection.provider || session.model?.id !== selection.model_id || session.thinkingLevel !== selection.effort) {
        throw new Error(`Saved selection ${selection.provider}/${selection.model_id} @${selection.effort} was not applied (runtime reports ${session.model?.provider}/${session.model?.id} @${session.thinkingLevel}); restore that model and retry resume from source.`);
      }
      let stopped = false;
      return {
        session, sessionFile: manager.getSessionFile(), inheritedIds: record.inherited_entry_ids,
        entries: () => manager.getEntries(), isIdle: () => session.isIdle,
        async prompt(text) {
          await session.prompt(text, { expandPromptTemplates: false });
          const last = [...session.messages].reverse().find(message => message.role === "assistant");
          if (last?.stopReason === "error") throw new Error(`${last.errorMessage ?? "Provider request failed"}; verify the branch provider/model credentials and retry resume from the source.`);
        },
        async stop() {
          if (stopped) return;
          // Emit full extension shutdown (dispose alone does not close watchers), then abort SDK activity.
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          await session.abort();
          if (!session.isIdle) throw new Error("SDK branch has not stopped; inspect active tools before retrying pause.");
          stopped = true;
        },
        dispose() { session.dispose(); workBranchBindings.delete(manager.getSessionId()); },
      };
    } catch (error) {
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await session.abort(); session.dispose();
      }
      workBranchBindings.delete(manager.getSessionId());
      throw error;
    }
  };
}

const coresKey = Symbol.for("control-plane.delegate-work.native-cores.v1");
const cores = globalThis[coresKey] ??= new Map();

export function installDelegateWork(pi, { sdk = null, sourceSession = null, core = null, storeRoot = null,
  branchFactory = null, onAccepted = () => {}, onError = () => {}, resolveDelegateSelection = null,
  runtimeRoot = null, projectRoot = null, manifest = null, registerSessionStart = true, ...factoryOptions } = {}) {
  async function spawnSelectionBridge({ pick, model, effort }) {
    const runtime = runtimeRoot || sourcePackageRoot();
    const project = projectRoot || currentSource?.session?.sessionManager?.getCwd?.() || runtime;
    if (!runtime || !project) throw selectionError("delegate_work selection needs the assembled runtime and project roots.");
    const script = resolveDeclaredEntrypointByNames({
      names: ["delegate_work_selection"], runtimeRoot: runtime, manifest,
      defaults: ["ops/dist/delegate_work_selection.bundle.mjs"],
    });
    const response = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, SUBAGENT_RUNTIME_ROOT: runtime, SUBAGENT_PROJECT_ROOT: project },
      });
      const timer = setTimeout(() => child.kill(), 20000);
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", text => { stdout += text; if (stdout.length > 65536) child.kill(); });
      child.stderr.on("data", text => { stderr += text; if (stderr.length > 65536) child.kill(); });
      child.on("error", reject);
      child.on("close", code => {
        clearTimeout(timer);
        let result;
        try { result = JSON.parse(stdout); }
        catch { reject(selectionError(`delegate_work selection bridge returned invalid JSON (exit ${code}): ${stderr || stdout}`)); return; }
        if (code !== 0 || result.error) {
          reject(selectionError(result.error?.message ?? (stderr || "delegate_work selection failed")));
        } else resolve(result);
      });
      child.stdin.end(JSON.stringify({ pick, model, effort }));
    });
    return response;
  }
  let currentCore = core, currentSource = null, timer = null;
  let readyTimer = null, deliveryReady = true;
  let initialization = null;
  async function initialize() {
    if (currentSource && currentCore) return currentCore;
    if (initialization) return initialization;
    initialization = (async () => {
      const hostSdk = sdk ?? await loadHostPiSdk(process.argv[1], { pi });
      const session = typeof sourceSession === "function" ? sourceSession() : sourceSession ?? captureSourceSession(pi, hostSdk);
      currentSource = nativeWorkSource(session);
      const sourceIdle = currentSource.isIdle;
      currentSource.isIdle = () => deliveryReady && sourceIdle();
      const root = storeRoot ?? path.join(session.sessionManager.getCwd(), ".runtime", "delegate-work", currentSource.id);
      currentCore = core ?? cores.get(root);
      if (!currentCore) {
        currentCore = createDelegateWorkCore({ store: createWorkStore(root), source: currentSource,
          branchFactory: branchFactory ?? createNativeBranchFactory({ sdk: hostSdk, ...factoryOptions }), onError });
        cores.set(root, currentCore);
      }
      currentCore.attachSource(currentSource);
      return currentCore;
    })();
    try { return await initialization; } finally { initialization = null; }
  }
  const resolveSelection = resolveDelegateSelection ?? spawnSelectionBridge;
  pi.registerTool({ name: "delegate_work", label: "Delegate Work", description: WORK_TEXT.delegate,
    promptSnippet: "Delegate a goal asynchronously; default luna_xhigh, or pick luna_max/sol_high, or give model and effort together",
    parameters: delegateWorkParameters,
    executionMode: "sequential",
    async execute(_id, params) {
      // pick 不用 schema enum：入口 enum 的报错不带可选档，这里统一报出三档。
      if (params.pick && !DELEGATE_PICKS.includes(params.pick)) throw selectionError(`Unknown pick ${params.pick}.`);
      const service = await initialize();
      if (params.pick && params.model) throw selectionError("Choose pick or model, not both.");
      if ((params.model && !params.effort) || (params.effort && !params.model && !params.pick)) {
        throw selectionError("model and effort must be given together.");
      }
      const { selection } = await resolveSelection({ pick: params.pick, model: params.model, effort: params.effort });
      const available = currentSource.session.modelRuntime.getModel(selection.provider, selection.model_id);
      if (!available) throw selectionError(`Selected model ${selection.provider}/${selection.model_id} is unavailable in the source runtime.`);
      const receipt = await service.delegate({ goal: params.goal, selection });
      onAccepted(receipt);
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
    },
  });
  const startSession = async (_event, ctx) => {
    // A work branch reloads source factories. Do not treat that session as a new delegate source.
    const branchId = ctx?.sessionManager?.getSessionId?.();
    if (branchId && workBranchBinding(branchId)) return;
    try {
      // Recovery may enqueue a turn. resources_discover follows the complete SDK session_start dispatch.
      deliveryReady = false;
      await initialize();
      timer ??= setInterval(() => { void currentCore?.flush(); }, 1000);
      timer.unref?.();
    } catch (error) { onError(error); }
  };
  if (registerSessionStart) pi.on("session_start", startSession);
  pi.on("resources_discover", () => {
    if (!currentSource) return;
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => { deliveryReady = true; void currentCore?.flush(); }, 0);
    readyTimer.unref?.();
  });
  pi.on("agent_settled", () => { void currentCore?.flush(); });
  pi.on("message_end", (event, ctx) => {
    currentCore?.acknowledge?.(event.message, ctx.sessionManager.getSessionId());
  });
  pi.on("session_shutdown", async event => {
    clearInterval(timer); timer = null;
    clearTimeout(readyTimer); readyTimer = null;
    deliveryReady = false;
    currentCore?.detachSource();
    if (event?.reason === "quit") await currentCore?.close();
    currentSource = null;
  });
  return {
    startSession,
    get core() { return currentCore; },
    wrapControl(tool) {
      // Submitted delegate results live in the source-owned snapshot, not the cockpit registry.
      const method = {
        subagent_get: "get", subagent_result: "get", subagent_pause: "pause",
        subagent_resume: "resume", subagent_cancel: "cancel",
      }[tool.name];
      if (!method) return tool;
      const workResult = tool.name === "subagent_result"
        ? "work_id 返回来源会话持有的工作快照：已提交结果在 results[]，evidence 是分身提交的引用，未做产物存在性检查；未提交时 results 为空。"
        : "";
      return { ...tool, description: `${tool.description}\n也接受 task_id=delegate_work 返回的 work_id；控制动作沿用 expected_revision CAS，待决续跑自动带回来源新增文字。${workResult}`,
        async execute(...args) {
          const input = args[1];
          if (!String(input?.task_id ?? "").startsWith("work-")) return tool.execute(...args);
          const service = await initialize();
          const receipt = await service[method](input);
          return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
        },
      };
    },
  };
}
