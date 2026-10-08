// Pi 子进程模型目录的文件层：把一次真实探测的结果按身份落盘，供同一调用项目的
// 后续 compiler 进程复用。进程内 LRU 仍留在 dispatch_prepare.mjs，本模块只做持久层。
//
// 边界（与派发缓存裁决一致）：
//   - 身份只记录事实指纹：解析后的 Pi 命令、PI_CONTROL_PI、受控扩展 profile、
//     相关配置文件的大小/修改时间与 target cwd。只 stat 文件，不读配置内容、不落凭据原文。
//   - 只持久化 status=ok 的结果；损坏、schema 不符、过期、非 ok 一律按 miss 处理，
//     回到真实探测，不新增失败门。
//   - 写入是 best-effort：任何 IO 失败都只返回 false，不影响调用方拿到的探测结果。
//   - TTL 是内部常量，不提供用户开关；过期即 miss。
//   - model_details 按模型键缓存 Pi 目录的选型事实（supports_vision、thinking_levels、level_map、
//     context_window）；字段形状变化时提升 schema，旧条目按 miss 处理。
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

export const CATALOG_CACHE_SCHEMA = 2;
export const CATALOG_CACHE_TTL_MS = 60 * 1000;
export const CATALOG_CACHE_FILE_NAME = "pi-child-model-catalog.json";
export const CATALOG_CACHE_MAX_ENTRIES = 8;

/** 稳定 JSON：对象键递归排序、数组保序，身份哈希不受键序影响。 */
export function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

/** 身份 → 缓存键。身份由调用方给出，本模块不解释其字段含义。 */
export function catalogCacheKey(identity) {
  return createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex");
}

function statOrNull(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

/** 文件指纹：只取 path/size/mtime_ms，绝不读取内容。 */
export function fingerprintPaths(paths) {
  const seen = new Set();
  const fingerprints = [];
  for (const raw of paths) {
    const target = String(raw ?? "");
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const stat = statOrNull(target);
    fingerprints.push({
      path: target,
      exists: Boolean(stat),
      size: stat ? stat.size : null,
      mtime_ms: stat ? Math.trunc(stat.mtimeMs) : null,
    });
  }
  return fingerprints;
}

/** 读缓存文件；缺失、损坏、schema 不符或形状不对都按空缓存处理。 */
function readPayload(cacheFile) {
  let text;
  try {
    text = readFileSync(cacheFile, "utf8");
  } catch {
    return { entries: [] };
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { entries: [] };
  }
  if (!payload || typeof payload !== "object" || payload.schema !== CATALOG_CACHE_SCHEMA) return { entries: [] };
  if (!Array.isArray(payload.entries)) return { entries: [] };
  return {
    entries: payload.entries.filter((entry) => entry && typeof entry === "object" && typeof entry.key === "string"),
  };
}

/**
 * 读一条命中条目：只接受 ok 结果、形状完整且在 TTL 内的条目，其余返回 null。
 * `now` 只用于测试注入时钟，生产调用走 Date.now()。
 */
export function readCatalogCacheEntry(cacheFile, key, { now = Date.now() } = {}) {
  const entry = readPayload(cacheFile).entries.find((item) => item.key === key);
  if (!entry) return null;
  if (entry.status !== "ok") return null;
  const models = Array.isArray(entry.models) ? entry.models.filter((item) => typeof item === "string" && item) : [];
  if (!models.length) return null;
  const storedAt = Number(entry.stored_at_ms);
  if (!Number.isFinite(storedAt)) return null;
  const age = now - storedAt;
  // 过期与未来时间戳（时钟回拨）都按 miss 处理，宁可多探一次。
  if (age < 0 || age > CATALOG_CACHE_TTL_MS) return null;
  const details = entry.model_details && typeof entry.model_details === "object" && !Array.isArray(entry.model_details)
    ? entry.model_details
    : {};
  return {
    stored_at_ms: storedAt,
    identity: entry.identity ?? null,
    catalog: {
      status: "ok",
      models,
      model_details: details,
      model_count: models.length,
      source: typeof entry.source === "string" ? entry.source : "",
      error: null,
    },
  };
}

/** 写入一条 ok 结果：替换同身份条目、按最近写入裁剪、tmp+rename 原子落盘。 */
export function writeCatalogCacheEntry(cacheFile, key, identity, catalog, { now = Date.now() } = {}) {
  try {
    if (catalog?.status !== "ok") return false;
    const models = Array.isArray(catalog.models) ? catalog.models.filter((item) => typeof item === "string" && item) : [];
    if (!models.length) return false;
    const entry = {
      key,
      status: "ok",
      stored_at_ms: now,
      identity,
      models,
      model_details: catalog.model_details && typeof catalog.model_details === "object" && !Array.isArray(catalog.model_details)
        ? catalog.model_details
        : {},
      source: typeof catalog.source === "string" ? catalog.source : "",
    };
    const entries = [entry, ...readPayload(cacheFile).entries.filter((item) => item.key !== key)]
      .slice(0, CATALOG_CACHE_MAX_ENTRIES);
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ schema: CATALOG_CACHE_SCHEMA, entries }, null, 2)}\n`, "utf8");
      renameSync(tmp, cacheFile);
    } finally {
      rmSync(tmp, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}
