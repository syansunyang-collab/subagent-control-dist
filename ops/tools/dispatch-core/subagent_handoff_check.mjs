// ops/tools/subagent_handoff_check.py 的 JS 复刻（dispatch-core 迁移波 1b）。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」：导出名为 Python 函数名的 camelCase，
// 位置参数同序，Python 关键字参数作为末尾 options 对象（键 camelCase）。错误消息与 issue code 逐字一致。
//
// 异常映射表（Python → JS）
//   ToolError(msg)                                   → ToolError(msg)，消息逐字相同。覆盖 target_root 的四条分支、
//                                                      task_path 的 "<label> not found"、load_task_package_by_id 的
//                                                      "task package not found for package_id="，以及 _tool_common
//                                                      load_json 的 json file not found / cannot read / invalid /
//                                                      json root is not object。
//   OSError / IsADirectoryError（读文件、stat 失败）    → Node fs 原生 Error 原样上抛；Python 侧同样不捕获这些分支。
//   TypeError（实参类型错）                            → TypeError。
//
// 返回值口径
//   Python 返回 set 的函数（report_headings、task_gate_values）在 JS 返回「按码点排序、去重的数组」。
//   Python 返回 Path 的函数在 JS 返回平台原生路径字符串。
//   Python 返回 tuple 的函数在 JS 返回数组。
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { ROOT, ToolError, clock, isRecord, loadJson as readJsonObject, rel, resolveLikePython } from "./_tool_common.mjs";
import {
  PY_ALNUM_RE, PY_SPACE_CLASS, PY_SPACE_RE, pyCasefold, pyGet, pyIsAbsolute, pyLStrip, pyReadTextReplace,
  pySamePath, pySplitLines, pyStrip, pyStripChars,
} from "./_py.mjs";

export const NON_PATH_EVIDENCE_LABELS = new Set([
  "ENV", "REG", "CMD", "DIR", "DIR1", "DIR2", "DIR3", "SERVICE", "PROCESS", "PORT", "LICENSE",
]);

// ---- 本模块私有的 Python 语义补充（通用部分在 _py.mjs） ----

function comparePythonStrings(left, right) {
  const a = [...String(left)];
  const b = [...String(right)];
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const x = a[index].codePointAt(0);
    const y = b[index].codePointAt(0);
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

// Python set → 排序去重数组（json_safe 对 set 的口径）。
function sortedUnique(values) {
  return [...new Set(values)].sort(comparePythonStrings);
}

// Path(value).resolve() if is_absolute else (ROOT / value).resolve()
function resolveAgainstRoot(value) {
  const text = String(value ?? "");
  return pyIsAbsolute(text) ? resolveLikePython(text) : resolveLikePython(path.resolve(ROOT, text));
}

// ---- 逐函数复刻 ----

export function targetRoot(taskPackage) {
  const runtime = pyGet(taskPackage, "runtime_context");
  const target = isRecord(runtime) ? pyGet(runtime, "target_repo") : undefined;
  if (target === null || target === undefined || target === "") return resolveLikePython(ROOT);
  if (typeof target !== "string" || !pyStrip(target)) {
    throw new ToolError("runtime_context.target_repo must be a non-empty string when set");
  }
  if (!pyIsAbsolute(target)) throw new ToolError("runtime_context.target_repo must be an absolute path");
  const resolved = resolveLikePython(target);
  if (!existsSync(resolved)) throw new ToolError(`runtime_context.target_repo not found: ${target}`);
  let info;
  try {
    info = statSync(resolved);
  } catch {
    info = null;
  }
  if (!info || !info.isDirectory()) throw new ToolError(`runtime_context.target_repo is not a directory: ${target}`);
  return resolved;
}

export function taskPath(value, taskPackage, { label, mustExist = false } = {}) {
  const resolved = resolveAgainstRoot(value);
  if (mustExist && !existsSync(resolved)) throw new ToolError(`${label} not found: ${rel(resolved)}`);
  return resolved;
}

export function loadJson(file) {
  const data = readJsonObject(file);
  const taskPackage = pyGet(data, "task_package");
  return isRecord(taskPackage) ? taskPackage : data;
}

export function safePackageFilename(packageId) {
  let out = "";
  for (const ch of String(packageId ?? "")) {
    out += PY_ALNUM_RE.test(ch) || "._:-".includes(ch) ? ch : "-";
  }
  return [...out].slice(0, 120).join("");
}

function listDirectory(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function mtimeNs(file) {
  try {
    return statSync(file, { bigint: true }).mtimeNs;
  } catch {
    return 0n;
  }
}

export function candidatePackagePaths(packageId) {
  const safe = safePackageFilename(packageId);
  const candidates = [
    path.join(ROOT, "tmp", "dispatch_prepare", `${safe}.task-package.json`),
    path.join(ROOT, "notes", "manifests", `${safe}.task-package.json`),
  ];
  for (const root of [path.join(ROOT, "tmp", "dispatch_prepare"), path.join(ROOT, "notes", "manifests")]) {
    if (!existsSync(root)) continue;
    for (const name of listDirectory(root)) {
      if (!name.endsWith(".json")) continue;
      if (!String(name).includes(packageId)) continue;
      candidates.push(path.join(root, name));
    }
  }
  const preparationRoot = path.join(ROOT, "tmp", "dispatch_prepare", "preparations");
  if (existsSync(preparationRoot)) {
    const preparationPackages = [];
    for (const name of listDirectory(preparationRoot)) {
      if (!name.startsWith("prep-")) continue;
      const candidate = path.join(preparationRoot, name, "package.json");
      if (existsSync(candidate)) preparationPackages.push(candidate);
    }
    // Python list.sort(key=..., reverse=True) 稳定：并列项保持原顺序。
    preparationPackages.sort((left, right) => {
      const a = mtimeNs(left);
      const b = mtimeNs(right);
      if (a === b) return 0;
      return a < b ? 1 : -1;
    });
    candidates.push(...preparationPackages);
  }
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const resolved = resolveLikePython(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export function loadTaskPackageById(packageId) {
  const checked = [];
  for (const candidate of candidatePackagePaths(packageId)) {
    checked.push(rel(candidate));
    if (!existsSync(candidate)) continue;
    let taskPackage;
    try {
      taskPackage = loadJson(candidate);
    } catch (error) {
      // 单个候选损坏(半截写入/截断)不阻断整个查找,继续找目标 package_id。
      if (error instanceof ToolError || error?.name === "ToolError") continue;
      throw error;
    }
    if (String(pyGet(taskPackage, "package_id") || "") === packageId) return [candidate, taskPackage];
  }
  throw new ToolError(`task package not found for package_id=${packageId}; checked=${checked.join(", ")}`);
}

export function scalarFields(text) {
  const fields = Object.create(null);
  for (const line of pySplitLines(text)) {
    const stripped = pyStrip(line);
    if (!stripped || stripped.startsWith("- ") || stripped.endsWith(":")) continue;
    if (!stripped.includes(":")) continue;
    const separator = stripped.indexOf(":");
    const key = pyStrip(stripped.slice(0, separator));
    const rawValue = stripped.slice(separator + 1);
    if (!key || PY_SPACE_RE.test(key)) continue;
    const value = pyStripChars(pyStrip(rawValue), "\"'`");
    if (["", "null", "none", "~"].includes(value.toLowerCase())) continue;
    if (!Object.hasOwn(fields, key)) fields[key] = [];
    fields[key].push(value);
  }
  return fields;
}

export function firstField(fields, ...names) {
  for (const name of names) {
    const values = (fields && typeof fields === "object" && Object.hasOwn(fields, name) ? fields[name] : null) || [];
    if (values.length) return values[0];
  }
  return "";
}

// 只认 section 的直接子标量：section 须与首行（FINAL_HANDOFF:）的直接子项同层，
// section 下更深层的同名 key 不算。
export function nestedScalarField(text, section, field) {
  const lines = pySplitLines(text).filter((line) => pyStrip(line));
  const indentOf = (line) => line.length - pyLStrip(line).length;
  const baseIndent = lines.length > 1 ? indentOf(lines[1]) : 0;
  const start = lines.findIndex((line, index) => index > 0 && indentOf(line) === baseIndent && pyStrip(line) === `${section}:`);
  if (start < 0) return "";
  const childIndent = start + 1 < lines.length ? indentOf(lines[start + 1]) : 0;
  for (const line of lines.slice(start + 1)) {
    const indent = indentOf(line);
    if (indent <= baseIndent) break;
    if (indent !== childIndent) continue;
    const stripped = pyStrip(line);
    if (stripped.startsWith("- ") || stripped.endsWith(":")) continue;
    if (!stripped.includes(":")) continue;
    const separator = stripped.indexOf(":");
    const key = stripped.slice(0, separator);
    const rawValue = stripped.slice(separator + 1);
    if (pyStrip(key) !== field) continue;
    const value = pyStripChars(pyStrip(rawValue), "\"'`");
    if (["", "null", "none", "~"].includes(value.toLowerCase())) return "";
    return value;
  }
  return "";
}

export function extractFinalHandoff(text) {
  const marker = "FINAL_HANDOFF:";
  const value = String(text ?? "");
  const index = value.lastIndexOf(marker);
  if (index < 0) return "";
  return pyStrip(value.slice(index));
}

export function sectionItems(text, name) {
  const lines = pySplitLines(text);
  let start = -1;
  let baseIndent = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = pyStrip(lines[index]);
    if (stripped === `${name}:`) {
      start = index;
      baseIndent = lines[index].length - pyLStrip(lines[index]).length;
      break;
    }
  }
  if (start < 0) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (!pyStrip(line)) continue;
    const indent = line.length - pyLStrip(line).length;
    if (indent <= baseIndent && !pyLStrip(line).startsWith("- ")) break;
    const stripped = pyStrip(line);
    if (stripped.startsWith("- ")) {
      const value = pyStripChars(pyStrip(stripped.slice(2)), "\"'`");
      if (value) items.push(value);
    }
  }
  return items;
}

export function taskExpectedOutputFile(taskPackage) {
  const expected = pyGet(taskPackage, "expected_output");
  if (isRecord(expected) && String(pyGet(expected, "mode") || "") === "file") {
    return String(pyGet(expected, "resolved_file_path") || pyGet(expected, "file_path") || "");
  }
  return "";
}

export function taskExpectedResolvedFile(taskPackage) {
  const expected = pyGet(taskPackage, "expected_output");
  if (isRecord(expected) && String(pyGet(expected, "mode") || "") === "file") {
    return String(pyGet(expected, "resolved_file_path") || "");
  }
  return "";
}

export function taskHandoffResolvedFile(taskPackage) {
  const handoff = pyGet(taskPackage, "handoff_contract");
  if (isRecord(handoff)) return String(pyGet(handoff, "resolved_handoff_file") || "");
  return "";
}

export function taskTargetRepo(taskPackage) {
  const runtime = pyGet(taskPackage, "runtime_context");
  if (!isRecord(runtime)) return "";
  return String(pyGet(runtime, "target_repo") || "");
}

export function taskBusinessGate(taskPackage) {
  const expected = pyGet(taskPackage, "expected_output");
  if (!isRecord(expected)) return "";
  return pyStrip(String(pyGet(expected, "business_gate") || ""));
}

export function taskCapability(taskPackage) {
  const agent = pyGet(taskPackage, "agent");
  if (!isRecord(agent)) return ["", ""];
  const role = pyStrip(String(pyGet(agent, "role") || ""));
  const capability = pyGet(agent, "capability");
  if (!isRecord(capability)) return [role, ""];
  return [role, pyStrip(String(pyGet(capability, "name") || ""))];
}

export function businessGateValue(handoff, fields, businessGate) {
  // 裸 gate 名语义即 FINAL_HANDOFF.output.<gate>；限定 output 层级查找，
  // 任意嵌套块下的同名 key 不得冒充业务门。
  const gate = String(businessGate ?? "");
  const leaf = gate.startsWith("FINAL_HANDOFF.output.") ? gate.slice(gate.lastIndexOf(".") + 1) : gate;
  return nestedScalarField(handoff, "output", leaf);
}

export function taskGateValues(taskPackage) {
  const extensions = pyGet(taskPackage, "extensions");
  if (!isRecord(extensions)) return [];
  const contract = pyGet(extensions, "capability_contract");
  if (!isRecord(contract)) return [];
  for (const slot of Object.values(contract)) {
    if (!isRecord(slot)) continue;
    const raw = String(pyGet(slot, "gate_values") || "");
    if (!raw) continue;
    return sortedUnique(raw.split("|").map((item) => pyStrip(item)).filter((item) => item));
  }
  return [];
}

export function validateCapabilityBusinessGate(taskPackage, handoff, fields, businessGate) {
  const [role, capability] = taskCapability(taskPackage);
  if (role !== "plan-checker" || capability !== "plan-review" || businessGate !== "FINAL_HANDOFF.output.overall") {
    return [];
  }
  const value = businessGateValue(handoff, fields, businessGate);
  if (!value) return [];
  const allowed = ["APPROVED", "APPROVED_WITH_FLAGS", "BLOCKED"];
  if (!allowed.includes(value)) {
    return [`FINAL_HANDOFF.output.overall_invalid=${value}; expected one of ${[...allowed].sort(comparePythonStrings).join(", ")}`];
  }
  return [];
}

export function taskRequiredSections(taskPackage) {
  const expected = pyGet(taskPackage, "expected_output");
  if (!isRecord(expected)) return [];
  const sections = pyGet(expected, "required_sections");
  if (!Array.isArray(sections)) return [];
  return sections.map((item) => pyStrip(String(item))).filter((item) => item);
}

export function normalizeSection(value) {
  let out = "";
  for (const ch of pyCasefold(pyStrip(value))) {
    if (PY_ALNUM_RE.test(ch)) out += ch;
  }
  return out;
}

export function reportHeadings(text) {
  const headings = [];
  for (const line of pySplitLines(text)) {
    const match = /^[\s]{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const raw = pyStripChars(pyStripChars(pyStrip(match[1]), "#"), "`*_ ");
    const normalized = normalizeSection(raw);
    if (normalized) headings.push(normalized);
  }
  return sortedUnique(headings);
}

export function missingRequiredSections(expectedFile, requiredSections, taskPackage) {
  if (!expectedFile || !requiredSections || !requiredSections.length) return [];
  let headings;
  try {
    const target = taskPath(expectedFile, taskPackage, { label: "expected_output.file_path", mustExist: true });
    headings = reportHeadings(pyReadTextReplace(target));
  } catch (error) {
    if (error instanceof ToolError || error?.name === "ToolError") return requiredSections;
    throw error;
  }
  const missing = [];
  for (const section of requiredSections) {
    if (!headings.includes(normalizeSection(section))) missing.push(section);
  }
  return missing;
}

export function looksLikePath(value) {
  const text = pyStripChars(pyStrip(value), "\"'`");
  if (!text || text === "FINAL_HANDOFF" || text === "-") return false;
  const labelMatch = /^([A-Za-z][A-Za-z0-9_-]*)\|/.exec(text);
  if (labelMatch && NON_PATH_EVIDENCE_LABELS.has(labelMatch[1].toUpperCase())) return false;
  const lowered = text.toLowerCase();
  for (const prefix of ["http://", "https://", "command:", "cmd:", "shell:", "powershell:", "bash:"]) {
    if (lowered.startsWith(prefix)) return false;
  }
  if (text.startsWith("`") || text.startsWith("$")) return false;
  if (text.includes("/") || text.includes("\\")) return true;
  return [".md", ".json", ".yaml", ".yml", ".txt", ".csv"].some((suffix) => text.endsWith(suffix));
}

export function normalizeRefPath(value) {
  let text = pyStripChars(pyStrip(value), "\"'`");
  // 结构化列表项的 label 前缀（"location: src/x.mjs"）剥掉再验路径：冒号后带空白
  // 才算 label；Windows 盘符（E:\ / E:/）冒号后无空白，不受影响
  //（工具病 notes/tooling/20260831-handoff-checker-rejects-line-suffixed-locations.md）
  const labelMatch = new RegExp(`^[A-Za-z][\\p{L}\\p{N}_-]*:[${PY_SPACE_CLASS}]+([^${PY_SPACE_CLASS}].*)$`, "u").exec(text);
  if (labelMatch) text = pyStripChars(pyStrip(labelMatch[1]), "\"'`");
  const separator = text.lastIndexOf(":");
  if (separator >= 0) {
    const suffix = pyStrip(text.slice(separator + 1));
    if (/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(suffix)) text = text.slice(0, separator);
  }
  return text;
}

export function missingPaths(values, taskPackage) {
  const missing = [];
  const seen = new Set();
  for (const value of values) {
    if (!looksLikePath(value)) continue;
    const candidate = normalizeRefPath(value);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    let candidates;
    if (pyIsAbsolute(candidate)) {
      candidates = [resolveLikePython(candidate)];
    } else {
      candidates = [resolveLikePython(path.resolve(ROOT, candidate))];
      // target_repo 无效时已由 check_handoff 首次调用聚合报 issue;此处降级为
      // 仅控制仓根解析,让相对引用按缺失聚合,而不是未捕获异常炸掉结构化输出。
      let target;
      try {
        target = targetRoot(taskPackage);
      } catch (error) {
        if (!(error instanceof ToolError || error?.name === "ToolError")) throw error;
        target = resolveLikePython(ROOT);
      }
      if (!pySamePath(target, resolveLikePython(ROOT))) {
        candidates.push(resolveLikePython(path.resolve(target, candidate)));
      }
    }
    if (!candidates.some((item) => existsSync(item))) missing.push(candidate);
  }
  return missing;
}

export function acceptedVerdicts(taskPackage) {
  const handoffContract = pyGet(taskPackage, "handoff_contract");
  const values = isRecord(handoffContract) ? pyGet(handoffContract, "accept_verdicts") : null;
  if (!Array.isArray(values)) return [];
  return values.map((value) => pyStrip(String(value))).filter((value) => value);
}

export function validationBoolOk(value) {
  return ["true", "false"].includes(pyCasefold(pyStrip(value)));
}

export function sameResolvedPath(value, expected) {
  if (!value || !expected) return false;
  return pySamePath(resolveAgainstRoot(value), resolveLikePython(expected));
}

export function checkHandoff(taskPackage, handoffText, { actualHandoffPath = null } = {}) {
  const handoff = extractFinalHandoff(handoffText);
  const issues = [];
  const diagnostics = [];
  let fields;
  if (!handoff) {
    issues.push("missing_FINAL_HANDOFF");
    fields = Object.create(null);
  } else {
    fields = scalarFields(handoff);
  }

  try {
    targetRoot(taskPackage);
  } catch (error) {
    if (!(error instanceof ToolError || error?.name === "ToolError")) throw error;
    issues.push(error.message);
  }

  const taskPackageId = String(pyGet(taskPackage, "package_id") || "");
  const handoffPackageId = firstField(fields, "package_id");
  if (!taskPackageId) issues.push("task_package.package_id_missing");
  if (!handoffPackageId) issues.push("FINAL_HANDOFF.package_id_missing");
  if (taskPackageId && handoffPackageId && taskPackageId !== handoffPackageId) {
    issues.push(`package_id_mismatch task_package=${taskPackageId} handoff=${handoffPackageId}`);
  }

  const verdict = firstField(fields, "verdict");
  if (!verdict) issues.push("FINAL_HANDOFF.verdict_missing");
  const accepted = acceptedVerdicts(taskPackage);
  if (!accepted.length) {
    issues.push("task_package.handoff_contract.accept_verdicts_missing");
  } else if (verdict && !accepted.includes(verdict)) {
    // 与 submit_task_result 同一口径：verdict 按 accept_verdicts 词面精确比对，不做同义归一。
    issues.push(`FINAL_HANDOFF.verdict_invalid=${verdict}`);
  }
  const needsOwnerExit = verdict === "needs_owner";
  // partial / needs_split 与 needs_owner 同为未完成收口：业务 gate 与报告必填段不强求，
  // 文件存在性检查仍按各自条件执行。
  const incompleteExit = ["needs_owner", "partial", "needs_split"].includes(verdict);

  for (const field of ["required_files_loaded", "expected_output_satisfied", "scope_compliant"]) {
    const value = firstField(fields, field);
    if (!value) diagnostics.push(`FINAL_HANDOFF.validation.${field}_missing`);
    else if (!validationBoolOk(value)) diagnostics.push(`FINAL_HANDOFF.validation.${field}_invalid=${value}`);
  }
  const mechanicalCheck = firstField(fields, "mechanical_check");
  if (!mechanicalCheck) diagnostics.push("FINAL_HANDOFF.validation.mechanical_check_missing");
  else if (pyCasefold(pyStrip(mechanicalCheck)) !== "pass") {
    diagnostics.push(`FINAL_HANDOFF.validation.mechanical_check_not_pass=${mechanicalCheck}`);
  }

  const businessGate = taskBusinessGate(taskPackage);
  if (businessGate && !incompleteExit && !businessGateValue(handoff, fields, businessGate)) {
    if (businessGate.startsWith("FINAL_HANDOFF.output.")) issues.push(`${businessGate}_missing`);
    else issues.push(`FINAL_HANDOFF.output.${businessGate}_missing`);
  } else if (businessGate && !incompleteExit) {
    const gateValue = businessGateValue(handoff, fields, businessGate);
    const allowedGateValues = taskGateValues(taskPackage);
    if (allowedGateValues.length && gateValue && !allowedGateValues.includes(gateValue)) {
      const leaf = businessGate.slice(businessGate.lastIndexOf(".") + 1);
      issues.push(
        `FINAL_HANDOFF.output.${leaf}_invalid=${gateValue}; expected one of ${[...allowedGateValues].sort(comparePythonStrings).join(" | ")}`,
      );
    }
    issues.push(...validateCapabilityBusinessGate(taskPackage, handoff, fields, businessGate));
  }

  const expectedTargetRepo = taskTargetRepo(taskPackage);
  if (expectedTargetRepo && !needsOwnerExit) {
    const outputTargetRepo = firstField(fields, "target_repo");
    if (!outputTargetRepo) issues.push("FINAL_HANDOFF.output.target_repo_missing");
    else if (!sameResolvedPath(outputTargetRepo, expectedTargetRepo)) issues.push("FINAL_HANDOFF.output.target_repo_mismatch");
  }

  const expectedResolvedFile = taskExpectedResolvedFile(taskPackage);
  if (expectedResolvedFile && !needsOwnerExit) {
    const outputResolvedFile = firstField(fields, "resolved_file_path");
    const outputFile = firstField(fields, "file_path");
    if (!outputResolvedFile) issues.push("FINAL_HANDOFF.output.resolved_file_path_missing");
    else if (!sameResolvedPath(outputResolvedFile, expectedResolvedFile)) issues.push("FINAL_HANDOFF.output.resolved_file_path_mismatch");
    if (outputFile && !sameResolvedPath(outputFile, expectedResolvedFile)) {
      issues.push("FINAL_HANDOFF.output.file_path_not_expected_output");
    }
  }

  const handoffResolvedFile = taskHandoffResolvedFile(taskPackage);
  if (handoffResolvedFile) {
    const outputResolvedHandoff = firstField(fields, "resolved_handoff_file");
    const outputHandoff = firstField(fields, "handoff_file");
    if (!outputResolvedHandoff) issues.push("FINAL_HANDOFF.output.resolved_handoff_file_missing");
    else if (!sameResolvedPath(outputResolvedHandoff, handoffResolvedFile)) issues.push("FINAL_HANDOFF.output.resolved_handoff_file_mismatch");
    if (outputHandoff && !sameResolvedPath(outputHandoff, handoffResolvedFile)) {
      issues.push("FINAL_HANDOFF.output.handoff_file_not_expected_handoff");
    }
    if (actualHandoffPath !== null && actualHandoffPath !== undefined
      && !pySamePath(resolveLikePython(actualHandoffPath), resolveLikePython(handoffResolvedFile))) {
      issues.push("handoff_file_actual_path_mismatch");
    }
  }

  const refs = [];
  const expectedFile = taskExpectedOutputFile(taskPackage);
  if (expectedFile && !needsOwnerExit) refs.push(expectedFile);
  for (const field of ["file_path", "handoff_file", "report_ref", "output_ref"]) {
    const value = firstField(fields, field);
    if (value) refs.push(value);
  }
  refs.push(...sectionItems(handoff, "evidence_refs"));
  refs.push(...sectionItems(handoff, "evidence"));

  const missing = missingPaths(refs, taskPackage);
  for (const item of missing) issues.push(`referenced_path_missing=${item}`);

  let missingSections = [];
  if (expectedFile && !incompleteExit && !missing.includes(expectedFile)) {
    missingSections = missingRequiredSections(expectedFile, taskRequiredSections(taskPackage), taskPackage);
    for (const section of missingSections) diagnostics.push(`expected_output.required_section_missing=${section}`);
  }

  const status = issues.length ? "fail" : "pass";
  return {
    tool: "subagent_handoff_check",
    status,
    exit_code: status === "pass" ? 0 : 1,
    package_id: handoffPackageId || taskPackageId,
    handoff_fields_ok: !issues.some((issue) => issue.startsWith("FINAL_HANDOFF.")),
    business_gate_ok: !issues.some((issue) => issue.startsWith("FINAL_HANDOFF.output.") && issue.endsWith("_missing")),
    expected_output_present: !(expectedFile && missing.includes(expectedFile)),
    required_sections_ok: !missingSections.length,
    missing_required_sections: missingSections,
    references_exist: !missing.length,
    mechanical_check: status === "pass" ? "pass" : "fail",
    diagnostics,
    issues,
  };
}

export function buildText(data) {
  const lines = [
    "SUBAGENT_HANDOFF_CHECK:",
    `  status: ${data.status}`,
    `  package_id: ${pyGet(data, "package_id") ?? ""}`,
    `  mechanical_check: ${data.mechanical_check}`,
    `  handoff_fields_ok: ${String(data.handoff_fields_ok).toLowerCase()}`,
    `  business_gate_ok: ${String(pyGet(data, "business_gate_ok") ?? true).toLowerCase()}`,
    `  expected_output_present: ${String(data.expected_output_present).toLowerCase()}`,
    `  required_sections_ok: ${String(pyGet(data, "required_sections_ok") ?? true).toLowerCase()}`,
    `  references_exist: ${String(data.references_exist).toLowerCase()}`,
  ];
  if (data.issues && data.issues.length) {
    lines.push("  issues:");
    for (const issue of data.issues) lines.push(`    - ${issue}`);
  }
  if (data.diagnostics?.length) {
    lines.push("  diagnostics:");
    for (const diagnostic of data.diagnostics) lines.push(`    - ${diagnostic}`);
  }
  return `${lines.join("\n")}\n`;
}

export function runSelfTest() {
  const tempRoot = path.join(ROOT, "tmp", `subagent-handoff-check-self-test-${Math.trunc(clock.now().getTime())}`);
  try {
    mkdirSync(tempRoot, { recursive: true });
    const report = path.join(tempRoot, "report.md");
    const handoff = path.join(tempRoot, "handoff.yaml");
    const packageFile = path.join(tempRoot, "task-package.json");
    writeFileSync(report, "# report\n\n## scope\n\n## summary\n\n## findings\n\n## 结论前置\n", "utf8");
    writeFileSync(
      packageFile,
      `${JSON.stringify({
        task_package: {
          package_id: "pkg-handoff-check-self-test",
          handoff_contract: { accept_verdicts: ["done", "partial", "needs_owner", "failed"] },
          expected_output: {
            mode: "file",
            file_path: rel(report),
            business_gate: "sample_gate",
            required_sections: ["scope", "summary", "findings", "结论前置"],
          },
        },
      })}\n`,
      "utf8",
    );
    writeFileSync(
      handoff,
      [
        "FINAL_HANDOFF:",
        "  package_id: pkg-handoff-check-self-test",
        "  verdict: done",
        "  output:",
        `    file_path: ${rel(report)}`,
        `    handoff_file: ${rel(handoff)}`,
        "    sample_gate: pass",
        "  validation:",
        "    required_files_loaded: true",
        "    expected_output_satisfied: true",
        "    scope_compliant: true",
        "    mechanical_check: pass",
        "  evidence_refs:",
        `    - ${rel(report)}`,
        "  evidence:",
        "    - ENV|TEST_PATH=C:\\\\Program Files\\\\Example",
        "    - REG|Example Tool|loc=C:\\\\Program Files\\\\Example",
        "",
      ].join("\n"),
      "utf8",
    );
    const data = checkHandoff(loadJson(packageFile), pyReadTextReplace(handoff));
    if (data.status !== "pass") throw new ToolError("self-test expected pass");
    const missingGate = pyReadTextReplace(handoff).replace("    sample_gate: pass\n", "");
    const failedGate = checkHandoff(loadJson(packageFile), missingGate);
    if (failedGate.status !== "fail" || !failedGate.issues.some((issue) => issue.includes("sample_gate_missing"))) {
      throw new ToolError("self-test expected missing business gate failure");
    }
    writeFileSync(report, "# report\n\n## scope\n\n## findings\n\n## 结论前置\n", "utf8");
    const failedSections = checkHandoff(loadJson(packageFile), pyReadTextReplace(handoff));
    if (failedSections.status !== "pass" || failedSections.required_sections_ok
      || !failedSections.diagnostics.length) {
      throw new ToolError("self-test expected missing section diagnostics without rejection");
    }
    unlinkSync(report);
    const needsOwnerHandoff = [
      "FINAL_HANDOFF:",
      "  package_id: pkg-handoff-check-self-test",
      "  verdict: needs_owner",
      "  output:",
      "    file_path: null",
      `    handoff_file: ${rel(handoff)}`,
      "  validation:",
      "    required_files_loaded: true",
      "    expected_output_satisfied: false",
      "    scope_compliant: true",
      "    mechanical_check: pass",
      "  evidence_refs: []",
      "",
    ].join("\n");
    const needsOwnerData = checkHandoff(loadJson(packageFile), needsOwnerHandoff);
    if (needsOwnerData.status !== "pass") {
      throw new ToolError("self-test expected needs_owner without expected output file to pass");
    }
    writeFileSync(report, "# report\n\n## scope\n\n## summary\n\n## findings\n\n## 结论前置\n", "utf8");
    const broken = pyReadTextReplace(handoff).replace(rel(report), "tmp/missing-report.md");
    const failed = checkHandoff(loadJson(packageFile), broken);
    if (failed.status !== "fail" || !failed.issues.length) throw new ToolError("self-test expected missing path failure");
    const taggedMissing = pyReadTextReplace(handoff).split(`    - ${rel(report)}`).join("    - FILE|tmp/missing-report.md");
    const failedTagged = checkHandoff(loadJson(packageFile), taggedMissing);
    if (failedTagged.status !== "fail"
      || !failedTagged.issues.some((issue) => issue.includes("referenced_path_missing=FILE|tmp/missing-report.md"))) {
      throw new ToolError("self-test expected generic tagged missing path failure");
    }
    const invalidVerdict = pyReadTextReplace(handoff).split("  verdict: done").join("  verdict: surprise");
    const failedVerdict = checkHandoff(loadJson(packageFile), invalidVerdict);
    if (failedVerdict.status !== "fail" || !failedVerdict.issues.some((issue) => issue.includes("verdict_invalid=surprise"))) {
      throw new ToolError("self-test expected invalid verdict failure");
    }
    const invalidValidation = pyReadTextReplace(handoff)
      .split("    required_files_loaded: true").join("    required_files_loaded: maybe");
    const failedValidation = checkHandoff(loadJson(packageFile), invalidValidation);
    if (failedValidation.status !== "pass" || !failedValidation.diagnostics.length) {
      throw new ToolError("self-test expected invalid self-report diagnostics without rejection");
    }
    const missingMechanical = pyReadTextReplace(handoff).replace("    mechanical_check: pass\n", "");
    const failedMechanical = checkHandoff(loadJson(packageFile), missingMechanical);
    if (failedMechanical.status !== "pass" || !failedMechanical.diagnostics.length) {
      throw new ToolError("self-test expected missing self-report diagnostics without rejection");
    }
    // verdict 按 accept_verdicts 词面精确比对：accept_verdicts 含 done 时，completed 不算合法取值。
    const synonymHandoff = pyReadTextReplace(handoff).split("  verdict: done").join("  verdict: completed");
    const synonymFailed = checkHandoff(loadJson(packageFile), synonymHandoff);
    if (synonymFailed.status !== "fail" || !synonymFailed.issues.includes("FINAL_HANDOFF.verdict_invalid=completed")) {
      throw new ToolError("self-test expected verdict completed to fail against accept_verdicts [done, ...]");
    }
    // 业务门只认 FINAL_HANDOFF.output 的直接子标量：output.meta 下的同名 key 不能冒充。
    const nestedDecoy = pyReadTextReplace(handoff).split("    sample_gate: pass").join("    meta:\n      sample_gate: pass");
    const failedNestedDecoy = checkHandoff(loadJson(packageFile), nestedDecoy);
    if (failedNestedDecoy.status !== "fail"
      || !failedNestedDecoy.issues.some((issue) => issue.includes("FINAL_HANDOFF.output.sample_gate_missing"))) {
      throw new ToolError("self-test expected nested output.meta.sample_gate not to satisfy the business gate");
    }
    const directWithDecoy = pyReadTextReplace(handoff)
      .split("    sample_gate: pass").join("    meta:\n      sample_gate: decoy\n    sample_gate: pass");
    if (businessGateValue(extractFinalHandoff(directWithDecoy), null, "sample_gate") !== "pass"
      || checkHandoff(loadJson(packageFile), directWithDecoy).status !== "pass") {
      throw new ToolError("self-test expected direct output.sample_gate to be read past a nested decoy");
    }
    // 工具病 20260831-handoff-checker-rejects-line-suffixed-locations 回归：
    // "- location: <path>:12-34" 形态剥 label 与行号后指向存在文件，不得误报 missing；
    // label 后的真缺失路径仍必须报。
    const labeledHandoff = pyReadTextReplace(handoff)
      .split(`    - ${rel(report)}`).join(`    - location: ${rel(report)}:12-34`);
    const labeledOk = checkHandoff(loadJson(packageFile), labeledHandoff);
    if (labeledOk.issues.some((issue) => issue.includes("referenced_path_missing"))) {
      throw new ToolError("self-test expected labeled line-suffixed existing path to resolve");
    }
    const labeledMissing = pyReadTextReplace(handoff)
      .split(`    - ${rel(report)}`).join("    - location: tmp/missing-labeled.md");
    const failedLabeled = checkHandoff(loadJson(packageFile), labeledMissing);
    if (!failedLabeled.issues.some((issue) => issue.includes("referenced_path_missing=tmp/missing-labeled.md"))) {
      throw new ToolError("self-test expected labeled missing path to still fail");
    }
    const planReviewPackage = {
      package_id: "pkg-handoff-check-plan-review-self-test",
      agent: { role: "plan-checker", capability: { name: "plan-review" } },
      handoff_contract: { accept_verdicts: ["pass", "partial", "fail", "needs_owner", "failed"] },
      expected_output: {
        mode: "file",
        file_path: rel(report),
        business_gate: "FINAL_HANDOFF.output.overall",
        required_sections: ["scope", "summary", "findings", "结论前置"],
      },
    };
    let planReviewHandoff = pyReadTextReplace(handoff).split("    sample_gate: pass").join("    overall: APPROVED");
    planReviewHandoff = planReviewHandoff
      .split("  package_id: pkg-handoff-check-self-test").join("  package_id: pkg-handoff-check-plan-review-self-test");
    planReviewHandoff = planReviewHandoff.split("  verdict: done").join("  verdict: pass");
    const planReviewOk = checkHandoff(planReviewPackage, planReviewHandoff);
    if (planReviewOk.status !== "pass") throw new ToolError("self-test expected plan-review APPROVED overall to pass");
    const planReviewBad = planReviewHandoff.split("    overall: APPROVED").join("    overall: pass");
    const failedPlanReview = checkHandoff(planReviewPackage, planReviewBad);
    if (failedPlanReview.status !== "fail"
      || !failedPlanReview.issues.some((issue) => issue.includes("overall_invalid=pass"))) {
      throw new ToolError("self-test expected plan-review invalid overall enum failure");
    }
    const prefixedDecoy = `example:\n  output:\n    overall: APPROVED\n\n${planReviewHandoff.split("    overall: APPROVED\n").join("")}`;
    const failedDecoy = checkHandoff(planReviewPackage, prefixedDecoy);
    if (failedDecoy.status !== "fail"
      || !failedDecoy.issues.some((issue) => issue.includes("FINAL_HANDOFF.output.overall_missing"))) {
      throw new ToolError("self-test expected prefixed decoy output overall not to satisfy FINAL_HANDOFF output");
    }

    const externalRoot = path.join(tempRoot, "external-target");
    mkdirSync(externalRoot, { recursive: true });
    const externalReport = path.join(externalRoot, "notes", "explorer", "external.md");
    const externalHandoff = path.join(externalRoot, "notes", "handoffs", "external.yaml");
    const externalEvidence = path.join(externalRoot, "outputs", "evidence", "target.json");
    const parentReport = path.join(tempRoot, "notes", "explorer", "external.md");
    const parentHandoff = path.join(tempRoot, "notes", "handoffs", "external.yaml");
    mkdirSync(path.dirname(externalReport), { recursive: true });
    mkdirSync(path.dirname(externalHandoff), { recursive: true });
    mkdirSync(path.dirname(externalEvidence), { recursive: true });
    mkdirSync(path.dirname(parentReport), { recursive: true });
    mkdirSync(path.dirname(parentHandoff), { recursive: true });
    writeFileSync(externalReport, "# report\n\n## scope\n\n## summary\n", "utf8");
    writeFileSync(externalEvidence, "{}\n", "utf8");
    writeFileSync(parentReport, "# report\n\n## scope\n\n## summary\n", "utf8");
    const externalPackage = {
      package_id: "pkg-handoff-check-target-repo",
      runtime_context: { target_repo: externalRoot },
      expected_output: {
        mode: "file",
        file_path: rel(parentReport),
        resolved_file_path: parentReport,
        business_gate: "sample_gate",
        required_sections: ["scope", "summary"],
      },
      handoff_contract: {
        accept_verdicts: ["done", "partial", "needs_owner", "failed"],
        handoff_file_required: true,
        handoff_file: rel(parentHandoff),
        resolved_handoff_file: parentHandoff,
      },
    };
    writeFileSync(
      parentHandoff,
      [
        "FINAL_HANDOFF:",
        "  package_id: pkg-handoff-check-target-repo",
        "  verdict: done",
        "  output:",
        `    target_repo: ${externalRoot}`,
        `    file_path: ${rel(parentReport)}`,
        `    resolved_file_path: ${parentReport}`,
        `    handoff_file: ${rel(parentHandoff)}`,
        `    resolved_handoff_file: ${parentHandoff}`,
        "    sample_gate: pass",
        "  validation:",
        "    required_files_loaded: true",
        "    expected_output_satisfied: true",
        "    scope_compliant: true",
        "    mechanical_check: pass",
        "  evidence_refs:",
        `    - ${rel(parentReport)}`,
        "    - outputs/evidence/target.json",
        "",
      ].join("\n"),
      "utf8",
    );
    const externalData = checkHandoff(externalPackage, pyReadTextReplace(parentHandoff), { actualHandoffPath: parentHandoff });
    if (externalData.status !== "pass") {
      throw new ToolError("self-test expected parent-root cross-repo handoff check to pass");
    }
    writeFileSync(
      externalHandoff,
      pyReadTextReplace(parentHandoff)
        .split(parentReport).join(externalReport)
        .split(parentHandoff).join(externalHandoff)
        .split(rel(parentReport)).join("notes/explorer/external.md")
        .split(rel(parentHandoff)).join("notes/handoffs/external.yaml"),
      "utf8",
    );
    const externalBad = checkHandoff(externalPackage, pyReadTextReplace(externalHandoff), { actualHandoffPath: externalHandoff });
    if (externalBad.status !== "fail"
      || !externalBad.issues.some((issue) => issue.includes("resolved_file_path_mismatch") || issue.includes("actual_path_mismatch"))) {
      throw new ToolError("self-test expected external handoff output path to fail");
    }
    let relativeTargetFailed = false;
    try {
      targetRoot({ runtime_context: { target_repo: "relative-target" } });
    } catch (error) {
      if (!String(error?.message ?? "").includes("must be an absolute path")) throw error;
      relativeTargetFailed = true;
    }
    if (!relativeTargetFailed) throw new ToolError("self-test expected relative target_repo to fail");
    let missingTargetFailed = false;
    try {
      targetRoot({ runtime_context: { target_repo: path.join(tempRoot, "missing-target") } });
    } catch (error) {
      if (!String(error?.message ?? "").includes("runtime_context.target_repo not found")) throw error;
      missingTargetFailed = true;
    }
    if (!missingTargetFailed) throw new ToolError("self-test expected missing target_repo to fail");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  process.stdout.write("PASS subagent_handoff_check self-test\n");
  return 0;
}
