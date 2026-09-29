import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveDeclaredEntrypointByNames,
  resolveProjectRoot,
  resolveRealPath,
  rootContractError,
  sameRootPath,
} from "./consumer-root.mjs";
import {
  AUTHORIZATION_OVERRIDES,
  DISPATCH_PREPARE_SEED_FIELDS,
  DISPATCH_PREPARE_SEED_FIELD_TYPES,
  dispatchPrepareSeedArgs,
  dispatchPrepareTimeoutMessage,
  unknownSeedFields,
  unknownSeedFieldsMessage,
} from "../../../ops/tools/_dispatch-prepare-argv.mjs";

export const DISPATCH_PREPARE_TOOL_NAME = "dispatch_prepare";
export const DISPATCH_PREPARE_ACTIONS = Object.freeze(["list", "template", "preview", "submit"]);

const EFFORTS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// 未显式给运行根时按模块位置回到仓根/部署根，与 createDispatchPrepareCompiler 的默认一致。
const MODULE_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const DISPATCH_PREPARE_DESCRIPTION = "Dispatch background subagents. use list to discover a route, roles, picks and models (line text; format=json for every field; model_scope=all includes the current Pi model catalog; otherwise models come from picks or model notes); template shows applicable picks. Give at most one of pick/model, effort optional; omit both for capability default. Effort must be one of the model's selectable efforts; outside the pick row's range or with a model outside the role's picks, provide authorization with the user's quote and overrides. preview checks; submit launches.";
const ROUTE_INDEX_HEADING = "Routes (route_id — purpose):";

// 常驻短路由索引：读 route 注册目录里每张卡的 applies_to，与 task_package_profiles.mjs 同一批文件。
// 整体安装：任何一张卡缺失或读不到 applies_to 就不写索引，描述保持原文，路由发现继续走 list。
// 适配器不能 import ops/tools/dispatch-core：运行包正向清单明确排除该目录
// （tests/control_plane/test_pi_control_deploy.py 断言 runtime 包内无 dispatch-core），
// 所以这里保持零依赖；MCP 侧用 ops/tools/dispatch-core/route_index.mjs，两份读取由测试逐行比对。
const ROUTE_CARD_RE = /```json\s+route_card\s*\n([\s\S]*?)\n```/;

export function routeIndexLines(runtimeRoot) {
  try {
    const directory = path.join(runtimeRoot, "ops", "protocols", "task-package-routes");
    const names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    if (!names.length) return null;
    return names.map((name) => {
      const match = ROUTE_CARD_RE.exec(readFileSync(path.join(directory, name), "utf8"));
      const card = match ? JSON.parse(match[1]) : null;
      const appliesTo = typeof card?.applies_to === "string" ? card.applies_to.trim() : "";
      if (!appliesTo) throw new Error(`route card has no applies_to: ${name}`);
      return `${name.slice(0, -".md".length)} — ${appliesTo}`;
    });
  } catch {
    return null;
  }
}

const SEED_TEMPLATE_HINT = "render the skeleton with action=template";
const seedFieldDescriptions = {
  goal: "Task objective. Supply it for routes that require goal; action=template shows required fields and defaults.",
  scope: "Use read for inputs. Minimal route seeds use write_extra for task writes; full package_seed bodies use write. target_paths alone grants no access. Compiler-owned transport files are not task writes.",
  contract: "Route-specific work and deliverable requirements. Use the fields and enum values from action=template; model pick names are not contract values. Omit optional fields to use defaults.",
  known_facts: "Relevant facts supplied directly to the worker, rather than separate transport instructions.",
};
const seedSchema = Object.freeze({
  type: "object",
  description: "Minimal route seed (route_id plus route fields under contract) or full package_seed. Supply task facts here; the compiler creates task and transport files.",
  properties: Object.fromEntries(
    Object.entries(DISPATCH_PREPARE_SEED_FIELD_TYPES).map(([field, type]) => [field, {
      type,
      ...(seedFieldDescriptions[field] ? { description: seedFieldDescriptions[field] } : {}),
    }]),
  ),
  additionalProperties: false,
});

export { DISPATCH_PREPARE_SEED_FIELDS };

export const DISPATCH_PREPARE_SCHEMA = Object.freeze({
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: [...DISPATCH_PREPARE_ACTIONS], description: "list: routes and model choices; template: route seed; preview: validate without writes; submit: launch durable tasks." },
    route_id: { type: "string", minLength: 1, description: "Required for template; optional for list, where it lists only that route. For preview/submit put routes in each seed; a top-level duplicate is accepted only when it matches every seed.route_id." },
    format: { type: "string", enum: ["text", "json"], description: "list only: text (default) returns one line per role, capability, pick and model; json returns the same catalog with every field." },
    model_scope: { type: "string", enum: ["recommended", "all"], description: "仅 list：默认 recommended 列推荐行和笔记涉及的模型；all 同时列出当前 Pi 完整模型目录，并标注是否可用。" },
    seed: seedSchema,
    seeds: {
      type: "array",
      minItems: 1,
      // 用户账号的单批突发风险预算，不是提供商公布的限流或封禁阈值。
      maxItems: 24,
      description: "1..24 seeds per batch: user-account burst risk budget, not an official provider threshold.",
      items: seedSchema,
    },
    pick: { type: "string", minLength: 1, description: "推荐行 ID；与 model 至多给一个" },
    model: { type: "string", minLength: 1, description: "Pi 模型全名；与 pick 至多给一个。省略 effort 时沿用本能力适用的同模型推荐行" },
    authorization: { type: "object", required: ["quote", "overrides"], properties: { quote: { type: "string", minLength: 1 }, overrides: { type: "array", items: { type: "string", enum: [...AUTHORIZATION_OVERRIDES] } } }, additionalProperties: false, description: "用户本轮原话与本次解除项：effort_range（显式档位越出所在行范围）、outside_pool（模型不在本角色推荐行里）；须显式给 effort，只对本次 model + effort 生效" },
    effort: { type: "string", enum: [...EFFORTS], description: "请求档位；省略时用所选推荐行的档位。必须在模型可选档位内，越出所在行 [min–max] 需授权 effort_range。" },
    target_cwd: { type: "string", minLength: 1, description: "Worker working directory and target repository for scope validation; defaults to the current repository. Explicit scope.write/write_extra still defines task writes." },
    execution_profile: { type: "string", enum: ["standard", "simulation"], description: "standard runs the task normally; simulation uses the target-project acceptance profile." },
  },
  additionalProperties: false,
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertSeedFields(seed, label) {
  const unknown = unknownSeedFields(seed);
  if (unknown.length === 0) return;
  throw new TypeError(unknownSeedFieldsMessage(label, unknown, SEED_TEMPLATE_HINT));
}

function textResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") throw new TypeError("dispatch_prepare result must be serializable");
  return {
    content: [{ type: "text", text }],
    details: value,
  };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function structuredCompilerFailure(value) {
  if (!isRecord(value)) return null;
  if (isRecord(value.error)) return value.error;
  const status = String(value.status ?? "").toLowerCase();
  return (status === "error" || status === "failed") && typeof value.message === "string"
    ? value
    : null;
}

// 从混合文本(warning 前缀、多行 pretty JSON、多段对象)里抽出每个顶层 JSON 对象。
function extractJsonObjects(text) {
  const source = String(text || "");
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(source.slice(start, index + 1)));
        } catch {
          // Unbalanced or non-JSON braces inside plain text are not candidates.
        }
        start = -1;
      }
    }
  }
  return objects;
}

function parseCompilerFailure(text) {
  const failures = extractJsonObjects(text).map(structuredCompilerFailure).filter(Boolean);
  return failures.length > 0 ? failures[failures.length - 1] : null;
}

function compilerFailureError(stdout, stderr, code, closeSignal) {
  const details = parseCompilerFailure(stderr) ?? parseCompilerFailure(stdout);
  if (!details) {
    const text = stderr.trim() || stdout.trim() || `exit ${code}${closeSignal ? ` (${closeSignal})` : ""}`;
    return new Error(`dispatch_prepare compiler failed: ${text}`);
  }
  const rawMessage = typeof details.message === "string" && details.message.trim()
    ? details.message
    : "dispatch_prepare compiler failed";
  const message = rawMessage.replace(
    /node ops\/tools\/dispatch_prepare\.mjs --seed-template ([\w-]+)/g,
    (_match, routeId) => `dispatch_prepare({action:"template",route_id:"${routeId}"})`,
  );
  const error = new Error(message);
  error.name = "DispatchPrepareCompilerError";
  error.details = { ...details, message };
  for (const [field, value] of Object.entries(details)) {
    if (!["message", "name", "stack"].includes(field)) error[field] = value;
  }
  error.exit_code = code;
  if (closeSignal) error.signal = closeSignal;
  return error;
}

function sessionOrigin(ctx) {
  const sessionId = typeof ctx?.sessionManager?.getSessionId === "function"
    ? ctx.sessionManager.getSessionId()
    : ctx?.sessionId;
  return sessionId ? `pi-session:${String(sessionId)}` : "";
}

function validateRequest(params) {
  if (!isRecord(params)) throw new TypeError("dispatch_prepare requires an object request");
  const action = String(params.action || "");
  if (!DISPATCH_PREPARE_ACTIONS.includes(action)) {
    throw new TypeError(`dispatch_prepare action must be one of ${DISPATCH_PREPARE_ACTIONS.join(", ")}`);
  }
  const dispatchAction = ["preview", "submit"].includes(action);
  if (params.seed !== undefined && !isRecord(params.seed)) throw new TypeError("dispatch_prepare seed must be an object");
  if (params.seeds !== undefined && (!Array.isArray(params.seeds) || params.seeds.some(item => !isRecord(item)))) {
    throw new TypeError("dispatch_prepare seeds must be an array of objects");
  }
  // Discovery actions ignore task content; real dispatch still validates its fields.
  const hasSeed = dispatchAction && isRecord(params.seed);
  const hasSeeds = dispatchAction && Array.isArray(params.seeds);
  if (hasSeed && hasSeeds) throw new TypeError("dispatch_prepare accepts seed or seeds, not both");
  if (["preview", "submit"].includes(action) && !hasSeed && !hasSeeds) {
    throw new TypeError(`dispatch_prepare ${action} requires seed or seeds`);
  }
  if (params.format !== undefined && (action !== "list" || !["text", "json"].includes(params.format))) {
    throw new TypeError("dispatch_prepare format applies to list only and must be text or json");
  }
  if (params.model_scope !== undefined && (action !== "list" || !["recommended", "all"].includes(params.model_scope))) {
    throw new TypeError("model_scope 仅用于 list，取 recommended 或 all");
  }
  if (action === "template" && !String(params.route_id || "").trim()) {
    throw new TypeError("dispatch_prepare template requires route_id");
  }
  if (hasSeed) assertSeedFields(params.seed, "seed");
  if (hasSeeds) {
    if (params.seeds.length < 1 || params.seeds.length > 24) {
      throw new TypeError("dispatch_prepare seeds must contain 1..24 entries: 用户账号单批突发风险预算，非提供商官方阈值");
    }
    params.seeds.forEach((item, index) => {
      if (!isRecord(item)) throw new TypeError(`dispatch_prepare seeds[${index}] must be an object`);
      assertSeedFields(item, `seeds[${index}]`);
    });
  }
  if (dispatchAction && params.route_id !== undefined) {
    const seeds = hasSeeds ? params.seeds : [params.seed];
    const mismatch = seeds.findIndex(seed => seed.route_id !== params.route_id);
    if (mismatch !== -1) {
      const field = hasSeeds ? `seeds[${mismatch}].route_id` : "seed.route_id";
      throw new TypeError(`dispatch_prepare top-level route_id does not match ${field}; put each task's route in its seed`);
    }
  }
  const request = {
    ...params,
    action,
    input: hasSeeds ? params.seeds : (hasSeed ? params.seed : null),
  };
  if (dispatchAction) delete request.route_id;
  return request;
}

function runProcess(command, args, {
  cwd,
  env = undefined,
  input = "",
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new Error("dispatch_prepare compiler aborted")));
    };
    const append = (kind, chunk) => {
      if (settled) return;
      if (kind === "stdout") stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) {
        child.kill();
        finish(() => reject(new Error(`dispatch_prepare compiler output exceeded ${maxOutputBytes} bytes`)));
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, closeSignal) => finish(() => {
      if (code !== 0) {
        reject(compilerFailureError(stdout, stderr, code, closeSignal));
        return;
      }
      resolve({ stdout, stderr, code });
    }));

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener?.("abort", abort, { once: true });
    timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(dispatchPrepareTimeoutMessage(timeoutMs, stderr))));
    }, timeoutMs);
    timer.unref?.();
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") finish(() => reject(error));
    });
    child.stdin.end(input);
  });
}

function parseJson(stdout, action) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`dispatch_prepare ${action} returned invalid JSON: ${errorText(error)}`);
  }
}

// 装配双根：controlRoot 只是 runtimeRoot 的兼容别名；缺 projectRoot 在库层报 missing_project_root，
// 不回落常驻宿主 process.cwd。消费模式下项目根必须由调用方（会话 ctx.cwd）提供。
function resolveAssemblyRoots({
  controlRoot = null,
  runtimeRoot = null,
  projectRoot,
  cwd = undefined,
  mode = null,
  manifest = null,
  moduleRoot,
  label,
}) {
  if (controlRoot && runtimeRoot && !sameRootPath(controlRoot, runtimeRoot)) {
    throw rootContractError(
      "invalid_root_contract",
      `${label}: controlRoot conflicts with runtimeRoot; controlRoot is only a compatibility alias`,
    );
  }
  const declaredRuntime = controlRoot ?? runtimeRoot;
  const runtime = declaredRuntime ? resolveRealPath(declaredRuntime) : moduleRoot;
  const projectSource = projectRoot !== undefined ? projectRoot : cwd;
  if (projectSource === null) {
    throw rootContractError("missing_project_root", `${label} requires an explicit project root; refusing to fall back to process.cwd()`);
  }
  if (projectSource === undefined && (mode === "consumer" || manifest)) {
    throw rootContractError("missing_project_root", `${label} requires an explicit project root in consumer mode`);
  }
  return {
    runtimeRoot: runtime,
    // 开发/测试兼容：未显式给根时按调用进程目录，仅限非消费装配。
    projectRoot: resolveProjectRoot(projectSource === undefined ? process.cwd() : projectSource),
    manifest: manifest ?? null,
    consumer: Boolean(manifest),
  };
}

const PROJECT_ROOT_ENV = "SUBAGENT_PROJECT_ROOT";
const RUNTIME_ROOT_ENV = "SUBAGENT_RUNTIME_ROOT";

function childEnvironment({ projectRoot, runtimeRoot, env = process.env }) {
  return {
    ...env,
    [PROJECT_ROOT_ENV]: projectRoot,
    [RUNTIME_ROOT_ENV]: runtimeRoot,
  };
}

// 开发源码入口只在“项目就是运行根”（维护仓自用开发）或显式 controlRoot 时优先；
// 消费者项目里的旧 ops 副本不参与入口选择，默认用运行包里已声明的制品。
function developmentSourcePaths(roots, controlRoot, scriptName) {
  const runtimeSource = path.join(roots.runtimeRoot, "ops", "tools", scriptName);
  if (controlRoot) return [runtimeSource];
  if (sameRootPath(roots.projectRoot, roots.runtimeRoot)) {
    return [path.join(roots.projectRoot, "ops", "tools", scriptName), runtimeSource];
  }
  return [runtimeSource];
}

// 资产解析：消费模式只认 manifest 已声明入口，优先 ops/dist/<name>.bundle.mjs；
// 开发模式才允许显式开发根（项目 ops/tools 或运行包 ops/tools）里的同名脚本。
function resolveCliAsset({ roots, names, scriptName, defaults, devSourcePaths }) {
  if (roots.consumer) {
    return resolveDeclaredEntrypointByNames({
      names,
      runtimeRoot: roots.runtimeRoot,
      manifest: roots.manifest,
      defaults,
    });
  }
  for (const candidate of devSourcePaths ?? []) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const relative of defaults) {
    const candidate = path.join(roots.runtimeRoot, ...relative.split("/"));
    if (existsSync(candidate)) return candidate;
  }
  throw rootContractError(
    "missing_runtime_asset",
    `${scriptName} was not found under ${roots.runtimeRoot} and no consumer entrypoint declared it`,
  );
}

export function createDispatchPrepareCompiler({
  controlRoot = null,
  runtimeRoot = null,
  projectRoot,
  cwd = undefined,
  mode = null,
  manifest = null,
  env = process.env,
  nodePath = process.execPath,
  run = runProcess,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const moduleRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const roots = resolveAssemblyRoots({
    controlRoot,
    runtimeRoot,
    projectRoot,
    cwd,
    mode,
    manifest,
    moduleRoot,
    label: mode === "consumer" ? "consumer dispatch_prepare compiler" : "dispatch_prepare compiler",
  });
  const scriptPath = resolveCliAsset({
    roots,
    names: ["dispatch_prepare", "dispatchPrepare"],
    scriptName: "dispatch_prepare",
    defaults: ["ops/dist/dispatch_prepare.bundle.mjs"],
    // 显式 controlRoot 是既有覆盖项：只在该根找源码；否则只在项目即运行根时看项目源码。
    devSourcePaths: developmentSourcePaths(roots, controlRoot, "dispatch_prepare.mjs"),
  });
  const spawnEnv = childEnvironment({ projectRoot: roots.projectRoot, runtimeRoot: roots.runtimeRoot, env });
  return {
    scriptPath,
    runtimeRoot: roots.runtimeRoot,
    projectRoot: roots.projectRoot,
    mode: roots.consumer ? "consumer" : "development",
    async execute(request, { signal } = {}) {
      const normalized = validateRequest(request);
      let args;
      let input = "";
      const listFormat = normalized.format === "text" ? "text" : "json";
      if (normalized.action === "list") {
        args = [scriptPath, "--list", "--format", listFormat];
        if (normalized.model_scope) args.push("--model-scope", normalized.model_scope);
        if (normalized.route_id) args.push("--route-id", String(normalized.route_id));
      } else if (normalized.action === "template") {
        args = [scriptPath, "--seed-template", String(normalized.route_id)];
      } else {
        args = dispatchPrepareSeedArgs(
          scriptPath,
          normalized.action === "submit" ? "prepare" : "preview",
          normalized,
        );
        input = `${JSON.stringify(normalized.input)}\n`;
      }
      const result = await run(nodePath, args, { cwd: roots.projectRoot, env: spawnEnv, input, signal, timeoutMs });
      if (normalized.action === "list" && listFormat === "text") {
        return { status: "ok", action: "list", format: "text", text: result.stdout };
      }
      if (normalized.action === "template") {
        return {
          status: "ok",
          action: "template",
          route_id: String(normalized.route_id),
          template: result.stdout,
        };
      }
      return parseJson(result.stdout, normalized.action);
    },
  };
}

export function createAgentPanelEnsurer({
  controlRoot = null,
  runtimeRoot = null,
  projectRoot,
  cwd = undefined,
  mode = null,
  manifest = null,
  env = process.env,
  nodePath = process.execPath,
  run = runProcess,
} = {}) {
  const moduleRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const roots = resolveAssemblyRoots({
    controlRoot,
    runtimeRoot,
    projectRoot,
    cwd,
    mode,
    manifest,
    moduleRoot,
    label: mode === "consumer" ? "consumer Agent Panel ensurer" : "Agent Panel ensurer",
  });
  const spawnEnv = childEnvironment({ projectRoot: roots.projectRoot, runtimeRoot: roots.runtimeRoot, env });
  // 与旧行为一致：工厂期不要求面板入口存在，调用期才解析（提交后失败只记 post_submit_failures）。
  return async function ensureAgentPanel() {
    const scriptPath = resolveCliAsset({
      roots,
      names: ["agent_panel_launcher", "agentPanelLauncher"],
      scriptName: "agent_panel_launcher",
      defaults: ["ops/dist/agent_panel_launcher.bundle.mjs"],
      devSourcePaths: developmentSourcePaths(roots, controlRoot, "agent_panel_launcher.mjs"),
    });
    const result = await run(nodePath, [scriptPath], {
      cwd: roots.projectRoot,
      env: spawnEnv,
      timeoutMs: 60 * 1000,
    });
    return parseJson(result.stdout, "agent-panel-launch");
  };
}

function preparedEntries(preparation) {
  if (Array.isArray(preparation?.dispatches)) {
    return preparation.dispatches.filter((item) => item?.status !== "failed" && item?.dispatch_file);
  }
  return preparation?.dispatch_file ? [preparation] : [];
}

function pathPointers(preparation) {
  const businessOutput = isRecord(preparation?.business_output) ? preparation.business_output : {};
  const expectedOutput = isRecord(businessOutput.expected_output) ? businessOutput.expected_output : {};
  const handoffContract = isRecord(businessOutput.handoff_contract) ? businessOutput.handoff_contract : {};
  return {
    task_package_path: preparation?.task_package_path ?? preparation?.package_file ?? null,
    report_path: preparation?.report_path
      ?? businessOutput.expected_report_path
      ?? expectedOutput.resolved_file_path
      ?? null,
    handoff_path: preparation?.handoff_path
      ?? businessOutput.expected_handoff_path
      ?? handoffContract.resolved_handoff_file
      ?? null,
  };
}

function normalizedPostSubmitFailures(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((failure) => ({
      step: String(failure.step || "unknown"),
      error: String(failure.error || "unknown post-submit failure"),
    }));
}

function withPostSubmitFailures(receipt, failures) {
  const combined = [
    ...normalizedPostSubmitFailures(receipt?.post_submit_failures),
    ...normalizedPostSubmitFailures(failures),
  ];
  if (combined.length === 0) return receipt;
  return { ...receipt, post_submit_failures: combined };
}

function compactPreview(preparation) {
  if (Array.isArray(preparation?.dispatches)) {
    return {
      status: preparation.status,
      action: "preview",
      batch_id: preparation.batch_id ?? null,
      dispatches: preparation.dispatches.map((entry, index) => ({ ...compactPreview(entry), seed_index: entry.seed_index ?? index + 1 })),
      ...(preparation.failed_seed_indexes ? { failed_seed_indexes: preparation.failed_seed_indexes } : {}),
      ...(preparation.not_submitted_seed_indexes ? { not_submitted_seed_indexes: preparation.not_submitted_seed_indexes } : {}),
    };
  }
  const asyncPreview = isRecord(preparation?.async_preview) ? preparation.async_preview : {};
  const status = preparation?.status ?? "failed";
  return {
    status,
    action: "preview",
    ...(status !== "ok" ? { error: String(preparation?.error ?? "dispatch_prepare preview failed") } : {}),
    package_id: preparation?.package_id ?? null,
    ...(preparation?.warnings?.length ? { warnings: preparation.warnings } : {}),
    display_title: preparation?.display_title ?? null,
    delivery_mode: preparation?.would_delivery_mode ?? preparation?.resolved_delivery ?? null,
    model: asyncPreview.model ?? null,
    effort: asyncPreview.effort ?? null,
    selection: asyncPreview.selection ?? null,
    selection_summary: preparation?.selection_summary ?? null,
    ...pathPointers(preparation),
    validation: {
      delivery_readiness: preparation?.delivery_readiness ?? null,
      scope_preflight: preparation?.scope_preflight ?? null,
      child_model: asyncPreview.child_model ?? null,
    },
    writes_performed: Array.isArray(preparation?.writes_performed) ? [...preparation.writes_performed] : [],
  };
}

function compactSubmitted(entry, receipt) {
  const compact = {
    task_id: receipt?.task_id ?? null,
    revision: receipt?.revision ?? null,
    model: receipt?.model ?? null,
    effort: receipt?.effort ?? null,
    model_source: receipt?.model_source ?? "unknown",
    effort_source: receipt?.effort_source ?? "unknown",
    selection: entry?.async_model_selection?.selection ?? receipt?.selection ?? null,
    selection_summary: entry?.selection_summary ?? receipt?.selection_summary ?? null,
    status: receipt?.state ?? receipt?.transport_state,
    display_title: receipt?.display_title ?? entry?.display_title ?? null,
    dispatch_file: entry?.dispatch_file ?? null,
    ...pathPointers(entry),
  };
  const warnings = [...new Set([...(entry?.warnings || []), ...(receipt?.warnings || []), entry?.async_model_selection?.child_model?.warning].filter(Boolean))];
  if (warnings.length) compact.warnings = warnings;
  return withPostSubmitFailures(compact, receipt?.post_submit_failures);
}

function compactFailedDispatch(entry, error = null) {
  const compact = {
    ...(Number.isInteger(entry?.seed_index) ? { seed_index: entry.seed_index } : {}),
    status: entry?.status === "not_submitted" ? "not_submitted" : "failed",
    error: String(error ?? entry?.error ?? "dispatch was not submitted"),
  };
  if (entry?.dispatch_file) compact.dispatch_file = entry.dispatch_file;
  return compact;
}

async function submitPrepared(preparation, service) {
  const entries = preparedEntries(preparation);
  if (entries.length === 0) {
    if (!Array.isArray(preparation?.dispatches)) {
      return {
        task_id: null,
        status: preparation?.status || "failed",
        error: String(preparation?.error ?? "dispatch_prepare produced nothing to submit"),
        display_title: preparation?.display_title ?? null,
        dispatch_file: preparation?.dispatch_file ?? null,
        ...pathPointers(preparation),
      };
    }
    const dispatches = preparation.dispatches.map((entry) => compactFailedDispatch(entry));
    return {
      status: "failed",
      batch_id: preparation?.batch_id ?? null,
      dispatches,
      committed_task_ids: [],
      failed_seed_indexes: Array.isArray(preparation?.failed_seed_indexes)
        ? [...preparation.failed_seed_indexes]
        : dispatches.filter((entry) => entry.status === "failed")
          .map((entry) => entry.seed_index).filter(Number.isInteger),
      ...(Array.isArray(preparation?.not_submitted_seed_indexes)
        ? { not_submitted_seed_indexes: [...preparation.not_submitted_seed_indexes] }
        : {}),
    };
  }

  const submitted = [];
  const failed = [];
  for (const entry of entries) {
    try {
      const receipt = await service.submitPrepared({ dispatch_file: entry.dispatch_file });
      submitted.push({ entry, receipt });
    } catch (error) {
      failed.push({ entry, error: errorText(error) });
    }
  }

  if (!Array.isArray(preparation?.dispatches)) {
    if (failed.length > 0) {
      throw new Error(`dispatch_prepare submit failed after preparation ${preparation.dispatch_file}: ${failed[0].error}`);
    }
    return compactSubmitted(submitted[0].entry, submitted[0].receipt);
  }

  const byFile = new Map(submitted.map((item) => [item.entry.dispatch_file, item.receipt]));
  const errorsByFile = new Map(failed.map((item) => [item.entry.dispatch_file, item.error]));
  const dispatches = preparation.dispatches.map((entry) => {
    const receipt = byFile.get(entry?.dispatch_file);
    if (receipt) return compactSubmitted(entry, receipt);
    return compactFailedDispatch(entry, errorsByFile.get(entry?.dispatch_file));
  });
  const committedTaskIds = submitted
    .map((item) => item.receipt?.task_id)
    .filter((taskId) => typeof taskId === "string" && taskId.length > 0);
  const uncommittedDispatches = dispatches.filter((item) => item?.status !== "queued");
  const failedSeedIndexes = [...new Set([
    ...(Array.isArray(preparation?.failed_seed_indexes) ? preparation.failed_seed_indexes : []),
    ...dispatches.filter((item) => item?.status === "failed")
      .map((item) => item.seed_index)
      .filter((index) => Number.isInteger(index)),
  ])].sort((left, right) => left - right);
  return {
    status: uncommittedDispatches.length > 0 ? (committedTaskIds.length > 0 ? "partial" : "failed") : "queued",
    batch_id: preparation?.batch_id ?? null,
    dispatches,
    committed_task_ids: committedTaskIds,
    failed_seed_indexes: failedSeedIndexes,
    ...(Array.isArray(preparation?.not_submitted_seed_indexes)
      ? { not_submitted_seed_indexes: [...preparation.not_submitted_seed_indexes] }
      : {}),
  };
}

export function createDispatchPrepareTool({
  service,
  compiler = createDispatchPrepareCompiler(),
  onSubmitted = null,
} = {}) {
  if (!service || typeof service.submitPrepared !== "function") {
    throw new TypeError("createDispatchPrepareTool requires an AsyncTaskService");
  }
  if (!compiler || typeof compiler.execute !== "function") {
    throw new TypeError("createDispatchPrepareTool requires a compiler");
  }
  // 索引落在模型可见的工具体描述里，与编译器同一运行根；缺项或读不到时不写部分索引（审查 R1 F1）。
  const indexLines = routeIndexLines(compiler.runtimeRoot ?? MODULE_ROOT);
  const description = indexLines
    ? `${DISPATCH_PREPARE_DESCRIPTION}\n${ROUTE_INDEX_HEADING}\n${indexLines.join("\n")}`
    : DISPATCH_PREPARE_DESCRIPTION;
  return {
    name: DISPATCH_PREPARE_TOOL_NAME,
    label: "Dispatch Prepare",
    description,
    promptSnippet: "Delegate tasks to background workers",
    parameters: DISPATCH_PREPARE_SCHEMA,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const request = validateRequest(params);
      if (request.action === "list" && request.format === undefined) request.format = "text";
      const originId = sessionOrigin(ctx);
      const preparation = await compiler.execute(
        originId ? { ...request, origin_id: originId } : request,
        { signal },
      );
      if (request.action === "list") {
        return preparation?.format === "text" ? textResult(preparation.text) : textResult(preparation);
      }
      if (request.action === "preview") return textResult(compactPreview(preparation));
      if (request.action !== "submit") return textResult(preparation);
      let result = await submitPrepared(preparation, service);
      const taskIds = Array.isArray(result.committed_task_ids)
        ? result.committed_task_ids
        : (result.task_id ? [result.task_id] : []);
      if (taskIds.length > 0 && typeof onSubmitted === "function") {
        try {
          const sideEffects = await onSubmitted({ task_ids: taskIds, result, ctx });
          result = withPostSubmitFailures(result, sideEffects?.post_submit_failures);
          if (sideEffects?.agent_panel_launch) result.agent_panel_launch = sideEffects.agent_panel_launch;
        } catch (error) {
          result = withPostSubmitFailures(result, [{ step: "on_submitted", error: errorText(error) }]);
        }
      }
      return textResult(result);
    },
  };
}
