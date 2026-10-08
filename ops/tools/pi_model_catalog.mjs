// Pi 模型目录探针：经 Pi RPC get_available_models 取完整模型对象，按 Pi 自身规则推导图像输入与可选档位。
// Agent Panel 用异步探针，dispatch_prepare 用同步探针；两者共用启动参数、解帧与归一化。
// 档位语义对应 Pi 的 getSupportedThinkingLevels / clampThinkingLevel。
import { spawn, spawnSync } from "node:child_process";

export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const REQUEST_ID = "pi-model-catalog";
const BASE_ARGS = Object.freeze([
  "--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates",
  "--no-themes", "--no-context-files", "--no-tools",
]);
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const REQUEST_LINE = `${JSON.stringify({ id: REQUEST_ID, type: "get_available_models" })}\n`;

export class PiCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PiCatalogError";
    this.code = code;
  }
}

/** Pi 支持的档位：reasoning 为假只有 off；映射为 null 的档位不支持；xhigh / max 须显式映射才支持。 */
export function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  const map = model.thinkingLevelMap ?? {};
  return THINKING_LEVELS.filter((level) => map[level] !== null
    && (level === "xhigh" || level === "max" ? map[level] !== undefined : true));
}

/** 请求不支持的档位时 Pi 实际运行的档位：先向上找最近的支持档，找不到再向下。 */
export function clampThinkingLevel(levels, level) {
  if (levels.includes(level)) return level;
  const index = THINKING_LEVELS.indexOf(level);
  if (index < 0) return levels[0] ?? "off";
  return THINKING_LEVELS.slice(index + 1).find((item) => levels.includes(item))
    ?? THINKING_LEVELS.slice(0, index).reverse().find((item) => levels.includes(item))
    ?? "off";
}

function valid(model) {
  return model && typeof model.provider === "string" && model.provider && typeof model.id === "string" && model.id;
}

/** 单个 Pi 模型对象的选型事实；level_map 只列支持档里实际发送值与档位名不同的项。 */
export function normalizePiModel(model) {
  const levels = supportedThinkingLevels(model);
  const map = model.thinkingLevelMap ?? {};
  return {
    value: `${model.provider}/${model.id}`,
    name: typeof model.name === "string" && model.name ? model.name : model.id,
    supports_vision: Array.isArray(model.input) ? model.input.includes("image") : null,
    thinking_levels: levels,
    level_map: Object.fromEntries(levels.filter((level) => typeof map[level] === "string" && map[level] !== level).map((level) => [level, map[level]])),
    context_window: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
  };
}

/** 原始 Pi 模型数组 → { "provider/id": 选型事实 }；缺 provider / id 的条目丢弃。 */
export function piModelDetails(models) {
  return Object.fromEntries((Array.isArray(models) ? models : []).filter(valid).map((model) => {
    const { value, ...detail } = normalizePiModel(model);
    return [value, detail];
  }));
}

export function isPiModel(model) {
  return Boolean(valid(model));
}

function catalogResponse(line) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  if (record?.type !== "response" || record.id !== REQUEST_ID || record.command !== "get_available_models") return null;
  if (!record.success || !Array.isArray(record.data?.models)) {
    throw new PiCatalogError("PI_RPC_RESPONSE_INVALID", "Pi RPC 拒绝目录查询或返回格式不正确");
  }
  return record.data.models;
}

function invocationOf(command) {
  return Array.isArray(command) ? command.map(String) : [String(command)];
}

const childEnv = () => ({ ...process.env, NO_COLOR: "1", PI_SKIP_VERSION_CHECK: "1" });

/**
 * 异步探针：返回 Pi 原始模型数组。收到响应、超时、取消或出错都回收子进程。
 * args 追加在基础 RPC 参数之后（如 --no-extensions 与 -e 扩展清单）。
 */
export function probePiModels({ cwd, command, args = [], timeoutMs = 30000, signal } = {}) {
  const invocation = invocationOf(command);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation[0], [...invocation.slice(1), ...BASE_ARGS, ...args], { cwd, windowsHide: true, env: childEnv() });
    const closed = new Promise((resolveClose) => child.once("close", resolveClose));
    let buffer = "";
    let bytes = 0;
    let settled = false;
    const finish = (error, models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // 该进程只查询目录，没有生成或业务任务；完成、超时和退出都回收它。
      child.kill();
      closed.then(() => { if (error) reject(error); else resolve(models); });
    };
    const abort = () => finish(new PiCatalogError("PI_RPC_CANCELLED", "模型目录查询已取消"));
    const timer = setTimeout(() => finish(new PiCatalogError("PI_RPC_TIMEOUT", `Pi 模型目录查询超过 ${timeoutMs} ms，点击重试目录`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => finish(new PiCatalogError("PI_RPC_START_FAILED", `Pi 启动失败（${error.code || "unknown"}），检查 Pi 安装路径`)));
    child.stdin.on("error", () => finish(new PiCatalogError("PI_RPC_INPUT_FAILED", "Pi RPC 输入管道已关闭")));
    child.stderr.resume(); // 不保留可能含凭据的扩展启动输出。
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > OUTPUT_LIMIT) {
        finish(new PiCatalogError("PI_RPC_OUTPUT_LIMIT", "Pi RPC 输出超过 16 MiB"));
        return;
      }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        let models;
        try { models = catalogResponse(line); } catch (error) { finish(error); return; }
        if (models) { finish(null, models); return; }
      }
    });
    child.once("close", (code) => finish(new PiCatalogError("PI_RPC_RESPONSE_MISSING", `Pi 退出但未返回模型目录（exit=${code}）`)));
    if (signal?.aborted) abort();
    else child.stdin.end(REQUEST_LINE);
  });
}

/**
 * 同步探针：stdin 写入请求后关闭，Pi 答复后自行退出。返回 Pi 原始模型数组。
 * runSync 是 spawnSync 形状的启动函数，供调用方处理 Windows .cmd 等启动差异。
 */
export function probePiModelsSync({ cwd, command, args = [], timeoutMs = 30000, runSync = spawnSync } = {}) {
  const invocation = invocationOf(command);
  const completed = runSync(invocation[0], [...invocation.slice(1), ...BASE_ARGS, ...args], {
    cwd, input: REQUEST_LINE, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * OUTPUT_LIMIT, env: childEnv(),
  });
  for (const line of String(completed.stdout ?? "").split("\n")) {
    const models = catalogResponse(line.replace(/\r$/, ""));
    if (models) return models;
  }
  if (completed.error) {
    const timedOut = completed.error.code === "ETIMEDOUT";
    throw new PiCatalogError(timedOut ? "PI_RPC_TIMEOUT" : "PI_RPC_START_FAILED",
      timedOut ? `Pi 模型目录查询超过 ${timeoutMs} ms` : `Pi 启动失败（${completed.error.code || completed.error.message}），检查 Pi 安装路径`);
  }
  const detail = String(completed.stderr || "").trim().slice(0, 500);
  throw new PiCatalogError("PI_RPC_RESPONSE_MISSING", `Pi 退出但未返回模型目录（exit=${completed.status}）${detail ? `：${detail}` : ""}`);
}
