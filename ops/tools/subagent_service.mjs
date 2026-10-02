#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { selectionSummary } from "./dispatch-core/model_selection_guidance.mjs";
import { FAST_MODE_DESCRIPTION, fastModeSeed } from "./pi_fast_mode.mjs";
import { normalizePauseReceipt, pauseRejection, PAUSE_TOOL_DESCRIPTION, RESUME_TOOL_DESCRIPTION } from "./pause-surface.mjs";
import {
  AUTHORIZATION_OVERRIDES,
  DISPATCH_PREPARE_SEED_FIELD_TYPES,
  dispatchPrepareSeedArgs,
  dispatchPrepareTimeoutMessage,
  unknownSeedFieldsMessage,
} from "./_dispatch-prepare-argv.mjs";
import { ensureDir, pick, pickCsv } from "./_fs-utils.mjs";
// 常驻短路由索引：与 route 注册同源，只读 route_card 的 applies_to，不复制角色/模型表。
import { withRouteIndex } from "./dispatch-core/route_index.mjs";
import { LineJsonRpcClient, notificationWaitFailureType } from "./_stdio-jsonrpc.mjs";
import {
  createFleetCore,
  FLEET_DECISIONS,
  FLEET_TOOL_NAMES,
  FLEET_WAIT_MS_MAX,
  FLEET_WAIT_MS_MIN,
} from "./fleet-tools-core.mjs";
import { MAX_WAIT_MS } from "./async-core/contracts.mjs";
import {
  createAsyncTaskCore,
  CONTRACT_VERSION,
  DISPATCH_ENVELOPE_VERSION,
  SUPPORTED_DISPATCH_ENVELOPE_VERSIONS,
  WRITE_CLAIM_CONTRACT_VERSION,
} from "./async-core/index.mjs";
import {
  isTrustedRunnerPath,
  resolveSubagentCoreOptions,
  resolveTrustedRunnerPath,
} from "./subagent_runtime.mjs";
import { runAsyncTaskCoreSelfTest } from "./async-core/runtime.mjs";

const SERVER_NAME = "async-subagent";
const SERVER_VERSION = "1.0.0";
const BUILD_ID = typeof __SUBAGENT_BUILD_ID__ !== "undefined" ? __SUBAGENT_BUILD_ID__ : "dev";
const PUBLIC_TOOL_NAMES = Object.freeze([
  "subagent_prepare",
  "subagent_dispatch",
  "subagent_submit_prepared",
  "subagent_wait",
  "subagent_get",
  "subagent_result",
  "subagent_server_info",
  "subagent_cancel",
  "subagent_pause",
  "subagent_resume",
  "subagent_ack_review",
  ...FLEET_TOOL_NAMES,
]);

const CURRENT_ENTRY_PATH = fileURLToPath(import.meta.url);
// ops/tools 与 ops/dist 同深度，源码入口和打包入口都能用同一步回到仓根。
const MODULE_REPO_ROOT = path.resolve(path.dirname(CURRENT_ENTRY_PATH), "..", "..");
const DISPATCH_PREPARE_RELATIVE_PATH = path.join("ops", "tools", "dispatch_prepare.mjs");
const DISPATCH_PREPARE_TIMEOUT_MS = 300_000;
// MCP 工具面保留 effort 枚举；CLI --async-effort 不设 choices，
// runner 对不支持的 effort 记录 warning。这里的枚举不是 CLI 或模型能力上限。
const DISPATCH_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DISPATCH_SEED_TEMPLATE_HINT =
  "render the skeleton with subagent_prepare(action=template, project_root, route_id)";
const DISPATCH_SEED_FIELD_ZOD = {
  string: () => z.string(),
  object: () => z.object({}).passthrough(),
  array: () => z.array(z.unknown()),
};
// 字段闭集与类型跟 Pi 扩展工具同源；未知顶层键在工具面就拦下并点名正确层位，
// 模型不必按发布面调用后白吃一次编译器往返。
// 关键字段带 describe：schema 是 LLM 主代理构造参数的第一信源，规则只活在编译器
// 拒绝文案里会让每次误用白吃一轮往返（工具病 20260831-seed-rejection-messages-lack-exit-guidance）。
const DISPATCH_SEED_FIELD_DESCRIPTIONS = {
  route_id: "route id from --list; the route's diff card decides which optional fields apply",
  goal: "task goal in plain language; minimal routes without a contract slot take all task detail here and in inputs / known_facts",
  scope: "path sets: scope.read lists EXISTING material to read (compile fails on missing paths); scope.write_extra lists extra writable outputs including directories the task will create (no existence check); scope.delete lists allowed deletions",
  contract: "route-card capability fields; ONLY accepted when the route's diff card declares a slot (e.g. verify-agent__code-verification) — minimal routes such as general-agent__general-default reject this field",
  inputs: "free-form task inputs, e.g. inputs.constraints for output format and uncertainty handling rules",
  known_facts: "current facts the subagent needs, default empty",
  tool_contract: "tool_contract.allowed narrows the tool set; omit for the route default",
};
const dispatchSeedSchema = z.object(
  Object.fromEntries(Object.entries(DISPATCH_PREPARE_SEED_FIELD_TYPES)
    .map(([field, type]) => {
      const base = DISPATCH_SEED_FIELD_ZOD[type]().optional();
      const description = DISPATCH_SEED_FIELD_DESCRIPTIONS[field];
      return [field, description ? base.describe(description) : base];
    })),
  {
    errorMap: (issue, ctx) => (issue.code === z.ZodIssueCode.unrecognized_keys
      ? { message: unknownSeedFieldsMessage("seed", issue.keys, DISPATCH_SEED_TEMPLATE_HINT) }
      : { message: ctx.defaultError }),
  },
).strict();

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function currentCoreOptions(overrides = {}) {
  return resolveSubagentCoreOptions({
    entryPath: CURRENT_ENTRY_PATH,
    cwd: process.cwd(),
    home: homedir(),
    env: { ...process.env },
    ...overrides,
  });
}

function createService(overrides = {}) {
  return createAsyncTaskCore(currentCoreOptions(overrides));
}

const taskIdSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/);
// 静默疑似卡死：Core worker 检测到 live 静默超阈值时写入；有新事件即消失。只是叫醒信号，不是运输态。
const stallSchema = z.object({
  suspected_at: z.string(),
  silent_seconds: z.number(),
  threshold_seconds: z.number(),
  last_event_at: z.string().nullable(),
  live_phase: z.string().nullable(),
  last_tool: z.string().nullable(),
  attempt: z.number(),
}).strict();
// 模型与档位的展示投影；历史任务缺失时省略。
const modelDisplayShape = {
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  model_source: z.string().optional(),
  effort_source: z.string().optional(),
};
// task-outcome.mjs 的只读展示投影；预算裁剪可去掉 summary，或把 object_gate 缩到只剩 value。
const taskOutcomeSchema = z.object({
  execution: z.string(),
  business: z.string(),
  delivery: z.string(),
  object_gate: z.object({
    name: z.string().nullable().optional(),
    value: z.string(),
    source: z.string().nullable().optional(),
  }).strict(),
  parent_review: z.string(),
  summary: z.string().optional(),
}).strict();
// 返回超出 token 预算时 boundedDisplay 另存完整副本并补这些字段（async-core runtime/utilities.mjs）。
const displayBudgetFields = {
  status_path: z.string().optional(),
  full_evidence_path: z.string().optional(),
  display_truncated: z.array(z.string()).optional(),
  diagnostics: z.array(z.object({ step: z.string(), error: z.string() }).passthrough()).optional(),
};
const compactStatusSchema = z.object({
  ...modelDisplayShape,
  task_id: taskIdSchema,
  batch_id: z.string().nullable().optional(),
  slice_id: z.string().nullable().optional(),
  display_title: z.string().nullable().optional(),
  state: z.string(),
  contract_state: z.string().nullable(),
  business_state: z.string().nullable(),
  review_gate: z.enum(["pending", "pass", "needs_parent_review", "fail", "cancelled"]),
  task_outcome: taskOutcomeSchema.optional(),
  revision: z.string(),
  updated_at: z.string().nullable(),
  failure_summary: z.string().nullable(),
  transport_state: z.string().nullable().optional(),
  result_receipt_error: z.string().optional(),
  latest_model_error: z.string().optional(),
  // 写域守门：scope_compliant 为 false 时紧凑投影带越界次数（async-core compactTaskStatus）。
  write_domain_violation_count: z.number().int().nonnegative().optional(),
  artifact_state: z.string().nullable().optional(),
  process_alive: z.boolean().nullable().optional(),
  // 紧凑回执只带 elapsed_seconds / tool_call_count / progress_state；其余三项在完整诊断投影中出现。
  progress: z.object({
    elapsed_seconds: z.number().nullable(),
    live_age_seconds: z.number().nullable().optional(),
    tool_call_count: z.number(),
    last_tool_kind: z.string().nullable().optional(),
    live_health: z.string().nullable().optional(),
    progress_state: z.string().nullable(),
  }).optional(),
  failure_type: z.string().nullable().optional(),
  turn_status: z.string().nullable().optional(),
  resumable: z.boolean().optional(),
  session_file: z.string().nullable().optional(),
  resume_mode: z.enum(["session", "start"]).nullable().optional(),
  pause_requested_at: z.string().nullable().optional(),
  live_phase: z.string().nullable().optional(),
  live_last_request: z.string().nullable().optional(),
  last_tool_call: z.object({
    id: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  }).strict().nullable().optional(),
  diagnostic_omitted: z.array(z.string()).optional(),
  diagnostic_paths: z.object({
    task_dir: z.string(),
    stdout: z.string().nullable(),
    stderr: z.string().nullable(),
    live: z.string(),
    events: z.string(),
  }).strict().optional(),
  stall: stallSchema.nullable().optional(),
  ...displayBudgetFields,
}).strict();

const dispatchOutputSchema = z.object({
  task_id: taskIdSchema,
  status: z.string(),
  display_title: z.string().nullable(),
  selection_summary: z.string().nullable(),
  fast: z.boolean(),
}).strict();
const submitOutputSchema = z.object({
  ...modelDisplayShape,
  contract_version: z.literal(CONTRACT_VERSION),
  task_id: taskIdSchema,
  batch_id: z.string().nullable().optional(),
  slice_id: z.string().nullable().optional(),
  display_title: z.string().nullable().optional(),
  state: z.string(),
  revision: z.string(),
  submitted_at: z.string(),
  poll_after_ms: z.number().int().nonnegative(),
  ...displayBudgetFields,
}).strict();
const waitOutputSchema = z.object({
  contract_version: z.literal(CONTRACT_VERSION),
  task_id: taskIdSchema,
  event: z.enum(["timeout", "completion", "stall", "attention"]),
  changed: z.boolean(),
  after_revision: z.string().nullable().optional(),
  waited_ms: z.number().int().nonnegative().optional(),
  task: compactStatusSchema.optional(),
  ...displayBudgetFields,
}).strict();
const getOutputSchema = z.object({
  contract_version: z.literal(CONTRACT_VERSION),
  detail: z.enum(["compact", "diagnostic"]),
  tasks: z.array(compactStatusSchema),
  ...displayBudgetFields,
}).strict();
const resultOutputSchema = z.object({
  contract_version: z.literal(CONTRACT_VERSION),
  task_id: taskIdSchema,
  batch_id: z.string().nullable().optional(),
  slice_id: z.string().nullable().optional(),
  display_title: z.string().nullable().optional(),
  state: z.string(),
  business_state: z.string().nullable(),
  review_gate: z.enum(["pending", "pass", "needs_parent_review", "fail", "cancelled"]),
  task_outcome: taskOutcomeSchema.optional(),
  revision: z.string(),
  // 历史缓存可省略已读追踪版本。
  result_tracking_version: z.string().optional(),
  finished_at: z.string().nullable(),
  // 预算裁剪登记被裁字段；最小集合省略 mechanical_summary 与 session，完整副本见 artifacts.full_result_path。
  display_truncated: z.array(z.string()).optional(),
  handoff_summary: z.object({ verdict: z.string(), summary: z.string() }).strict(),
  mechanical_summary: z.object({
    contract_state: z.string().nullable(),
    artifact_state: z.string().nullable(),
    handoff_check: z.string().nullable(),
    requires_parent_review: z.boolean(),
    write_domain_enabled: z.boolean().nullable(),
    write_domain_scope_compliant: z.boolean().nullable(),
    write_domain_audit_complete: z.boolean().nullable(),
    write_domain_violation_count: z.number().int().nonnegative(),
    write_domain_reported_violation_count: z.number().int().nonnegative(),
    write_domain_covered_tools: z.array(z.string()),
    write_domain_command_write_enforced: z.boolean(),
  }).strict().optional(),
  artifacts: z.object({
    report_path: z.string().nullable().optional(),
    handoff_path: z.string().nullable().optional(),
    salvage_report_path: z.string().nullable().optional(),
    attestation_path: z.string().nullable().optional(),
    full_result_path: z.string().nullable().optional(),
  }).strict(),
  attestation: z.object({
    result_mode: z.string(),
    verified: z.boolean(),
    summary: z.string(),
  }).strict().nullable(),
  session: z.object({
    resumable: z.boolean(),
    file: z.string().nullable(),
  }).strict().optional(),
}).strict();
const cancelOutputSchema = z.object({
  contract_version: z.literal(CONTRACT_VERSION),
  task_id: taskIdSchema,
  accepted: z.boolean(),
  state: z.string(),
  revision: z.string(),
  reason: z.string(),
  next_step: z.string().optional(),
  ...displayBudgetFields,
}).strict();
const ackReviewOutputSchema = z.object({
  contract_version: z.literal(CONTRACT_VERSION),
  task_id: taskIdSchema,
  accepted: z.boolean(),
  acked: z.boolean(),
  state: z.string(),
  revision: z.string(),
  reason: z.string(),
  next_step: z.string().optional(),
  ...displayBudgetFields,
}).strict();
const serverInfoOutputSchema = z.object({
  server_name: z.string(),
  server_version: z.string(),
  contract_version: z.literal(CONTRACT_VERSION),
  dispatch_contract_version: z.string(),
  supported_dispatch_contract_versions: z.array(z.string()),
  build_id: z.string(),
  tools: z.array(z.string()),
}).strict();

function toolSuccess(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function dispatchPreparePath() {
  for (const relative of ["ops/dist/dispatch_prepare.bundle.mjs", DISPATCH_PREPARE_RELATIVE_PATH]) {
    const script = path.join(MODULE_REPO_ROOT, relative);
    if (existsSync(script)) return script;
  }
  throw new Error(`MCP运行包缺少派发编译器：${MODULE_REPO_ROOT}；重新发布完整运行包。`);
}

const projectRootSchema = z.string().min(1).describe("请求所属项目的绝对路径；决定配置覆盖与任务材料归属。target_cwd仅改变子任务执行目录。");

function mcpProjectRoot(value) {
  if (!value || !path.isAbsolute(value)) throw new Error("project_root必须是请求所属项目的绝对路径。");
  const root = path.resolve(value);
  const relative = path.relative(MODULE_REPO_ROOT, root);
  if (existsSync(path.join(MODULE_REPO_ROOT, "subagent_service.manifest.json"))
      && (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))) {
    throw new Error("project_root不能指向共享MCP发布槽；请提供实际项目目录。");
  }
  return root;
}

function runDispatchPrepare(args, seedJson, projectRoot, { raw = false } = {}) {
  const interpreter = process.execPath;
  return new Promise((resolve, reject) => {
    const child = spawn(interpreter, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        SUBAGENT_PROJECT_ROOT: projectRoot,
        SUBAGENT_RUNTIME_ROOT: MODULE_REPO_ROOT,
        SUBAGENT_CONTROL_REPO_ROOT: projectRoot,
      },
      windowsHide: true,
      timeout: DISPATCH_PREPARE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(
      `could not run ${interpreter}: ${error?.message ?? String(error)}`,
    )));
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(
          `${dispatchPrepareTimeoutMessage(DISPATCH_PREPARE_TIMEOUT_MS, stderr)}; nothing was submitted`,
        ));
        return;
      }
      if (raw && code === 0) { resolve(stdout); return; }
      let payload = null;
      try { payload = JSON.parse(stdout); } catch { payload = null; }
      if (code !== 0 || !payload) {
        // 编译器的 JSON 错误对象是 {status, stage, message}；stderr 末行常是 [dispatch-phase] 心跳行，只作兜底。
        const stderrLines = stderr.trim().split("\n").filter((line) => !line.startsWith("[dispatch-phase]"));
        const detail = payload?.message
          || payload?.error
          || stderrLines.pop()?.replace(/^error:\s*/, "")
          || stdout.trim().slice(0, 500)
          || `exit code ${code}`;
        reject(new Error(`dispatch_prepare rejected the seed: ${detail}; fix the seed and call again, nothing was submitted`));
        return;
      }
      resolve(payload);
    });
    // 编译器早退时 stdin 写入报 EPIPE，真正的失败原因由 close 分支给出。
    child.stdin.on("error", () => {});
    child.stdin.end(seedJson);
  });
}

async function dispatchSeed(service, input) {
  const projected = fastModeSeed(input.seed, input.fast);
  const seed = input.display_title ? { ...projected, title: input.display_title } : projected;
  // 覆盖项闭集与 flag 映射跟 Pi 扩展工具同源；origin_id 需要会话来源，这条入口没有，留空即不出现。
  const args = dispatchPrepareSeedArgs(dispatchPreparePath(), "prepare", input);
  const prepared = await runDispatchPrepare(args, `${JSON.stringify(seed)}\n`, mcpProjectRoot(input.project_root));
  const dispatchFile = String(prepared.dispatch_file || "");
  if (!dispatchFile) {
    throw new Error(
      `dispatch_prepare returned no dispatch_file (status=${prepared.status ?? "unknown"}); nothing was submitted`,
    );
  }
  let receipt;
  try {
    receipt = service.submitPrepared({ dispatch_file: dispatchFile });
  } catch (error) {
    throw new Error(
      `prepared material ${dispatchFile} was rejected on submit: ${error?.message ?? String(error)}`
      + "; the material stays on disk, retry it with subagent_submit_prepared once the cause is fixed",
    );
  }
  return {
    task_id: receipt.task_id,
    status: receipt.state,
    fast: prepared.fast === true,
    display_title: receipt.display_title ?? prepared.display_title ?? null,
    selection_summary: prepared.async_model_selection?.selection ? selectionSummary(prepared.async_model_selection.selection) : null,
  };
}

async function invokePause(service, input) {
  if (!service || typeof service.pause !== "function") {
    return pauseRejection(input, "pause_unavailable", CONTRACT_VERSION);
  }
  try {
    return normalizePauseReceipt(input, await service.pause(input), CONTRACT_VERSION);
  } catch (error) {
    const receipt = pauseRejection(input, "pause_failed", CONTRACT_VERSION);
    const detail = error instanceof Error ? error.message : String(error);
    receipt.next_step = `${receipt.next_step} 具体原因：${detail}`;
    return receipt;
  }
}

function registerPublicTools(server, service) {
  // 短路由索引落在模型可见描述里；读不到完整索引时保持原描述，路由发现仍走 list。
  const prepareDescription = withRouteIndex(
    "只读查询角色目录或seed模板及当前推荐行。先用template取得填写格式；路由未知时用list，给route_id只列该路由。list默认返回逐行文本，format=json返回同一目录的全部字段；model_scope=recommended（默认）只列推荐行与模型笔记涉及的型号，all按需列完整模型目录。不写任务材料，不提交任务。" ,
    MODULE_REPO_ROOT,
    { heading: "现役路由（route_id — 用途）:" },
  );
  server.registerTool("subagent_prepare", {
    description: prepareDescription,
    inputSchema: z.object({
      project_root: projectRootSchema,
      action: z.enum(["list", "template"]),
      route_id: z.string().min(1).optional(),
      format: z.enum(["text", "json"]).optional().describe("仅list：text（默认）逐行目录；json 同一目录的全部字段"),
      model_scope: z.enum(["recommended", "all"]).optional().describe("仅list：recommended（默认）推荐型号；all 完整可用模型目录"),
    }).strict(),
    // 只回 content 文本：Claude Code 见到 structuredContent 时只把它交给模型，正文文本块会被丢弃。
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { contract_version: CONTRACT_VERSION, build_id: BUILD_ID },
  }, async (input) => {
    const root = mcpProjectRoot(input.project_root);
    if (input.action === "template" && !input.route_id) throw new Error("template需要route_id；先用list查询路由。");
    if (input.action === "template" && input.format) throw new Error("format只用于list；template固定返回文本模板。");
    if (input.action === "template" && input.model_scope) throw new Error("model_scope只用于list；请改用action=list。");
    const format = input.action === "list" ? input.format ?? "text" : "text";
    const args = input.action === "template"
      ? [dispatchPreparePath(), "--seed-template", input.route_id]
      : [dispatchPreparePath(), "--list", "--format", format,
        ...(input.model_scope ? ["--model-scope", input.model_scope] : []),
        ...(input.route_id ? ["--route-id", input.route_id] : [])];
    return { content: [{ type: "text", text: await runDispatchPrepare(args, "", root, { raw: true }) }] };
  });
  server.registerTool("subagent_dispatch", {
    description: "Compile one package seed and submit it as a durable background subagent task in a single call: "
      + "the seed is compiled by this published runtime and the prepared envelope is submitted to this server. "
      + "Set project_root to the requesting project; target_cwd only overrides where the child executes. "
      + "Get the seed skeleton from subagent_prepare(action=template), whose header carries "
      + "the applicable picks and default; use list when route_id is unknown. "
      + "Give at most one of pick and model; omit both for the capability default. effort is optional; "
      + "it must be one of the model's selectable efforts, which no authorization can lift. "
      + "With an explicit effort outside the pick row's range (effort_range), or a model in none of the role's picks (outside_pool), "
      + "pass authorization={quote: the user's exact words this turn, overrides: [...]}; it covers only this model + effort. "
      + "Reuse current selection information for the requesting project; refresh it when the configuration source changes. "
      + "The seed object is passed through unchanged, so route_id, goal and scope must already be filled in; "
      + "its top-level keys are a closed set. Route-card capability fields go under contract.* ONLY for routes whose "
      + "diff card declares a slot — minimal routes (e.g. general-agent__general-default) reject the contract field, "
      + "so put their task detail in goal / inputs / known_facts. Path lists go under scope.* "
      + "(scope.read entries must exist on disk; directories the task will create go in scope.write_extra). "
      + "The optional arguments override the route defaults, and display_title overrides the seed title. "
      + "Returns task_id, status and display_title; wait for the task with subagent_wait and read it with subagent_result. "
      + "To keep working while it runs, start `node <home>/.subagent-control/releases/consumer/current/ops/consumer-tools/async_watch.mjs --project <project_root> --tasks <task_id> --until-done` as a background command; it exits when the task reaches a terminal state. "
      + "Failures name the stage: a rejected seed reports the compiler message and submits nothing, so fix the seed and call again; "
      + "a rejected submit leaves the compiled material on disk for a retry through subagent_submit_prepared, "
      + "which is also the tool for an envelope compiled outside this call.",
    inputSchema: z.object({
      project_root: projectRootSchema,
      seed: dispatchSeedSchema,
      pick: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      effort: z.enum(DISPATCH_EFFORTS).optional(),
      fast: z.boolean().optional().describe(FAST_MODE_DESCRIPTION),
      authorization: z.object({ quote: z.string().min(1), overrides: z.array(z.enum(AUTHORIZATION_OVERRIDES)) }).strict().optional(),
      target_cwd: z.string().min(1).optional(),
      execution_profile: z.enum(["standard", "simulation"]).optional(),
      display_title: z.string().min(1).optional(),
    }).strict(),
    outputSchema: dispatchOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { contract_version: CONTRACT_VERSION, build_id: BUILD_ID },
  }, async (input) => toolSuccess(await dispatchSeed(service, input)));

  server.registerTool("subagent_submit_prepared", {
    description: "Submit one dispatch_prepare envelope and return a compact task receipt. "
      + "Only for material already compiled to a dispatch_file on disk: a prior subagent_dispatch whose "
      + "submit stage failed, or an envelope compiled outside via ops/tools/dispatch_prepare.mjs. "
      + "To re-dispatch a task that already ran and reached a terminal state, call subagent_dispatch "
      + "with the seed again — this tool takes no seed and no task_id.",
    inputSchema: z.object({
      dispatch_file: z.string().min(1)
        .describe("Path to the compiled dispatch envelope written by dispatch_prepare; not a seed, not a task_id"),
    }).strict(),
    outputSchema: submitOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { contract_version: CONTRACT_VERSION, build_id: BUILD_ID },
  }, async ({ dispatch_file }) => toolSuccess(service.submitPrepared({ dispatch_file })));

  server.registerTool("subagent_wait", {
    description: `Wait for one completion notice or timeout; timeout does not inspect task status. timeout_ms defaults to 60000; long-running tasks may opt in up to ${MAX_WAIT_MS}. `
      + "event=stall means the running child has been silent past its stall threshold (task.stall carries details): the task is still running and nothing was cancelled; decide with subagent_get, and pass after_revision to skip a stall you already saw. "
      + "event=attention means the task is parked without a completion (paused, pause unconfirmed, or cancel awaiting cleanup): read task.state and resume, cancel, or inspect cleanup with subagent_get.",
    inputSchema: z.object({
      task_id: taskIdSchema,
      after_revision: z.string().optional(),
      timeout_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
    }).strict(),
    outputSchema: waitOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { contract_version: CONTRACT_VERSION, build_id: BUILD_ID },
  }, async (input) => toolSuccess(await service.wait(input)));

  server.registerTool("subagent_get", {
    description: "Read compact status for 1-20 named tasks, or bounded diagnostics for at most 5 named tasks. diagnostic includes live phase/request/tool and task-local stdout/event log entry points; diagnostic_omitted lists detail omitted to fit the budget, so query one task for more detail. No list-all operation exists.",
    inputSchema: z.object({
      task_ids: z.array(taskIdSchema).min(1).max(20),
      detail: z.enum(["compact", "diagnostic"]).optional(),
    }).strict(),
    outputSchema: getOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { contract_version: CONTRACT_VERSION, build_id: BUILD_ID },
  }, async (input) => toolSuccess(service.get(input)));

  server.registerTool("subagent_result", {
    description: "Return a terminal handoff summary and durable artifact pointers without report or handoff bodies.",
    inputSchema: z.object({ task_id: taskIdSchema }).strict(),
    outputSchema: resultOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { contract_version: CONTRACT_VERSION, build_id: BUILD_ID },
  }, async (input) => toolSuccess(service.result(input)));

  server.registerTool("subagent_server_info", {
    description: "Return server identity for pre-dispatch build comparison: build_id, contract versions, tool names.",
    inputSchema: z.object({}).strict(),
    outputSchema: serverInfoOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { contract_version: CONTRACT_VERSION, build_id: BUILD_ID },
  }, async () => {
    const info = service.contractInfo();
    return toolSuccess({
      server_name: SERVER_NAME,
      server_version: SERVER_VERSION,
      contract_version: info.contract_version,
      dispatch_contract_version: info.dispatch_contract_version,
      supported_dispatch_contract_versions: info.supported_dispatch_contract_versions,
      build_id: BUILD_ID,
      tools: [...PUBLIC_TOOL_NAMES],
    });
  });

  server.registerTool("subagent_cancel", {
    description: "Cancel one active task using an expected status revision. "
      + "reason=revision_conflict means the status moved between the read and this call: take the current revision from subagent_get and retry. "
      + "reason=process_tree_termination_unconfirmed means the write claim is still retained. "
      + "Read subagent_get(detail=diagnostic) and the evidence before deciding the next action; get observes state but does not advance cleanup. "
      + "If complete termination cannot be established, report needs_owner with the missing evidence.",
    inputSchema: z.object({
      task_id: taskIdSchema,
      expected_revision: z.string().min(1),
      reason: z.string().trim().min(1).max(1024)
        .describe("Non-empty cancellation reason; user_requested is the only value treated as an explicit user stop"),
    }).strict(),
    outputSchema: cancelOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { contract_version: CONTRACT_VERSION, build_id: BUILD_ID },
  }, async (input) => toolSuccess(service.cancel(input)));

  server.registerTool("subagent_pause", {
    description: PAUSE_TOOL_DESCRIPTION,
    inputSchema: z.object({
      task_id: taskIdSchema,
      task_root: z.string().min(1).optional(),
      expected_revision: z.string().min(1),
      reason: z.string().trim().min(1).max(1024)
        .describe("暂停原因，仅作说明，不改变动作或权限。"),
    }).strict(),
    outputSchema: cancelOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { contract_version: CONTRACT_VERSION, build_id: BUILD_ID },
  }, async (input) => toolSuccess(await invokePause(service, input)));

  server.registerTool("subagent_resume", {
    description: RESUME_TOOL_DESCRIPTION,
    inputSchema: z.object({
      task_id: taskIdSchema,
      expected_revision: z.string().min(1),
    }).strict(),
    outputSchema: cancelOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { contract_version: CONTRACT_VERSION, build_id: BUILD_ID },
  }, async (input) => toolSuccess(service.resume(input)));

  server.registerTool("subagent_ack_review", {
    description: "Acknowledge a terminal task's parent review: clears requires_parent_review so the task leaves review queues, and records review_acked_at. "
      + "Business verdicts stay untouched. Idempotent: reason=already_acked means the flag was already cleared. "
      + "reason=task_not_terminal means the task is still running and cannot be acknowledged yet.",
    inputSchema: z.object({
      task_id: taskIdSchema,
      expected_revision: z.string().min(1).optional(),
      note: z.string().max(240).optional(),
    }).strict(),
    outputSchema: ackReviewOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { contract_version: CONTRACT_VERSION, build_id: BUILD_ID },
  }, async (input) => toolSuccess(service.ackReview(input)));
}

const fleetOutputSchema = z.object({ ok: z.boolean() }).passthrough();

function registerFleetTools(server) {
  const fleetFor = (input) => createFleetCore({ runtimeRoot: MODULE_REPO_ROOT, projectRoot: mcpProjectRoot(input.project_root), env: process.env });
  const fleetAnnotations = { destructiveHint: false, openWorldHint: false };
  const fleetMeta = { contract_version: CONTRACT_VERSION, build_id: BUILD_ID };

  // 注册顺序即对外工具面顺序：PUBLIC_TOOL_NAMES 展开 FLEET_TOOL_NAMES，listTools 顺序
  // 要与之一致（subagent_service_contract_test.mjs 的 public_tool_surface_matches_runtime_source）。
  server.registerTool("fleet_start", {
    description: "Validate a fleet manifest and launch its DAG under a detached scheduler driver. Returns run_id, state_root and node_count; the driver keeps dispatching without further parent calls.",
    inputSchema: z.object({
      project_root: projectRootSchema,
      manifest_path: z.string().min(1),
      run_id: z.string().min(1).optional(),
    }).strict(),
    outputSchema: fleetOutputSchema,
    annotations: { ...fleetAnnotations, readOnlyHint: false, idempotentHint: false },
    _meta: fleetMeta,
  }, async (input) => toolSuccess(await fleetFor(input).fleet_start(input)));

  server.registerTool("fleet_status", {
    description: "Read one fleet run's bounded state summary: node counts, active nodes, nodes waiting for parent review, failures and the next ready nodes.",
    inputSchema: z.object({ project_root: projectRootSchema, run_id: z.string().min(1) }).strict(),
    outputSchema: fleetOutputSchema,
    annotations: { ...fleetAnnotations, readOnlyHint: true, idempotentHint: true },
    _meta: fleetMeta,
  }, async (input) => toolSuccess(await fleetFor(input).fleet_status(input)));

  server.registerTool("fleet_wait", {
    description: `Block until the fleet run settles or the budget expires, then return the settlement summary. This is a real completion-notice wait, not a poll: never sleep-poll a fleet run, call this tool instead. wait_ms is clamped to [${FLEET_WAIT_MS_MIN}, ${FLEET_WAIT_MS_MAX}]; a settled run reports driver_status completed, blocked, needs_parent_review or failed.`,
    inputSchema: z.object({
      project_root: projectRootSchema,
      run_id: z.string().min(1),
      wait_ms: z.number().int().optional(),
    }).strict(),
    outputSchema: fleetOutputSchema,
    annotations: { ...fleetAnnotations, readOnlyHint: false, idempotentHint: true },
    _meta: fleetMeta,
  }, async (input) => toolSuccess(await fleetFor(input).fleet_wait(input)));

  server.registerTool("fleet_review", {
    description: `Record a parent review decision for a node in needs_parent_review: ${FLEET_DECISIONS.join(", ")}. evidence is a repo-internal path the scheduler requires; accepting relaunches the driver so downstream nodes keep moving.`,
    inputSchema: z.object({
      project_root: projectRootSchema,
      run_id: z.string().min(1),
      node_id: z.string().min(1),
      decision: z.enum(FLEET_DECISIONS),
      // scheduler 侧 evidence 必填(空值直接 ToolError),reason 可选——schema 与其对齐,
      // 避免模型按发布面调用后白吃一次失败往返。
      evidence: z.string().min(1),
      reason: z.string().optional(),
    }).strict(),
    outputSchema: fleetOutputSchema,
    annotations: { ...fleetAnnotations, readOnlyHint: false, idempotentHint: false },
    _meta: fleetMeta,
  }, async (input) => toolSuccess(await fleetFor(input).fleet_review(input)));

  server.registerTool("fleet_cancel", {
    description: "Cancel an entire fleet after an explicit user stop request. Stops further dispatch, cancels active tasks and unstarted nodes, and preserves finished results. A cancelling result means termination is not yet confirmed; inspect fleet_status or retry fleet_cancel.",
    inputSchema: z.object({ project_root: projectRootSchema, run_id: z.string().min(1), reason: z.string().min(1) }).strict(),
    outputSchema: fleetOutputSchema,
    annotations: { ...fleetAnnotations, readOnlyHint: false, idempotentHint: true },
    _meta: fleetMeta,
  }, async (input) => toolSuccess(await fleetFor(input).fleet_cancel(input)));
}

async function mcpServer() {
  const service = createService();
  const server = new McpServer({ name: SERVER_NAME, version: `${SERVER_VERSION}+${BUILD_ID}` });
  registerPublicTools(server, service);
  registerFleetTools(server);
  await server.connect(new StdioServerTransport());
}

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

// 父级销账是显式决定，不是可推导字段：CLI 必须点名所复核的 revision 与理由，
// 避免批量脚本盲销账。约束只加在 CLI 调用方，MCP 工具面与运行时判定保持原样。
function ackReviewArgs(args, taskRoot) {
  const taskId = pick(args, ["task-id", "task_id"], "");
  const expectedRevision = pick(args, ["expected-revision", "expected_revision"], "").trim();
  // note 只用来判断是否给了说明，转发给运行时的是原值，CLI 不重写父级决定。
  const note = pick(args, ["note"], "");
  const missing = [
    ...(taskId ? [] : ["--task-id"]),
    ...(expectedRevision ? [] : ["--expected-revision"]),
    ...(String(note).trim() ? [] : ["--note"]),
  ];
  if (missing.length) {
    throw new Error(
      `internal ack-review requires ${missing.join(", ")}: acknowledge the revision actually reviewed and record the decision note; `
      + "read the current revision with `internal get --task-ids <task_id> --task-root <task_root>`",
    );
  }
  return { task_id: taskId, task_root: taskRoot, expected_revision: expectedRevision, note };
}

async function internalAdapter(args) {
  const operation = args._[1] || "";
  const service = createService({ registryRoot: pick(args, ["registry-root", "registry_root"], "") || undefined });
  const taskRoot = pick(args, ["task-root", "task_root"], "");
  if (operation === "submit-prepared") {
    return service.submitPrepared({ dispatch_file: pick(args, ["dispatch-file", "dispatch_file"], "") });
  }
  if (operation === "get") {
    return service.get({ task_ids: pickCsv(args, ["task-ids", "task_ids"], []), detail: pick(args, ["detail"], "compact"), task_root: taskRoot });
  }
  if (operation === "result") return service.result({ task_id: pick(args, ["task-id", "task_id"], ""), task_root: taskRoot });
  if (operation === "cancel") return service.cancel({
    task_id: pick(args, ["task-id", "task_id"], ""), task_root: taskRoot,
    expected_revision: pick(args, ["expected-revision", "expected_revision"], ""), reason: pick(args, ["reason"], ""),
  });
  if (operation === "resume") return service.resume({
    task_id: pick(args, ["task-id", "task_id"], ""), task_root: taskRoot,
    expected_revision: pick(args, ["expected-revision", "expected_revision"], ""),
  });
  if (operation === "pause") {
    const pauseInput = {
      task_id: pick(args, ["task-id", "task_id"], ""),
      task_root: taskRoot || undefined,
      expected_revision: pick(args, ["expected-revision", "expected_revision"], ""),
      reason: pick(args, ["reason"], ""),
    };
    const missing = [
      ...(String(pauseInput.task_id).trim() ? [] : ["--task-id"]),
      ...(String(pauseInput.expected_revision).trim() ? [] : ["--expected-revision"]),
      ...(String(pauseInput.reason).trim() ? [] : ["--reason"]),
    ];
    if (missing.length) {
      throw new Error(
        `internal pause requires ${missing.join(", ")}: reason=missing_pause_args. `
        + "Read the current revision with internal get, then retry internal pause with that expected_revision and a non-empty reason. Do not switch this call to internal cancel.",
      );
    }
    return invokePause(service, pauseInput);
  }
  if (operation === "ack-review") return service.ackReview(ackReviewArgs(args, taskRoot));
  if (operation === "reconcile") return service.reconcile({ task_ids: pickCsv(args, ["task-ids", "task_ids"], []), task_root: taskRoot });
  if (operation === "build-info") {
    const info = service.contractInfo();
    return {
      server_name: SERVER_NAME,
      server_version: SERVER_VERSION,
      contract_version: info.contract_version,
      dispatch_contract_version: info.dispatch_contract_version,
      supported_dispatch_contract_versions: info.supported_dispatch_contract_versions,
      build_id: BUILD_ID,
      tools: [...PUBLIC_TOOL_NAMES],
    };
  }
  throw new Error("internal operation must be submit-prepared, get, result, cancel, pause, resume, ack-review, reconcile, or build-info");
}

function workerDiagnosticsPath(input) {
  const taskRoot = path.resolve(process.cwd(), pick(input, ["task-root", "task_root"], currentCoreOptions().defaultTaskRoot));
  const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
  return taskId ? path.join(taskRoot, taskId, "worker.stderr.log") : null;
}

function appendWorkerDiagnostics(logPath, label, error) {
  if (!logPath) return;
  try {
    ensureDir(path.dirname(logPath));
    appendFileSync(logPath, `[${new Date().toISOString()}] ${label}: ${error?.stack ?? error?.message ?? String(error)}\n`);
  } catch {
    // Diagnostics are best effort and must not hide the original failure.
  }
}

function selfTestBuildIdentity() {
  const isSourceEntry = BUILD_ID === "dev";
  const manifestPath = isSourceEntry
    ? null
    : path.join(path.dirname(CURRENT_ENTRY_PATH), "subagent_service.manifest.json");
  let manifestBuildId = null;
  let manifestError = null;
  if (manifestPath) {
    try {
      manifestBuildId = String(JSON.parse(readFileSync(manifestPath, "utf8")).build_id || "");
    } catch (error) {
      manifestError = error?.message ?? String(error);
    }
  }
  const identityMatches = isSourceEntry
    ? BUILD_ID === "dev"
    : Boolean(manifestBuildId && manifestBuildId === BUILD_ID);
  return {
    build_id: BUILD_ID,
    entry_identity: {
      kind: isSourceEntry ? "source" : "dist",
      source: isSourceEntry ? "dev" : null,
      dist_manifest_build_id: manifestBuildId,
      entrypoint: CURRENT_ENTRY_PATH,
      manifest_path: manifestPath,
      manifest_error: manifestError,
      build_id_matches_manifest: identityMatches,
    },
    identityMatches,
  };
}

async function selfTest() {
  const coreResult = await runAsyncTaskCoreSelfTest(currentCoreOptions());
  const checks = { ...coreResult.checks };
  const buildIdentity = selfTestBuildIdentity();
  const batchMetadata = {
    batch_id: "batch-self-test",
    slice_id: "schema-slice",
    display_title: "schema title",
  };
  const resultReceiptFixture = {
    contract_version: CONTRACT_VERSION,
    task_id: "schema",
    ...batchMetadata,
    state: "done",
    business_state: "completed",
    review_gate: "pass",
    revision: "1",
    finished_at: null,
    handoff_summary: { verdict: "done", summary: "" },
    mechanical_summary: {
      contract_state: "ok",
      artifact_state: "runtime_artifact_present",
      handoff_check: "not_requested",
      requires_parent_review: false,
      write_domain_enabled: null,
      write_domain_scope_compliant: null,
      write_domain_audit_complete: null,
      write_domain_violation_count: 0,
      write_domain_reported_violation_count: 0,
      write_domain_covered_tools: [],
      write_domain_command_write_enforced: false,
    },
    artifacts: {
      report_path: null,
      handoff_path: null,
      salvage_report_path: null,
      attestation_path: null,
    },
    attestation: null,
    session: { resumable: false, file: null },
  };
  checks.public_output_schemas_accept_batch_metadata = (
    compactStatusSchema.safeParse({
      task_id: "schema",
      ...batchMetadata,
      state: "done",
      contract_state: null,
      business_state: null,
      review_gate: "pass",
      revision: "1",
      updated_at: null,
      failure_summary: null,
    }).success
    && resultOutputSchema.safeParse(resultReceiptFixture).success
    && submitOutputSchema.safeParse({
      contract_version: CONTRACT_VERSION,
      task_id: "schema",
      ...batchMetadata,
      state: "queued",
      revision: "1",
      submitted_at: new Date().toISOString(),
      poll_after_ms: 1000,
    }).success
  );
  // 运行时投影的实际形状：模型展示字段、task_outcome 及其裁剪形态、暂停态、诊断附加字段、预算裁剪后的最小回执。
  const outcome = {
    execution: "completed", business: "done", delivery: "delivered",
    object_gate: { name: "verdict", value: "pass", source: "child-task-result.json:task.reviewGate" },
    parent_review: "not_required", summary: "运行结束；合同产物已交付；对象门通过（verdict）",
  };
  const modelFields = { model: "xai/grok-4.7", effort: "high", model_source: "task_config", effort_source: "task_config" };
  const compactFixture = {
    ...modelFields, task_id: "schema", state: "done", contract_state: "ok", business_state: "done",
    review_gate: "pass", task_outcome: outcome, revision: "3", updated_at: null, failure_summary: null,
  };
  checks.public_output_schemas_accept_runtime_projection_fields = (
    compactStatusSchema.safeParse(compactFixture).success
    && compactStatusSchema.safeParse({ ...compactFixture, task_outcome: { ...outcome, summary: undefined, object_gate: { value: "pass" } } }).success
    && compactStatusSchema.safeParse({ ...compactFixture, state: "paused", transport_state: "paused", pause_requested_at: null, resumable: true, session_file: null, resume_mode: "session" }).success
    && compactStatusSchema.safeParse({ ...compactFixture, result_receipt_error: "copy failed", latest_model_error: "429 rate limited" }).success
    && submitOutputSchema.safeParse({
      ...modelFields, contract_version: CONTRACT_VERSION, task_id: "schema", state: "queued",
      revision: "1", submitted_at: new Date().toISOString(), poll_after_ms: 1000,
    }).success
    && resultOutputSchema.safeParse({
      ...resultReceiptFixture, task_outcome: outcome, display_truncated: ["handoff_summary.summary"],
      artifacts: { ...resultReceiptFixture.artifacts, full_result_path: "result-full.json" },
      mechanical_summary: { ...resultReceiptFixture.mechanical_summary, handoff_check: null },
    }).success
    && resultOutputSchema.safeParse({
      contract_version: CONTRACT_VERSION, task_id: "schema", state: "done", business_state: "done",
      review_gate: "pass", task_outcome: outcome, revision: "3", finished_at: null, result_tracking_version: "3",
      handoff_summary: { verdict: "pass", summary: "" }, artifacts: { full_result_path: "result-full.json" },
      attestation: null, display_truncated: ["mechanical_summary", "session", "artifacts.in_full_result"],
    }).success
    && !compactStatusSchema.safeParse({ ...compactFixture, unexpected_field: true }).success
  );
  // 兼容追踪版本，继续拒绝未知字段。
  checks.result_schema_accepts_tracking_version_and_stays_closed = (
    resultOutputSchema.safeParse({ ...resultReceiptFixture, result_tracking_version: "1" }).success
    && !resultOutputSchema.safeParse({ ...resultReceiptFixture, result_tracking_version: "1", unexpected_field: true }).success
  );
  // 编译器超时时错误正文必须点名停在哪一阶段；心跳走 stderr，Windows 上是 CRLF。
  checks.dispatch_timeout_message_carries_last_compiler_phase = (
    dispatchPrepareTimeoutMessage(
      DISPATCH_PREPARE_TIMEOUT_MS,
      "[dispatch-phase] seed=0 phase=load_seed\r\n[dispatch-phase] seed=0 phase=build_package\r\n",
    ) === `dispatch_prepare compiler timed out after ${DISPATCH_PREPARE_TIMEOUT_MS}ms;`
      + " last phase: [dispatch-phase] seed=0 phase=build_package"
    && dispatchPrepareTimeoutMessage(DISPATCH_PREPARE_TIMEOUT_MS, "").endsWith("last phase: none observed")
  );
  checks.dispatch_seed_schema_is_the_shared_closed_field_set = (
    Object.keys(dispatchSeedSchema.shape).join(",") === Object.keys(DISPATCH_PREPARE_SEED_FIELD_TYPES).join(",")
    && !dispatchSeedSchema.safeParse({ route_id: "r", scan_mode: "slice_scan" }).success
    && dispatchSeedSchema.safeParse({ route_id: "r" }).success
  );
  checks.public_v1_output_schemas_omit_origin_thread_id = [
    compactStatusSchema,
    submitOutputSchema,
    resultOutputSchema,
  ].every((schema) => !Object.hasOwn(schema.shape, "origin_thread_id"));

  const fakeExit = path.join(process.cwd(), "tmp", `async-stdio-self-test-exit-${Date.now()}-${process.pid}.mjs`);
  ensureDir(path.dirname(fakeExit));
  writeFileSync(fakeExit, "setTimeout(() => process.exit(23), 20);\n", "utf8");
  const client = new LineJsonRpcClient(
    { command: process.execPath, args: [fakeExit], shell: false },
    { cwd: process.cwd(), timeoutMs: 500 },
  );
  let waiterError = "";
  try {
    await client.start().waitForNotification(() => false, { timeoutMs: 0 });
  } catch (error) {
    waiterError = String(error?.message ?? error);
  } finally {
    client.stop();
    rmSync(fakeExit, { force: true });
  }
  checks.no_timeout_waiter_rejects_on_process_exit = waiterError.includes("process exited before response")
    && waiterError.includes("code=23")
    && notificationWaitFailureType(waiterError) === "app_server_exit";
  const ok = Object.values(checks).every(Boolean);
  return {
    ...coreResult,
    build_id: buildIdentity.build_id,
    entry_identity: buildIdentity.entry_identity,
    ok,
    checks,
  };
}

async function main() {
  const args = parseArgs();
  const command = args._[0] || "help";
  try {
    if (command === "mcp") await mcpServer();
    else if (command === "internal") printJson(await internalAdapter(args));
    else if (command === "self-test") printJson(await selfTest());
    else if (command === "worker") {
      const logPath = workerDiagnosticsPath(args);
      process.on("uncaughtException", (error) => { appendWorkerDiagnostics(logPath, "uncaughtException", error); process.exit(1); });
      // 只记诊断不够：装上 handler 会压掉 Node 默认终止，必须退出，否则未处理拒绝被静默继续。
      process.on("unhandledRejection", (reason) => { appendWorkerDiagnostics(logPath, "unhandledRejection", reason); process.exit(1); });
      try {
        const taskRoot = pick(args, ["task-root", "task_root"], "");
        const taskId = pick(args, ["task-id", "task_id"], "");
        await createService().runWorker({ task_root: taskRoot, task_id: taskId });
      } catch (error) {
        appendWorkerDiagnostics(logPath, "worker_error", error);
        process.exitCode = 1;
      }
    } else {
      const options = currentCoreOptions();
      printJson({
        ok: true,
        commands: ["mcp", "internal", "self-test"],
        mcp_tools: [...PUBLIC_TOOL_NAMES],
        contract_version: CONTRACT_VERSION,
        build_id: BUILD_ID,
        defaults: {
          task_root: options.defaultTaskRoot,
          child_runner: options.defaultRunnerPath,
          model: options.defaultModel,
          effort: options.defaultEffort,
          context_mode: options.defaultContextMode,
        },
      });
    }
  } catch (error) {
    printJson({ ok: false, error: error?.message ?? String(error) });
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(CURRENT_ENTRY_PATH)) await main();

export {
  registerPublicTools,
  registerFleetTools,
  CONTRACT_VERSION,
  DISPATCH_ENVELOPE_VERSION,
  PUBLIC_TOOL_NAMES,
  SUPPORTED_DISPATCH_ENVELOPE_VERSIONS,
  WRITE_CLAIM_CONTRACT_VERSION,
  resolveSubagentCoreOptions,
  resolveTrustedRunnerPath,
  isTrustedRunnerPath,
};
