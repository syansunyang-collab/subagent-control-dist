#!/usr/bin/env node
// run-pi-task.mjs — Pi RPC 后台子代理执行体；本仓唯一 child runner。
//
// 与 Core worker(async-core/runtime.mjs)的 runner 接口契约:
//   argv:--contextMode --targetCwd --childCwd --taskFile/--task --model --effort
//         --outDir --artifactsDir --saveRawEvidence [--simProfileJson]
//         [--turnTimeoutMs] [--timeoutMs] [--controlHome] [--writeDomainSpec <path>]
//         [--runtimeRoot <dir>] [--controlFile <path> --attemptId <id>] [--ext <path> ...]
//   写回:child-task-result.json / child-final.md / child-task-live.json / child-task-events.jsonl
//         / child-handoff.md / child-task-identity.json / pi-session/ / pi-stderr.log
//   退出码:result.ok=false → exit 1(业务 partial/blocked 照常跑完再 exit 1)
//
// 运输层:spawn `node <pi cli> --mode rpc`,走 LF-only JSONL 双向自定义命令协议
// ({type,id} 命令 / {type:"response",id,command,success} 响应 / 其余行为异步事件),
// 与 JSON-RPC 2.0 形状不同,因此不复用 _stdio-jsonrpc.mjs 的 LineJsonRpcClient,自带 JSONL 客户端。
// 协议事实来自 @earendil-works/pi-coding-agent 0.84.2 dist 实读与本机 RPC 双向 dump 实测。
//
// 时序:get_state(启动完成)→ get_available_models(模型目录诊断)→ 身份回读/纠正/复核
//       → prompt(异步 preflight-ack)→ 事件流至回合结束(agent_settled 后静默窗内无新活动、
//         无压缩在途、pi 自报 idle且任务内command已收尾)→ get_last_assistant_text → get_session_stats
//       → stdin EOF 关停；超时后 Windows 整树回收，POSIX 先 TERM 再 KILL。
// runner 只报运输事实:回合怎么收的(stopReason / errorMessage)留在 turns[] 与 diagnostics,不翻译成
// 失败类别;failure_type 只覆盖 runner 自己能观测的运输、超时、身份与配置事故,业务与模型侧结论归主代理。
//
// 权限:pi 无 OS sandbox、无反向权限询问;工具、扩展、skills 由导入范围(ops/templates/worker-resources.json)
//       与任务包的角色 × 能力白名单决定(tool_contract.allowed + worker_resources,dispatch_prepare 编译),
//       -t 与 -xt 按 pi_worker_resources.mjs 的加载规则求得。
// Core 下发写域时再由 extension
//       对 write/edit 做调用前路径守门。bash/powershell 不是路径沙箱,仍靠任务合同与事后 diff 验收。
//       result.permission.answer_mode 区分 configured_tools 与显式 tool_allowlist。
//
// effort 直配 pi thinkingLevel(值域同为 off/minimal/low/medium/high/xhigh/max),无映射表;
// 发请求前必须从任务元数据恢复角色并解析 control_root。带冻结选型(--selectionFile)时按冻结的
// model / effort / 模型可选档位 / 行范围 / 已授权解除项校验;没有冻结选型时校验 effort 在当前模型档位内。
// 缺 model / effort 或不符均在 spawn 前 failEarly(invalid_model_effort)。合法性由 pi 侧解析,runner 只做请求-实收核对。
//
// 环境变量:PI_CONTROL_PI(覆盖 pi cli.js 路径,自测注入 stub 用)、PI_CONTROL_MODEL、
//           PI_CONTROL_EFFORT、PI_CONTROL_HOME → defaultControlHome()。
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { EFFORT_LEVELS, loadSelectionConfig, modelEfforts, resolveWorkerResources } from "./dispatch-core/model_selection.mjs";
import { ModelConfigError, resolveModelConfigSources } from "./model_config.mjs";
import {
  PI_CHILD_MODEL_EXTENSION_PROFILE,
  resolvePiChildModelExtensions,
} from "./pi_model_extension_profile.mjs";
import {
  PI_CHILD_COMPACTION_EXTENSION_PROFILE,
  resolvePiChildCompactionExtensions,
} from "./pi_compaction_extension_profile.mjs";
import {
  discoverWorkerResources,
  excludedTools,
  loadWorkerResourcesConfig,
  selectTaskResources,
  workerSpawnTools,
} from "./pi_worker_resources.mjs";
import { readCommandJobsState } from "./pi_child_command_jobs.mjs";
import {
  PI_CHILD_BASH_PROCESS_TREE_PROFILE,
  renderPiChildBashProcessTreeSource,
  resolveChildBash,
  resolvePiChildBashToolModule,
  snapshotChildProcessTree,
  terminateChildProcessTree,
} from "./pi_child_bash_process_tree.mjs";
import {
  PI_CHILD_WRITE_DOMAIN_PROFILE,
  WRITE_DOMAIN_ENV,
  mergeWriteDomainEvidence,
  parseWriteDomainSpec,
  summarizeWriteDomainAudit,
} from "./pi_write_domain_extension.mjs";
import {
  boolArg,
  countBy,
  defaultControlHome,
  ensureDir,
  numberArg,
  parseArgs,
  redactAuth,
  redactText,
  stampForPath,
  stringArg,
} from "./_stdio-jsonrpc.mjs";
import {
  evidenceOnlyPackage,
  readAssistedReviewGate,
  ReviewContractError,
  structuredReviewPackage,
  synthesizeReviewResult,
} from "./review_result_synthesis.mjs";
import {
  TASK_RESULT_TOOL_NAME,
  parseHandoffCheckSpec,
  taskResultOutputPaths,
} from "./task_result_synthesis.mjs";
import { TRANSIENT_RETRY_EXTENSION_NAMES } from "./pi_transient_retry.mjs";
import { fastModeExtensionPath } from "./pi_fast_mode.mjs";
import { submitTaskResult } from "./pi_task_result_extension.mjs";
import {
  analyzeTaskResult,
  applyReviewGate,
  classifyFinalResult,
  fillTemplate,
  headingStatus,
  makeFailEarly,
  makeLiveWriter,
  normalizeFinalText,
  parseSimulationProfile,
  readTaskText,
  requiredHeadings,
  simulationProfilePrompt,
} from "./_child-task-contract.mjs";

const rawArgv = process.argv.slice(2);
const args = parseArgs(rawArgv);
const selfTestRequested = rawArgv.includes("--self-test") || boolArg(args, "self-test", false);

const RUNTIME_NAME = "pi";
const BACKEND = "pi-rpc";
const RUNNER_NAME = "run-pi-task";
const PI_CHILD_SYSTEM_PROMPT_PROFILE = "pi-child-worker-system/v1";
const DEFAULT_PI_CLI = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
// turnTimeoutMs/timeoutMs 的 0 语义是不限时;setTimeout 不接受 0/Infinity,用 24h 哨兵代替。
const NO_TIMEOUT_MS = 24 * 60 * 60 * 1000;
// 单条控制命令(get_state / get_available_models / set_model / ... )的响应上限;
// 不覆盖 prompt→agent_settled 的等待,那一段走 turnTimeoutMs。
const COMMAND_TIMEOUT_MS = 60000;
// 超时后先 abort,再给 agent_settled 一个短窗口,然后进关停流程。
const ABORT_SETTLE_WINDOW_MS = 12000;
// agent_settled 只表示 pi 循环停了一拍:压缩插件 ctx.compact() 先 abort 当前回合再压缩、压完自己发续跑,
// 全程发生在同一个活着的 pi 进程里。回合结束 = 静默窗内没有新活动、没有压缩在途、pi 自报 idle。
const SETTLE_GRACE_MS = 3000;
const ACTIVITY_EVENT_TYPES = new Set(["agent_start", "turn_start", "message_start", "tool_execution_start", "compaction_start"]);
const SHUTDOWN_TERM_MS = 5000;
const SHUTDOWN_KILL_MS = 5000;
const STDERR_CAP_BYTES = 262144;
// 协议流健康熔断:切行后残帧缓冲上限按 UTF-8 字节计量(防无换行输出无界吃内存);脏行熔断
// 阈值按会话生命周期累计(少量脏行按 W-1 语义容错记账,累计过量=协议流已不可信,立即从失败
// 通道扇出唤醒)。任一熔断触发后 consume 闩死,后续数据全部丢弃。
const STDOUT_FRAME_CAP_BYTES = 16 * 1024 * 1024;
const MALFORMED_LINES_FUSE = 100;
// 重复签名仅提示可能无进展：同参数轮询可以返回变化的数据，不能据此 abort。
// 最近 TOOL_LOOP_WINDOW 次调用中不同签名不超过 TOOL_LOOP_MAX_DISTINCT 个且均重复时，
// 每任务记录一次非终态告警。已确认的空转命令与执行预算仍独立控制停止。
// 签名 = 工具名 + 参数键排序后的 JSON，字符串空白折叠；数字一律保留：
// `--offset 1`…`--offset 20` 这类分页与批量取证的数字参数选的是不同数据，不算同一调用。
const TOOL_LOOP_WINDOW = 20;
const TOOL_LOOP_MAX_DISTINCT = 2;
const TOOL_LOOP_COMMAND_TOOLS = new Set(["bash", "powershell"]);
// 空转命令连续计数：命令类工具的命令整行只是 echo / printf / Write-Host / Write-Output / true / : / exit，
// 且不含管道、重定向、串联、变量展开或子表达式（`(`、`$(`、反引号），视为不做任何事；
// `Write-Output (Get-Content x)` 先求值括号里的命令读真实数据，不是空转。连续 TOOL_LOOP_NOOP_STREAK 次即判 tool_loop。
// 09-25 两次 grok 死循环都是连串空转命令（`echo stop`、`echo x1`…），内容各不相同，签名窗口抓不到；
// 三个项目 362 个会话里正常任务连续空转命令不超过 1 次。去掉 bash 后 grok 同样卡住，改发 PowerShell `exit 0`。
const TOOL_LOOP_NOOP_STREAK = 8;
const TOOL_LOOP_NOOP_COMMAND = /^\s*(echo|printf|write-host|write-output|true|exit|:)\b[^|;&><`$(\n]*$/i;
const CONTINUE_INTERRUPTED_PROMPT = "Continue the interrupted task from the last complete tool boundary. Do not redo completed work.";
const NON_RESUMABLE_FAILURE_TYPES = new Set([
  "identity_mismatch",
  "invalid_model_effort",
  "invalid_model",
  "auth_or_preflight_failed",
]);

// dispatch_prepare 把角色白名单编译进 allowed；null 只见于未受白名单管理的任务包，继承已配置工具。
function taskToolSelection(taskPackage) {
  const allowed = taskPackage?.tool_contract?.allowed;
  if (allowed == null) return { tools: null, source: "pi_configured_tools", error: null };
  if (!Array.isArray(allowed) || allowed.some((name) => typeof name !== "string" || !name.trim())) {
    return { tools: null, source: "task_package.tool_contract.allowed", error: "tool_contract.allowed must be null or an array of non-empty Pi tool names" };
  }
  return { tools: [...new Set(allowed.map((name) => name.trim()))], source: "task_package.tool_contract.allowed", error: null };
}

// parseArgs 用对象承载,重复键只保留最后一个;--ext 是可重复参数,单独从 argv 收集。
function collectRepeated(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.push(next);
        i += 1;
      }
    }
  }
  return values;
}

// provider/modelId 按第一个 "/" 切分;openrouter 的 modelId 自带 "/",全部归到 modelId。
function parseModelRef(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return { provider: "", modelId: "", ok: false, reason: "missing" };
  }
  const index = text.indexOf("/");
  if (index <= 0 || index === text.length - 1) {
    return { provider: "", modelId: text, ok: false, reason: "malformed" };
  }
  return { provider: text.slice(0, index), modelId: text.slice(index + 1), ok: true, reason: "ok" };
}

const ROLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function runtimeRoleFromTask(taskPackage) {
  const agent = taskPackage?.agent;
  if (!agent || typeof agent !== "object") {
    return { role: "", status: "missing_role" };
  }
  const runtimeRole = String(agent.runtime_role || "").trim();
  const role = String(agent.role || "").trim();
  const candidate = runtimeRole || role;
  if (!candidate) return { role: "", status: "missing_role" };
  if (!ROLE_NAME_RE.test(candidate)) return { role: candidate, status: "invalid_role" };
  return { role: candidate, status: "ok" };
}

// 角色/模型配置来源与父进程选型同源：全局默认运行根，或项目 .pi/control-plane-model-config.json
// 的显式覆盖。目标项目内的旧 ops 副本不参与解析，薄运行槽不再回落到 targetCwd。
function resolveModelConfigForEffort({ explicitRuntimeRoot = null, opsRoot = null, projectRoot = null } = {}) {
  const candidates = [];
  if (explicitRuntimeRoot) candidates.push({ root: explicitRuntimeRoot, source: "runtime_root" });
  const envRoot = String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
  if (envRoot) candidates.push({ root: envRoot, source: "SUBAGENT_CONTROL_REPO_ROOT" });
  if (!envRoot && opsRoot) candidates.push({ root: path.dirname(opsRoot), source: "script_root" });
  return resolveModelConfigSources({ roots: candidates, projectRoot });
}

// 冻结选型的档位校验：授权只对冻结的 model + effort 生效。
function checkFrozenEffort(frozen, model, effort) {
  if (!Array.isArray(frozen.efforts)) throw new Error("冻结选型缺少 efforts，是旧版本准备的任务；重新准备并派发。");
  if (frozen.resolved_model !== model || frozen.resolved_effort !== effort) {
    throw new Error(`请求 ${model}@${effort} 与冻结选型 ${frozen.resolved_model}@${frozen.resolved_effort} 不一致；重新准备任务。`);
  }
  if (!frozen.efforts.includes(effort)) {
    throw new Error(`${effort} 不在 ${model} 的可选档位（${frozen.efforts.join("/")}）内。`);
  }
  const range = frozen.effort_range;
  const applied = (frozen.authorization?.applied_overrides ?? []).map((item) => item.kind);
  const rank = (level) => EFFORT_LEVELS.indexOf(level);
  if (range && (rank(effort) < rank(range[0]) || rank(effort) > rank(range[1])) && !applied.includes("effort_range")) {
    throw new Error(`${effort} 超出推荐行 ${frozen.pick} 的档位范围 ${range[0]}–${range[1]}，冻结选型没有 effort_range 授权。`);
  }
  return { source: "frozen_selection", model, effort, efforts: frozen.efforts, effort_range: range, applied_overrides: applied };
}

// ---------- pi 事件 → live 相位 ----------

function phaseFromPiEvent(type) {
  switch (type) {
    case "agent_start":
    case "turn_start":
      return "turn_wait";
    case "message_start":
    case "message_update":
    case "message_end":
      return "response_item";
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return "tool_call";
    case "auto_retry_start":
    case "auto_retry_end":
      return "auto_retry";
    case "compaction_start":
    case "compaction_end":
      return "compaction";
    case "agent_settled":
      return "turn_completed";
    default:
      return null;
  }
}

function compactPiToolCall(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  return {
    id: event.toolCallId ?? null,
    type: event.type ?? null,
    name: event.toolName ?? null,
    status: event.type === "tool_execution_end" ? (event.isError ? "error" : "completed") : "running",
    command_preview: typeof event.args?.command === "string" ? redactText(event.args.command).slice(0, 500) : null,
    full_output_path: event.partialResult?.details?.fullOutputPath ?? event.result?.details?.fullOutputPath
      ?? event.result?.details?.stdout_path ?? null,
  };
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costTotal: 0 };
}

function compactUsage(usage) {
  const source = usage && typeof usage === "object" ? usage : {};
  return {
    input: Number(source.input ?? 0) || 0,
    output: Number(source.output ?? 0) || 0,
    cacheRead: Number(source.cacheRead ?? 0) || 0,
    cacheWrite: Number(source.cacheWrite ?? 0) || 0,
    reasoning: Number(source.reasoning ?? 0) || 0,
    totalTokens: Number(source.totalTokens ?? 0) || 0,
    costTotal: Number(source.cost?.total ?? 0) || 0,
  };
}

function addUsage(target, addend) {
  for (const key of Object.keys(target)) {
    target[key] += Number(addend?.[key] ?? 0) || 0;
  }
  return target;
}

// get_session_stats 是纯计数聚合;按白名单直取,避免 redactAuth 把 tokens 键整体抹掉。
function compactSessionStats(stats) {
  if (!stats || typeof stats !== "object") {
    return null;
  }
  return {
    sessionId: stats.sessionId ?? null,
    userMessages: stats.userMessages ?? null,
    assistantMessages: stats.assistantMessages ?? null,
    toolCalls: stats.toolCalls ?? null,
    toolResults: stats.toolResults ?? null,
    totalMessages: stats.totalMessages ?? null,
    tokens: stats.tokens && typeof stats.tokens === "object" ? { ...stats.tokens } : null,
    cost: stats.cost ?? null,
    contextUsage: stats.contextUsage && typeof stats.contextUsage === "object" ? { ...stats.contextUsage } : null,
  };
}

function assistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

// ---------- pi RPC JSONL 客户端 ----------

// pi RPC 是自定义 {type,id} 命令形状,不是 JSON-RPC 2.0;这里只做行切分、id 关联与事件回调。
class PiRpcClient {
  constructor(options = {}) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? {};
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.onUiRequest = typeof options.onUiRequest === "function" ? options.onUiRequest : () => null;
    this.recordRaw = options.recordRaw === true;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderrText = "";
    this.stderrBytes = 0;
    this.rawRecords = [];
    this.malformedLines = 0;
    this.eventCounts = new Map();
    this.startedAt = null;
    this.exitInfo = null;
    this.transportError = null;
    this.shuttingDown = false;
    this.failWaiter = null;
    // 运输失败通道:子进程退出、spawn 失败、协议流损坏都从这里唤醒等待中的调用点。
    this.failed = new Promise((_, reject) => {
      this.failWaiter = reject;
    });
    this.failed.catch(() => {});
  }

  start() {
    this.startedAt = new Date().toISOString();
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // PI_SKIP_VERSION_CHECK:headless 下禁止启动期版本检查交互面(调试仓 live_pi_rpc_probe.py 同款姿势)。
      env: { ...process.env, ...this.env, NO_COLOR: "1", PI_SKIP_VERSION_CHECK: "1" },
    });
    this.child.on("error", (error) => {
      this.failTransport(new Error(`pi spawn failed: ${error.message}`));
    });
    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal: signal ?? null, at: new Date().toISOString() };
      // 关停流程里的退出是预期结果,不算运输失败。
      if (!this.shuttingDown) {
        this.failTransport(new Error(`pi process exited before completion: code=${code} signal=${signal}`));
      }
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (this.stderrText.length < STDERR_CAP_BYTES) {
        this.stderrText += chunk;
      }
    });
    return this;
  }

  failTransport(error) {
    if (!this.transportError) {
      this.transportError = error instanceof Error ? error : new Error(String(error));
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(this.transportError);
    }
    this.pending.clear();
    this.failWaiter(this.transportError);
  }

  consume(chunk) {
    // 运输失败或进入关停后丢弃后续输出。
    if (this.transportError || this.shuttingDown) {
      this.stdoutBuffer = "";
      return;
    }
    this.stdoutBuffer += chunk;
    let index;
    while ((index = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line.trim()) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.malformedLines += 1;
        if (this.recordRaw) {
          this.rawRecords.push({ at: new Date().toISOString(), dir: "recv-bad", line: redactText(line).slice(0, 2000) });
        }
        if (this.malformedLines >= MALFORMED_LINES_FUSE) {
          this.failTransport(new Error(`pi protocol stream unreliable: ${this.malformedLines} malformed stdout lines`));
          this.stdoutBuffer = "";
          return;
        }
        continue;
      }
      if (this.recordRaw) {
        this.rawRecords.push({ at: new Date().toISOString(), dir: "recv", msg: redactAuth(message) });
      }
      this.dispatch(message);
      if (this.transportError || this.shuttingDown) {
        this.stdoutBuffer = "";
        return;
      }
    }
    // 上限只约束切行后仍未补完的残帧,且按 UTF-8 字节计量(与错误文案一致)。
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > STDOUT_FRAME_CAP_BYTES) {
      this.failTransport(new Error(`pi stdout frame exceeded ${STDOUT_FRAME_CAP_BYTES} bytes without newline`));
      this.stdoutBuffer = "";
    }
  }

  dispatch(message) {
    if (message?.type === "response") {
      const key = message.id === undefined || message.id === null ? "" : String(message.id);
      const entry = this.pending.get(key);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(key);
        entry.resolve(message);
      }
      return;
    }
    if (message?.type === "extension_ui_request") {
      if (this.shuttingDown) return;
      const reply = this.onUiRequest(message);
      if (reply) {
        this.writeRaw(reply);
      }
      return;
    }
    const type = String(message?.type ?? "unknown");
    this.eventCounts.set(type, (this.eventCounts.get(type) ?? 0) + 1);
    this.onEvent(message);
  }

  writeRaw(payload) {
    if (!this.child?.stdin?.writable) {
      return false;
    }
    if (this.recordRaw) {
      this.rawRecords.push({ at: new Date().toISOString(), dir: "send", msg: redactAuth(payload) });
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  send(type, payload = {}, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    if (this.transportError) {
      return Promise.reject(this.transportError);
    }
    if (this.shuttingDown) {
      return Promise.reject(new Error(`pi client is shutting down (command ${type})`));
    }
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error(`pi stdin is not writable (command ${type})`));
    }
    const id = String(this.nextId);
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for pi response: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.writeRaw({ ...payload, type, id });
    return promise;
  }

  // 命令的成功响应;success=false 时抛出带 command/error 的错误,由调用点归类。
  async call(type, payload = {}, options = {}) {
    const response = await this.send(type, payload, options);
    if (response?.success !== true) {
      const detail = typeof response?.error === "string" ? response.error : JSON.stringify(redactAuth(response ?? null));
      const error = new Error(`pi command ${type} failed: ${detail}`);
      error.piCommand = type;
      error.piError = detail;
      throw error;
    }
    return response.data ?? null;
  }

  eventCountList() {
    return [...this.eventCounts.entries()].map(([key, count]) => ({ key, count }));
  }

  exited() {
    return this.child ? this.child.exitCode !== null || this.child.signalCode !== null : true;
  }

  // EOF 优雅关停；超时后 Windows 整树回收，POSIX 先 TERM 再 KILL。
  async shutdown(options = {}) {
    if (!this.child) {
      return { requested: false, reason: "not_started", exitInfo: null };
    }
    this.shuttingDown = true;
    // 关停即拒绝全部在途请求并清计时器:在途 Promise 不等各自超时,立即从关停事实唤醒。
    const shutdownError = new Error("pi client shutting down");
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(shutdownError);
    }
    this.pending.clear();
    const steps = [];
    if (options.forceTreeCleanup === true && process.platform === "win32" && !this.exited()) {
      const treeKill = terminateChildProcessTree(this.child.pid);
      steps.push("kill");
      await this.waitForExit(2000);
      return { requested: true, steps, treeKill, exitInfo: this.exitInfo };
    }
    try {
      this.child.stdin.end();
      steps.push("stdin_eof");
    } catch {
      steps.push("stdin_eof_failed");
    }
    if (!(await this.waitForExit(SHUTDOWN_TERM_MS))) {
      // Pause never authorizes TERM/KILL. Keep ownership and observe exit; the
      // control monitor stays alive so an explicit cancel can restore escalation.
      while (options.cooperativeOnly?.() && !this.exited()) {
        options.onUnconfirmed?.();
        await this.waitForExit(250);
      }
      if (this.exited()) return { requested: true, steps, treeKill: null, exitInfo: this.exitInfo };
      if (process.platform === "win32") {
        const treeKill = terminateChildProcessTree(this.child.pid);
        steps.push("kill");
        await this.waitForExit(2000);
        return { requested: true, steps, treeKill, exitInfo: this.exitInfo };
      }
      try {
        this.child.kill("SIGTERM");
        steps.push("sigterm");
      } catch {
        steps.push("sigterm_failed");
      }
      if (!(await this.waitForExit(SHUTDOWN_KILL_MS))) {
        const treeKill = terminateChildProcessTree(this.child.pid);
        try {
          this.child.kill("SIGKILL");
        } catch {
          // 进程可能已在 taskkill 中消失。
        }
        steps.push("kill");
        await this.waitForExit(2000);
        return { requested: true, steps, treeKill, exitInfo: this.exitInfo };
      }
    }
    return { requested: true, steps, treeKill: null, exitInfo: this.exitInfo };
  }

  waitForExit(ms) {
    if (this.exited()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.exited()), ms);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

// ---------- 运行参数 ----------

const scriptPath = fileURLToPath(import.meta.url);

if (selfTestRequested) {
  try {
    // 说明符保持字面量:esbuild 只内联字面量动态 import,伴生自测要随本文件一起进
    // ops/dist/run-pi-task.bundle.mjs,bundle 的 --self-test 冒烟才有实现可跑。
    const { runSelfTest } = await import("./run-pi-task.selftest.mjs");
    await runSelfTest(scriptPath);
    process.exit(0);
  } catch (error) {
    console.error(`PI_RUNNER_SELF_TEST_FAIL: ${error?.message ?? error}`);
    process.exit(1);
  }
}

const skillRoot = path.dirname(path.dirname(scriptPath));
// 只读生产资产根：角色/ model-notes / 模板 / worker-resources 从这里读；模型用目录 junction 不参与。
const runtimeRoot = path.resolve(
  stringArg(args, "runtimeRoot", process.env.SUBAGENT_RUNTIME_ROOT || path.dirname(skillRoot)),
);
const runStamp = stampForPath();
const runId = `pi-child-task-${runStamp}`;
const controlHome = path.resolve(
  stringArg(args, "controlHome", process.env.PI_CONTROL_HOME || defaultControlHome()),
);
const contextMode = stringArg(args, "contextMode", "isolated");
const legacyCwdArg = stringArg(args, "cwd", "");
const targetCwdSource = args.targetCwd !== undefined ? "targetCwd" : legacyCwdArg ? "legacy-cwd" : "process-cwd";
const targetCwd = path.resolve(stringArg(args, "targetCwd", legacyCwdArg || process.cwd()));
const childCwdArg = stringArg(args, "childCwd", "");
const childCwdDefault = contextMode === "project-aware" ? targetCwd : path.join(controlHome, "workspaces", runId);
const childCwdSource = childCwdArg
  ? "childCwd"
  : contextMode === "project-aware"
    ? "targetCwd-project-aware"
    : "controlHome-isolated-workspace";
const childCwd = path.resolve(childCwdArg || childCwdDefault);
const cwd = childCwd;
const outDir = path.resolve(stringArg(args, "outDir", path.join(controlHome, "runs", runId)));
const artifactsDir = path.resolve(stringArg(args, "artifactsDir", path.join(controlHome, "artifacts", runId)));
const livePath = path.join(outDir, "child-task-live.json");
const liveEventsPath = path.join(outDir, "child-task-events.jsonl");
const reviewResultPath = path.join(outDir, "review-result.json");
const reviewTaskPackagePath = path.join(outDir, "review-task-package.json");
const taskResultPayloadPath = path.join(outDir, "task-result.json");
// 模型写交卷字段的约定文件；submit_task_result 以 payload_path 引用它，调用发不出时 runner 读它代收。
const taskResultDraftPath = path.join(artifactsDir, "task-result-payload.json");
const writeDomainAuditPath = path.join(outDir, "write-domain-events.jsonl");
const identityPath = path.join(outDir, "child-task-identity.json");
const sessionDir = path.join(outDir, "pi-session");
const stderrPath = path.join(outDir, "pi-stderr.log");
const targetAgentsPath = path.join(targetCwd, "AGENTS.md");
const workerSystemPromptPath = path.join(runtimeRoot, "ops", "templates", "worker-system-prompt.md");

const modelFromArg = stringArg(args, "model", "");
const effortFromArg = stringArg(args, "effort", "");
const selectionFileArg = stringArg(args, "selectionFile", "");
const selectionFile = selectionFileArg ? path.resolve(selectionFileArg) : null;
let frozenSelection = null;
if (selectionFile) {
  if (!existsSync(selectionFile)) {
    throw new Error(`selection file does not exist: ${selectionFile}`);
  }
  frozenSelection = JSON.parse(readFileSync(selectionFile, "utf8"));
  if (!frozenSelection || typeof frozenSelection !== "object" || Array.isArray(frozenSelection)) {
    throw new Error("selection file must contain an object");
  }
}
const modelFromEnv = process.env.PI_CONTROL_MODEL || "";
const effortFromEnv = process.env.PI_CONTROL_EFFORT || "";
const model = modelFromArg || modelFromEnv;
const effort = effortFromArg || effortFromEnv;
const modelSource = modelFromArg ? "argument" : modelFromEnv ? "env" : "missing";
const effortSource = effortFromArg ? "argument" : effortFromEnv ? "env" : "missing";
const modelRef = parseModelRef(model);
const explicitExtensionPaths = collectRepeated(rawArgv, "--ext");
const bashProcessTreeExtensionPath = path.join(outDir, "pi-child-bash-process-tree.mjs");
const workerToolsSnapshotPath = path.join(outDir, "worker-tools.json");
const toolRuntimeExtensionPaths = String(process.env.PI_CONTROL_PI || "").trim()
  ? []
  : [bashProcessTreeExtensionPath];
const extensionPaths = [...new Set([
  ...toolRuntimeExtensionPaths,
  ...explicitExtensionPaths,
])];
// runner 每次固定加载的同目录扩展清单：源码名在前、bundle 名在后。清单外扩展只经 --ext 或任务合同加载。
const PI_CHILD_RUNNER_EXTENSION_PROFILE = "pi-child-runner-extensions/v1";
const RUNNER_FIXED_EXTENSIONS = Object.freeze({
  worker_tools: Object.freeze(["pi_worker_tools_extension.mjs", "pi_worker_tools_extension.bundle.mjs"]),
  // grep / find 以同名注册覆盖 Pi 内置实现；缺失即运行包不完整，不回落到内置版。
  search: Object.freeze(["pi_search_extension.mjs", "pi_search_extension.bundle.mjs"]),
  // 只给原生分类漏掉的临时服务错误追加原生可识别提示；不新增重试循环，不改 retry 次数和间隔。
  transient_retry: TRANSIENT_RETRY_EXTENSION_NAMES,
});
const simProfileJson = stringArg(args, "simProfileJson", "");
const turnTimeoutMs = numberArg(args, "turnTimeoutMs", 0);
const effectiveTurnTimeoutMs = turnTimeoutMs > 0 ? turnTimeoutMs : NO_TIMEOUT_MS;
const globalTimeoutMs = numberArg(args, "timeoutMs", 0);
const effectiveGlobalTimeoutMs = globalTimeoutMs > 0 ? globalTimeoutMs : NO_TIMEOUT_MS;
const saveRawEvidence = boolArg(args, "saveRawEvidence", false);
const taskFile = stringArg(args, "taskFile", "");
const taskArg = stringArg(args, "task", "");
const taskPackageFile = stringArg(args, "taskPackageFile", "");
const resumeSession = stringArg(args, "resumeSession", "");
const controlFileArg = stringArg(args, "controlFile", "");
const controlFile = controlFileArg ? path.resolve(controlFileArg) : null;
const attemptId = stringArg(args, "attemptId", "");
const bashCleanupPath = path.join(outDir, `bash-tree-cleanup.${path.basename(attemptId || runId)}.jsonl`);
const commandJobsRoot = path.join(outDir, `command-jobs.${path.basename(attemptId || runId)}`);
const writeDomainSpecArg = stringArg(args, "writeDomainSpec", "");
const writeDomainSpecPath = writeDomainSpecArg ? path.resolve(writeDomainSpecArg) : null;
const piCli = process.env.PI_CONTROL_PI?.trim() || DEFAULT_PI_CLI;

const toolAllowlist = null;

const startedAtMs = Date.now();
const globalDeadlineMs = startedAtMs + effectiveGlobalTimeoutMs;
let promptStarted = false;
let settledIdleConfirmed = false;
let cancellationPoll = null;
const externalCancellation = {
  requested: false,
  reason: null,
  attempt_id: null,
  requested_at: null,
  detected_at: null,
  abort_sent: false,
  abort_acknowledged: false,
  abort_error: null,
  deadline_ms: null,
  graceful: false,
};

class ExternalCancellationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExternalCancellationError";
  }
}

function remainingGlobalMs() {
  return Math.max(0, globalDeadlineMs - Date.now());
}

// ---------- 观测与早退 ----------

const live = makeLiveWriter({
  outDir,
  livePath,
  eventsPath: liveEventsPath,
  initialState: {
    rev: 0,
    run_id: runId,
    attempt_id: attemptId || null,
    turn_completed: false,
    backend: BACKEND,
    status: "starting",
    phase: "bootstrap",
    model,
    effort,
    context_mode: contextMode,
    cwd,
    child_cwd: childCwd,
    target_cwd: targetCwd,
    pid: process.pid,
    created_at: new Date().toISOString(),
    updated_at: null,
    last_event_at: null,
    last_notification_method: null,
    last_tool_call: null,
    event_counts: [],
    tool_call_counts: [],
  },
});
const writeLive = (patch) => live.writeLive(patch);

function failureFinalDoc(failureType, message) {
  return [
    "## 结论",
    "任务状态:failed",
    "",
    "## 事实与证据",
    `- runner failure_type: ${failureType}`,
    "",
    "## 已检查内容",
    "- pi RPC 运输与当前任务阶段。",
    "",
    "## 失败检查",
    `- ${message}`,
    "",
    "## 不确定项",
    "无",
    "",
    "## 边界",
    "- runner 在失败点停止,未继续执行后续任务步骤。",
  ].join("\n");
}

// 任何失败点后 child-final.md 必存在(规格 §6);已有内容不覆盖。
function ensureFailureFinal(target, failureType, message) {
  const finalPath = path.join(outDir, "child-final.md");
  if (existsSync(finalPath)) {
    return finalPath;
  }
  ensureDir(outDir);
  const doc = failureFinalDoc(failureType, message);
  writeFileSync(finalPath, doc, "utf8");
  target.turn = { ...target.turn, finalTextPath: finalPath, finalTextSource: "runner_failure_summary" };
  target.required_headings = headingStatus(doc);
  return finalPath;
}

const failEarlyBase = makeFailEarly({ outDir });

function failEarly(target, failureType, message) {
  ensureFailureFinal(target, failureType, message);
  writeLive({
    status: "failed",
    phase: "finished",
    event: "finished",
    final_status: "failed",
    failure_type: failureType,
  });
  failEarlyBase(target, failureType, message);
}

// ---------- 主流程 ----------

let simProfile = null;
const simProfileError = (() => {
  try {
    simProfile = parseSimulationProfile(simProfileJson);
    return null;
  } catch (error) {
    return error;
  }
})();

const result = {
  ok: false,
  status: "pending",
  failure_type: "unknown",
  backend: BACKEND,
  runner: RUNNER_NAME,
  outputPath: null,
  cwd,
  childCwd,
  targetCwd,
  run: {
    runId,
    controlHome,
    outDir,
    artifactsDir,
  },
  context: {
    mode: contextMode,
    childCwd,
    targetCwd,
    legacyCwdArg: legacyCwdArg || null,
    childCwdSource,
    targetCwdSource,
    targetAgentsPath,
    targetAgentsLoaded: false,
    workerSystemPromptProfile: PI_CHILD_SYSTEM_PROMPT_PROFILE,
    workerSystemPromptPath,
    globalAppendSystemSuppressed: true,
    isolationOk: null,
    note: "pi 以 -nc 关闭上下文文件发现，并用显式 --append-system-prompt 选择 worker system、替代全局 APPEND_SYSTEM 自动发现；isolated 模式再用独立空工作区物理隔离，project-aware 模式 cwd=targetCwd。",
  },
  orchestration: {
    ok: false,
    status: "pending",
    failure_type: "unknown",
  },
  task: {
    ok: false,
    status: "pending",
    failure_type: "unknown",
    blockedSignals: [],
  },
  selection: {
    model: model || null,
    effort: effort || null,
    frozen: frozenSelection,
    modelSource,
    effortSource,
    requestedProvider: modelRef.ok ? modelRef.provider : null,
    requestedModelId: modelRef.ok ? modelRef.modelId : null,
    appliedProvider: null,
    appliedModel: null,
    appliedEffort: null,
    availableModels: [],
    availableModelCount: 0,
    availableThinking: [],
    extensions: extensionPaths,
    extensionProfile: PI_CHILD_MODEL_EXTENSION_PROFILE,
    runnerExtensionProfile: PI_CHILD_RUNNER_EXTENSION_PROFILE,
    // 固定清单逐项的解析结果：路径为本次加载的文件，null 为运行目录缺失或尚未解析。
    runnerExtensions: Object.fromEntries(Object.keys(RUNNER_FIXED_EXTENSIONS).map((id) => [id, null])),
    compactionExtensionProfile: PI_CHILD_COMPACTION_EXTENSION_PROFILE,
    toolRuntimeProfile: PI_CHILD_BASH_PROCESS_TREE_PROFILE,
    writeDomainExtensionProfile: PI_CHILD_WRITE_DOMAIN_PROFILE,
    workerResources: null,
    effort_check: null,
    validated: false,
    note: null,
  },
  identity: {
    requested: {
      provider: modelRef.ok ? modelRef.provider : null,
      modelId: modelRef.ok ? modelRef.modelId : null,
      thinkingLevel: effort || null,
    },
    applied: null,
    corrections: [],
    verified: false,
    evidencePath: identityPath,
  },
  turns: [],
  usage: emptyUsage(),
  permission: {
    evidenceDir: outDir,
    answer_mode: "tool_allowlist",
    tool_allowlist: toolAllowlist,
    decisions: [],
    note:
      "pi 无 OS sandbox 强制、无反向权限询问;工具默认继承配置，显式数组才在 spawn 期限制(-t)。" +
      "Core 下发写域时,write/edit 在执行前机械守门;bash/powershell 的命令写入仍由任务合同与事后 diff 审计。",
  },
  write_domain: {
    profile: PI_CHILD_WRITE_DOMAIN_PROFILE,
    enabled: false,
    scope_compliant: null,
    audit_complete: null,
    request_count: 0,
    allowed_count: 0,
    blocked_count: 0,
    violations: [],
    audit_errors: [],
    audit_path: null,
    covered_tools: ["write", "edit"],
    command_write_enforced: false,
  },
  rawEvidenceSaved: saveRawEvidence,
  runtime: null,
  diagnostics: {},
  session: null,
  turn: {
    requestedModel: model || null,
    requestedEffort: effort || null,
    requestedModelSource: modelSource,
    requestedEffortSource: effortSource,
  },
  required_headings: {
    required: requiredHeadings,
    missing: requiredHeadings,
    ok: false,
  },
  warnings: [],
  evidence: null,
  cleanup: null,
};

if (!["isolated", "project-aware"].includes(contextMode)) {
  failEarly(result, "invalid_context_mode", "无效 contextMode。可用值为 isolated 或 project-aware。");
}

if (!existsSync(targetCwd)) {
  failEarly(result, "target_cwd_missing", `任务目标工作区不存在:${targetCwd}`);
}

if (!existsSync(workerSystemPromptPath)) {
  failEarly(
    result,
    "transport_failed",
    `缺少 worker system prompt:${workerSystemPromptPath}。请重新构建并部署 child runner。`,
  );
}

if (simProfileError) {
  failEarly(result, "invalid_sim_profile", `simProfileJson 解析失败:${simProfileError?.message ?? simProfileError}`);
}

if (model && !modelRef.ok) {
  failEarly(result, "invalid_model", `--model 需要 provider/model-id 形式,实得:${model}`);
}

const taskText = readTaskText({ taskFile, task: taskArg });
if (!taskText) {
  failEarly(result, "child_task_failed", "缺少任务文本。请提供 --task 或 --taskFile。");
}

if (resumeSession && !existsSync(resumeSession)) {
  failEarly(result, "session_missing", `resumeSession 不存在:${resumeSession}`);
}

ensureDir(outDir);
if (toolRuntimeExtensionPaths.length > 0) {
  try {
    const bashToolModuleUrl = resolvePiChildBashToolModule(piCli);
    const bashExecutable = resolveChildBash();
    const bashProcessTreeSource = renderPiChildBashProcessTreeSource({ bashToolModuleUrl, bashExecutable, cleanupPath: bashCleanupPath });
    writeFileSync(bashProcessTreeExtensionPath, `${bashProcessTreeSource}\n`, "utf8");
  } catch (error) {
    failEarly(result, "transport_failed", `Pi Bash extension preparation failed: ${error?.message || error}`);
  }
}
ensureDir(childCwd);
ensureDir(artifactsDir);
ensureDir(sessionDir);
writeLive({ status: "starting", phase: "workspace_prepared", event: "workspace_prepared" });

// 任务包从 async-core 写入任务目录的 JSON 读取；任务文本只给模型看。
function readTaskPackageFile(file) {
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed?.task_package && typeof parsed.task_package === "object" ? parsed.task_package : parsed;
  } catch (error) {
    failEarly(result, "child_task_failed", `任务包文件无法读取:${file}:${error?.message || error}`);
  }
}
const reviewTaskPackage = readTaskPackageFile(taskPackageFile);
const evidenceOnlyTask = evidenceOnlyPackage(reviewTaskPackage);
const structuredReviewTask = structuredReviewPackage(reviewTaskPackage);
const declaredToolSelection = taskToolSelection(reviewTaskPackage);
if (declaredToolSelection.error) {
  failEarly(result, "invalid_tool_contract", declaredToolSelection.error);
}
const roleResolution = runtimeRoleFromTask(reviewTaskPackage);
if (roleResolution.status !== "ok") {
  const detail = roleResolution.status === "invalid_role"
    ? `runtime role 非法:${roleResolution.role}。请在任务包 agent.runtime_role 或 agent.role 中提供合法角色名。`
    : "缺少 runtime role。请在任务包 agent.runtime_role 或 agent.role 中提供已配置角色；无法在身份不明时校验已保存档位范围。";
  failEarly(result, "invalid_model_effort", detail);
}
const envControlRoot = String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
let modelConfigSources = null;
try {
  // 来源解析与父进程选型同源：显式运行根 → 旧环境兼容入口 → 脚本根；项目侧只认显式声明。
  const binding = reviewTaskPackage?.extensions?.model_config;
  modelConfigSources = binding
    ? resolveModelConfigSources({ roots: [{ root: binding.global_root, source: "runtime_root" }], projectRoot: binding.project_root })
    : resolveModelConfigForEffort({
      explicitRuntimeRoot: args.runtimeRoot !== undefined || process.env.SUBAGENT_RUNTIME_ROOT ? runtimeRoot : null,
      opsRoot: skillRoot,
      projectRoot: targetCwd,
    });
  result.selection.model_config = modelConfigSources.describe();
} catch (error) {
  const message = error instanceof ModelConfigError || error?.name === "ModelConfigError"
    ? error.message
    : String(error?.message || error);
  result.selection.model_config = {
    status: "unavailable",
    runtime_root: runtimeRoot,
    project_root: targetCwd,
    legacy_env_root: envControlRoot || null,
    error: message,
  };
  failEarly(result, "invalid_model_effort", message);
}
const roleConfigFile = modelConfigSources.roleConfigPath(roleResolution.role);
result.selection.model_config.role_file = roleConfigFile;
if (!existsSync(roleConfigFile)) failEarly(result, "invalid_model_effort", `缺少角色配置:${roleConfigFile}。`);
if (!model || !effort) {
  failEarly(result, "invalid_model_effort", "必须同时提供 --model 与 --effort：档位按模型可选档位校验，不交给 Pi 自选默认。");
}
try {
  result.selection.effort_check = frozenSelection
    ? checkFrozenEffort(frozenSelection, model, effort)
    : (() => {
      const efforts = modelEfforts(loadSelectionConfig(modelConfigSources), model);
      if (!efforts.includes(effort)) throw new Error(`${effort} 不在 ${model} 的可选档位（${efforts.join("/")}）内。`);
      return { source: "model_notes", model, effort, efforts };
    })();
} catch (error) {
  failEarly(result, "invalid_model_effort", String(error?.message || error));
}

// 旧包从角色 × 能力配置恢复资源及工具；显式任务合同优先，配置缺口直接报出。
let workerResourceSpec = reviewTaskPackage?.worker_resources;
let recoveredTools = null;
if (!workerResourceSpec) {
  const role = roleResolution.role;
  try {
    const capability = String(reviewTaskPackage?.agent?.capability?.name || "").trim();
    const recovered = resolveWorkerResources(loadSelectionConfig(modelConfigSources), role, capability);
    if (recovered) {
      recoveredTools = recovered.tools;
      workerResourceSpec = {
        extensions: recovered.extensions, skills: recovered.skills, project_skills: recovered.project_skills,
        source: { role, capability, recovered_from: "legacy_role_resources" },
      };
      result.warnings.push(`旧任务包缺少 worker_resources；按当前角色 ${role} 的资源配置恢复。`);
    }
  } catch (error) {
    failEarly(result, "worker_resources_unavailable", `无法恢复旧任务包的角色资源：${error.message}`);
  }
}
workerResourceSpec ??= { extensions: [], skills: [], project_skills: "none" };
const effectiveToolAllowlist = evidenceOnlyTask ? [] : declaredToolSelection.tools ?? recoveredTools;
// 导入范围给出工具资格与默认开启项；工具面规则见 pi_worker_resources.mjs 头注释。
const workerResourcesConfigPath = path.join(runtimeRoot, "ops", "templates", "worker-resources.json");
let workerImports;
try {
  workerImports = loadWorkerResourcesConfig(workerResourcesConfigPath);
} catch (error) {
  failEarly(result, "worker_resources_unavailable", error.message);
}
const toolSurface = workerSpawnTools(effectiveToolAllowlist, workerImports);
for (const name of toolSurface.dropped) result.warnings.push(`任务工具 ${name} 在导入范围里不开放或未记录，本次不启用。`);
const toolEnabled = (name) => (toolSurface.tools === null ? workerImports.tools[name]?.access === "default_on" : toolSurface.tools.includes(name));
const commandJobsEnabled = toolRuntimeExtensionPaths.length > 0 && !evidenceOnlyTask && toolEnabled("command_job");
let commandJobsConfig = null;
if (commandJobsEnabled) {
  const jobsExtensionPath = resolveSiblingExtension(["pi_child_command_jobs.mjs", "pi_child_command_jobs.bundle.mjs"]);
  if (!jobsExtensionPath) failEarly(result, "transport_failed", "Command jobs runtime is missing; rebuild/deploy the runner.");
  commandJobsConfig = { root: commandJobsRoot, cwd: childCwd, owner: attemptId || runId,
    shell: resolveChildBash(), controlFile, attemptId };
  extensionPaths.push(jobsExtensionPath);
}
const structuredReviewWriteTool = structuredReviewTask && (effectiveToolAllowlist === null || effectiveToolAllowlist.includes("write"));
const guardedDirectTools = (effectiveToolAllowlist || ["write", "edit"]).filter((name) => ["write", "edit"].includes(name));
const forceExcludedTools = excludedTools(workerImports);
let workerResources = { spec: workerResourceSpec, extensions: [], skills: [], warnings: [] };
try {
  if (evidenceOnlyTask || process.env.PI_CONTROL_PI?.trim()) {
    extensionPaths.push(...resolvePiChildModelExtensions(), ...resolvePiChildCompactionExtensions());
  } else {
    const installed = await discoverWorkerResources({ cwd: targetCwd, piCli });
    workerResources = { spec: workerResourceSpec, ...selectTaskResources(workerImports, installed, workerResourceSpec) };
    for (const resource of workerResources.extensions) if (!extensionPaths.includes(resource.path)) extensionPaths.push(resource.path);
    for (const source of installed.missing) result.warnings.push(`Configured Pi resource is not installed: ${source}`);
    for (const item of workerResources.warnings) {
      result.warnings.push({
        off: `任务清单的 ${item.type} ${item.name} 在导入范围里不开放或未记录，本次不加载。`,
        not_installed: `任务清单的 ${item.type} ${item.name} 本机未安装，本次不加载。`,
        shadowed_by_user_skill: `项目级 skill ${item.name} 与已选用户级 skill 同名，本次跳过。`,
      }[item.reason]);
    }
  }
} catch (error) {
  failEarly(result, "worker_resources_unavailable", error.message);
}
result.selection.workerResources = workerResources;
// grep / find 由 pi_search_extension 以同名注册覆盖内置版；只在工具面含其一时加载，缺失即运行包不完整。
if (toolEnabled("grep") || toolEnabled("find")) {
  const searchExtensionPath = resolveSiblingExtension(RUNNER_FIXED_EXTENSIONS.search);
  if (!searchExtensionPath) failEarly(result, "transport_failed", "Search tools extension (pi_search_extension) is missing beside runner; rebuild/deploy the runner.");
  result.selection.runnerExtensions.search = searchExtensionPath;
  extensionPaths.push(searchExtensionPath);
}
const workerToolsExtensionPath = resolveSiblingExtension(RUNNER_FIXED_EXTENSIONS.worker_tools);
if (!workerToolsExtensionPath) failEarly(result, "worker_resources_unavailable", "Missing pi_worker_tools_extension beside runner; rebuild/deploy the runner.");
result.selection.runnerExtensions.worker_tools = workerToolsExtensionPath;
extensionPaths.push(workerToolsExtensionPath);
const transientRetryPath = resolveSiblingExtension(RUNNER_FIXED_EXTENSIONS.transient_retry);
result.selection.runnerExtensions.transient_retry = transientRetryPath;
if (transientRetryPath && !extensionPaths.includes(transientRetryPath)) extensionPaths.push(transientRetryPath);
else if (!transientRetryPath) {
  result.warnings.push("瞬时服务错误分类扩展不在运行目录；本次不追加原生重试提示。");
}
if (reviewTaskPackage?.runtime_context?.fast === true) {
  const fastModePath = fastModeExtensionPath(path.dirname(fileURLToPath(import.meta.url)));
  if (!fastModePath) failEarly(result, "transport_failed", "Missing pi_fast_mode beside runner; rebuild/deploy the runner.");
  if (!extensionPaths.includes(fastModePath)) extensionPaths.push(fastModePath);
  result.selection.fast = true;
}
let writeDomainSpec = null;
if (writeDomainSpecPath) {
  try {
    const input = JSON.parse(readFileSync(writeDomainSpecPath, "utf8"));
    if (!input || typeof input !== "object" || !Array.isArray(input.paths)) {
      throw new Error("write-domain spec must contain paths[]");
    }
    if (input.contract_version !== PI_CHILD_WRITE_DOMAIN_PROFILE) {
      throw new Error(`write-domain spec contract_version must be ${PI_CHILD_WRITE_DOMAIN_PROFILE}`);
    }
    writeDomainSpec = parseWriteDomainSpec(JSON.stringify({
      version: PI_CHILD_WRITE_DOMAIN_PROFILE,
      taskId: input.task_id || null,
      allowed: input.paths,
      deleteAllowed: Array.isArray(input.delete_paths) ? input.delete_paths : [],
      // 与提示词口径一致:产物目录与本次证据目录都可写；运行包只读，任何任务都不因 marker/链接自动扩权。
      roots: [artifactsDir, outDir],
      runtimeRoot: existsSync(path.join(runtimeRoot, "consumer-release-manifest.json")) ? runtimeRoot : null,
      log: writeDomainAuditPath,
      caseInsensitive: input.case_insensitive === true,
    }), { baseDir: targetCwd });
  } catch (error) {
    failEarly(result, "invalid_write_domain", `写域规格不可用:${writeDomainSpecPath}: ${error?.message || error}`);
  }
}
const writeDomainExtensionPath = writeDomainSpec
  ? resolveSiblingExtension(["pi_write_domain_extension.mjs", "pi_write_domain_extension.bundle.mjs"])
  : null;
if (writeDomainSpec) {
  if (!writeDomainExtensionPath) {
    failEarly(result, "invalid_write_domain", "pi write-domain extension is missing beside the runner");
  }
  rmSync(writeDomainAuditPath, { force: true });
  extensionPaths.push(writeDomainExtensionPath);
}
result.write_domain = {
  ...result.write_domain,
  enabled: Boolean(writeDomainSpec),
  scope_compliant: null,
  audit_complete: null,
  audit_path: writeDomainSpec ? writeDomainAuditPath : null,
  claim_path_count: writeDomainSpec?.allowed?.length ?? 0,
  delete_path_count: writeDomainSpec?.deleteAllowed?.length ?? 0,
  artifact_root_count: writeDomainSpec?.roots?.length ?? 0,
  guarded_tools: guardedDirectTools,
  command_tools_present: (effectiveToolAllowlist || ["bash", "powershell"]).filter((name) => ["bash", "powershell"].includes(name)),
};
result.permission.write_domain_guard = writeDomainSpec
  ? { profile: PI_CHILD_WRITE_DOMAIN_PROFILE, guarded_tools: guardedDirectTools, command_write_enforced: false }
  : null;

// structured review 任务注入 submit_review_result 工具:结果经工具当场校验落盘,
// 失败同回合修正,替代"最终回复内联 JSON、事后解析失败整单作废"。pi 的 -t 白名单
// 同样过滤扩展注册的工具(实测:notes/general/pi-custom-tool-registration-probe.md),
// 故工具名必须进 spawn 白名单;evidence_only 由 --no-tools 改为仅暴露该提交工具。
// 扩展与 runner 同目录同名发布:HUB 散文件即源文件,货架由部署面改名拷贝。
function resolveSiblingExtension(names) {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  for (const name of names) {
    const candidate = path.join(selfDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const reviewResultExtensionPath = structuredReviewTask
  ? resolveSiblingExtension(["pi_review_result_extension.mjs", "pi_review_result_extension.bundle.mjs"])
  : null;
const reviewResultToolEnabled = Boolean(reviewResultExtensionPath);
if (structuredReviewTask && !reviewResultToolEnabled) {
  result.warnings.push(
    "submit_review_result 扩展不可用(运行目录缺 pi_review_result_extension.mjs);结构化结果退回最终回复内联 JSON 链路。",
  );
}
if (reviewResultToolEnabled) {
  extensionPaths.push(reviewResultExtensionPath);
}
// 普通任务注入 submit_task_result 工具:报告与 FINAL_HANDOFF 由单一渲染器写出并当场跑 checker,
// 子代理不再手写 YAML handoff 或经 bash 调 checker。任务包声明了报告与 handoff 时扩展是必需件，缺失即运行包不完整。
const handoffCheckSpec = parseHandoffCheckSpec(stringArg(args, "handoffCheck", ""));
const taskResultPaths = !structuredReviewTask && reviewTaskPackage
  ? taskResultOutputPaths(reviewTaskPackage, targetCwd)
  : { reportPath: null, handoffPath: null };
const taskResultExtensionPath = taskResultPaths.reportPath && taskResultPaths.handoffPath
  ? resolveSiblingExtension(["pi_task_result_extension.mjs", "pi_task_result_extension.bundle.mjs"])
  : null;
if (taskResultPaths.reportPath && taskResultPaths.handoffPath && !taskResultExtensionPath) {
  failEarly(result, "transport_failed", "Task result extension (pi_task_result_extension) is missing beside runner; rebuild/deploy the runner.");
}
const taskResultToolEnabled = Boolean(taskResultExtensionPath);
if (taskResultToolEnabled) {
  extensionPaths.push(taskResultExtensionPath);
}
const submitTool = reviewResultToolEnabled ? "submit_review_result" : taskResultToolEnabled ? TASK_RESULT_TOOL_NAME : null;
// command_job 只在其运行扩展已加载时进入工具面（受控 stub 与 evidence_only 不加载）。
const spawnToolAllowlist = toolSurface.tools === null ? null
  : [...toolSurface.tools.filter((name) => name !== "command_job" || commandJobsEnabled), ...(submitTool ? [submitTool] : [])];
workerResources.tools = spawnToolAllowlist;
result.permission.force_excluded_tools = forceExcludedTools;
result.permission.answer_mode = spawnToolAllowlist === null ? "configured_tools" : "tool_allowlist";
result.permission.tool_allowlist = spawnToolAllowlist;
result.permission.tool_inventory_path = workerToolsSnapshotPath;
result.permission.tool_allowlist_source = declaredToolSelection.source;
result.permission.structured_review_write_tool = structuredReviewWriteTool;
result.permission.evidence_only_no_tools = evidenceOnlyTask && !reviewResultToolEnabled;
result.permission.review_result_tool = reviewResultToolEnabled;
result.permission.task_result_tool = taskResultToolEnabled;
const templatePath = path.join(
  runtimeRoot,
  "ops",
  "templates",
  structuredReviewTask ? "review-evidence-prompt-template.md" : "handoff-prompt-template.md",
);
// 工具清单不含 write（如无工具的专家问询）时写不出交卷文件，改为直接内联传参。
const inlineSubmission = Array.isArray(spawnToolAllowlist) && !spawnToolAllowlist.includes("write");
const resultSubmissionText = taskResultToolEnabled && inlineSubmission
  ? [
      "做完后直接调用 `submit_task_result`，内联传 verdict、summary、sections（按任务卡的报告章节逐节写 Markdown）、",
      "output（业务门与能力合同要求的字段）、scope_actual、evidence_refs；取值与必需章节见其参数说明。",
      "返回 ok:false 时按 errors / issues 修正后再提交；返回 ok:true 即交付完成，最终回复一句话写明任务状态与报告路径。",
    ].join("")
  : taskResultToolEnabled
  ? [
      `做完后先用写文件工具把交卷字段写成 JSON 文件 \`${taskResultDraftPath}\`：verdict、summary、sections（按任务卡的报告章节`,
      "逐节写 Markdown）、output（业务门与能力合同要求的字段）、scope_actual、evidence_refs；verdict 取值与必需章节见 ",
      "`submit_task_result` 的参数说明。再调用 `submit_task_result`，只传 payload_path。返回 ok:false 时按 errors / issues ",
      "修正文件后再提交；返回 ok:true 即交付完成，最终回复一句话写明任务状态与报告路径。工具调用发不出时，文件写好后直接结束回复，",
      "runner 会读取该文件按同一套校验代为提交，有缺口会发回给你修正。",
    ].join("")
  : "本任务没有声明报告与 handoff 文件，最终回复按下面六节写即为交付。";
// 六节正文是未声明报告文件时的交付格式；声明了报告并注入 submit_task_result 时，交付以工具提交为准，模板中的六节块整段去掉。
const FINAL_REPLY_SECTIONS_BLOCK = /<!-- final-reply-sections -->\n?([\s\S]*?)<!-- \/final-reply-sections -->\n?/;
// 审查轨同理：submit_review_result 可用时交卷即交付，六节块换成一句收尾要求；工具缺席时保留六节与内联 JSON 退回链路。
const REVIEW_TOOL_DELIVERY = "结构化结果用 `submit_review_result` 提交；返回 ok:true 即交付完成，最终回复一句话写明 gate 与结论。\n";
const template = readFileSync(templatePath, "utf8")
  .replace(FINAL_REPLY_SECTIONS_BLOCK, structuredReviewTask
    ? (reviewResultToolEnabled ? REVIEW_TOOL_DELIVERY : "$1")
    : (taskResultToolEnabled ? "" : "$1"))
  .replace("{{RESULT_SUBMISSION}}", resultSubmissionText);
const taskHeadline = String(reviewTaskPackage?.goal || "").trim().split("\n")[0];
const handoffPrompt = fillTemplate(template, taskText, {
  contextMode,
  childCwd,
  targetCwd,
  artifactsDir,
  outDir,
  runtimeName: RUNTIME_NAME,
  taskReminder: taskHeadline ? `再次确认：本次任务是「${taskHeadline}」。按任务卡的完成条件全部做完再交付。` : "",
});
writeFileSync(path.join(outDir, "child-handoff.md"), handoffPrompt, "utf8");
writeLive({ status: "starting", phase: "handoff_prompt_prepared", event: "handoff_prompt_prepared" });

const promptMessage = resumeSession
  ? CONTINUE_INTERRUPTED_PROMPT
  : simProfile
    ? `${simulationProfilePrompt(simProfile)}\n\n${handoffPrompt}`
    : handoffPrompt;

// system 追加层：worker 通用规则在前，本次角色卡在后；角色卡只从角色配置读取，不进任务材料。
const roleInstructions = String(
  parseToml(readFileSync(modelConfigSources.roleConfigPath(roleResolution.role), "utf8")).developer_instructions || "",
).trim();
const taskSystemPromptPath = path.join(outDir, "worker-system.md");
writeFileSync(
  taskSystemPromptPath,
  `${readFileSync(workerSystemPromptPath, "utf8").trimEnd()}\n${roleInstructions ? `\n<role name="${roleResolution.role}">\n${roleInstructions}\n</role>\n` : ""}`,
  "utf8",
);

// ---------- spawn 规格 ----------

const piArgs = [
  piCli,
  "--mode", "rpc",
  "-ne", "-ns", "-np", "--no-themes", "-nc", "--no-approve",
  "--append-system-prompt", taskSystemPromptPath,
  "--session-dir", sessionDir,
  ...(resumeSession ? ["--session", resumeSession] : []),
];
if (modelRef.ok) {
  piArgs.push("--provider", modelRef.provider, "--model", modelRef.modelId);
}
if (effort) {
  piArgs.push("--thinking", effort);
}
for (const extPath of extensionPaths) {
  piArgs.push("-e", extPath);
}
for (const skill of workerResources.skills) piArgs.push("--skill", skill.path);
if (Array.isArray(spawnToolAllowlist)) {
  if (spawnToolAllowlist.length > 0) {
    piArgs.push("-t", spawnToolAllowlist.join(","));
  } else {
    piArgs.push("--no-tools");
  }
}
if (forceExcludedTools.length) piArgs.push("-xt", forceExcludedTools.join(","));

if (reviewResultToolEnabled || taskResultToolEnabled) {
  // 复用 outDir 时的上次残留会被事后收割误吃,先清。
  rmSync(reviewResultPath, { force: true });
  rmSync(taskResultPayloadPath, { force: true });
}
// 任务包同时是 worker 身份来源（research 工具面等），不随交卷通道启用与否。
if (reviewTaskPackage) writeFileSync(reviewTaskPackagePath, `${JSON.stringify(reviewTaskPackage, null, 2)}\n`, "utf8");
// Core 每个 attempt 复用同一 artifactsDir：上一 attempt 的交卷文件会被代收成本轮交付，新 attempt 先清。
// 续跑自己会话（--resumeSession）时文件属于同一会话，保留。
if (taskResultToolEnabled && !resumeSession) rmSync(taskResultDraftPath, { force: true });

// 结构化交卷成功（自检通过、未配置自检，或 checker 自身故障 error）时，业务状态取提交的 verdict；
// 否则退回解析最终回复正文。error 是基础设施故障，改结果字段修不好：记交付，不发修正轮，交父级复核 handoff。
const SUBMITTED_VERDICT_STATUS = new Map([
  ["done", "completed"], ["completed", "completed"], ["pass", "completed"],
  ["partial", "partial"],
  ["needs_owner", "blocked"], ["needs_split", "blocked"], ["blocked", "blocked"],
  ["failed", "failed"], ["fail", "failed"],
]);
function submittedTaskStatus(taskResult) {
  if (!taskResult?.submitted || !["pass", "not_configured", "error"].includes(taskResult.handoff_check_status)) return null;
  return SUBMITTED_VERDICT_STATUS.get(String(taskResult.verdict || "").trim().toLowerCase()) ?? null;
}

// submit_task_result 的提交回执:扩展落盘 task-result.json(负载 + checker 结果),runner 只读投影。
function readTaskResultSubmission() {
  if (!taskResultToolEnabled) return { enabled: false, submitted: false };
  if (!existsSync(taskResultPayloadPath)) {
    return { enabled: true, submitted: false, payload_path: taskResultPayloadPath };
  }
  try {
    const record = JSON.parse(readFileSync(taskResultPayloadPath, "utf8"));
    return {
      enabled: true,
      submitted: true,
      payload_path: taskResultPayloadPath,
      submitted_at: record.submitted_at ?? null,
      verdict: record.result?.verdict ?? null,
      handoff_check_status: record.handoff_check?.status ?? null,
      handoff_check_issues: Array.isArray(record.handoff_check?.issues) ? record.handoff_check.issues : [],
      scope_compliant: record.scope_validation?.compliant ?? null,
      write_domain_audit_complete: record.scope_validation?.audit_complete ?? null,
      write_domain_violation_count: record.scope_validation?.violation_count ?? 0,
      write_domain_blocked_count: record.scope_validation?.blocked_count ?? 0,
      write_domain_reported_violation_count: record.scope_validation?.reported_violation_count ?? 0,
      write_domain_reported_violations: Array.isArray(record.scope_validation?.reported_violations)
        ? record.scope_validation.reported_violations.slice(0, 50)
        : [],
    };
  } catch (error) {
    return { enabled: true, submitted: false, payload_path: taskResultPayloadPath, error: String(error?.message || error) };
  }
}

// 09-25 grok 长上下文下交卷文件已写好，submit_task_result 调用却总被 shell 工具吸走成空转命令。
// 约定文件存在且还没有成功交卷时，runner 按扩展同一条路径（校验、渲染、handoff 自检、写域审计）代收。
const TASK_RESULT_DRAFT_FIX_ROUNDS = 2;
function ingestTaskResultDraft(trigger) {
  if (!taskResultToolEnabled || !existsSync(taskResultDraftPath)) return null;
  if (submittedTaskStatus(readTaskResultSubmission())) return null;
  const outcome = submitTaskResult({
    raw: { payload_path: taskResultDraftPath },
    taskPackagePath: reviewTaskPackagePath,
    reportPath: taskResultPaths.reportPath,
    handoffPath: taskResultPaths.handoffPath,
    payloadPath: taskResultPayloadPath,
    checkSpec: handoffCheckSpec,
    writeDomainSpec,
    cwd: childCwd,
  });
  const gaps = [...(outcome.errors ?? []), ...(outcome.handoff_check?.issues ?? []).map(String)];
  // 是否交付以落盘的提交记录为准，与收尾投影同一判据；checker 自身故障不进修正轮。
  const ok = outcome.ok === true || Boolean(submittedTaskStatus(readTaskResultSubmission()));
  result.task_result_ingestions = [...(result.task_result_ingestions ?? []), {
    trigger,
    ok,
    gaps: gaps.slice(0, 20),
    at: new Date().toISOString(),
  }];
  writeLive({ status: "running", phase: "result_collection", event: "task_result_draft_ingested", force_record_event: true,
    event_extra: { task_result_ingestion: { trigger, ok } } });
  return { ok, gaps };
}

function taskResultDraftFixPrompt(gaps) {
  return [
    `交卷文件 \`${taskResultDraftPath}\` 未通过校验：`,
    ...gaps.slice(0, 20).map((gap) => `- ${gap}`),
    "",
    "修正该文件后调用 `submit_task_result`（只传 payload_path），或写好后直接结束回复。",
  ].join("\n");
}

// ---------- 事件消费 ----------

const eventLog = [];
const toolCallIndex = new Map();
const turnReceipts = [];
// 与 turnReceipts 同下标的 assistant 正文;正文不进身份快照,避免证据文件被整篇回复撑爆。
const turnTexts = [];
const uiRequests = [];
let failedToolCallCount = 0;
let failedBashToolCount = 0;
// 需要整树回收的只是没正常结束的 Bash（超时、中止、无退出码、起不来）。命令跑完只是退出码非零
// （grep 无匹配、测试报红）时，Pi bash 以 `Command exited with code N` 结尾报错，进程已退出。
const interruptedBashToolIds = new Set();
const BASH_EXITED_NONZERO = /Command exited with code \d+\s*$/;
function bashExitedNormally(event) {
  const content = Array.isArray(event?.result?.content) ? event.result.content : [];
  return BASH_EXITED_NONZERO.test(content.filter((part) => part?.type === "text").map((part) => part.text).join("\n"));
}
let messageUpdateCount = 0;
let settledCount = 0;
let activityGeneration = 0;
let modelActivityObserved = false;
let compactionsStarted = 0;
let compactionsEnded = 0;
const toolLoop = { window: [], noopStreak: 0, tripped: null, warned: false };
const compactionLog = [];
const eventWaiters = new Set();

// 事件等待器:按谓词等一条 pi 事件,超时返回 null。回合结束判定与压缩等待都靠 pi 的事件与状态,不靠错误文本。
function waitForEvent(match, ms) {
  return new Promise((resolve) => {
    const waiter = { match, resolve: null };
    const timer = setTimeout(() => {
      eventWaiters.delete(waiter);
      resolve(null);
    }, Math.max(1, ms));
    // 预算级长定时器不得拖住进程:运输失败(client.failed)抢先时,残留 waiter 只能随进程自然退出。
    timer.unref();
    waiter.resolve = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    eventWaiters.add(waiter);
  });
}

function notifyEventWaiters(type, message) {
  for (const waiter of [...eventWaiters]) {
    if (waiter.match(type, message)) {
      eventWaiters.delete(waiter);
      waiter.resolve({ type, message });
    }
  }
}

function recordEvent(entry) {
  eventLog.push({ at: new Date().toISOString(), ...entry });
  if (eventLog.length > 4000) {
    eventLog.splice(0, eventLog.length - 4000);
  }
}

function toolCallCounts() {
  return countBy([...toolCallIndex.values()], (item) => item.name ?? item.type ?? "unknown");
}

function stableToolArgs(value) {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(stableToolArgs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableToolArgs(value[key])]));
}

function toolCallSignature(message) {
  const name = String(message?.toolName ?? "unknown");
  const args = stableToolArgs(message?.args ?? null);
  let argsText;
  try {
    argsText = JSON.stringify(args) ?? "null";
  } catch {
    argsText = String(args);
  }
  return `${name} ${argsText}`;
}

// 已确认空转首次判定后闩住，由 deadlineBounded 的 tool_loop 候选驱动 abort 与关停。
function tripToolLoop(tripped) {
  toolLoop.tripped = tripped;
  result.tool_loop = tripped;
  writeLive({
    status: "running",
    phase: "tool_call",
    event: "tool_loop_detected",
    force_record_event: true,
    tool_loop: tripped,
    event_extra: { tool_loop: tripped },
  });
}

function observeToolCallStart(message) {
  const command = TOOL_LOOP_COMMAND_TOOLS.has(String(message?.toolName)) ? message?.args?.command : null;
  toolLoop.noopStreak = typeof command === "string" && TOOL_LOOP_NOOP_COMMAND.test(command.trim()) ? toolLoop.noopStreak + 1 : 0;
  if (!toolLoop.tripped && toolLoop.noopStreak >= TOOL_LOOP_NOOP_STREAK) {
    tripToolLoop({
      kind: "noop_commands",
      noop_streak: toolLoop.noopStreak,
      signatures: [{ preview: redactText(toolCallSignature(message)).slice(0, 300), count: toolLoop.noopStreak }],
      detected_at: new Date().toISOString(),
    });
  }
  toolLoop.window.push(toolCallSignature(message));
  if (toolLoop.window.length > TOOL_LOOP_WINDOW) toolLoop.window.shift();
  if (toolLoop.tripped || toolLoop.warned || toolLoop.window.length < TOOL_LOOP_WINDOW) return;
  const counts = new Map();
  for (const signature of toolLoop.window) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  if (counts.size > TOOL_LOOP_MAX_DISTINCT || [...counts.values()].some((count) => count < 2)) return;
  toolLoop.warned = true;
  const warning = {
    kind: "signature_window",
    window: TOOL_LOOP_WINDOW,
    max_distinct: TOOL_LOOP_MAX_DISTINCT,
    signatures: [...counts].map(([signature, count]) => ({ preview: redactText(signature).slice(0, 300), count })),
    detected_at: new Date().toISOString(),
  };
  result.tool_progress_warning = warning;
  writeLive({
    status: "running",
    phase: "tool_call",
    event: "tool_progress_warning",
    force_record_event: true,
    tool_progress_warning: warning,
    event_extra: { tool_progress_warning: warning },
  });
}

function isModelActivity(type, message) {
  if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(type)) return true;
  if (type === "message_update" && message?.message?.role === "assistant") return true;
  return type === "message_end" && message?.message?.role === "assistant";
}

function handlePiEvent(message) {
  const type = String(message?.type ?? "unknown");
  if (isModelActivity(type, message)) modelActivityObserved = true;
  if (ACTIVITY_EVENT_TYPES.has(type)) {
    activityGeneration += 1;
  }
  if (type === "agent_settled") {
    settledCount += 1;
  } else if (type === "compaction_start") {
    compactionsStarted += 1;
    compactionLog.push({ reason: message?.reason ?? null, started_at: new Date().toISOString(), ended_at: null, aborted: null, error: null });
  } else if (type === "compaction_end") {
    compactionsEnded += 1;
    const entry = compactionLog.find((item) => item.ended_at === null);
    if (entry) {
      entry.ended_at = new Date().toISOString();
      entry.aborted = message?.aborted === true;
      entry.error = message?.errorMessage ? redactText(String(message.errorMessage)).slice(0, 500) : null;
    }
  }
  notifyEventWaiters(type, message);
  if (type === "message_update") {
    messageUpdateCount += 1;
    // token_usage 只在 message_end 后按累计值更新;流式期间不用单条快照覆盖,避免多轮任务的
    // live 数值在单条与累计之间跳变。
    writeLive({
      status: "running",
      phase: "response_item",
      event: "message_update",
      last_notification_method: "message_update",
    });
    return;
  }
  if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
    if (type === "tool_execution_start") observeToolCallStart(message);
    const compact = compactPiToolCall(message);
    if (compact?.id) {
      const previous = toolCallIndex.get(String(compact.id)) ?? {};
      toolCallIndex.set(String(compact.id), {
        id: compact.id,
        type: previous.type ?? compact.type ?? null,
        name: previous.name ?? compact.name ?? null,
        status: compact.status ?? previous.status ?? null,
        command_preview: compact.command_preview ?? previous.command_preview ?? null,
        full_output_path: compact.full_output_path ?? previous.full_output_path ?? null,
      });
    }
    if (type !== "tool_execution_update") {
      recordEvent({ type, toolCallId: compact?.id ?? null, toolName: compact?.name ?? null, isError: message?.isError === true });
      if (type === "tool_execution_end" && message?.isError === true) {
        failedToolCallCount += 1;
        if (compact?.name === "bash") {
          failedBashToolCount += 1;
          if (!bashExitedNormally(message)) interruptedBashToolIds.add(compact.id);
        }
      }
    }
    writeLive({
      status: "running",
      phase: "tool_call",
      event: type,
      last_notification_method: type,
      last_tool_call: compact?.id ? toolCallIndex.get(String(compact.id)) : live.state.last_tool_call,
      tool_call_counts: toolCallCounts(),
    });
    return;
  }
  if (type === "message_end" && message?.message?.role === "assistant") {
    const assistant = message.message;
    const usage = compactUsage(assistant.usage);
    const text = assistantText(assistant);
    const receipt = {
      index: turnReceipts.length,
      phase: currentTurnPhase,
      model: assistant.model ?? null,
      provider: assistant.provider ?? null,
      responseModel: assistant.responseModel ?? null,
      api: assistant.api ?? null,
      stopReason: assistant.stopReason ?? null,
      errorMessage: assistant.errorMessage ? redactText(String(assistant.errorMessage)).slice(0, 2000) : null,
      usage,
      textLength: text.length,
      at: new Date().toISOString(),
    };
    turnReceipts.push(receipt);
    turnTexts.push(text);
    const applied = result.identity?.applied;
    if (applied?.model && (receipt.provider !== applied.provider || receipt.model !== applied.model)) {
      result.identity.turnReceiptMismatch = true;
      result.warnings.push(
        `第 ${turnReceipts.length} 条 assistant 回执 ${receipt.provider ?? "?"}/${receipt.model ?? "?"} 与实收身份 ` +
          `${applied.provider ?? "?"}/${applied.model ?? "?"} 不符。`,
      );
    }
    addUsage(result.usage, usage);
    live.state.token_usage = { ...result.usage };
    recordEvent({ type, model: receipt.model, provider: receipt.provider, stopReason: receipt.stopReason });
    writeLive({
      status: "running",
      phase: "response_item",
      event: "message_end",
      last_notification_method: "message_end",
      last_turn_receipt: {
        model: receipt.model,
        provider: receipt.provider,
        responseModel: receipt.responseModel,
        stopReason: receipt.stopReason,
      },
    });
    return;
  }
  if (type === "auto_retry_start" || type === "auto_retry_end" || type === "compaction_start" || type === "compaction_end") {
    const detail = redactAuth({
      attempt: message?.attempt ?? null,
      maxAttempts: message?.maxAttempts ?? null,
      reason: message?.reason ?? null,
      success: message?.success ?? null,
      errorMessage: message?.errorMessage ?? message?.finalError ?? null,
    });
    result.warnings.push(`pi 事件 ${type}:${JSON.stringify(detail)}`);
    recordEvent({ type, detail });
    writeLive({
      status: "running",
      phase: phaseFromPiEvent(type) ?? live.state.phase,
      event: type,
      force_record_event: true,
      event_extra: { detail },
      last_notification_method: type,
    });
    return;
  }
  if (type === "agent_settled") {
    recordEvent({ type });
    writeLive({ status: "running", phase: "turn_completed", event: "agent_settled", last_notification_method: type });
    return;
  }
  recordEvent({ type });
  const nextPhase = phaseFromPiEvent(type) ?? live.state.phase;
  writeLive({ status: "running", phase: nextPhase, event: type, last_notification_method: type });
}

// 后台 RPC 不进行用户交互；extension UI 请求按无确认/取消应答并记观测。
function handleUiRequest(message) {
  const method = String(message?.method ?? "unknown");
  uiRequests.push({ method, at: new Date().toISOString() });
  result.warnings.push(`Pi 后台扩展发出 UI 请求(method=${method});已记录，不进行用户交互。`);
  let reply = null;
  if (method === "confirm") {
    reply = { type: "extension_ui_response", id: message.id, confirmed: false };
  } else if (["select", "input", "editor"].includes(method)) {
    reply = { type: "extension_ui_response", id: message.id, cancelled: true };
  }
  result.permission.decisions.push({
    source: "extension_ui_request",
    method,
    effective: reply ? (method === "confirm" ? "deny" : "cancelled") : "ignored",
    at: new Date().toISOString(),
  });
  writeLive({
    status: "running",
    phase: live.state.phase,
    event: "extension_ui_request",
    force_record_event: true,
    event_extra: { ui_request: { method, answered: Boolean(reply) } },
  });
  return reply;
}

let currentTurnPhase = "bootstrap";

const childExtensionEnv = {
  // 插件无法区分watchdog中止与用户取消；默认只保留错误分类，显式配置可覆盖。
  PI_RETRY_STALL_TIMEOUT_MS: process.env.PI_RETRY_STALL_TIMEOUT_MS?.trim() || "0",
  PI_COMMAND_JOBS_CONFIG: commandJobsConfig ? JSON.stringify(commandJobsConfig) : "",
  PI_WORKER_TOOLS_PATH: workerToolsSnapshotPath,
  PI_WORKER_INHERIT_TOOLS: spawnToolAllowlist === null ? "1" : "0",
  PI_WORKER_TOOL_SURFACE: spawnToolAllowlist === null ? "" : JSON.stringify(spawnToolAllowlist),
  // 双根显式下传：worker 侧项目面一律以 targetCwd 为本，运行面只读资产以 runtimeRoot 为本。
  SUBAGENT_PROJECT_ROOT: targetCwd,
  SUBAGENT_RUNTIME_ROOT: runtimeRoot,
  PI_WORKER_TASK_PACKAGE_PATH: reviewTaskPackage ? reviewTaskPackagePath : "",
  // runner 自有的结果与审计通道先置空，本次启用时再覆盖。子进程环境是 {...process.env, ...本对象}：
  // 子代理在任务里跑测试、测试再拉起 runner 时，不置空就会继承外层任务的通道，把假数据写进外层的
  // 写域审计（09-24 d4b74295：guard_ready 13 条判不合规）或报告路径。各扩展把空值视为未配置。
  PI_REVIEW_RESULT_PATH: "",
  PI_REVIEW_TASK_PACKAGE_PATH: "",
  PI_TASK_RESULT_TASK_PACKAGE_PATH: "",
  PI_TASK_RESULT_REPORT_PATH: "",
  PI_TASK_RESULT_HANDOFF_PATH: "",
  PI_TASK_RESULT_PAYLOAD_PATH: "",
  PI_TASK_RESULT_HANDOFF_CHECK: "",
  [WRITE_DOMAIN_ENV]: "",
};
if (reviewResultToolEnabled) {
  Object.assign(childExtensionEnv, {
    PI_REVIEW_RESULT_PATH: reviewResultPath,
    PI_REVIEW_TASK_PACKAGE_PATH: reviewTaskPackagePath,
  });
} else if (taskResultToolEnabled) {
  Object.assign(childExtensionEnv, {
    PI_TASK_RESULT_TASK_PACKAGE_PATH: reviewTaskPackagePath,
    PI_TASK_RESULT_REPORT_PATH: taskResultPaths.reportPath,
    PI_TASK_RESULT_HANDOFF_PATH: taskResultPaths.handoffPath,
    PI_TASK_RESULT_PAYLOAD_PATH: taskResultPayloadPath,
    ...(handoffCheckSpec ? { PI_TASK_RESULT_HANDOFF_CHECK: JSON.stringify(handoffCheckSpec) } : {}),
  });
}
if (writeDomainSpec) childExtensionEnv[WRITE_DOMAIN_ENV] = JSON.stringify(writeDomainSpec);

const client = new PiRpcClient({
  command: process.execPath,
  args: piArgs,
  cwd,
  env: childExtensionEnv,
  recordRaw: saveRawEvidence,
  onEvent: handlePiEvent,
  onUiRequest: handleUiRequest,
});

function sendExternalAbort() {
  if (!externalCancellation.requested || externalCancellation.abort_sent || !promptStarted) return;
  externalCancellation.abort_sent = true;
  externalCancellation.deadline_ms = Date.now() + ABORT_SETTLE_WINDOW_MS;
  void client.call("abort", {}, { timeoutMs: 5000 }).then(() => {
    externalCancellation.abort_acknowledged = true;
  }).catch((error) => {
    externalCancellation.abort_error = String(error?.message ?? error);
  });
}

const cancellationReadErrors = new Set();
function inspectCancellationRequest() {
  if (!controlFile || !attemptId || (externalCancellation.requested && externalCancellation.type !== "pause") || (settledIdleConfirmed && !promptStarted) || !existsSync(controlFile)) return false;
  let request;
  try {
    request = JSON.parse(readFileSync(controlFile, "utf8"));
  } catch (error) {
    // 文件在 exists 与读之间被删：下一拍再看。其余读/解析错误照常续轮询，但留痕，不装作没有请求。
    if (error?.code === "ENOENT") return false;
    const message = String(error?.message ?? error);
    // 收到取消后 result.cancellation 由 externalCancellation 整体重建，两处都记才不丢。
    externalCancellation.read_error = message;
    result.cancellation = { ...(result.cancellation ?? {}), read_error: message };
    if (!cancellationReadErrors.has(message)) {
      cancellationReadErrors.add(message);
      result.warnings.push(`取消请求文件读取失败(${controlFile}): ${message};继续轮询。`);
    }
    return false;
  }
  if (!["abort", "pause"].includes(request?.type) || String(request?.attempt_id || "") !== attemptId) return false;
  if (externalCancellation.requested && request.type === "pause") return false;
  const reason = String(request?.reason ?? "").trim();
  if (!reason) return false;
  Object.assign(externalCancellation, {
    requested: true,
    type: request.type,
    reason,
    attempt_id: attemptId,
    requested_at: request.requested_at ?? null,
    detected_at: new Date().toISOString(),
    deadline_ms: Date.now() + ABORT_SETTLE_WINDOW_MS,
  });
  writeLive({
    status: "running",
    phase: live.state.phase,
    event: request.type === "pause" ? "pause_request" : "cancel_request",
    force_record_event: true,
    event_extra: { cancellation: { attempt_id: attemptId, reason } },
  });
  sendExternalAbort();
  return true;
}

function startCancellationMonitor() {
  if (!controlFile || !attemptId || cancellationPoll !== null) return;
  inspectCancellationRequest();
  cancellationPoll = setInterval(inspectCancellationRequest, 100);
  cancellationPoll.unref?.();
}

function stopCancellationMonitor() {
  if (cancellationPoll !== null) clearInterval(cancellationPoll);
  cancellationPoll = null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deadlineBounded(turnDeadlineMs) {
  const now = Date.now();
  if (externalCancellation.type === "pause") {
    // A missed pause deadline is observation, not permission to terminate.
    if (now >= externalCancellation.deadline_ms && !externalCancellation.unconfirmed_reported) {
      externalCancellation.unconfirmed_reported = true;
      writeLive({ status: "running", phase: "pause_unconfirmed", event: "pause_unconfirmed",
        error: "Pi has not confirmed idle after pause; ownership remains active. Inspect get or explicitly cancel if forced termination is intended." });
    }
    return { ms: COMMAND_TIMEOUT_MS, boundedBy: "pause", exhausted: false };
  }
  const globalLeft = remainingGlobalMs();
  const turnLeft = Math.max(0, turnDeadlineMs - now);
  const cancelLeft = externalCancellation.deadline_ms == null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, externalCancellation.deadline_ms - now);
  const candidates = [
    { kind: "global", ms: globalLeft },
    { kind: "turn", ms: turnLeft },
    { kind: "cancel", ms: cancelLeft },
    { kind: "tool_loop", ms: toolLoop.tripped ? 0 : Number.POSITIVE_INFINITY },
  ].sort((left, right) => left.ms - right.ms);
  return {
    ms: Math.max(1, candidates[0].ms),
    boundedBy: candidates[0].kind,
    exhausted: candidates[0].ms <= 0,
  };
}

// 等下一次 agent_settled;运输失败立即打断;turn/global 预算用尽返回 timedOut。
async function waitForSettled(baseline, turnDeadlineMs) {
  while (settledCount <= baseline) {
    const bound = deadlineBounded(turnDeadlineMs);
    if (bound.exhausted) return { timedOut: true, boundedBy: bound.boundedBy };
    const hit = await Promise.race([
      waitForEvent((type) => type === "agent_settled", Math.min(bound.ms, 100)),
      client.failed,
    ]);
    if (hit) return { timedOut: false };
  }
  return { timedOut: false };
}

// 等压缩结束:以 compactionsEnded 计数为准,compaction_end 早于等待注册也不会漏。
async function waitForCompactionEnd(endedBaseline, turnDeadlineMs) {
  while (compactionsEnded <= endedBaseline) {
    const bound = deadlineBounded(turnDeadlineMs);
    if (bound.exhausted) return { timedOut: true, boundedBy: bound.boundedBy };
    const ended = await Promise.race([
      waitForEvent((type) => type === "compaction_end", Math.min(bound.ms, 100)),
      client.failed,
    ]);
    if (ended) return { timedOut: false };
  }
  return { timedOut: false };
}

// 回合结束判定:agent_settled后静默窗无新活动、无压缩在途、get_state自报idle，且任务内command已收尾。
// 压缩在途就等 compaction_end;有新活动(插件续跑、排队消息)就回去等下一次 agent_settled。
// 每一步等待都受 turn/global 预算约束;get_state 失败按运输失败上抛,不当 idle。
async function waitForTurnEnd(baseline, turnDeadlineMs) {
  let settleCycles = 0;
  let commandJobsProjectionKey = null;
  let settledBaseline = baseline;
  for (;;) {
    const settled = await waitForSettled(settledBaseline, turnDeadlineMs);
    if (settled.timedOut) return { ...settled, settleCycles };
    settleCycles += 1;
    settledBaseline = settledCount;
    let agentRestarted = false;
    while (!agentRestarted) {
      if (compactionsStarted > compactionsEnded) {
        const ended = await waitForCompactionEnd(compactionsEnded, turnDeadlineMs);
        if (ended.timedOut) return { ...ended, settleCycles };
        writeLive({ status: "running", phase: "turn_wait", event: "compaction_settled" });
        continue;
      }
      const grace = deadlineBounded(turnDeadlineMs);
      if (grace.exhausted) return { timedOut: true, boundedBy: grace.boundedBy, settleCycles };
      const activityBaseline = activityGeneration;
      const activity = await Promise.race([
        waitForEvent((type) => ACTIVITY_EVENT_TYPES.has(type), Math.min(SETTLE_GRACE_MS, grace.ms)),
        client.failed,
      ]);
      if (activity) {
        if (activity.type === "compaction_start") continue;
        agentRestarted = true;
        break;
      }
      const probe = deadlineBounded(turnDeadlineMs);
      if (probe.exhausted) return { timedOut: true, boundedBy: probe.boundedBy, settleCycles };
      const endedBaseline = compactionsEnded;
      const state = await client.call("get_state", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, probe.ms)) });
      if (activityGeneration !== activityBaseline) {
        agentRestarted = true;
        break;
      }
      if (compactionsStarted > compactionsEnded) continue;
      if (state?.isCompacting === true) {
        // pi 自报压缩中而事件流里没看到 compaction_start:等 compaction_end 事件(以计数为准),不猜。
        if (compactionsEnded > endedBaseline) continue;
        const ended = await waitForCompactionEnd(endedBaseline, turnDeadlineMs);
        if (ended.timedOut) return { ...ended, settleCycles };
        continue;
      }
      if (state?.isStreaming === true) {
        agentRestarted = true;
        break;
      }
      const finalBound = deadlineBounded(turnDeadlineMs);
      if (finalBound.exhausted) return { timedOut: true, boundedBy: finalBound.boundedBy, settleCycles };
      // Pi暂时idle不代表后台命令已完成；保留同一任务和写域，等待作业结束的follow-up。
      if (commandJobsEnabled && (!externalCancellation.requested || externalCancellation.type === "pause")) {
        const jobs = readCommandJobsState(commandJobsRoot);
        if (jobs.active_commands > 0) {
          const observed = jobs.jobs.filter(job => ['starting', 'running', 'stopping'].includes(job.status))
            .map(({ job_id, status, last_output_at, stdout_path, stderr_path }) => ({ job_id, status, last_output_at, stdout_path, stderr_path }));
          const key = JSON.stringify(observed);
          if (key !== commandJobsProjectionKey) {
            commandJobsProjectionKey = key;
            writeLive({ status: 'running', phase: 'command_job_wait', event: 'command_job_progress',
              event_extra: { command_jobs: observed } });
          }
          continue;
        }
      }
      return { timedOut: false, settleCycles };
    }
  }
}

async function runPromptTurn(messageText) {
  currentTurnPhase = "main";
  const receiptCursor = turnReceipts.length;
  const eventCursor = eventLog.length;
  const compactionCursor = compactionLog.length;
  const settledBaseline = settledCount;
  const turnDeadlineMs = Date.now() + effectiveTurnTimeoutMs;
  writeLive({ status: "running", phase: "turn_start", event: "turn_start" });
  try {
    await client.call("prompt", { message: messageText }, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) });
  } catch (error) {
    if (client.transportError) {
      result.failure_type = "transport_failed";
      result.orchestration.failure_type = "transport_failed";
      throw client.transportError;
    }
    result.failure_type = "auth_or_preflight_failed";
    result.orchestration.failure_type = "auth_or_preflight_failed";
    throw error;
  }
  result.turn = { ...result.turn, startAck: true };
  promptStarted = true;
  inspectCancellationRequest();
  sendExternalAbort();
  writeLive({ status: "running", phase: "turn_wait", event: "turn_wait" });

  const ended = await waitForTurnEnd(settledBaseline, turnDeadlineMs);
  if (ended.timedOut) {
    if (ended.boundedBy === "cancel") {
      externalCancellation.graceful = false;
      throw new ExternalCancellationError("取消请求已发出，但 Pi 未在优雅收尾窗口内证明 settled/idle。");
    }
    const failureType = ended.boundedBy === "global" ? "global_timeout"
      : ended.boundedBy === "tool_loop" ? "tool_loop" : "turn_timeout";
    try {
      await client.call("abort", {}, { timeoutMs: 5000 });
    } catch {
      // abort 是 best-effort;超时判定不依赖它成功。
    }
    await Promise.race([
      waitForEvent((type) => type === "agent_settled", ABORT_SETTLE_WINDOW_MS),
      client.failed.catch(() => {}),
    ]);
    // 交卷阶段的空转：已成功交卷，或交卷文件已写好且代收通过，即按正常回合收尾，熔断记录留在 tool_loop。
    const salvagedBy = failureType !== "tool_loop" ? null
      : submittedTaskStatus(readTaskResultSubmission()) ? "task_result_submitted"
        : ingestTaskResultDraft("tool_loop")?.ok === true ? "task_result_draft" : null;
    if (salvagedBy) {
      toolLoop.tripped.salvaged_by = salvagedBy;
    } else {
      result.failure_type = failureType;
      result.orchestration.failure_type = failureType;
      throw new Error(
        failureType === "global_timeout"
          ? `全程预算用尽(timeoutMs=${globalTimeoutMs || 0});已发 abort 并进入关停。`
          : failureType === "tool_loop"
            ? `工具调用循环:连续 ${toolLoop.tripped.noop_streak} 次空转命令(最近一次 ${toolLoop.tripped.signatures[0].preview});已发 abort 并进入关停。`
            : `单轮等待超时(turnTimeoutMs=${turnTimeoutMs || 0});已发 abort 并进入关停。`,
      );
    }
  }

  settledIdleConfirmed = true;
  if (externalCancellation.requested) {
    externalCancellation.graceful = true;
    writeLive({
      status: "running",
      phase: "cancel_settled",
      event: "cancel_abort_settled",
      force_record_event: true,
      cancel_abort_settled: true,
    });
    throw new ExternalCancellationError(externalCancellation.type === "pause"
      ? "暂停请求已由 Pi abort，已证明 settled/idle；正在保存会话并等待进程退出。"
      : "取消请求已由 Pi abort，并已证明 settled/idle。");
  }
  // 此处是回合完成的边界；后续统计和产物收割不再接受该回合的取消。
  promptStarted = false;
  stopCancellationMonitor();

  const receipts = turnReceipts.slice(receiptCursor);
  const last = receipts.length > 0 ? receipts[receipts.length - 1] : null;
  // 一轮内可能有多条 assistant 消息(工具循环、auto_retry、压缩后续跑);正文取最后一条非空的。
  const turnText = turnTexts.slice(receiptCursor).filter((text) => text.trim().length > 0).pop() ?? "";
  const events = eventLog.slice(eventCursor);
  const compactions = compactionLog.slice(compactionCursor);
  writeLive({
    status: "running",
    phase: "result_collection",
    event: "turn_completed",
    turn_completed: true,
    stop_reason: last?.stopReason ?? null,
    settle_cycles: ended.settleCycles,
    compactions: compactions.length,
    tool_call_counts: toolCallCounts(),
  });
  return {
    receipts,
    lastReceipt: last,
    text: turnText,
    stopReason: last?.stopReason ?? null,
    settleCycles: ended.settleCycles,
    compactions,
    eventCounts: countBy(events, (entry) => entry.type ?? "unknown"),
  };
}

async function readAssistantText() {
  const data = await client.call("get_last_assistant_text", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) });
  return typeof data?.text === "string" ? data.text : "";
}

// 目录读不了与"没有会话文件"不是一回事：前者另记 readError，不洗成 null。
function resolveSessionFile(preferred) {
  if (preferred && existsSync(preferred)) return { file: preferred, readError: null };
  if (!existsSync(sessionDir)) return { file: null, readError: null };
  try {
    const names = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
    if (names.length === 0) return { file: null, readError: null };
    names.sort();
    return { file: path.join(sessionDir, names[names.length - 1]), readError: null };
  } catch (error) {
    return { file: null, readError: String(error?.message ?? error) };
  }
}

function attachSessionResume() {
  const { file, readError } = resolveSessionFile(result.session?.file);
  const failureType = String(result.failure_type || "");
  // file is the on-disk path when present; resumable is a separate predicate.
  // Non-graceful cancel must still report the jsonl if it exists.
  result.session = {
    ...(result.session || {}),
    sessionDir,
    file: file || null,
    ...(readError ? { read_error: readError } : {}),
    resumable: Boolean(file)
      && result.ok !== true
      && result.identity?.verified === true
      && result.cleanup?.tree_confirmed !== false
      && (!externalCancellation.requested || externalCancellation.graceful)
      && !NON_RESUMABLE_FAILURE_TYPES.has(failureType),
  };
  const lastReceipt = turnReceipts.length ? turnReceipts[turnReceipts.length - 1] : null;
  result.diagnostics = {
    ...(result.diagnostics || {}),
    stop_reason: lastReceipt?.stopReason ?? null,
    last_error_message: lastReceipt?.errorMessage ?? null,
    compaction_seen: compactionsStarted > 0,
    compactions: compactionLog,
  };
}

// 模型卡显式取字段:redactAuth 会把任何含 token/key 的键名整体抹掉(maxTokens 也中招),
// 身份证据必须保留这些数字,因此原始 state 走 redactAuth,模型卡与逐轮回执按白名单直取。
function modelCardOf(state) {
  const card = state?.model;
  if (!card || typeof card !== "object") {
    return null;
  }
  return {
    id: card.id ?? null,
    name: card.name ?? null,
    provider: card.provider ?? null,
    api: card.api ?? null,
    reasoning: card.reasoning ?? null,
    contextWindow: card.contextWindow ?? null,
    maxTokens: card.maxTokens ?? null,
    thinkingLevelMap: card.thinkingLevelMap ?? null,
  };
}

function writeIdentitySnapshot(extra = {}) {
  const snapshot = {
    requested: result.identity.requested,
    applied: result.identity.applied,
    verified: result.identity.verified,
    corrections: result.identity.corrections,
    initial_state: result.diagnostics.initial_state ?? null,
    final_state: result.diagnostics.final_state ?? null,
    model_card: modelCardOf(finalState ?? initialState),
    available_models: {
      count: result.selection.availableModelCount,
      matched: result.selection.validated,
      sample: result.selection.availableModels.slice(0, 40),
    },
    available_thinking_levels: result.selection.availableThinking,
    turn_receipts: turnReceipts,
    runnerExtensionProfile: result.selection.runnerExtensionProfile,
    runnerExtensions: result.selection.runnerExtensions,
    ...extra,
  };
  ensureDir(outDir);
  writeFileSync(identityPath, JSON.stringify(snapshot, null, 2), "utf8");
  return snapshot;
}

let initialState = null;
let finalState = null;

client.start();
startCancellationMonitor();
result.runtime = {
  backend: BACKEND,
  piCli,
  spawnArgs: piArgs.slice(1),
  pid: client.child?.pid ?? null,
  startedAt: client.startedAt,
  exitCode: null,
  exitSignal: null,
  stderrBytes: 0,
  stderrPath: null,
  malformedLines: 0,
};
result.failure_type = "transport_failed";
result.orchestration.failure_type = "transport_failed";

try {
  writeLive({ status: "running", phase: "handshake", event: "handshake_start" });
  // 1. get_state 首答即启动完成。
  initialState = await client.call("get_state", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) });
  result.diagnostics.initial_state = redactAuth(initialState);
  // child 继承启动时加载的 compaction/retry 配置。对应 RPC setter 会持久化到
  // PI_CODING_AGENT_DIR/settings.json，因此 runner 不在握手期修改这两项。重试耗尽后仍由
  // turn/global timeout 与上游 requeue/blocked 裁决收口。
  result.session = {
    id: initialState?.sessionId ?? null,
    file: initialState?.sessionFile ?? null,
    sessionDir,
    stats: null,
  };
  // 2. 模型目录诊断；是否可执行由后续身份核验决定。
  writeLive({ status: "running", phase: "model_catalog", event: "model_catalog_start" });
  const catalog = await client.call("get_available_models", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) });
  const catalogModels = Array.isArray(catalog?.models) ? catalog.models : [];
  result.selection.availableModelCount = catalogModels.length;
  result.selection.availableModels = catalogModels
    .map((entry) => `${entry?.provider ?? "?"}/${entry?.id ?? "?"}`)
    .filter((entry) => entry !== "?/?");
  const thinkingLevels = await client
    .call("get_available_thinking_levels", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) })
    .catch(() => null);
  result.selection.availableThinking = Array.isArray(thinkingLevels?.levels) ? thinkingLevels.levels : [];
  if (effort && result.selection.availableThinking.length > 0 && !result.selection.availableThinking.includes(effort)) {
    result.warnings.push(
      `--effort ${effort} 不在 pi thinkingLevel 值域(${result.selection.availableThinking.join(", ")})内;以身份回读结果为准。`,
    );
  }
  if (modelRef.ok) {
    let matched = catalogModels.some((entry) => entry?.provider === modelRef.provider && entry?.id === modelRef.modelId);
    if (!matched) {
      // pi 启动时异步刷新模型目录且不等其完成；冷缓存 miss 等一拍重查，供目录诊断使用。
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const refreshed = await client
        .call("get_available_models", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) })
        .catch(() => null);
      const refreshedModels = Array.isArray(refreshed?.models) ? refreshed.models : [];
      if (refreshedModels.length > 0) {
        result.selection.availableModelCount = refreshedModels.length;
        result.selection.availableModels = refreshedModels
          .map((entry) => `${entry?.provider ?? "?"}/${entry?.id ?? "?"}`)
          .filter((entry) => entry !== "?/?");
        matched = refreshedModels.some((entry) => entry?.provider === modelRef.provider && entry?.id === modelRef.modelId);
      }
    }
    if (!matched) {
      result.warnings.push(
        `所选模型不在 pi 可用模型目录内:${modelRef.provider}/${modelRef.modelId}。目录共 ${result.selection.availableModelCount} 项；继续身份核对。`,
      );
    }
    result.selection.validated = matched;
  } else {
    result.selection.note = "--model 缺失,使用 pi 启动时选定的默认模型。";
  }

  // 3. 身份回读 / 纠正 / 复核。
  writeLive({ status: "running", phase: "identity_check", event: "identity_check_start" });
  const stateModel = (state) => ({
    provider: state?.model?.provider ?? null,
    model: state?.model?.id ?? null,
    thinkingLevel: state?.thinkingLevel ?? null,
  });
  let current = stateModel(initialState);
  const modelMismatch = () => modelRef.ok && (current.provider !== modelRef.provider || current.model !== modelRef.modelId);
  const thinkingMismatch = () => Boolean(effort) && current.thinkingLevel !== effort;
  if (modelMismatch()) {
    try {
      await client.call("set_model", { provider: modelRef.provider, modelId: modelRef.modelId }, {
        timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())),
      });
      result.identity.corrections.push({ command: "set_model", ok: true, error: null });
    } catch (error) {
      result.identity.corrections.push({ command: "set_model", ok: false, error: String(error?.piError ?? error?.message ?? error) });
    }
  }
  if (thinkingMismatch()) {
    try {
      await client.call("set_thinking_level", { level: effort }, {
        timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())),
      });
      result.identity.corrections.push({ command: "set_thinking_level", ok: true, error: null });
    } catch (error) {
      result.identity.corrections.push({
        command: "set_thinking_level",
        ok: false,
        error: String(error?.piError ?? error?.message ?? error),
      });
    }
  }
  if (result.identity.corrections.length > 0) {
    finalState = await client.call("get_state", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) });
    current = stateModel(finalState);
  } else {
    finalState = initialState;
  }
  result.diagnostics.final_state = redactAuth(finalState);
  result.identity.applied = current;
  result.selection.appliedProvider = current.provider;
  result.selection.appliedModel = current.model;
  result.selection.appliedEffort = current.thinkingLevel;
  result.identity.verified = !modelMismatch() && !thinkingMismatch();
  writeIdentitySnapshot();
  if (!result.identity.verified) {
    // 模型不符是身份事故；仅 thinkingLevel 不符（pi setThinkingLevel 会按模型能力夹取）归
    // invalid_model_effort，向上游保留准确的失败类型。
    const identityFailure = modelMismatch() ? "identity_mismatch" : "invalid_model_effort";
    result.failure_type = identityFailure;
    result.orchestration.failure_type = identityFailure;
    throw new Error(
      `身份核对失败:请求 ${modelRef.ok ? `${modelRef.provider}/${modelRef.modelId}` : "(默认模型)"}` +
        `/thinking=${effort || "(默认)"};实收 ${current.provider ?? "?"}/${current.model ?? "?"}/thinking=${current.thinkingLevel ?? "?"}。`,
    );
  }

  // 4-5. prompt 与事件消费。
  result.failure_type = "transport_failed";
  result.orchestration.failure_type = "transport_failed";
  inspectCancellationRequest();
  if (externalCancellation.requested) {
    const state = await client.call("get_state", {}, { timeoutMs: 5000 });
    settledIdleConfirmed = state?.isStreaming !== true && state?.isCompacting !== true;
    externalCancellation.graceful = settledIdleConfirmed;
    if (settledIdleConfirmed) {
      writeLive({
        status: "running",
        phase: "cancel_settled",
        event: "cancel_abort_settled",
        force_record_event: true,
        cancel_abort_settled: true,
      });
    }
    throw new ExternalCancellationError("任务在 prompt 前收到当前 attempt 的取消请求。");
  }
  let mainTurn = await runPromptTurn(promptMessage);
  // 回合结束仍没有成功交卷而交卷文件在：runner 代收；未通过时把具体缺口发回，限 TASK_RESULT_DRAFT_FIX_ROUNDS 轮。
  for (let round = 0; ; round += 1) {
    const ingested = ingestTaskResultDraft(round === 0 ? "turn_end" : "fix_round");
    if (!ingested || ingested.ok || round >= TASK_RESULT_DRAFT_FIX_ROUNDS) break;
    startCancellationMonitor();
    mainTurn = await runPromptTurn(taskResultDraftFixPrompt(ingested.gaps));
  }
  result.turn = {
    ...result.turn,
    id: "pi-turn-1",
    startAck: true,
    modelActivityObserved,
  };
  // 回合结束即运输完成。最后一条回执的 stopReason / errorMessage 是事实,留在 turns[] 与 diagnostics,
  // 不翻译成失败类别:模型这轮怎么收的由主代理裁决,runner 不替它判死。

  // 正文首选 message_end 拼装结果;为空时退 get_last_assistant_text。
  let finalText = normalizeFinalText(mainTurn.text);
  let finalTextSource = "message_end";
  if (!finalText) {
    finalText = normalizeFinalText(await readAssistantText());
    finalTextSource = finalText ? "get_last_assistant_text" : "empty";
  }

  // 正文六节格式只观测不把关:不追加收口轮、不因缺节判失败。报告与 handoff 的格式真源是
  // Core 侧 checker(submit_task_result 当场复验、终态复验),runner 一轮收完即收。
  // structured review 轨:结论状态行不进 headingStatus.ok(真源是 review gate)。
  const headingOptions = { conclusionStatusRequired: !structuredReviewTask };

  const finalPath = path.join(outDir, "child-final.md");
  writeFileSync(finalPath, finalText, "utf8");

  // 6. 会话聚合统计。
  const stats = await client
    .call("get_session_stats", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) })
    .catch(() => null);
  result.session = { ...(result.session ?? {}), stats: compactSessionStats(stats) };

  result.turns = turnReceipts;
  // submit_review_result 是 runner 注入的正式提交通道,不算 evidence_only 任务的越界工具执行。
  const nonSubmitToolCalls = [...toolCallIndex.values()]
    .filter((item) => item.name !== "submit_review_result").length;
  if (evidenceOnlyTask && nonSubmitToolCalls > 0) {
    result.warnings.push(
      `evidence_only 任务包内发生 ${nonSubmitToolCalls} 次工具执行;pi 轨不中断运行,证据留在 child-task-events.jsonl 供审计。`,
    );
  }

  result.review_synthesis = synthesizeReviewResult({
    taskPackage: reviewTaskPackage,
    taskText,
    finalText,
    outDir,
    fallbackRoot: targetCwd,
    reviewResultPath: reviewResultToolEnabled ? reviewResultPath : null,
    runnerObservations: {
      // 回合按 pi 事实结束即视为完成;回执 stopReason 是事实,不再作为合成前置条件。
      turn_completed: true,
      // 额外工具调用只记 warning，不把已完成回合打成 transport_failed。
      evidence_tool_guard_passed: true,
    },
  });
  if (!result.review_synthesis.applied) {
    result.review_synthesis = readAssistedReviewGate({ taskPackage: reviewTaskPackage, fallbackRoot: targetCwd });
  }
  result.task_result = readTaskResultSubmission();

  result.turn = {
    ...result.turn,
    completed: true,
    stopReason: mainTurn.stopReason,
    settleCycles: mainTurn.settleCycles,
    compactions: mainTurn.compactions,
    finalTextPath: finalPath,
    finalTextSource,
    eventCounts: mainTurn.eventCounts,
    messageUpdateCount,
    toolCalls: [...toolCallIndex.values()],
    modelActivityObserved,
  };
  result.required_headings = headingStatus(finalText, undefined, headingOptions);
  const submittedStatus = submittedTaskStatus(result.task_result);
  const reviewSubmitted = result.review_synthesis?.applied === true && result.review_synthesis?.result_source === "submit_tool";
  result.task_status_source = submittedStatus ? "submit_task_result" : reviewSubmitted ? "submit_review_result" : "final_text";
  if (!result.required_headings.ok && !submittedStatus && !reviewSubmitted) {
    const detail = [
      result.required_headings.missing.length ? `缺 ${result.required_headings.missing.length} 节` : "",
      ...result.required_headings.warnings,
    ].filter(Boolean).join(";");
    result.warnings.push(`最终回复正文未包含完整六节(${detail});仅记录观测,不判失败、不追加收口轮。`);
  }
  result.orchestration.ok = true;
  result.orchestration.status = "completed";
  result.orchestration.failure_type = "none";
  // 机械信号:失败/受阻判定优先用运输层实测(UI 请求保守应答数、工具失败数、error 轮次),
  // 业务叙述里的失败词汇不再单独触发降级(公共层机械信号门)。被压制的文本命中转 result.warnings 可见。
  const mechanicalSignals = {
    deniedPermissions: uiRequests.length,
    failedToolCalls: failedToolCallCount,
    failedBashToolCalls: failedBashToolCount,
    errorTurns: turnReceipts.filter((receipt) => receipt.stopReason === "error").length,
  };
  result.mechanical_signals = mechanicalSignals;
  // 交卷成功时 ok、status、failure_type 只按提交的 verdict 投影；正文扫描（提交状态置于首个 `## 结论`）
  // 只产出 warnings 与诊断信号，正文失败叙述和失败工具计数不改业务状态。
  const submittedStatusLine = `## 结论\n任务状态：${submittedStatus}`;
  const textAnalysis = analyzeTaskResult(submittedStatus ? `${submittedStatusLine}\n\n${finalText}` : finalText, {
    mechanicalSignals,
  });
  const verdictTask = submittedStatus ? analyzeTaskResult(submittedStatusLine) : null;
  const taskAnalysis = verdictTask
    ? {
        ...textAnalysis,
        ok: verdictTask.ok,
        status: verdictTask.status,
        controllerClassifiedStatus: verdictTask.controllerClassifiedStatus,
        failure_type: verdictTask.failure_type,
      }
    : textAnalysis;
  const suppressedHits = taskAnalysis.sections?.diagnosticSignals?.suppressedBlockedSignals ?? [];
  if (suppressedHits.length > 0) {
    result.warnings.push(
      `正文含失败叙述(${suppressedHits.length} 个正则命中)但运输层无失败证据(机械信号干净);按业务讨论处理,未降级。`,
    );
  }
  result.task = applyReviewGate(taskAnalysis, result.review_synthesis);
  if (submittedStatus && result.task_result.handoff_check_status === "error") {
    result.task = { ...result.task, requiresParentReview: true };
    result.warnings.push(
      `handoff checker 自身故障(status=error: ${result.task_result.handoff_check_issues.join("; ") || "无详情"});交卷按提交 verdict 投影,handoff 未经机械自检,须父级复核。`,
    );
  }
  const classified = classifyFinalResult(result.orchestration, result.task);
  result.ok = classified.ok;
  result.status = classified.status;
  result.failure_type = classified.failure_type;
} catch (error) {
  const message = String(error?.message ?? error);
  if (error instanceof ExternalCancellationError) {
    result.status = "cancelled";
    result.ok = false;
    result.failure_type = "cancelled";
    result.orchestration.ok = false;
    result.orchestration.status = "cancelled";
    result.orchestration.failure_type = "cancelled";
    result.task = { ok: false, status: "cancelled", failure_type: "cancelled", blockedSignals: [] };
    result.cancellation = { ...externalCancellation, graceful: externalCancellation.graceful && settledIdleConfirmed };
  } else {
    // 审查交付违反审查合同：已交原件留在原处，按交付契约失败记账，与运输失败分开。
    if (error instanceof ReviewContractError) result.failure_type = "handoff_check_failed";
    else if (result.failure_type === "unknown") result.failure_type = "transport_failed";
    result.status = "failed";
    result.ok = false;
    result.orchestration.ok = false;
    result.orchestration.status = "failed";
    result.orchestration.failure_type = result.failure_type;
  }
  if (client.malformedLines > 0) {
    result.warnings.push(`协议流含 ${client.malformedLines} 条无法解析的 stdout 行;失败仍按上游具体分类归因。`);
  }
  result.error = redactText(message);
  result.turns = turnReceipts;
  if (externalCancellation.type !== "pause") ensureFailureFinal(result, result.failure_type, result.error);
} finally {
  // Keep the monitor active during cooperative-only shutdown: explicit cancel
  // must remain reachable even when Pi's EOF shutdown hangs.
  const bashCleanup = new Map();
  let cleanupLogValid = true;
  try {
    if (existsSync(bashCleanupPath)) {
      for (const line of readFileSync(bashCleanupPath, "utf8").split("\n").filter(Boolean)) {
        const record = JSON.parse(line);
        bashCleanup.set(record.tool_call_id, record);
      }
    }
  } catch { cleanupLogValid = false; }
  const bashStopsProven = cleanupLogValid
    && [...interruptedBashToolIds].every((id) => bashCleanup.get(id)?.confirmed === true)
    && [...bashCleanup.values()].every((record) => record.confirmed === true);
  result.cleanup = await client.shutdown({
    cooperativeOnly: () => externalCancellation.type === "pause",
    onUnconfirmed: () => {
      if (externalCancellation.shutdown_unconfirmed) return;
      externalCancellation.shutdown_unconfirmed = true;
      writeLive({ status: "running", phase: "pause_unconfirmed", event: "pause_shutdown_unconfirmed",
        error: "Pi has not exited after cooperative pause; no force kill was sent. Inspect get or explicitly cancel to authorize termination." });
    },
    forceTreeCleanup: externalCancellation.type !== "pause" && ((externalCancellation.requested && !settledIdleConfirmed)
      || (interruptedBashToolIds.size > 0 && !(externalCancellation.requested && settledIdleConfirmed && bashStopsProven))),
  });
  stopCancellationMonitor();
  // abort / settle / shutdown 期间仍可能收到 assistant 或工具事件（usage 可能尚未到达）。
  // 在关停等待结束后刷新最终证据；保留原始超时分类与错误，不把迟到活动误作可重放。
  if (result.turn) {
    result.turn = { ...result.turn, modelActivityObserved, toolCalls: [...toolCallIndex.values()] };
  }
  const unconfirmed = [...bashCleanup.values()].filter((record) => !record.confirmed);
  let treeConfirmed = cleanupLogValid && (interruptedBashToolIds.size === 0 || bashStopsProven || result.cleanup.treeKill?.confirmed === true);
  const remainingPids = new Set();
  for (const record of unconfirmed) {
    const remaining = record.observed && Array.isArray(record.tracked_pids)
      ? snapshotChildProcessTree(record.tracked_pids) : null;
    if (remaining === null || remaining.length > 0) treeConfirmed = false;
    for (const pid of remaining || []) remainingPids.add(pid);
  }
  if (result.cleanup.treeKill && result.cleanup.treeKill.confirmed !== true) treeConfirmed = false;
  if (commandJobsEnabled) {
    try {
      const jobs = readCommandJobsState(commandJobsRoot);
      result.cleanup.command_jobs = jobs;
      if (jobs.active_commands > 0 || jobs.active_services > 0 || jobs.unsafe_jobs > 0) {
        treeConfirmed = false;
        for (const job of jobs.jobs) if (job.cleanup_confirmed !== true) {
          for (const pid of job.cleanup?.remaining_pids || [job.pid]) if (pid) remainingPids.add(pid);
        }
      }
    } catch (error) {
      treeConfirmed = false;
      result.cleanup.command_jobs_error = String(error.message || error);
    }
  }
  result.cleanup.tree_confirmed = treeConfirmed;
  result.cleanup.remaining_pids = [...remainingPids];
  result.cleanup.bash_evidence_path = existsSync(bashCleanupPath) ? bashCleanupPath : null;
  // settled/idle 只是 Pi 已停下；收到正常退出且 Bash 后代已确认回收才证明收尾完成。
  if (externalCancellation.requested) {
    externalCancellation.graceful = settledIdleConfirmed && treeConfirmed && bashStopsProven
      && result.cleanup.exitInfo?.code === 0
      && !result.cleanup.exitInfo?.signal
      && !(result.cleanup.steps ?? []).some((step) => ["sigterm", "kill"].includes(step));
  }
  if (writeDomainSpec) {
    const submitted = readTaskResultSubmission();
    if (submitted.enabled) result.task_result = submitted;
    const audit = summarizeWriteDomainAudit({
      logPath: writeDomainAuditPath,
      observedToolCalls: [...toolCallIndex.values()],
    });
    const mergedEvidence = mergeWriteDomainEvidence(audit, submitted);
    result.write_domain = {
      ...result.write_domain,
      ...mergedEvidence,
      audit_path: writeDomainAuditPath,
    };
    if (!mergedEvidence.scope_compliant) {
      result.warnings.push(
        `写域守门发现 ${result.write_domain.violation_count} 次越界请求/报告或审计不完整;详见 ${writeDomainAuditPath},任务交 Core 父级复核。`,
      );
    }
  }
  result.runtime = {
    ...result.runtime,
    exitCode: client.exitInfo?.code ?? null,
    exitSignal: client.exitInfo?.signal ?? null,
    exitAt: client.exitInfo?.at ?? null,
    stderrBytes: client.stderrBytes,
    malformedLines: client.malformedLines,
    eventCounts: client.eventCountList(),
    uiRequests,
    durationMs: Date.now() - startedAtMs,
  };
  if (client.stderrText.trim()) {
    writeFileSync(stderrPath, redactText(client.stderrText), "utf8");
    result.runtime.stderrPath = stderrPath;
  }
  // 任务正文已收割时,关停阶段的异常退出不翻案 verdict,但必须可见:非零码、信号退出、
  // 退出信息缺失三种形态分别记录。
  if (result.ok) {
    const info = client.exitInfo;
    if (!info) {
      result.warnings.push("pi 进程关停后未观测到退出事件(exitInfo 缺失);任务结论在关停前已收割,verdict 不变。");
    } else if (info.signal) {
      result.warnings.push(`pi 进程在关停阶段被信号终止(signal=${info.signal});任务结论在退出前已收割,verdict 不变。`);
    } else if (info.code !== 0 && info.code !== null) {
      result.warnings.push(`pi 进程在关停阶段以非零码退出(code=${info.code});任务结论在退出前已收割,verdict 不变。`);
    }
  }
  if (saveRawEvidence) {
    const rawPath = path.join(outDir, "pi-rpc-raw.jsonl");
    writeFileSync(rawPath, `${client.rawRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    result.evidence = { rawJsonl: rawPath, records: client.rawRecords.length };
  }
  try {
    const sessionFiles = existsSync(sessionDir) ? statSync(sessionDir).isDirectory() : false;
    result.session = { ...(result.session ?? {}), sessionDir, sessionDirExists: sessionFiles };
  } catch {
    result.session = { ...(result.session ?? {}), sessionDir, sessionDirExists: false };
  }
  attachSessionResume();
  if (externalCancellation.requested) {
    result.cancellation = {
      ...externalCancellation,
      graceful: externalCancellation.graceful && settledIdleConfirmed,
    };
  }
  if (externalCancellation.type === "pause") {
    result.pause = { ...externalCancellation, graceful: externalCancellation.graceful && settledIdleConfirmed };
    delete result.cancellation;
    if (result.pause.graceful && result.cleanup?.tree_confirmed === true
      && !result.session?.file && !result.session?.read_error) {
      result.session = { ...result.session, resumable: true, resume_mode: "start" };
    }
    result.status = result.pause.graceful && result.session?.resumable ? "paused" : "pause_unconfirmed";
    result.failure_type = result.status === "paused" ? "none" : "pause_unconfirmed";
    result.orchestration.status = result.status;
    result.orchestration.failure_type = result.failure_type;
    result.task = null;
  }
  writeIdentitySnapshot();
}

const resultPath = path.join(outDir, "child-task-result.json");
result.outputPath = resultPath;
writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
// live 的 status 只表达运行本身是否正常结束；业务状态单列 business_status，避免 partial 显示成 failed。
writeLive({
  status: result.status === "paused" ? "paused" : result.orchestration?.ok === true ? "completed" : "failed",
  phase: "finished",
  event: "finished",
  final_status: result.status,
  business_status: result.task?.status ?? null,
  failure_type: result.failure_type,
  event_counts: client.eventCountList(),
  tool_call_counts: toolCallCounts(),
  output_path: resultPath,
});
console.log(JSON.stringify(result, null, 2));

if (!result.ok && result.status !== "paused") {
  process.exitCode = 1;
}
