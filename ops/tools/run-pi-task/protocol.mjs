// run-pi-task 的 Pi RPC 客户端、协议常量与不依赖运行态的纯函数。
import { spawn } from "node:child_process";
import path from "node:path";
import { redactAuth, redactText } from "../_stdio-jsonrpc.mjs";
import { terminateChildProcessTree } from "../pi_child_bash_process_tree.mjs";

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

export {
  RUNTIME_NAME,
  BACKEND,
  RUNNER_NAME,
  PI_CHILD_SYSTEM_PROMPT_PROFILE,
  DEFAULT_PI_CLI,
  NO_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  ABORT_SETTLE_WINDOW_MS,
  SETTLE_GRACE_MS,
  ACTIVITY_EVENT_TYPES,
  TOOL_LOOP_WINDOW,
  TOOL_LOOP_MAX_DISTINCT,
  TOOL_LOOP_COMMAND_TOOLS,
  TOOL_LOOP_NOOP_STREAK,
  TOOL_LOOP_NOOP_COMMAND,
  CONTINUE_INTERRUPTED_PROMPT,
  NON_RESUMABLE_FAILURE_TYPES,
  taskToolSelection,
  collectRepeated,
  parseModelRef,
  runtimeRoleFromTask,
  phaseFromPiEvent,
  compactPiToolCall,
  emptyUsage,
  compactUsage,
  addUsage,
  compactSessionStats,
  assistantText,
  PiRpcClient,
};
