// ops/tools/task_package_profiles.py 的 JS 复刻：route 固定包头与差异卡档案。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；导出名为 Python 名的 camelCase。
//
// 异常映射表（Python 分支 → JS 抛出物）：
//   _block_scalar 缺 ```yaml task_package_agent 块        ValueError      → pyError("ValueError", ...)
//   _parse_card route_card 不是合法 JSON                  ValueError      → pyError("ValueError", ...)（消息内嵌 JSONDecodeError 文案，见 pyJsonLoads）
//   _parse_card route_card 非对象 / 缺 slot / required 缺 path
//              / business_gate 非裸字段名
//              / required_files_by_contract 结构或映射非法 / 条件必读文件缺失   ValueError → pyError("ValueError", ...)
//   _parse_agent_block 缺 role、runtime_role、capability.name/file、required_files  ValueError → pyError("ValueError", ...)
//   _route_profile 文件名与 task_package_agent 不匹配      ValueError      → pyError("ValueError", ...)
//   load_route_profiles route 目录不存在 / route 为空       ValueError      → pyError("ValueError", ...)
//   profile_for 未注册 route_id                          KeyError        → pyError("KeyError", pyRepr(消息))
//     —— Python `str(KeyError(msg))` 是 msg 的 repr，带引号；lint 的 `[str(exc)]` 直接消费这一形态，故此处逐字复刻。
//   本模块不抛 ToolError。
//
// 已知取舍：Python 的模块级 `__getattr__` 惰性属性 ROUTE_PROFILES 在 ESM 里没有对应物，
// 消费面统一用 routeProfiles()；lru_cache 用模块级 Map，键含 ROOT，工作区用例重新 import 时不串。
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { ROOT, RUNTIME_ROOT, isRecord, pyError } from "./_tool_common.mjs";
import {
  pyGet, pyGetItem, pyJsonLoads, pyKeyError, pyOr, pyReadText, pyRepr, pySplitLines, pyStr, pyStripChars, pyTruthy,
} from "./_py.mjs";

export { ROOT, RUNTIME_ROOT };

// 路由与提示词是运行包只读资产：从 RUNTIME_ROOT 读取，项目根只承载项目面材料。
export const ROUTE_DIR = path.join(RUNTIME_ROOT, "ops", "protocols", "task-package-routes");
export const ACCEPTANCE_LEAF_COMMON_FILE = "ops/agent-prompts/_acceptance-leaf-common.md";

export const REQUIRED_TOP_LEVEL = [
  "version",
  "package_id",
  "agent",
  "project_positioning",
  "goal",
  "scope",
  "ownership",
  "concurrency_contract",
  "inputs",
  "known_facts",
  "expected_output",
  "runtime_context",
  "alignment",
  "planning_policy",
  "tool_contract",
  "stop_conditions",
  "extensions",
  "handoff_contract",
];

export const SEED_BODY_REQUIRED = [
  "project_positioning",
  "goal",
  "scope",
  "ownership",
  "concurrency_contract",
  "inputs",
  "known_facts",
  "expected_output",
  "runtime_context",
  "alignment",
  "planning_policy",
  "tool_contract",
  "stop_conditions",
  "extensions",
  "handoff_contract",
];

function valueError(message) {
  return pyError("ValueError", message);
}

function relRoute(routeFile) {
  return path.relative(ROOT, routeFile).replace(/\\/g, "/");
}

// ---- route 卡解析 ----

export function routeIdFromAgent(role, capability) {
  return `${role}__${capability}`;
}

const AGENT_BLOCK_RE = /```yaml\s+task_package_agent\s*\n([\s\S]*?)\n```/;
export const CARD_RE = /```json\s+route_card\s*\n([\s\S]*?)\n```/;

function blockScalar(text, routeFile) {
  const match = AGENT_BLOCK_RE.exec(text);
  if (!match) throw valueError(`${relRoute(routeFile)} missing yaml task_package_agent block`);
  return match[1];
}

function parseCard(text, routeFile) {
  const match = CARD_RE.exec(text);
  if (!match) return null;
  const rel = relRoute(routeFile);
  let card;
  try {
    card = pyJsonLoads(match[1]);
  } catch (error) {
    throw valueError(`${rel} route_card block is not valid JSON: ${error.message}`);
  }
  if (!isRecord(card)) throw valueError(`${rel} route_card must be a JSON object`);
  const required = pyGet(card, "required", []);
  const slot = pyStr(pyOr(pyGet(card, "slot"), "")).trim();
  const needsSlot =
    pyTruthy(pyGet(card, "contract_defaults")) ||
    pyTruthy(pyGet(card, "required_files_by_contract")) ||
    required.some((req) => isRecord(req) && pyStr(pyGet(req, "path", "")).startsWith("contract."));
  if (needsSlot && !slot) throw valueError(`${rel} route_card uses contract fields but has no slot`);
  for (const req of required) {
    if (!isRecord(req) || !pyStr(pyGet(req, "path", "")).trim()) {
      throw valueError(`${rel} route_card required entries need a path`);
    }
  }
  const seedDefaults = isRecord(pyGet(card, "seed_defaults")) ? pyGet(card, "seed_defaults") : {};
  const expectedDefaults = isRecord(pyGet(seedDefaults, "expected_output")) ? pyGet(seedDefaults, "expected_output") : {};
  const businessGate = pyStr(pyOr(pyGet(expectedDefaults, "business_gate"), "")).trim();
  if (businessGate && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(businessGate)) {
    throw valueError(`${rel} expected_output.business_gate must be a bare field name`);
  }
  const requiredByContract = pyGet(card, "required_files_by_contract", null);
  if (requiredByContract !== null && requiredByContract !== undefined) {
    const keys = isRecord(requiredByContract) ? Object.keys(requiredByContract).sort() : null;
    if (!keys || keys.length !== 2 || keys[0] !== "map" || keys[1] !== "path") {
      throw valueError(`${rel} required_files_by_contract must contain path and map`);
    }
    const contractPath = pyStr(pyOr(pyGet(requiredByContract, "path"), "")).trim();
    const mapping = pyGet(requiredByContract, "map");
    if (!contractPath || !isRecord(mapping) || !pyTruthy(mapping)) {
      throw valueError(`${rel} required_files_by_contract needs a contract path and non-empty map`);
    }
    for (const [value, promptPath] of Object.entries(mapping)) {
      if (!pyStr(value).trim() || typeof promptPath !== "string" || !promptPath.startsWith("ops/agent-prompts/")) {
        throw valueError(`${rel} required_files_by_contract has an invalid mapping`);
      }
      const target = path.join(RUNTIME_ROOT, promptPath);
      if (!(existsSync(target) && statSync(target).isFile())) {
        throw valueError(`${rel} conditional required file missing: ${promptPath}`);
      }
    }
  }
  return card;
}

function parseAgentBlock(block, routeFile) {
  let role = "";
  let runtimeRole = "";
  let capabilityName = "";
  let capabilityFile = "";
  const requiredFiles = [];
  let section = "";
  for (const rawLine of pySplitLines(block)) {
    const stripped = rawLine.trim();
    if (!stripped || stripped.startsWith("#") || stripped === "agent:") continue;
    if (stripped === "capability:") {
      section = "capability";
      continue;
    }
    if (stripped === "required_files:") {
      section = "required_files";
      continue;
    }
    if (section === "required_files" && stripped.startsWith("- ")) {
      requiredFiles.push(stripped.slice(2).trim());
      continue;
    }
    const colon = stripped.indexOf(":");
    if (colon === -1) continue;
    const key = stripped.slice(0, colon);
    const value = pyStripChars(stripped.slice(colon + 1).trim(), "\"'");
    if (section === "capability" && key === "name") capabilityName = value;
    else if (section === "capability" && key === "file") capabilityFile = value;
    else if (key === "role") {
      section = "agent";
      role = value;
    } else if (key === "runtime_role") {
      section = "agent";
      runtimeRole = value;
    }
  }

  const rel = relRoute(routeFile);
  const missing = [];
  if (!role) missing.push("agent.role");
  if (!runtimeRole) missing.push("agent.runtime_role");
  if (!capabilityName) missing.push("agent.capability.name");
  if (!capabilityFile) missing.push("agent.capability.file");
  if (!requiredFiles.length) missing.push("agent.required_files");
  if (missing.length) throw valueError(`${rel} task_package_agent missing: ${missing.join(", ")}`);
  return {
    role,
    runtime_role: runtimeRole,
    capability: { name: capabilityName, file: capabilityFile },
    required_files: requiredFiles,
  };
}

function routeProfile(routeFile) {
  const routeId = path.basename(routeFile, ".md");
  const text = pyReadText(routeFile);
  const agent = parseAgentBlock(blockScalar(text, routeFile), routeFile);
  const expectedRoute = routeIdFromAgent(agent.role, agent.capability.name);
  const relRouteFile = relRoute(routeFile);
  if (expectedRoute !== routeId) {
    throw valueError(`${relRouteFile} file name does not match task_package_agent: expected ${expectedRoute}`);
  }
  return {
    route_id: routeId,
    agent,
    role: agent.role,
    runtime_role: agent.runtime_role,
    capability: agent.capability.name,
    prompt_file: agent.capability.file,
    route_file: relRouteFile,
    required_files: agent.required_files,
    card: parseCard(text, routeFile),
  };
}

export function loadRouteProfiles() {
  if (!(existsSync(ROUTE_DIR) && statSync(ROUTE_DIR).isDirectory())) {
    throw valueError(`route directory not found: ${path.relative(RUNTIME_ROOT, ROUTE_DIR).replace(/\\/g, "/")}`);
  }
  const profiles = {};
  const names = readdirMd(ROUTE_DIR).sort();
  for (const name of names) {
    const profile = routeProfile(path.join(ROUTE_DIR, name));
    profiles[profile.route_id] = profile;
  }
  if (!Object.keys(profiles).length) throw valueError("no task package routes found");
  return profiles;
}

function readdirMd(dir) {
  // Path.glob("*.md") 只取本级普通文件。
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name);
}

// Python lru_cache(maxsize=1) 的对应物；键含项目根与运行根，换根后不复用旧缓存。
const PROFILE_CACHE = new Map();

function profileCacheKey() {
  return `${ROOT}\u0000${RUNTIME_ROOT}`;
}

export function routeProfiles() {
  const key = profileCacheKey();
  if (!PROFILE_CACHE.has(key)) PROFILE_CACHE.set(key, loadRouteProfiles());
  return PROFILE_CACHE.get(key);
}

export function routeProfilesCacheClear() {
  PROFILE_CACHE.clear();
}

export function profileFor(routeId) {
  const profiles = routeProfiles();
  if (!Object.hasOwn(profiles, routeId)) {
    const supported = Object.keys(profiles).sort().join(", ");
    throw pyKeyError(`unsupported route_id ${pyRepr(routeId)}; supported: ${supported}`);
  }
  return profiles[routeId];
}

export function conditionalRequiredFiles(pkg, profile) {
  const expected = [...pyGetItem(pyGetItem(profile, "agent"), "required_files")];
  const extensions = isRecord(pyGet(pkg, "extensions")) ? pyGet(pkg, "extensions") : {};
  const contracts = isRecord(pyGet(extensions, "capability_contract")) ? pyGet(extensions, "capability_contract") : {};
  const hasAcceptanceContext = Object.values(contracts).some(
    (contract) => isRecord(contract) && Object.hasOwn(contract, "acceptance_context") && isRecord(pyGet(contract, "acceptance_context")),
  );
  if (hasAcceptanceContext) expected.push(ACCEPTANCE_LEAF_COMMON_FILE);

  const card = isRecord(pyGet(profile, "card")) ? pyGet(profile, "card") : {};
  const selector = pyGet(card, "required_files_by_contract");
  const slot = pyStr(pyOr(pyGet(card, "slot"), "")).trim();
  const contract = slot && isRecord(pyGet(contracts, slot)) ? pyGet(contracts, slot) : {};
  if (isRecord(selector)) {
    const selected = pyStr(pyOr(pyGet(contract, pyStr(pyOr(pyGet(selector, "path"), ""))), ""));
    const mapping = isRecord(pyGet(selector, "map")) ? pyGet(selector, "map") : {};
    const promptPath = pyGet(mapping, selected);
    if (typeof promptPath === "string" && promptPath) expected.push(promptPath);
  }
  return [...new Set(expected)];
}
