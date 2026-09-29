// search-effort-patch / core
// 运行时拦截 fetch：给 pi-web-access 的 OpenAI 搜索请求注入 reasoning 档位，
// 并在不破坏 SSE 流的前提下采集 usage。
//
// v0.2 相对 v0.1：
//   1. 新增 model:effort 一体化后缀（"gpt-5.6-luna:xhigh"），模型与档位绑在一处，避免错配
//   2. 新增 400 保底降级：档位被服务端拒绝时剥掉 reasoning 重试，避免静默降级到纯搜索引擎
//   3. 来源口径对齐插件（cleanSourceUrl 清 utm_source=openai）
//   4. 单行缓冲上限 512KB → 8MB（真实响应单行可含数千条引用）
//   5. 删除 v0.1 遗留的死代码 sampleSseText
//
// 设计约束：
//   1. 只命中“发往 Codex Responses 端点 + tools 含 web_search”的请求
//   2. 透传优先：任何解析/采样失败都不得影响原始流
//   3. 全程可注入依赖（configPath / logPath / fetchImpl），便于隔离测试

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

export const DEFAULT_CONFIG_PATH = join(HOME, ".pi", "web-search.json");
export const DEFAULT_LOG_PATH = join(HOME, ".pi", "agent", "state", "search-calls.jsonl");

/** 服务端实测支持的档位（minimal 不被 gpt-5.6-luna 支持） */
export const EFFORT_LEVELS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);

const CODEX_PATH_FRAGMENT = "/backend-api/codex/responses";
const BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;
const BUFFER_KEEP_BYTES = 4 * 1024 * 1024;
/**
 * 判定错误文本是否指向“档位被拒”。
 * 实测服务端拒绝档位时的报文形如：
 *   {"detail":"Unsupported value: 'minimal' is not supported with the 'gpt-5.6-luna' model.
 *    Supported values are: 'none', 'low', 'medium', ..."}
 * 即必然出现被引号包裹的档位名；也可能直接提到 reasoning / effort。
 * 反之，模型名错误等其它 400 不会命中，避免无谓重试。
 */
export function looksLikeEffortRejection(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (/reasoning|effort/i.test(text)) return true;
  return /['"`](none|minimal|low|medium|high|xhigh|max)['"`]/i.test(text);
}

/** 从 web-search.json 读取 openaiSearchReasoning 字段；文件缺失/字段非法/取值不在白名单一律返回 undefined */
export function readEffort(configPath = DEFAULT_CONFIG_PATH) {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const value = raw?.openaiSearchReasoning;
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().toLowerCase();
    return EFFORT_LEVELS.includes(trimmed) ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析 model:effort 一体化写法。
 * 只有冒号后缀恰好是合法档位时才拆分，其余情况原样返回（避免误伤带冒号的模型 id）。
 */
export function splitModelSuffix(value) {
  if (typeof value !== "string") return { model: value };
  const index = value.lastIndexOf(":");
  if (index <= 0) return { model: value };
  const suffix = value.slice(index + 1).trim().toLowerCase();
  if (!EFFORT_LEVELS.includes(suffix)) return { model: value };
  const model = value.slice(0, index).trim();
  if (model.length === 0) return { model: value };
  return { model, effort: suffix };
}

/**
 * 磁盘档位：openaiSearchModel 后缀优先于 openaiSearchReasoning 字段。
 * 插件对配置是进程内懒缓存，请求体上的模型名可能是旧值、不带后缀；
 * 拦截层每次读盘，才能把档位补上。
 */
function readDiskEffort(configPath) {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const fromModel = splitModelSuffix(raw?.openaiSearchModel);
    if (fromModel.effort) return { effort: fromModel.effort, source: "config-model-suffix" };
    const value = raw?.openaiSearchReasoning;
    if (typeof value !== "string") return {};
    const trimmed = value.trim().toLowerCase();
    if (EFFORT_LEVELS.includes(trimmed)) return { effort: trimmed, source: "config-field" };
  } catch {
    /* 文件缺失或无效 JSON */
  }
  return {};
}

/** 复刻插件的来源清理口径：去掉 utm_source=openai，再按 URL 规范化 */
export function cleanSourceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
    return url.toString();
  } catch {
    return rawUrl.replace(/[?&]utm_source=openai$/, "");
  }
}

/** 请求是否为目标搜索请求：端点匹配 + tools 里出现 web_search */
export function isSearchRequest(url, body) {
  try {
    if (typeof url !== "string" || !url.includes(CODEX_PATH_FRAGMENT)) return false;
    const tools = body?.tools;
    if (!Array.isArray(tools)) return false;
    return tools.some((tool) => tool && typeof tool === "object" && tool.type === "web_search");
  } catch {
    return false;
  }
}

function resolveUrl(input) {
  try {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return String(input);
  } catch {
    return "";
  }
}

function parseBody(init) {
  try {
    if (init && typeof init.body === "string") return JSON.parse(init.body);
  } catch {
    /* 非 JSON body：不拦截 */
  }
  return undefined;
}

/** 采集来源数：复刻插件的三条提取路径，按 cleanSourceUrl 去重 */
function collectSourceCount(output) {
  const urls = new Set();
  const pushUrl = (record) => {
    const url = record?.url ?? record?.source_website_url;
    if (typeof url !== "string" || url.length === 0) return;
    urls.add(cleanSourceUrl(url));
  };

  for (const item of output) {
    if (!item || typeof item !== "object") continue;

    // 路径 ①：message.content[].annotations[] 的 url_citation（真实响应主路径）
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        const annotations = part?.annotations;
        if (!Array.isArray(annotations)) continue;
        for (const annotation of annotations) {
          if (annotation?.type === "url_citation") pushUrl(annotation);
        }
      }
      continue;
    }

    // 路径 ② / ③：web_search_call 上的 sources / results
    if (item.type === "web_search_call") {
      const groups = [item.action?.sources, item.sources, item.results];
      for (const group of groups) {
        if (!Array.isArray(group)) continue;
        for (const source of group) pushUrl(source);
      }
    }
  }

  return urls.size;
}

/** 消费一行 SSE：累积 output_item，并在 completed 时抽取 usage/档位/来源 */
function consumeSseLine(line, record, outputItems) {
  if (!line.startsWith("data: ")) return false;
  let payload;
  try {
    payload = JSON.parse(line.slice(6));
  } catch {
    return false;
  }

  // 完整的 output item 是逐个下发的，必须先累积
  if (payload?.type === "response.output_item.done" && payload.item) {
    outputItems.push(payload.item);
    return false;
  }

  if (!["response.completed", "response.done", "response.incomplete", "response.failed"].includes(payload?.type)) return false;
  const response = payload.response;
  if (!response || typeof response !== "object") return false;

  const usage = response.usage ?? {};
  record.inputTokens = usage.input_tokens;
  record.outputTokens = usage.output_tokens;
  record.reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
  record.cachedInputTokens = usage.input_tokens_details?.cached_tokens;
  record.responseId = response.id;
  record.responseStatus = response.status ?? payload.type.slice("response.".length);
  record.incompleteReason = response.incomplete_details?.reason;
  record.serviceTierActual = response.service_tier;
  record.effortActual = response.reasoning?.effort;

  // 同插件的组装策略：completed.output 优先，为空则回退到累积的 items
  const completedOutput = Array.isArray(response.output) ? response.output : [];
  const output = completedOutput.length > 0 ? completedOutput : outputItems;
  record.sources = collectSourceCount(output);
  record.outputSource = completedOutput.length > 0 ? "completed" : "items";
  record.sampled = true;
  return true;
}

/**
 * 构造 usage 采样流：先无条件透传，再做旁路解析。
 * onDone(record) 在流结束或采样到 completed 事件时触发（只触发一次）。
 */
export function createUsageTap(record, onDone, startedAt = Date.now()) {
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const outputItems = []; // 跨 chunk 累积，不受缓冲区滑动影响

  const finish = () => {
    if (finished) return;
    finished = true;
    try {
      record.ms = Date.now() - startedAt; // 总耗时：流结束时刻
      onDone(record);
    } catch {
      /* 落盘失败不影响流 */
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk); // 透传优先
      if (finished) return;
      try {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (consumeSseLine(line, record, outputItems)) {
            finish();
            return;
          }
        }
        if (buffer.length > BUFFER_LIMIT_BYTES) {
          buffer = buffer.slice(-BUFFER_KEEP_BYTES);
          record.truncated = true; // 仅影响旁路计数，usage 仍取自已完成的行
        }
      } catch {
        /* 忽略 */
      }
    },
    flush() {
      try {
        if (!finished) {
          for (const line of buffer.split("\n")) {
            if (consumeSseLine(line, record, outputItems)) break;
          }
        }
      } catch {
        /* 忽略 */
      }
      finish();
    },
  });
}

function appendLog(logPath, record) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch {
    /* 日志失败不影响主流程 */
  }
}

async function cloneText(response) {
  try {
    return await response.clone().text();
  } catch {
    return "";
  }
}

/**
 * 生成被拦截的 fetch。依赖全部可注入，便于隔离测试。
 */
export function createPatchedFetch(options = {}) {
  const {
    configPath = DEFAULT_CONFIG_PATH,
    logPath = DEFAULT_LOG_PATH,
    fetchImpl = globalThis.fetch,
    logger = (record) => appendLog(logPath, record),
  } = options;

  return async function patchedFetch(input, init) {
    const url = resolveUrl(input);
    const body = parseBody(init);

    // 非目标请求：零改动直通
    if (!body || !isSearchRequest(url, body)) return fetchImpl(input, init);

    // ① 请求体上的一体化后缀优先（模型与档位绑在一处）
    const { model: bareModel, effort: suffixEffort } = splitModelSuffix(body.model);
    if (suffixEffort) body.model = bareModel;

    // ② 请求体没有后缀时读盘：磁盘 openaiSearchModel 后缀 → openaiSearchReasoning 字段
    //    插件懒缓存可能导致 body.model 仍是旧值（不带后缀），档位必须以磁盘为准
    const disk = suffixEffort ? {} : readDiskEffort(configPath);
    const effort = suffixEffort ?? disk.effort;
    if (effort) body.reasoning = { effort };

    const record = {
      ts: new Date().toISOString(),
      model: body.model,
      effortRequested: effort,
      effortSource: suffixEffort ? "model-suffix" : disk.source ?? null,
      injected: Boolean(effort),
    };
    const startedAt = Date.now();

    const send = async () => fetchImpl(input, { ...init, body: JSON.stringify(body) });

    let response;
    try {
      response = await send();
    } catch (error) {
      record.status = null;
      record.ms = Date.now() - startedAt;
      record.error = String(error?.message ?? error);
      logger(record);
      throw error;
    }

    // ③ 保底降级：档位被服务端拒绝时，剥掉 reasoning 重试一次
    //    宁可退回服务端默认档，也不能让搜索静默降级到纯搜索引擎
    if (response.status === 400 && effort) {
      const errorText = await cloneText(response);
      if (looksLikeEffortRejection(errorText)) {
        delete body.reasoning;
        record.fallbackReason = `reasoning-rejected: ${errorText.slice(0, 160)}`;
        try {
          response = await send();
        } catch (error) {
          record.status = null;
          record.ms = Date.now() - startedAt;
          record.error = String(error?.message ?? error);
          logger(record);
          throw error;
        }
      }
    }

    record.status = response.status;
    record.ttfbMs = Date.now() - startedAt; // 首字节耗时；总耗时在流结束时补记

    // 只在成功响应且可挂流时采样；任何异常都降级为原样返回
    try {
      const canTap =
        response.ok && response.body && typeof TransformStream === "function" && typeof Response === "function";
      if (!canTap) {
        record.ms = Date.now() - startedAt;
        logger(record);
        return response;
      }
      const tapped = response.body.pipeThrough(createUsageTap(record, logger, startedAt));
      return new Response(tapped, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      record.ms = Date.now() - startedAt;
      logger(record);
      return response;
    }
  };
}
