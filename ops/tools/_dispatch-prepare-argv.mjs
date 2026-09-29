// dispatch_prepare.mjs 编译器的调用规格：seed 字段闭集、seed-stdin argv、覆盖项 flag 映射与超时
// 心跳读取。Pi 扩展 dispatch_prepare 工具与 MCP subagent_dispatch 都从这里取，两侧不再各写一份。
// 部署形态：deploy_pi_control.py 的 CORE_FILES 按仓内相对路径拷贝 ops/tools/*.mjs，adapters/pi/src
// 用 ../../../ops/tools/ 到达；subagent_service.mjs 侧由 esbuild 内联进 bundle 并计入构建身份。

// 字段 → JSON Schema 类型。字段面取三处的并集：seed_minimal.mjs expandSeed 消费的最小种子键、
// task_package_build.mjs buildPackage 读取的完整 package_seed 主体、dispatch_prepare.mjs 直接
// 消费的派发元数据。顺序即两侧 schema 的属性顺序。
export const DISPATCH_PREPARE_SEED_FIELD_TYPES = Object.freeze({
  route_id: "string",
  goal: "string",
  scope: "object",
  contract: "object",
  slug: "string",
  known_facts: "array",
  delegation_intent: "string",
  extensions: "object",
  read_scope_layers: "object",
  budget: "object",
  slice_id: "string",
  title: "string",
  version: "string",
  package_id: "string",
  agent: "object",
  project_positioning: "object",
  ownership: "object",
  concurrency_contract: "object",
  inputs: "object",
  expected_output: "object",
  runtime_context: "object",
  alignment: "object",
  planning_policy: "object",
  tool_contract: "object",
  stop_conditions: "array",
  handoff_contract: "object",
});

export const DISPATCH_PREPARE_SEED_FIELDS = Object.freeze(Object.keys(DISPATCH_PREPARE_SEED_FIELD_TYPES));

// authorization.overrides 的闭集：选型解析器与 Pi / MCP 两侧 schema 共用。
export const AUTHORIZATION_OVERRIDES = Object.freeze(["effort_range", "outside_pool"]);

// 调用方覆盖项 → dispatch_prepare.mjs CLI flag。origin_id 只有持有会话来源的宿主会填，
// 不填的调用方留空即可，argv 里不出现该 flag。
export const DISPATCH_PREPARE_OVERRIDE_FLAGS = Object.freeze({
  pick: "--async-pick",
  model: "--async-model",
  authorization: "--async-authorization",
  effort: "--async-effort",
  target_cwd: "--async-target-cwd",
  execution_profile: "--async-execution-profile",
  origin_id: "--origin-id",
});

// 编译器 stderr 心跳行协议：[dispatch-phase] seed=<n> phase=<name>。
export const DISPATCH_PHASE_PREFIX = "[dispatch-phase]";
const NO_PHASE_OBSERVED = "none observed";

/** seed-stdin 调用的完整 argv：首位是编译器脚本，覆盖项按上表追加。 */
export function dispatchPrepareSeedArgs(scriptPath, action, overrides = {}) {
  const args = [
    String(scriptPath),
    "--seed-stdin",
    "--action", String(action),
    "--delivery", "async-subagent",
    "--format", "json",
  ];
  for (const [key, flag] of Object.entries(DISPATCH_PREPARE_OVERRIDE_FLAGS)) {
    const value = overrides[key];
    if (value === undefined || value === null || String(value).trim() === "") continue;
    args.push(flag, key === "authorization" && typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return args;
}

/** seed 顶层字段里落在闭集外的键。 */
export function unknownSeedFields(seed) {
  return Object.keys(seed).filter((key) => !DISPATCH_PREPARE_SEED_FIELDS.includes(key));
}

/** 错层提示：点名越界字段、指出正确层位、列出闭集，最后给出取骨架的办法。 */
export function unknownSeedFieldsMessage(label, unknown, templateHint) {
  return `dispatch_prepare ${label} has unknown top-level field(s): ${[...unknown].join(", ")}; `
    + "route-card fields belong under contract.*, path lists under scope.*; "
    + `allowed top-level fields: ${DISPATCH_PREPARE_SEED_FIELDS.join(", ")}; ${templateHint}`;
}

/** stderr 里最后一条心跳行的原文；一条都没有时返回 "none observed"。 */
export function lastDispatchPhase(stderr) {
  const lines = String(stderr ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.startsWith(DISPATCH_PHASE_PREFIX)) return line;
  }
  return NO_PHASE_OBSERVED;
}

/** 超时错误正文：停在哪一阶段由心跳给出，两侧调用方按各自的收尾语再拼后缀。 */
export function dispatchPrepareTimeoutMessage(timeoutMs, stderr) {
  return `dispatch_prepare compiler timed out after ${timeoutMs}ms; last phase: ${lastDispatchPhase(stderr)}`;
}
