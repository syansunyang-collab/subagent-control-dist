// search-effort-patch / pi 扩展包装层
//
// 本文件是薄壳：把 core.mjs 的可测逻辑挂到 pi 运行时的全局 fetch 上。
// 真源：adapters/pi/user-addons/agent/extensions/search-effort-patch/
// 用户级安装：~/.pi/agent/extensions/search-effort-patch/{index.ts,core.mjs}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-expect-error - 纯 JS 核心模块，无类型声明
import { createPatchedFetch } from "./core.mjs";

const INSTALLED = Symbol.for("pi.search-effort-patch.installed");
const VERSION = Symbol.for("pi.search-effort-patch.version");
const PATCH_VERSION = 5; // 每次改 core 拦截逻辑 +1，让 /reload 能换上新包装

export default function searchEffortPatch(_pi: ExtensionAPI): void {
  const current = globalThis.fetch;
  if (typeof current !== "function") return;

  const tagged = current as unknown as Record<symbol, unknown>;
  const inner = tagged[INSTALLED];
  // 旧版标记值是 true，解不出原 fetch，叠包装会双写日志——这种情况只能重启进程
  if (inner === true) return;
  const base = typeof inner === "function" ? inner : current;
  if (tagged[VERSION] === PATCH_VERSION && typeof inner === "function") return;

  const patched = createPatchedFetch({ fetchImpl: base as typeof fetch });
  Object.defineProperty(patched, INSTALLED, { value: base });
  Object.defineProperty(patched, VERSION, { value: PATCH_VERSION });
  globalThis.fetch = patched as typeof globalThis.fetch;
}
