import process from "node:process";

export const caches = {
  asyncSubagentServer: new Map(),
  asyncSubagentEndpoint: new Map(),
  asyncSubagentReadiness: new Map(),
  piChildModelExtensionProfile: new Map(),
  childModelCatalog: new Map(),
};

/** 等价于 Python 各 lru_cache 的 cache_clear() 全量调用。 */
export function clearCaches() {
  for (const cache of Object.values(caches)) cache.clear();
}

/** 只清 probe_pi_child_model_catalog 的缓存（Python 的 cache_clear()）。 */
export function clearModelCatalogCache() {
  caches.childModelCatalog.clear();
}

// ---- 派发阶段坐标 ----

export const dispatchPhaseState = { phase: "seed", seedIndex: 0 };

export function currentDispatchPhase() {
  return dispatchPhaseState.phase;
}

/**
 * 记录单个 seed 走到了哪一段：seed | lint | compile | submit。
 * 批量派发的失败项按这个坐标标注停在哪一步；同时向 stderr 打一行心跳，
 * 宿主按 `[dispatch-phase] seed=<批内 1 起序号，单发为 0> phase=<name>` 解析编译进度。
 */
export function markDispatchPhase(phase) {
  dispatchPhaseState.phase = phase;
  process.stderr.write(`[dispatch-phase] seed=${dispatchPhaseState.seedIndex} phase=${phase}\n`);
  return null;
}
