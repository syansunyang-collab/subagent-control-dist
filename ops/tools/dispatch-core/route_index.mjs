// 常驻短路由索引：完整 route_id + 一句用途（route_card.applies_to）。
// 真源与 task_package_profiles.mjs 相同：ops/protocols/task-package-routes/<route_id>.md 的
// ```json route_card 块。本模块只读 applies_to，不复制角色表、模型表或卡片正文，
// 让 Pi dispatch_prepare 与 MCP subagent_prepare 的模型可见描述共用同一份索引。
// 整体安装：任何一张卡读不到 applies_to 就不返回部分索引，调用方保留既有 list 入口
// （审查 R1 F1：缺任一 route_id 的索引不写入，也不写“不必再查 list”）。
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const ROUTE_INDEX_DIR_PARTS = Object.freeze(["ops", "protocols", "task-package-routes"]);

// 与 task_package_profiles.mjs 的 CARD_RE 同形；这里只取围栏块里的 applies_to。
const ROUTE_CARD_RE = /```json\s+route_card\s*\n([\s\S]*?)\n```/;

export class RouteIndexError extends Error {
  constructor(message) {
    super(message);
    this.name = "RouteIndexError";
    this.code = "route_index_unavailable";
  }
}

export function routeIndexDir(runtimeRoot) {
  return path.join(path.resolve(String(runtimeRoot)), ...ROUTE_INDEX_DIR_PARTS);
}

// 全量路由行；任一 route 卡缺失或读不到 applies_to 就抛错，由 routeIndexOrNull 收束为“不安装索引”。
export function routeIndexRows(runtimeRoot) {
  const dir = routeIndexDir(runtimeRoot);
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    throw new RouteIndexError(`route index directory unreadable: ${dir}: ${error?.message ?? error}`);
  }
  if (!names.length) throw new RouteIndexError(`route index directory has no route cards: ${dir}`);
  return names.map((name) => {
    const routeId = name.slice(0, -".md".length);
    const match = ROUTE_CARD_RE.exec(readFileSync(path.join(dir, name), "utf8"));
    if (!match) throw new RouteIndexError(`${name} has no json route_card block`);
    let card;
    try {
      card = JSON.parse(match[1]);
    } catch (error) {
      throw new RouteIndexError(`${name} route_card is not valid JSON: ${error?.message ?? error}`);
    }
    const appliesTo = typeof card?.applies_to === "string" ? card.applies_to.trim() : "";
    if (!appliesTo) throw new RouteIndexError(`${name} route_card has no applies_to`);
    return { route_id: routeId, applies_to: appliesTo };
  });
}

export function routeIndexLines(runtimeRoot) {
  return routeIndexRows(runtimeRoot).map((row) => `${row.route_id} — ${row.applies_to}`);
}

export function routeIndexText(runtimeRoot) {
  return routeIndexLines(runtimeRoot).join("\n");
}

// 缺索引不是派发失败：返回 null 让调用方沿用原有工具描述和 list 入口。
export function routeIndexOrNull(runtimeRoot) {
  try {
    return routeIndexText(runtimeRoot);
  } catch {
    return null;
  }
}

export function withRouteIndex(description, runtimeRoot, { heading }) {
  const index = routeIndexOrNull(runtimeRoot);
  return index ? `${description}\n${heading}\n${index}` : description;
}
