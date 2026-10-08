import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "../../../../ops/node_modules/smol-toml/dist/index.js";
import { ToolError } from "../../../../ops/tools/dispatch-core/_tool_common.mjs";
import { EFFORT_LEVELS, loadSelectionConfig, projectCatalog } from "../../../../ops/tools/dispatch-core/model_selection.mjs";
import { resolveModelConfigSources } from "../../../../ops/tools/model_config.mjs";
import { PanelError } from "./async-core.mjs";
import { createConfigSync } from "./config-sync.mjs";
import { patchDocument, TomlWritebackError } from "./toml-blocks.mjs";

const NOTES = "ops/model-notes.toml";
const LABELS = "ops/panel-labels.toml";
const ROUTES = "ops/protocols/task-package-routes";
const PYTHON_PARSE = "import json,sys,tomllib; print(json.dumps({k:tomllib.loads(v) for k,v in json.load(sys.stdin).items()}))";
// 推荐行里面板可编辑的字段；when / capability / default 缺省时不写进文件。
const PICK_FIELDS = ["id", "when", "capability", "model", "effort", "effort_min", "effort_max", "default"];
const OPTIONAL_PICK_FIELDS = ["when", "capability", "default"];
// 分身工具按标识写死引用的推荐行（adapters/pi/src/delegate-work-extension.mjs 的 DELEGATE_PICKS），界面不提供删除与改名。
const FIXED_PICKS = Object.freeze({ "delegate-work": ["luna_xhigh", "luna_max", "sol_high"] });
const EFFORT_FIELDS = { effort_min: "最低档位", effort: "默认档位", effort_max: "最高档位" };
// 模型笔记里面板可编辑的文字字段；草稿给空串表示删除该字段。
const NOTE_TEXT_FIELDS = ["tag", "description", "effort_note"];

export class SelectionError extends PanelError {
  constructor(code, message, details = null, status = 422) {
    super(code, message, { status, scope: "local", details });
  }
}

function revision(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function absolute(root, relative) {
  return path.join(root, ...relative.split("/"));
}

function relativeFile(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function roleFile(role) {
  return `ops/agents/${role}.toml`;
}

function editablePicks(picks) {
  if (!Array.isArray(picks)) throw new SelectionError("SELECTION_DRAFT_INVALID", "推荐行必须是数组");
  return picks.map((pick) => {
    if (!pick || typeof pick !== "object" || Array.isArray(pick)) throw new SelectionError("SELECTION_DRAFT_INVALID", "推荐行必须是对象");
    const entry = Object.fromEntries(PICK_FIELDS.filter((key) => Object.hasOwn(pick, key)).map((key) => [key, pick[key]]));
    for (const key of OPTIONAL_PICK_FIELDS) if (entry[key] === "" || entry[key] === null || entry[key] === false) delete entry[key];
    return entry;
  });
}

// toml-patch 按 id 合并推荐行以保留注释，草稿里清空的可省略字段要在合并后逐行删掉。
function clearOptionalPickFields(text, picks) {
  const wanted = new Map(picks.map((pick) => [pick.id, pick]));
  const lines = text.split("\n");
  const headers = [];
  let triple = null;
  let depth = 0;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    if (!triple && depth === 0 && /^\s*\[\[?[^\]\r\n]+\]\]?\s*(?:#.*)?$/.test(line)) {
      headers.push({ row, pick: /^\s*\[\[picks\]\]\s*(?:#.*)?$/.test(line) });
    }
    let quote = null;
    for (let index = 0; index < line.length; index += 1) {
      if (triple) {
        if (line.startsWith(triple, index)) { triple = null; index += 2; }
        continue;
      }
      if (quote) {
        if (quote === '"' && line[index] === "\\") { index++; continue; }
        if (line[index] === quote) quote = null;
        continue;
      }
      if (line[index] === "#") break;
      if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
        triple = line.slice(index, index + 3);
        index += 2;
      } else if (line[index] === '"' || line[index] === "'") quote = line[index];
      else if (line[index] === "[") depth++;
      else if (line[index] === "]") depth = Math.max(0, depth - 1);
    }
  }
  const removed = new Set();
  const optional = new RegExp(`^\\s*(${OPTIONAL_PICK_FIELDS.join("|")})\\s*=`);
  for (let index = 0; index < headers.length; index += 1) {
    const block = headers[index];
    if (!block.pick) continue;
    const end = headers[index + 1]?.row ?? lines.length;
    const idLine = lines.slice(block.row + 1, end).find((line) => /^\s*id\s*=/.test(line));
    const target = idLine && wanted.get(parseToml(idLine).id);
    if (!target) continue;
    for (let row = block.row + 1; row < end; row += 1) {
      const field = optional.exec(lines[row])?.[1];
      if (field && !Object.hasOwn(target, field)) removed.add(row);
    }
  }
  return lines.filter((_, row) => !removed.has(row)).join("\n");
}

function equalData(left, right) {
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, i) => equalData(item, right[i]));
  if (left && typeof left === "object") return right && typeof right === "object" && !Array.isArray(right)
    && Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every((key) => Object.hasOwn(right, key) && equalData(left[key], right[key]));
  return left === right;
}

// 错误与警告统一成 { code, file, field, role?, pick_id?, message }：file 相对控制仓，
// 角色卡里 picks[N] 开头的字段按对应推荐行补出 role 与 pick_id，供页面定位到行和字段。
function located({ code, file, field = null, role, pick_id: pickId, message }, root, picksOf) {
  const relative = file ? relativeFile(root, file) : null;
  const owner = role ?? /^ops\/agents\/([^/]+)\.toml$/.exec(relative ?? "")?.[1];
  const index = /^picks\[(\d+)\]/.exec(field ?? "")?.[1];
  const pick = pickId ?? (owner && index !== undefined ? picksOf(owner)?.[Number(index)]?.id : undefined);
  return { code, file: relative, field, ...(owner && { role: owner }), ...(pick && { pick_id: pick }), message };
}

function candidateError(error, root, picksOf) {
  if (error instanceof TomlWritebackError) {
    return located({ code: error.code, file: error.file, message: error.message }, root, picksOf);
  }
  if (!(error instanceof ToolError)) throw error;
  return located({ code: error.code ?? "SELECTION_CONFIG_INVALID", file: error.file, field: error.field, role: error.role, pick_id: error.pick_id,
    message: error.message.slice(error.message.indexOf("：") + 1) }, root, picksOf);
}

// 模型档位页去掉的档位若仍被推荐行引用，逐行列出，整批拒绝。
function effortsInUse(targets, roles) {
  const notes = targets[NOTES]?.notes;
  if (!notes) return [];
  return Object.entries(roles).flatMap(([role, saved]) => (targets[roleFile(role)]?.picks ?? saved).flatMap((pick) => {
    const levels = notes[pick.model]?.efforts;
    return levels ? Object.keys(EFFORT_FIELDS).filter((field) => !levels.includes(pick[field])).map((field) => ({
      code: "EFFORT_IN_USE", file: NOTES, field: `notes."${pick.model}".efforts`, role, pick_id: pick.id,
      message: `${pick[field]} 仍是推荐行 ${pick.id} 的${EFFORT_FIELDS[field]}`,
    })) : [];
  }));
}

// Pi 目录可用时，可选档位必须是该模型 Pi 支持档的非空子集；不在目录的模型不受此限。
function effortsUnsupported(targets, piDetails) {
  return Object.entries(targets[NOTES]?.notes ?? {}).flatMap(([model, note]) => {
    const levels = piDetails?.[model]?.thinking_levels;
    if (!note.efforts || !Array.isArray(levels)) return [];
    const extra = note.efforts.filter((level) => !levels.includes(level));
    if (note.efforts.length && !extra.length) return [];
    return [{ code: "EFFORT_NOT_SUPPORTED", file: NOTES, field: `notes."${model}".efforts`,
      message: extra.length ? `Pi 不支持 ${extra.join("、")}；可选 ${levels.join("/")}` : `至少保留一个档位；可选 ${levels.join("/")}` }];
  });
}

// 面板目录条目已带 Pi 详情（thinking_levels 等）；目录不可用时为 null。
function piDetailsOf(pi) {
  return pi?.available ? Object.fromEntries(pi.models.map((entry) => [entry.value, entry])) : null;
}

function plainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function fileOrder(a, b) {
  return (a === NOTES ? 0 : 1) - (b === NOTES ? 0 : 1) || a.localeCompare(b);
}

function modelSources(root) {
  return resolveModelConfigSources({ roots: [{ root, source: "control_repo" }], projectRoot: root });
}

/** 推荐行与模型档位的读取和多文件保存；真源是控制仓（不是监控工程）。 */
export function createSelectionStore(options = {}) {
  const sync = options.sync || createConfigSync({ ...options, faultInjector: options.syncFaultInjector });
  const pythonCommand = options.pythonCommand || process.env.AGENT_PANEL_PYTHON || "python";
  const faultInjector = options.faultInjector;
  let cached = null;

  function readSnapshot() {
    const root = sync.resolveSources().control_root;
    const roleFiles = readdirSync(path.join(root, "ops", "agents"))
      .filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/.test(name)).sort()
      .map((name) => `ops/agents/${name}`);
    const files = [NOTES, ...roleFiles];
    const texts = Object.fromEntries(files.map((file) => [file, readFileSync(absolute(root, file), "utf8")]));
    const revisions = Object.fromEntries(files.map((file) => [file, revision(texts[file])]));
    const key = JSON.stringify(revisions);
    if (!cached || cached.root !== root || cached.key !== key) {
      const sources = modelSources(root);
      const parsed = Object.fromEntries(files.map((file) => [file, parseToml(texts[file])]));
      const editable = {
        roles: Object.fromEntries(roleFiles.map((file) => [path.basename(file, ".toml"), editablePicks(parsed[file].picks || [])])),
        efforts: Object.fromEntries(Object.entries(parsed[NOTES].notes || {}).filter(([, note]) => note.efforts).map(([model, note]) => [model, note.efforts])),
        notes: Object.fromEntries(Object.entries(parsed[NOTES].notes || {})
          .map(([model, note]) => [model, Object.fromEntries(NOTE_TEXT_FIELDS.filter((field) => typeof note[field] === "string").map((field) => [field, note[field]]))])
          .filter(([, fields]) => Object.keys(fields).length)),
      };
      let config;
      try { config = loadSelectionConfig(sources); }
      catch (error) {
        const failure = candidateError(error, root, (role) => editable.roles[role]);
        throw new SelectionError(failure.code, failure.message, failure);
      }
      cached = { root, key, files, texts, revisions, parsed, config, editable, sources };
    }
    return cached;
  }

  function readLabels(root) {
    const file = absolute(root, LABELS);
    return existsSync(file) ? parseToml(readFileSync(file, "utf8")) : {};
  }

  function selectionState(configState = {}, monitorRoot = null) {
    const snapshot = readSnapshot();
    const pi = configState.catalogs?.pi ?? { available: false, error: "", models: [] };
    let projectOverride = null;
    if (monitorRoot && path.resolve(monitorRoot) !== snapshot.root) {
      const monitoredSources = resolveModelConfigSources({ roots: [{ root: snapshot.root }], projectRoot: monitorRoot }).describe();
      if (monitoredSources.project_override) projectOverride = monitoredSources;
    }
    // 没取到 Pi 模型清单时 piDetails 为 null；失败刷新时沿用上次成功的清单。
    const catalog = projectCatalog(snapshot.config, { piDetails: piDetailsOf(pi) });
    catalog.warnings = catalog.warnings.map((warning) => located({ code: "SELECTION_WARNING", ...warning }, snapshot.root, (role) => snapshot.editable.roles[role]));
    return { catalog, effort_levels: [...EFFORT_LEVELS], fixed_picks: FIXED_PICKS,
      labels: readLabels(snapshot.root), editable: snapshot.editable, revisions: snapshot.revisions, pi_catalog: pi,
      project_override: projectOverride, sync_status: configState.sync_status ?? sync.status() };
  }

  // 草稿可含 roles（角色 → 推荐行数组）、efforts（模型 → 可选档位）与 notes（模型 → 文字字段），按文件给出目标数据。
  function draftTargets(draft, snapshot) {
    if (!plainRecord(draft)) throw new SelectionError("SELECTION_DRAFT_INVALID", "草稿必须是对象");
    const targets = {};
    for (const [role, picks] of Object.entries(draft.roles || {})) {
      if (!Object.hasOwn(snapshot.editable.roles, role)) throw new SelectionError("SELECTION_ROLE_INVALID", `角色不存在：${role}`);
      const target = editablePicks(picks);
      if (!equalData(target, snapshot.editable.roles[role])) targets[roleFile(role)] = { picks: target };
    }
    const notes = {};
    for (const [model, levels] of Object.entries(draft.efforts || {})) {
      if (!Array.isArray(levels)) throw new SelectionError("SELECTION_DRAFT_INVALID", `可选档位必须是数组：${model}`);
      if (!equalData(levels, snapshot.editable.efforts[model] ?? null)) (notes[model] ??= {}).efforts = levels;
    }
    for (const [model, fields] of Object.entries(draft.notes || {})) {
      if (!plainRecord(fields)) throw new SelectionError("SELECTION_DRAFT_INVALID", `模型笔记必须是对象：${model}`);
      for (const [field, value] of Object.entries(fields)) {
        if (typeof value !== "string") throw new SelectionError("SELECTION_DRAFT_INVALID", `${model} 的 ${field} 必须是字符串`);
        if (value.trim() !== (snapshot.editable.notes[model]?.[field] ?? "")) (notes[model] ??= {})[field] = value.trim();
      }
    }
    if (Object.keys(notes).length) targets[NOTES] = { notes };
    return targets;
  }

  function written(file, data, target) {
    if (file !== NOTES) return equalData(editablePicks(data.picks || []), target.picks);
    return Object.entries(target.notes).every(([model, note]) => Object.entries(note).every(([field, value]) => (field === "efforts"
      ? equalData(data.notes?.[model]?.efforts ?? null, value)
      : (data.notes?.[model]?.[field] ?? "") === value)));
  }

  function validateCandidates(snapshot, candidates, picksOf) {
    const root = mkdtempSync(path.join(os.tmpdir(), "panel-selection-"));
    try {
      for (const file of snapshot.files) {
        mkdirSync(path.dirname(absolute(root, file)), { recursive: true });
        writeFileSync(absolute(root, file), candidates[file] ?? snapshot.texts[file]);
      }
      // 任务类型取自路由卡，原样复制供解析器读取。
      const routes = absolute(snapshot.root, ROUTES);
      if (existsSync(routes)) {
        mkdirSync(absolute(root, ROUTES), { recursive: true });
        for (const name of readdirSync(routes).filter((item) => item.endsWith(".md"))) copyFileSync(path.join(routes, name), path.join(absolute(root, ROUTES), name));
      }
      try { loadSelectionConfig(modelSources(root)); }
      catch (error) { return candidateError(error, root, picksOf); }
      const parsed = spawnSync(pythonCommand, ["-c", PYTHON_PARSE], {
        input: JSON.stringify(candidates), encoding: "utf8", timeout: 15000, windowsHide: true,
      });
      if (parsed.error || parsed.status !== 0) throw new SelectionError("SELECTION_PYTHON_FAILED", "Python tomllib 校验失败", { reason: parsed.error?.message || parsed.stderr }, 503);
      const python = JSON.parse(parsed.stdout);
      const mismatch = Object.keys(candidates).find((file) => !equalData(parseToml(candidates[file]), python[file]));
      return mismatch ? { code: "SELECTION_SEMANTIC_MISMATCH", file: mismatch, field: null, message: "候选文件双解析结果不一致" } : null;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function saveSelection({ draft, expected_revision: expectedRevision } = {}, configState = {}, monitorRoot = null) {
    const snapshot = readSnapshot();
    // 推荐行只接受面板可编辑的字段；旧字段（如 slot）不能被静默丢弃后报成已保存。
    const unknown = Object.entries(draft?.roles || {}).flatMap(([role, picks]) => (Array.isArray(picks) ? picks : []).flatMap((pick, index) => Object.keys(pick || {})
      .filter((key) => !PICK_FIELDS.includes(key))
      .map((key) => ({ code: "PICK_FIELD_UNKNOWN", file: roleFile(role), field: `picks[${index}].${key}`, role, pick_id: pick.id, message: `含面板不支持的配置项「${key}」，保存已拒绝` }))));
    const unknownNotes = Object.entries(plainRecord(draft?.notes) ? draft.notes : {}).flatMap(([model, fields]) => Object.keys(plainRecord(fields) ? fields : {})
      .filter((key) => !NOTE_TEXT_FIELDS.includes(key))
      .map((key) => ({ code: "NOTE_FIELD_UNKNOWN", file: NOTES, field: `notes."${model}".${key}`, message: `含面板不支持的配置项「${key}」，保存已拒绝` })));
    if (unknown.length || unknownNotes.length) return { state: "validation_error", errors: [...unknown, ...unknownNotes] };
    const targets = draftTargets(draft, snapshot);
    const changed = Object.keys(targets).sort(fileOrder);
    const stale = changed.find((file) => expectedRevision?.[file] !== snapshot.revisions[file]);
    if (stale) return { state: "revision_conflict", file: stale, current_revision: snapshot.revisions[stale] };
    const inUse = effortsInUse(targets, snapshot.editable.roles);
    if (inUse.length) return { state: "validation_error", errors: inUse };
    const piDetails = piDetailsOf(configState.catalogs?.pi);
    const unsupported = effortsUnsupported(targets, piDetails);
    if (unsupported.length) return { state: "validation_error", errors: unsupported };
    // 勾满 Pi 支持档等于不收窄，删掉 efforts；字段删光的笔记整段删除。
    for (const [model, note] of Object.entries(targets[NOTES]?.notes ?? {})) {
      if (note.efforts && equalData(note.efforts, piDetails?.[model]?.thinking_levels)) note.efforts = null;
    }
    const picksOf = (role) => targets[roleFile(role)]?.picks ?? snapshot.editable.roles[role];
    const candidates = {};
    for (const file of changed) {
      try {
        const deletedPaths = file === NOTES ? Object.entries(targets[file].notes).flatMap(([model, note]) => {
          const cleared = Object.keys(note).filter((field) => note[field] === "" || note[field] === null);
          const kept = new Set([...Object.keys(snapshot.parsed[NOTES].notes?.[model] ?? {}), ...Object.keys(note)].filter((field) => !cleared.includes(field)));
          return kept.size ? cleared.map((field) => ["notes", model, field]) : [["notes", model]];
        }) : [];
        candidates[file] = patchDocument(snapshot.texts[file], targets[file], { file: absolute(snapshot.root, file), deletedPaths });
      } catch (error) {
        if (!(error instanceof TomlWritebackError)) throw error;
        return { state: "validation_error", errors: [candidateError(error, snapshot.root, picksOf)] };
      }
      if (file !== NOTES) candidates[file] = clearOptionalPickFields(candidates[file], targets[file].picks);
      if (!written(file, parseToml(candidates[file]), targets[file])) {
        return { state: "validation_error", errors: [{ code: "SELECTION_SEMANTIC_MISMATCH", file, field: null, message: "写回结果与草稿不一致" }] };
      }
    }
    if (changed.length) {
      const error = validateCandidates(snapshot, candidates, picksOf);
      if (error) return { state: "validation_error", errors: [error] };
    }
    faultInjector?.({ op: "before-cas", files: changed });
    // 全部解析校验完成后、任何临时写入前，再核对一次 revision。
    for (const file of changed) {
      const fresh = readFileSync(absolute(snapshot.root, file), "utf8");
      if (revision(fresh) !== expectedRevision[file]) {
        cached = null;
        return { state: "revision_conflict", file, current_revision: revision(fresh) };
      }
    }
    const staged = [];
    const swapped = [];
    const restoreErrors = [];
    try {
      for (const file of changed) {
        const destination = absolute(snapshot.root, file);
        const suffix = randomBytes(8).toString("hex");
        const temporary = `${destination}.panel-tmp-${suffix}`;
        const backup = `${destination}.panel-bak-${suffix}`;
        copyFileSync(destination, backup);
        staged.push({ file, destination, temporary, backup });
        writeFileSync(temporary, candidates[file], "utf8");
      }
      for (const item of staged) {
        faultInjector?.({ op: "before-rename", file: item.file });
        renameSync(item.temporary, item.destination);
        swapped.push(item);
        if (readFileSync(item.destination, "utf8") !== candidates[item.file]) throw new Error(`post-write verification failed: ${item.file}`);
      }
    } catch (error) {
      for (const item of [...swapped].reverse()) {
        try { copyFileSync(item.backup, item.destination); }
        catch (restoreError) { restoreErrors.push({ file: item.file, reason: restoreError.message, backup: item.backup }); }
      }
      throw new SelectionError(restoreErrors.length ? "SELECTION_RESTORE_FAILED" : "SELECTION_WRITE_FAILED",
        "多文件写入失败", { cause: error.message, restore_errors: restoreErrors }, 503);
    } finally {
      for (const item of staged) {
        rmSync(item.temporary, { force: true });
        if (existsSync(item.backup) && !restoreErrors.some((failure) => failure.file === item.file)) rmSync(item.backup, { force: true });
      }
      cached = null;
    }
    const results = sync.syncWritten(changed);
    return { state: "saved", selection: selectionState(configState, monitorRoot),
      write_results: changed.map((file) => ({ file, ok: true })), ...results };
  }

  return { selectionState, saveSelection, sync: () => sync.reconcile() };
}
