// 角色推荐行（ops/agents/*.toml 的 [[picks]]）与模型档位（ops/model-notes.toml）的加载、校验与选型解析。
// 派发编译器、Fleet、分身选型、运行器档位校验与 Agent Panel 共用本模块；调用方不依赖 SelectionConfig 内部字段。
// 错误是 ToolError，带 code / file / field（推荐行错误另带 role / pick_id）；警告是同形对象。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

import { AUTHORIZATION_OVERRIDES } from "../_dispatch-prepare-argv.mjs";
import { ToolError } from "./_tool_common.mjs";

export const EFFORT_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const ID_RE = /^[a-z0-9_]+$/;
const ROLE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/;
const PICK_KEYS = Object.freeze(["id", "when", "capability", "model", "effort", "effort_min", "effort_max", "default"]);
const NOTE_KEYS = Object.freeze(["tag", "supports_vision", "description", "efforts", "effort_note"]);
const REMOVED_ROLE_KEYS = Object.freeze({
  pi_model: "改写 [[picks]]",
  pi_model_reasoning_effort: "改写 [[picks]]",
  pi_candidates: "改写 [[picks]]",
  owner_note: "改写 [[picks]]",
  pi_effort_limits: "档位范围改写在各推荐行的 effort_min / effort_max",
});
const REMOVED_NOTE_KEYS = Object.freeze({
  max_effort: "可选档位改写 efforts",
  effort_levels: "可选档位改写 efforts，实测说明写 effort_note",
  status: "模型是否可用以 Pi 模型清单为准",
});
const WORKER_RESOURCE_LISTS = Object.freeze(["tools", "extensions", "skills"]);
const PROJECT_SKILL_MODES = Object.freeze(["none", "all"]);
const AGENT_BLOCK_RE = /```yaml\s+task_package_agent\s*\n([\s\S]*?)\n```/;
const CARD_RE = /```json\s+route_card\s*\n([\s\S]*?)\n```/;

function fail(code, file, field, message, where = {}) {
  const error = new ToolError(`${field ? `${file} ${field}` : file}：${message}`);
  Object.assign(error, { code, file: String(file), field: field || null, ...where });
  throw error;
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function asText(value) {
  return text(value) ? value.trim() : "";
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

const rank = (level) => EFFORT_LEVELS.indexOf(level);

function readToml(file) {
  if (!text(file) || !existsSync(file)) fail("file_invalid", file || "(missing)", "", "文件不存在");
  try {
    return parseToml(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    fail("file_invalid", file, "", `不是有效 TOML：${error?.message ?? error}`);
  }
}

function optionalText(value, file, field, where) {
  if (value === undefined) return "";
  if (typeof value !== "string") fail("value_invalid", file, field, "必须是字符串", where);
  return value.trim();
}

function loadNotes(file) {
  const data = readToml(file);
  const notes = new Map();
  if (data.notes !== undefined && !record(data.notes)) fail("value_invalid", file, "notes", '必须是表，每个模型写一张 [notes."<模型>"]');
  for (const [model, value] of Object.entries(data.notes ?? {})) {
    const at = `notes."${model}"`;
    if (!record(value)) fail("value_invalid", file, at, "必须是表");
    for (const key of Object.keys(value)) {
      if (REMOVED_NOTE_KEYS[key]) fail("field_removed", file, `${at}.${key}`, `已删除，${REMOVED_NOTE_KEYS[key]}`);
      if (!NOTE_KEYS.includes(key)) fail("field_unknown", file, `${at}.${key}`, `未知字段；可用字段：${NOTE_KEYS.join("、")}`);
    }
    if (value.supports_vision !== undefined && typeof value.supports_vision !== "boolean") {
      fail("value_invalid", file, `${at}.supports_vision`, "必须是 true 或 false");
    }
    const efforts = value.efforts ?? EFFORT_LEVELS;
    const ordered = Array.isArray(efforts) && efforts.length > 0
      && efforts.every((item, index) => rank(item) >= 0 && (index === 0 || rank(item) > rank(efforts[index - 1])));
    if (!ordered) fail("value_invalid", file, `${at}.efforts`, `必须是 ${EFFORT_LEVELS.join(" < ")} 的非空子集，按档位顺序排列且不重复`);
    notes.set(model, {
      tag: optionalText(value.tag, file, `${at}.tag`),
      supports_vision: value.supports_vision ?? null,
      description: optionalText(value.description, file, `${at}.description`),
      efforts: [...efforts],
      effort_note: optionalText(value.effort_note, file, `${at}.effort_note`),
    });
  }
  return notes;
}

function loadRoutes(root) {
  const dir = root ? path.join(root, "ops", "protocols", "task-package-routes") : "";
  if (!dir || !existsSync(dir)) return [];
  const routes = [];
  for (const name of readdirSync(dir).filter((item) => item.endsWith(".md")).sort()) {
    const file = path.join(dir, name);
    const body = readFileSync(file, "utf8");
    const agent = AGENT_BLOCK_RE.exec(body);
    if (!agent) continue;
    const role = /(?:^|\n)\s*role:\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(agent[1])?.[1] || "";
    const capability = /capability:\s*\n(?:[^\n]*\n){0,4}?\s*name:\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(agent[1])?.[1] || "";
    if (!role || !capability) continue;
    let card = {};
    let phaseError = null;
    try {
      card = JSON.parse(CARD_RE.exec(body)?.[1] ?? "{}");
    } catch (error) {
      phaseError = `route_card 不是有效 JSON：${error?.message ?? error}`;
    }
    const phase = card.dispatch_phase;
    phaseError ??= phase === undefined ? "尚未写入 dispatch_phase"
      : !record(phase) || !["direct", "workflow"].includes(phase.kind) ? "dispatch_phase.kind 必须是 direct 或 workflow"
        : phase.kind === "workflow" && !text(phase.step) ? "dispatch_phase.step 缺少真实步骤" : null;
    routes.push({
      role,
      capability,
      route_id: `${role}__${capability}`,
      description: asText(card.applies_to),
      dispatch_phase: phaseError ? null : { kind: phase.kind, step: text(phase.step) ? phase.step.trim() : null },
      phase_error: phaseError,
      file,
    });
  }
  return routes;
}

function nameList(value, file, field) {
  if (!Array.isArray(value) || value.some((item) => !text(item))) fail("value_invalid", file, field, "必须是非空字符串数组");
  return [...new Set(value.map((item) => item.trim()))];
}

function projectSkillsValue(value, file, field) {
  if (PROJECT_SKILL_MODES.includes(value)) return value;
  if (Array.isArray(value)) return nameList(value, file, field);
  fail("value_invalid", file, field, '必须是 "none"、"all" 或 skill 名单');
}

// 角色顶层四键：缺省即空清单；四键都没写的角色（如分身）不受白名单管理，返回 null。
function roleWorkerResources(data, file) {
  if (![...WORKER_RESOURCE_LISTS, "project_skills"].some((key) => data[key] !== undefined)) return null;
  return {
    ...Object.fromEntries(WORKER_RESOURCE_LISTS.map((key) => [key, data[key] === undefined ? [] : nameList(data[key], file, key)])),
    project_skills: data.project_skills === undefined ? "none" : projectSkillsValue(data.project_skills, file, "project_skills"),
  };
}

// [capabilities.<id>] 同名四键只能收窄角色值，缺省继承。
function capabilityWorkerResources(role, value, file, field) {
  const base = role ?? { tools: [], extensions: [], skills: [], project_skills: "none" };
  const out = { ...base };
  for (const key of WORKER_RESOURCE_LISTS) {
    if (value[key] === undefined) continue;
    const list = nameList(value[key], file, `${field}.${key}`);
    const extra = list.filter((name) => !base[key].includes(name));
    if (extra.length) fail("value_invalid", file, `${field}.${key}`, `只能收窄角色清单，多出 ${extra.join(", ")}`);
    out[key] = list;
  }
  if (value.project_skills !== undefined) {
    const narrowed = projectSkillsValue(value.project_skills, file, `${field}.project_skills`);
    const allowed = base.project_skills === "all" || narrowed === "none"
      || (Array.isArray(base.project_skills) && Array.isArray(narrowed) && narrowed.every((name) => base.project_skills.includes(name)));
    if (!allowed) fail("value_invalid", file, `${field}.project_skills`, `只能收窄角色的 project_skills（角色值 ${JSON.stringify(base.project_skills)}）`);
    out.project_skills = narrowed;
  }
  return role || [...WORKER_RESOURCE_LISTS, "project_skills"].some((key) => value[key] !== undefined) ? out : null;
}

function effortsOf(notes, model) {
  return notes.get(model)?.efforts ?? EFFORT_LEVELS;
}

function loadPick(item, index, file, role, notes, known, ids) {
  const field = `picks[${index}]`;
  const where = { role, pick_id: record(item) && text(item.id) ? item.id.trim() : null };
  const bad = (code, key, message) => fail(code, file, key ? `${field}.${key}` : field, message, where);
  if (!record(item)) bad("value_invalid", "", "必须是表");
  if (item.slot !== undefined) bad("field_removed", "slot", "已删除，改写 model（Pi 模型全名）与 effort / effort_min / effort_max");
  const unknown = Object.keys(item).find((key) => !PICK_KEYS.includes(key));
  if (unknown) bad("field_unknown", unknown, `未知字段；可用字段：${PICK_KEYS.join("、")}。角色顶层键须写在第一个 [[picks]] 之前`);
  const id = asText(item.id);
  if (!ID_RE.test(id)) bad("value_invalid", "id", `必须是 ASCII 小写字母、数字与下划线，实得 ${JSON.stringify(item.id)}`);
  if (ids.has(id)) bad("pick_duplicate", "id", `${id} 在角色内重复`);
  ids.add(id);
  if (item.capability !== undefined && !text(item.capability)) bad("value_invalid", "capability", "不能为空；适用全部任务时删除该字段");
  const capability = item.capability === undefined ? null : item.capability.trim();
  if (capability && !known.has(capability)) bad("capability_unknown", "capability", `${capability} 不是该角色已有任务类型`);
  if (!text(item.model) || !item.model.includes("/")) bad("value_invalid", "model", "必须是 Pi 模型全名，例如 openai-codex/gpt-6.1-sol");
  const model = item.model.trim();
  const levels = {};
  for (const key of ["effort", "effort_min", "effort_max"]) {
    if (rank(item[key]) < 0) bad("value_invalid", key, `必须是 ${EFFORT_LEVELS.join("/")} 之一，实得 ${JSON.stringify(item[key])}`);
    levels[key] = item[key];
  }
  if (rank(levels.effort_min) > rank(levels.effort_max)) bad("effort_order", "effort_min", `${levels.effort_min} 高于 effort_max ${levels.effort_max}`);
  if (rank(levels.effort) < rank(levels.effort_min) || rank(levels.effort) > rank(levels.effort_max)) {
    bad("effort_order", "effort", `${levels.effort} 不在 effort_min–effort_max（${levels.effort_min}–${levels.effort_max}）内`);
  }
  const allowed = effortsOf(notes, model);
  for (const key of ["effort", "effort_min", "effort_max"]) {
    if (!allowed.includes(levels[key])) {
      bad("effort_not_supported", key, `${levels[key]} 不在 ${model} 的可选档位（${allowed.join("/")}）内；改选档位或到模型档位页调整`);
    }
  }
  if (item.default !== undefined && typeof item.default !== "boolean") bad("value_invalid", "default", "必须是 true 或 false");
  return { id, when: optionalText(item.when, file, `${field}.when`, where), capability, model, ...levels, default: item.default === true };
}

// 每个任务类型至多一行专属默认，角色默认至多一行；不继承的任务类型必须恰有一行专属默认；
// 角色没有任务类型、或有继承的任务类型缺专属默认时，必须有角色默认。
function checkDefaults(picks, known, capabilities, file, role) {
  const seen = new Map();
  picks.forEach((pick, index) => {
    if (!pick.default) return;
    const key = pick.capability ?? "";
    if (seen.has(key)) {
      fail("default_duplicate", file, `picks[${index}].default`, pick.capability
        ? `任务类型 ${pick.capability} 的默认行只能有一行（已有 ${seen.get(key)}）`
        : `不带 capability 的默认行只能有一行（已有 ${seen.get(key)}）`, { role, pick_id: pick.id });
    }
    seen.set(key, pick.id);
  });
  const lacking = [...known].filter((capability) => !seen.has(capability));
  const sealed = lacking.find((capability) => capabilities.get(capability)?.inherit_role_picks === false);
  if (sealed) {
    fail("default_missing", file, `capabilities.${sealed}`, "不继承角色推荐，必须有一行 capability 指向它的 default 推荐行", { role });
  }
  if ((known.size === 0 || lacking.length) && !seen.has("")) {
    fail("default_missing", file, "picks", known.size === 0
      ? "角色没有任务类型，必须把一行不带 capability 的推荐设为 default"
      : `任务类型 ${lacking.join("、")} 没有专属默认，必须把一行不带 capability 的推荐设为 default`, { role });
  }
}

function loadRoleFile(file, routes, notes) {
  const data = readToml(file);
  const role = asText(data.name);
  if (!role) fail("value_invalid", file, "name", "角色名不能为空");
  if (`${role}.toml` !== path.basename(file)) fail("value_invalid", file, "name", `与文件名不一致：${role}`);
  for (const [key, hint] of Object.entries(REMOVED_ROLE_KEYS)) {
    if (data[key] !== undefined) fail("field_removed", file, key, `已删除，${hint}`, { role });
  }
  const workerResources = roleWorkerResources(data, file);
  const roleRoutes = routes.filter((item) => item.role === role);
  const known = new Set(roleRoutes.map((item) => item.capability));
  const capabilities = new Map();
  if (data.capabilities !== undefined && !record(data.capabilities)) {
    fail("value_invalid", file, "capabilities", "必须是表，每个任务类型写一张 [capabilities.<id>]", { role });
  }
  for (const [capability, value] of Object.entries(data.capabilities ?? {})) {
    const field = `capabilities.${capability}`;
    if (roleRoutes.length && !known.has(capability)) fail("capability_unknown", file, field, "不是该角色已有任务类型", { role });
    if (!record(value)) fail("value_invalid", file, field, "必须是表", { role });
    if (value.inherit_role_picks !== undefined && typeof value.inherit_role_picks !== "boolean") {
      fail("value_invalid", file, `${field}.inherit_role_picks`, "必须是 true 或 false", { role });
    }
    capabilities.set(capability, {
      inherit_role_picks: value.inherit_role_picks !== false,
      worker_resources: capabilityWorkerResources(workerResources, value, file, field),
    });
    known.add(capability);
  }
  // 没有 route 卡的角色（测试夹具、分身）以推荐行里出现的任务类型为全集。
  if (!roleRoutes.length && Array.isArray(data.picks)) {
    for (const item of data.picks) if (record(item) && text(item.capability)) known.add(item.capability.trim());
  }
  if (!Array.isArray(data.picks) || !data.picks.length) fail("value_invalid", file, "picks", "至少要有一行推荐", { role });
  const ids = new Set();
  const picks = data.picks.map((item, index) => loadPick(item, index, file, role, notes, known, ids));
  checkDefaults(picks, known, capabilities, file, role);
  return {
    role,
    description: asText(data.description),
    file,
    picks,
    capabilities,
    routes: roleRoutes,
    known_capabilities: known,
    worker_resources: workerResources,
  };
}

function roleNames(sources) {
  const names = new Set();
  for (const dir of [sources.agents_dir, text(sources.global_root) ? path.join(sources.global_root, "ops", "agents") : ""]) {
    if (!text(dir) || !existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (ROLE_FILE_RE.test(name)) names.add(name.slice(0, -".toml".length));
  }
  return [...names].sort();
}

/**
 * sources 是 resolveModelConfigSources 的完整返回对象：agents_dir / model_notes 给出配置文件，
 * global_root 提供 route 卡（任务类型全集），roleConfigPath 负责项目覆盖缺角色时回落全局角色卡。
 */
export function loadSelectionConfig(sources) {
  if (!record(sources) || typeof sources.roleConfigPath !== "function") {
    throw new ToolError("loadSelectionConfig 需要 resolveModelConfigSources 的返回对象");
  }
  const notes = loadNotes(sources.model_notes);
  const routes = loadRoutes(sources.global_root);
  const roles = new Map();
  for (const name of roleNames(sources)) {
    const file = sources.roleConfigPath(name);
    if (existsSync(file)) roles.set(name, loadRoleFile(file, routes, notes));
  }
  return {
    sources,
    config_source: sources.describe(),
    notes,
    routes,
    roles,
    warnings: routes.filter((route) => route.phase_error)
      .map((route) => ({ code: "dispatch_phase_invalid", file: route.file, field: "dispatch_phase", role: route.role, message: route.phase_error })),
  };
}

/** 模型的可选档位：模型档位页维护；没有笔记或笔记未写 efforts 时七档全开。 */
export function modelEfforts(config, model) {
  return [...effortsOf(config.notes, model)];
}

function roleRecord(config, role) {
  const found = config.roles.get(role);
  if (!found) throw new ToolError(`未知角色：${role || "(空)"}`);
  return found;
}

function requireCapability(role, capability) {
  if (!text(capability)) throw new ToolError(`解析 ${role.role} 必须给出任务类型`);
  if (role.known_capabilities.size && !role.known_capabilities.has(capability)) {
    throw new ToolError(`${role.file}：${capability} 不是该角色已有任务类型`);
  }
}

function inherits(role, capability) {
  return role.capabilities.get(capability)?.inherit_role_picks !== false;
}

function applicable(role, capability) {
  return role.picks.filter((item) => item.capability === capability || (!item.capability && inherits(role, capability)));
}

function effectiveDefault(role, capability) {
  return role.picks.find((item) => item.capability === capability && item.default)
    || (inherits(role, capability) ? role.picks.find((item) => !item.capability && item.default) : null)
    || null;
}

/** Effective worker whitelist for role × capability; null when the role card declares none. */
export function resolveWorkerResources(config, roleName, capability) {
  const role = roleRecord(config, roleName);
  requireCapability(role, capability);
  const effective = role.capabilities.has(capability) ? role.capabilities.get(capability).worker_resources : role.worker_resources;
  return effective ? structuredClone(effective) : null;
}

export function selectionConfigFingerprint(config, { role = "" } = {}) {
  const roles = role ? [roleRecord(config, role)] : [...config.roles.values()];
  const snapshot = {
    notes: [...config.notes],
    roles: roles.map((item) => ({
      role: item.role,
      picks: item.picks,
      capabilities: [...item.capabilities],
      worker_resources: item.worker_resources,
    })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}

function readAuthorization(value) {
  if (value == null || value === "") return null;
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new ToolError(`authorization 不是有效 JSON：${error?.message ?? error}`);
    }
  }
  if (!record(parsed)) throw new ToolError("authorization 必须是对象 {quote, overrides}");
  if (!text(parsed.quote)) throw new ToolError("authorization.quote 必须是用户本轮原话");
  if (!Array.isArray(parsed.overrides) || parsed.overrides.some((item) => !AUTHORIZATION_OVERRIDES.includes(item))) {
    throw new ToolError(`authorization.overrides 只能包含 ${AUTHORIZATION_OVERRIDES.join("、")}`);
  }
  return { quote: parsed.quote, overrides: [...parsed.overrides] };
}

/**
 * pick 与 model 至多给一个，effort 可显式给出；都不给时取本任务类型的有效默认行。
 * 只给 model 时先看有效默认行是否同模型，再按顺序找本任务类型适用的同模型行；找不到须显式给 effort。
 * 模型可选档位之外直接拒绝；越出所在行 [effort_min, effort_max] 需授权 effort_range；
 * 模型不在该角色任何一行里需授权 outside_pool。授权只对本次 model + effort 生效。
 */
export function resolveSelection(config, input = {}) {
  const role = roleRecord(config, asText(input.role));
  const capability = asText(input.capability);
  requireCapability(role, capability);
  const requested = { pick: asText(input.pick) || null, model: asText(input.model) || null, effort: asText(input.effort) || null };
  if (requested.pick && requested.model) throw new ToolError("pick 与 model 只能填一个");
  if (requested.effort && rank(requested.effort) < 0) {
    throw new ToolError(`effort 必须是 ${EFFORT_LEVELS.join("/")} 之一，实得 ${requested.effort}`);
  }
  const authorization = readAuthorization(input.authorization);
  let row;
  if (requested.model) {
    const fallback = effectiveDefault(role, capability);
    row = fallback?.model === requested.model ? fallback : applicable(role, capability).find((item) => item.model === requested.model) || null;
  } else if (requested.pick) {
    row = role.picks.find((item) => item.id === requested.pick);
    if (!row) throw new ToolError(`${role.file}：推荐行不存在：${requested.pick}；可选 ${role.picks.map((item) => item.id).join("、")}`);
    if (row.capability && row.capability !== capability) {
      throw new ToolError(`${role.file}：推荐行 ${row.id} 只用于任务类型 ${row.capability}，不能用于 ${capability}`);
    }
  } else {
    row = effectiveDefault(role, capability);
    if (!row) throw new ToolError(`${role.file}：任务类型 ${capability} 没有有效默认推荐行`);
  }
  const model = requested.model || row.model;
  const effort = requested.effort || row?.effort;
  if (!effort) throw new ToolError(`${model} 不在 ${role.role} 适用于 ${capability} 的推荐行里，必须显式给出 effort`);
  const efforts = modelEfforts(config, model);
  if (!efforts.includes(effort)) {
    throw new ToolError(`${effort} 不在 ${model} 的可选档位（${efforts.join("/")}）内，授权不能解除；改选档位或到模型档位页调整`);
  }
  const pool = [...new Set(role.picks.map((item) => item.model))];
  const needed = [];
  if (!pool.includes(model)) {
    needed.push({ kind: "outside_pool", previous_value: pool, message: `${model} 不在 ${role.role} 的推荐行里` });
  } else if (row && (rank(effort) < rank(row.effort_min) || rank(effort) > rank(row.effort_max))) {
    needed.push({ kind: "effort_range", previous_value: [row.effort_min, row.effort_max],
      message: `${effort} 超出推荐行 ${row.id} 的档位范围 ${row.effort_min}–${row.effort_max}` });
  }
  const missing = needed.filter((item) => !authorization?.overrides.includes(item.kind));
  if (missing.length) {
    throw new ToolError(missing.map((item) => `${item.message}，需要用户授权：authorization={quote: 用户本轮原话, overrides: ["${item.kind}"]}`).join("；"));
  }
  return {
    requested,
    role: role.role,
    capability,
    pick: row?.id ?? null,
    config_source: {
      ...config.config_source,
      config_fingerprint: selectionConfigFingerprint(config, { role: role.role }),
    },
    resolved_model: model,
    resolved_effort: effort,
    effort_source: requested.effort ? "explicit" : "pick",
    efforts,
    effort_range: row ? [row.effort_min, row.effort_max] : null,
    authorization: authorization ? {
      quote: authorization.quote,
      requested_overrides: authorization.overrides,
      applied_overrides: needed.map(({ kind, previous_value }) => ({ kind, previous_value })),
    } : null,
  };
}

function capabilityRow(role, id) {
  const route = role.routes.find((item) => item.capability === id);
  return {
    id,
    route_id: route?.route_id ?? `${role.role}__${id}`,
    description: route?.description ?? "",
    dispatch_phase: route?.dispatch_phase ?? null,
    default_pick: effectiveDefault(role, id)?.id ?? null,
    inherit_role_picks: inherits(role, id),
  };
}

/**
 * 面板、list 与模板共用的只读投影。piModels 为当前 Pi 模型清单（string[]），取不到目录时为 null；
 * role / capability 只给 list 与模板收窄用。
 */
export function projectCatalog(config, { piModels = null, role: roleFilter = "", capability = "" } = {}) {
  const pi = piModels ? new Set(piModels) : null;
  const picked = [...config.roles.values()].flatMap((role) => role.picks.map((pick) => pick.model));
  const models = [...new Set([...(piModels ?? []), ...config.notes.keys(), ...picked])].map((model) => {
    const note = config.notes.get(model);
    return {
      model,
      tag: note?.tag ?? "",
      supports_vision: note?.supports_vision ?? null,
      efforts: modelEfforts(config, model),
      effort_note: note?.effort_note ?? "",
      in_pi: pi ? pi.has(model) : null,
    };
  });
  const warnings = [...config.warnings];
  const roles = [];
  for (const role of config.roles.values()) {
    if (roleFilter && role.role !== roleFilter) continue;
    if (capability) requireCapability(role, capability);
    const shown = capability ? applicable(role, capability) : role.picks;
    if (pi) {
      role.picks.forEach((pick, index) => {
        if (shown.includes(pick) && !pi.has(pick.model)) {
          warnings.push({ code: "model_not_in_pi", file: role.file, field: `picks[${index}].model`, role: role.role, pick_id: pick.id,
            message: `${pick.model} 不在当前 Pi 模型清单中` });
        }
      });
    }
    roles.push({
      role: role.role,
      description: role.description,
      capabilities: (capability ? [capability] : [...role.known_capabilities]).map((id) => capabilityRow(role, id)),
      picks: shown.map((pick) => ({ ...pick })),
    });
  }
  if (roleFilter && !roles.length) throw new ToolError(`未知角色：${roleFilter}`);
  return { config_source: config.config_source, config_fingerprint: selectionConfigFingerprint(config, { role: roleFilter }), models, roles, warnings };
}
