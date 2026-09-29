// ops/tools/pi_task_result_extension.mjs
import { mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import path3 from "node:path";

// ops/tools/task_result_synthesis.mjs
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
var TASK_RESULT_TOOL_NAME = "submit_task_result";
var TASK_RESULT_SCHEMA_VERSION = 1;
var INCOMPLETE_VERDICTS = /* @__PURE__ */ new Set(["needs_owner", "partial", "needs_split"]);
var RESERVED_OUTPUT_KEYS = ["target_repo", "file_path", "resolved_file_path", "handoff_file", "resolved_handoff_file"];
var YAML_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
var NON_PATH_PREFIXES = ["http://", "https://", "command:", "cmd:", "shell:", "powershell:", "bash:"];
var PATH_SUFFIXES = [".md", ".json", ".yaml", ".yml", ".txt", ".csv"];
var TASK_RESULT_V1_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: true,
  required: ["verdict", "summary", "sections"],
  properties: {
    // 输入层不写 const：模型可省略固定版本（工具补数字 1），显式写出的非 1 值由
    // validateTaskResultPayload 明确拒绝；落盘记录的 schema_version 始终是数字 1。
    schema_version: { type: "number", description: '\u53EF\u7701\u7565\uFF1A\u56FA\u5B9A\u534F\u8BAE\u7248\u672C\uFF0C\u5DE5\u5177\u4F1A\u8865\u6210\u6570\u5B57 1\uFF1B\u663E\u5F0F\u5199\u51FA\u65F6\u53EA\u63A5\u53D7 1\uFF08"1" \u4F1A\u88AB\u65E0\u635F\u5F52\u4E00\u4E3A 1\uFF09' },
    verdict: { type: "string", minLength: 1, description: "\u5FC5\u586B\uFF1B\u53EA\u53D6 task_package.handoff_contract.accept_verdicts \u4E4B\u4E00" },
    summary: { type: "string", minLength: 1, description: "\u5FC5\u586B\uFF1B\u4E00\u884C\u7ED3\u8BBA\uFF0C\u4E0D\u542B\u6362\u884C" },
    title: { type: "string", description: "\u62A5\u544A\u6807\u9898\uFF1B\u7F3A\u7701\u53D6\u4EFB\u52A1\u5305 title \u6216 package_id" },
    sections: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "\u5FC5\u586B\uFF1B\u62A5\u544A\u7AE0\u8282\uFF1A\u952E\u4E3A task_package.expected_output.required_sections \u91CC\u7684\u7AE0\u8282\u540D\uFF0C\u503C\u4E3A\u8BE5\u8282 Markdown \u6B63\u6587\uFF1B\u6BCF\u4E2A\u5FC5\u9700\u7AE0\u8282\u90FD\u8981\u975E\u7A7A\uFF0C\u53EF\u8FFD\u52A0\u989D\u5916\u7AE0\u8282\uFF1B\u6574\u4F53\u5199\u6210 JSON \u5B57\u7B26\u4E32\u4F1A\u88AB\u65E0\u635F\u8FD8\u539F"
    },
    output: {
      type: "object",
      description: "FINAL_HANDOFF.output \u7684\u4E1A\u52A1\u5B57\u6BB5\uFF1Aexpected_output.business_gate \u6307\u5B9A\u7684\u95E8\u5B57\u6BB5\u4E0E\u80FD\u529B\u63D0\u793A\u8BCD\u8981\u6C42\u7684\u5B57\u6BB5\uFF1B\u8DEF\u5F84\u7C7B\u4E94\u4E2A\u4FDD\u7559\u952E\u7531\u6E32\u67D3\u5668\u586B\u5199"
    },
    scope_actual: {
      type: "object",
      properties: {
        read: { type: "array", items: { type: "string" } },
        written: { type: "array", items: { type: "string" } },
        deleted: { type: "array", items: { type: "string" } }
      },
      description: "\u5B9E\u9645\u8BFB\u3001\u5199\u3001\u5220\u7684\u8DEF\u5F84\uFF1B\u62A5\u544A\u4E0E handoff \u8DEF\u5F84\u7531\u6E32\u67D3\u5668\u8865\u5165 written"
    },
    evidence_refs: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "\u652F\u6491\u7ED3\u8BBA\u7684\u5F15\u7528\uFF08\u8DEF\u5F84\u3001path:line\u3001URL \u6216 command: \u524D\u7F00\u7684\u547D\u4EE4\uFF09\uFF1B\u8DEF\u5F84\u7C7B\u5F15\u7528\u5FC5\u987B\u771F\u5B9E\u5B58\u5728"
    }
  }
});
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringArray(value, label) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`task_result_v1 ${label} must be a string array`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`task_result_v1 ${label} must not contain empty items`);
    return item.trim();
  });
}
var INPUT_ERROR_PREFIX = "submit_task_result input error:";
var ERROR_LIST_LIMIT = 8;
var JSON_WRAPPED_OBJECT_FIELDS = ["sections", "output", "scope_actual"];
var SCOPE_ACTUAL_KEYS = ["read", "written", "deleted"];
function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length} items)`;
  if (typeof value === "string") return `string(${value.length} chars)`;
  if (typeof value === "number" || typeof value === "boolean") return `${typeof value}(${String(value)})`;
  return typeof value;
}
function boundedList(items, limit = ERROR_LIST_LIMIT) {
  const list = [...items].map(String);
  if (list.length <= limit) return list.join(", ");
  return `${list.slice(0, limit).join(", ")} (+${list.length - limit} more)`;
}
function inputError(message) {
  return new Error(`${INPUT_ERROR_PREFIX} ${message}`);
}
function jsonWrapped(value, field, expected) {
  try {
    return JSON.parse(value);
  } catch {
    throw inputError(`${field} is a JSON string that does not parse (${describeValue(value)}); pass ${expected}.`);
  }
}
function objectField(value, field) {
  if (value === void 0 || value === null) return value;
  const parsed = typeof value === "string" ? jsonWrapped(value, field, "an object") : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw inputError(`${field} must be an object; received ${describeValue(parsed)}.`);
  }
  return parsed;
}
function stringArrayField(value, field) {
  if (value === void 0 || value === null) return value;
  const parsed = typeof value === "string" ? jsonWrapped(value, field, "a string array") : value;
  if (!Array.isArray(parsed)) throw inputError(`${field} must be a string array; received ${describeValue(parsed)}.`);
  parsed.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw inputError(`${field}[${index}] must be a non-empty string; received ${describeValue(item)}.`);
    }
  });
  return parsed;
}
function normalizeTaskResultArguments(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw inputError(`arguments must be a JSON object with verdict, summary and sections; received ${describeValue(raw)}.`);
  }
  const args = { ...raw };
  const version = args.schema_version;
  if (version === void 0 || version === null) {
    args.schema_version = TASK_RESULT_SCHEMA_VERSION;
  } else if (typeof version === "number" && Number.isInteger(version)) {
  } else if (typeof version === "string" && /^\d+$/.test(version.trim())) {
    args.schema_version = Number(version.trim());
  } else {
    throw inputError(`schema_version must be the number ${TASK_RESULT_SCHEMA_VERSION} or omitted; received ${describeValue(version)}.`);
  }
  for (const field of JSON_WRAPPED_OBJECT_FIELDS) args[field] = objectField(args[field], field);
  args.evidence_refs = stringArrayField(args.evidence_refs, "evidence_refs");
  for (const field of ["verdict", "summary"]) {
    if (args[field] === void 0 || args[field] === null) throw inputError(`${field} is required; received ${describeValue(args[field])}.`);
    if (typeof args[field] !== "string" || !args[field].trim()) {
      throw inputError(`${field} must be a non-empty string; received ${describeValue(args[field])}.`);
    }
  }
  if (args.title !== void 0 && args.title !== null && typeof args.title !== "string") {
    throw inputError(`title must be a string; received ${describeValue(args.title)}.`);
  }
  if (args.sections === void 0 || args.sections === null) {
    throw inputError("sections is required; pass an object of section name -> markdown body (keys are task_package.expected_output.required_sections).");
  }
  for (const [name, body] of Object.entries(args.sections)) {
    if (typeof body !== "string") {
      throw inputError(`sections["${String(name).slice(0, 60)}"] must be a markdown string; received ${describeValue(body)}.`);
    }
  }
  const scopeActual = args.scope_actual;
  if (scopeActual !== void 0 && scopeActual !== null) {
    const normalized = {};
    for (const key of SCOPE_ACTUAL_KEYS) {
      const list = stringArrayField(scopeActual[key], `scope_actual.${key}`);
      if (list !== void 0 && list !== null) normalized[key] = list;
    }
    args.scope_actual = normalized;
  }
  return args;
}
function normalizeSectionName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
function requiredSections(taskPackage) {
  const sections = object(taskPackage?.expected_output).required_sections;
  if (!Array.isArray(sections)) return [];
  return sections.map((item) => String(item || "").trim()).filter(Boolean);
}
function acceptVerdicts(taskPackage) {
  const values = object(taskPackage?.handoff_contract).accept_verdicts;
  if (!Array.isArray(values)) return [];
  return values.map((item) => String(item || "").trim()).filter(Boolean);
}
function businessGate(taskPackage) {
  return String(object(taskPackage?.expected_output).business_gate || "").replace(/^FINAL_HANDOFF\.output\./, "").trim();
}
function gateValues(taskPackage) {
  const contracts = object(object(taskPackage?.extensions).capability_contract);
  for (const slot of Object.values(contracts)) {
    const raw = String(object(slot).gate_values || "");
    if (raw) return raw.split("|").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}
function referencePath(value) {
  let text = String(value || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!text || text === "FINAL_HANDOFF" || text === "-") return null;
  const lowered = text.toLowerCase();
  if (NON_PATH_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return null;
  if (text.startsWith("`") || text.startsWith("$")) return null;
  if (/^[A-Za-z][A-Za-z0-9_-]*\|/.test(text)) return null;
  if (!(text.includes("/") || text.includes("\\") || PATH_SUFFIXES.some((suffix) => text.endsWith(suffix)))) return null;
  const label = /^[A-Za-z][\w-]*:\s+(\S.*)$/.exec(text);
  if (label) text = label[1].trim().replace(/^["'`]+|["'`]+$/g, "");
  const line = /^(.*):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/.exec(text);
  if (line) text = line[1];
  return text;
}
function referenceRoots(taskPackage, fallbackRoot) {
  const runtime = object(taskPackage?.runtime_context);
  return [...new Set([runtime.output_root, runtime.target_repo, fallbackRoot].map((item) => String(item || "").trim()).filter(Boolean))];
}
function referenceExists(candidate, roots) {
  if (path.isAbsolute(candidate)) return existsSync(candidate);
  return roots.some((root) => existsSync(path.resolve(root, candidate)));
}
function validateTaskResultPayload(payload, taskPackage, { fallbackRoot = process.cwd() } = {}) {
  const raw = object(payload);
  if (raw.schema_version !== TASK_RESULT_SCHEMA_VERSION) {
    throw new Error(`task_result_v1 schema_version must be the number ${TASK_RESULT_SCHEMA_VERSION} (omit the field to let the tool fill it in); got ${describeValue(raw.schema_version)}`);
  }
  const accepted = acceptVerdicts(taskPackage);
  const verdict = String(raw.verdict || "").trim();
  if (!verdict) throw new Error("task_result_v1 verdict is required");
  if (accepted.length && !accepted.includes(verdict)) {
    throw new Error(`task_result_v1 verdict must be one of ${accepted.join(" | ")}; got ${verdict}`);
  }
  const summary = String(raw.summary ?? "").trim();
  if (!summary) throw new Error("task_result_v1 summary is required");
  if (/[\r\n]/.test(summary)) throw new Error("task_result_v1 summary must be a single line");
  const title = String(raw.title ?? "").trim();
  const sectionsInput = raw.sections;
  if (!sectionsInput || typeof sectionsInput !== "object" || Array.isArray(sectionsInput)) {
    throw new Error("task_result_v1 sections must be an object of section name -> markdown body");
  }
  const sections = /* @__PURE__ */ new Map();
  for (const [name, body] of Object.entries(sectionsInput)) {
    const key = normalizeSectionName(name);
    if (!key) throw new Error("task_result_v1 sections contain an empty section name");
    if (typeof body !== "string") throw new Error(`task_result_v1 sections[${name}] must be a markdown string`);
    if (sections.has(key)) throw new Error(`task_result_v1 sections contain duplicate section ${name}`);
    sections.set(key, { name: String(name).trim(), body: body.replace(/\r\n?/g, "\n").trim() });
  }
  const required = requiredSections(taskPackage);
  const missing = required.filter((name) => !sections.get(normalizeSectionName(name))?.body);
  if (missing.length && !INCOMPLETE_VERDICTS.has(verdict)) {
    throw new Error(`task_result_v1 sections are missing or empty for required_sections: ${boundedList(missing)}`);
  }
  const output = object(raw.output);
  for (const [key, value] of Object.entries(output)) {
    if (!YAML_KEY.test(key)) throw new Error(`task_result_v1 output key is not a plain identifier: ${key}`);
    if (typeof value === "function" || typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`task_result_v1 output.${key} is not JSON-serializable`);
    }
  }
  const gate = businessGate(taskPackage);
  if (gate && !INCOMPLETE_VERDICTS.has(verdict)) {
    const value = output[gate];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`task_result_v1 output.${gate} is required by expected_output.business_gate`);
    }
    const allowed = gateValues(taskPackage);
    if (allowed.length && !allowed.includes(value.trim())) {
      throw new Error(`task_result_v1 output.${gate} must be one of ${allowed.join(" | ")}; got ${value}`);
    }
  }
  const scopeInput = object(raw.scope_actual);
  const scopeActual = {
    read: stringArray(scopeInput.read, "scope_actual.read"),
    written: stringArray(scopeInput.written, "scope_actual.written"),
    deleted: stringArray(scopeInput.deleted, "scope_actual.deleted")
  };
  const evidenceRefs = stringArray(raw.evidence_refs, "evidence_refs");
  const roots = referenceRoots(taskPackage, fallbackRoot);
  const missingRefs = [];
  for (const ref of evidenceRefs) {
    const candidate = referencePath(ref);
    if (candidate && !referenceExists(candidate, roots) && !missingRefs.includes(candidate)) missingRefs.push(candidate);
  }
  if (missingRefs.length) {
    throw new Error(`task_result_v1 evidence_refs reference missing paths: ${boundedList(missingRefs)}`);
  }
  return {
    schema_version: TASK_RESULT_SCHEMA_VERSION,
    verdict,
    summary,
    title,
    sections: [...sections.values()],
    output: JSON.parse(JSON.stringify(output)),
    scope_actual: scopeActual,
    evidence_refs: evidenceRefs
  };
}
var YAML_SPECIAL_WORDS = /* @__PURE__ */ new Set(["", "~", "null", "true", "false", "yes", "no", "on", "off", "y", "n"]);
function yamlQuote(text) {
  return `'${text.replace(/'/g, "''")}'`;
}
function yamlScalar(value) {
  if (value === null || value === void 0) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  const text = String(value);
  if (YAML_SPECIAL_WORDS.has(text.trim().toLowerCase())) return yamlQuote(text);
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text) || /\s$/.test(text) || /^\s/.test(text)) return yamlQuote(text);
  if (text.includes(": ") || text.includes(" #") || text.endsWith(":")) return yamlQuote(text);
  if (/^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(text) || /^0x[0-9a-fA-F]+$/.test(text)) return yamlQuote(text);
  return text;
}
function yamlLines(value, indent) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}[]`];
    return value.flatMap((item) => {
      if (item && typeof item === "object") {
        const nested = yamlLines(item, indent + 2);
        return [`${pad}- ${nested[0].trimStart()}`, ...nested.slice(1)];
      }
      return [`${pad}- ${yamlScalar(item)}`];
    });
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([key]) => YAML_KEY.test(key));
    if (!entries.length) return [`${pad}{}`];
    return entries.flatMap(([key, item]) => yamlEntry(key, item, indent));
  }
  return [`${pad}${yamlScalar(value)}`];
}
function yamlEntry(key, value, indent) {
  const pad = " ".repeat(indent);
  if (typeof value === "string" && value.includes("\n")) {
    const body = value.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    return [`${pad}${key}: |-`, ...body.split("\n").map((line) => line ? `${pad}  ${line}` : "")];
  }
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}${key}: []`];
    return [`${pad}${key}:`, ...yamlLines(value, indent + 2)];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([item]) => YAML_KEY.test(item));
    if (!entries.length) return [`${pad}${key}: {}`];
    return [`${pad}${key}:`, ...yamlLines(value, indent + 2)];
  }
  return [`${pad}${key}: ${yamlScalar(value)}`];
}
function reportTitle(result, taskPackage) {
  const title = String(result.title || "").trim();
  if (title) return title;
  const packageTitle = String(taskPackage?.title || "").trim();
  if (packageTitle) return packageTitle;
  return String(taskPackage?.package_id || "Task Report").trim();
}
function renderTaskReport(result, taskPackage) {
  const ordered = [];
  const seen = /* @__PURE__ */ new Set();
  for (const name of requiredSections(taskPackage)) {
    const key = normalizeSectionName(name);
    const section = result.sections.find((item) => normalizeSectionName(item.name) === key);
    if (!section || seen.has(key)) continue;
    seen.add(key);
    ordered.push({ name, body: section.body });
  }
  for (const section of result.sections) {
    const key = normalizeSectionName(section.name);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(section);
  }
  const lines = [`# ${reportTitle(result, taskPackage)}`, "", `- verdict: ${result.verdict}`, `- summary: ${result.summary}`, ""];
  for (const section of ordered) {
    lines.push(`## ${section.name}`, "", section.body || "\u65E0", "");
  }
  return lines.join("\n");
}
function renderTaskHandoff(result, taskPackage, { reportPath, handoffPath, scopeValidation: scopeValidation2 = null }) {
  const expected = object(taskPackage.expected_output);
  const handoff = object(taskPackage.handoff_contract);
  const runtime = object(taskPackage.runtime_context);
  const declaredReport = expected.file_path || reportPath;
  const declaredHandoff = handoff.handoff_file || handoffPath;
  const written = [...result.scope_actual.written];
  for (const item of [declaredReport, declaredHandoff]) {
    if (item && !written.includes(item)) written.push(item);
  }
  const gate = businessGate(taskPackage);
  const rank = (key, value) => {
    if (key === gate) return 0;
    if (typeof value === "string" && value.includes("\n")) return 3;
    if (value && typeof value === "object") return 2;
    return 1;
  };
  const customOutput = Object.entries(result.output).filter(([key]) => !RESERVED_OUTPUT_KEYS.includes(key)).map(([key, value], index) => ({ key, value, index, rank: rank(key, value) })).sort((left, right) => left.rank - right.rank || left.index - right.index);
  const output = {
    target_repo: runtime.target_repo || null,
    file_path: declaredReport,
    resolved_file_path: expected.resolved_file_path || reportPath,
    handoff_file: declaredHandoff,
    resolved_handoff_file: handoff.resolved_handoff_file || handoffPath,
    ...Object.fromEntries(customOutput.map(({ key, value }) => [key, value]))
  };
  const evidenceRefs = [...result.evidence_refs];
  for (const item of [expected.resolved_file_path || reportPath, handoff.resolved_handoff_file || handoffPath]) {
    if (item && !evidenceRefs.includes(item)) evidenceRefs.push(item);
  }
  const scopeCompliant = scopeValidation2?.compliant === true;
  const scopeComplianceSource = String(scopeValidation2?.source || "write_domain_unavailable");
  const writeDomainViolationCount = Math.max(0, Number(scopeValidation2?.violation_count) || 0);
  const writeDomainAuditComplete = scopeValidation2?.audit_complete === true;
  const lines = [
    "FINAL_HANDOFF:",
    ...yamlEntry("package_id", taskPackage.package_id ?? null, 2),
    ...yamlEntry("verdict", result.verdict, 2),
    ...yamlEntry("summary", result.summary, 2),
    ...yamlEntry("output", output, 2),
    ...yamlEntry("scope_actual", { read: result.scope_actual.read, written, deleted: result.scope_actual.deleted }, 2),
    "  validation:",
    "    required_files_loaded: true",
    "    required_files_loaded_detail: provided",
    "    expected_output_satisfied: true",
    `    scope_compliant: ${scopeCompliant}`,
    `    scope_compliance_source: ${yamlScalar(scopeComplianceSource)}`,
    `    write_domain_audit_complete: ${writeDomainAuditComplete}`,
    `    write_domain_violation_count: ${writeDomainViolationCount}`,
    "    mechanical_check: pass",
    ...yamlEntry("evidence_refs", evidenceRefs, 2),
    ""
  ];
  return lines.join("\n");
}
function write(pathname, content) {
  mkdirSync(path.dirname(pathname), { recursive: true });
  writeFileSync(pathname, content, "utf8");
}
function writeTaskResultOutputs({ payload, taskPackage, reportPath, handoffPath, fallbackRoot, scopeValidation: scopeValidation2 = null }) {
  const result = validateTaskResultPayload(payload, taskPackage, { fallbackRoot });
  const report = renderTaskReport(result, taskPackage);
  const handoff = renderTaskHandoff(result, taskPackage, { reportPath, handoffPath, scopeValidation: scopeValidation2 });
  write(reportPath, report);
  write(handoffPath, handoff);
  return { result, report, handoff };
}
function parseHandoffCheckSpec(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  const spec = object(parsed);
  if (!Array.isArray(spec.argv) || spec.argv.length < 2 || spec.argv.some((item) => typeof item !== "string" || !item)) {
    throw new Error("handoff check spec is present but not a usable {argv, cwd, env} object");
  }
  return {
    argv: [...spec.argv],
    cwd: String(spec.cwd || "") || null,
    env: Object.fromEntries(Object.entries(object(spec.env)).map(([key, value]) => [key, String(value)]))
  };
}
function runHandoffCheck(spec, { spawn = spawnSync, baseEnv = process.env } = {}) {
  if (!spec) return { checked: false, status: "not_configured", issues: [] };
  const run = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd || void 0,
    env: { ...baseEnv, ...spec.env },
    encoding: "utf8",
    windowsHide: true
  });
  const stdout = String(run.stdout || "").trim();
  if (run.error || !stdout) {
    return {
      checked: true,
      status: "error",
      exit_code: run.status ?? null,
      issues: [run.error ? `handoff_check_spawn_failed=${run.error.message}` : "handoff_check_no_output"],
      stderr: String(run.stderr || "").trim().slice(0, 2e3)
    };
  }
  try {
    const parsed = JSON.parse(stdout);
    return {
      checked: true,
      status: String(parsed.status || (run.status === 0 ? "pass" : "fail")),
      exit_code: run.status ?? null,
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : []
    };
  } catch {
    return {
      checked: true,
      status: "error",
      exit_code: run.status ?? null,
      issues: ["handoff_check_output_parse_failed"],
      stdout: stdout.slice(0, 2e3)
    };
  }
}
if (process.argv[1] && path.basename(process.argv[1]).toLowerCase() === "task_result_synthesis.mjs") {
  if (process.argv[2] !== "self-test") {
    console.error("usage: node ops/tools/task_result_synthesis.mjs self-test");
    process.exit(2);
  }
  const selfTestModule = "./task_result_synthesis.selftest.mjs";
  import(selfTestModule).then((module) => {
    module.selfTest();
    console.log("task_result_synthesis self-test: pass");
  }).catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}

// ops/tools/pi_write_domain_extension.mjs
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path2 from "node:path";
import { fileURLToPath } from "node:url";
var PI_CHILD_WRITE_DOMAIN_PROFILE = "pi-child-write-domain/v1";
var WRITE_DOMAIN_ENV = "PI_WRITE_DOMAIN";
var WRITE_DOMAIN_TOOL_NAMES = Object.freeze(["write", "edit"]);
var UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
function normalizeWindowsShellPath(value, platform = process.platform) {
  if (platform !== "win32" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return value;
  }
  const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return value;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}
function normalizeToolPathInput(value, platform = process.platform, homeDir = homedir()) {
  let normalized = String(value ?? "").replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  normalized = normalizeWindowsShellPath(normalized, platform);
  if (normalized === "~") return homeDir;
  if (normalized.startsWith("~/") || platform === "win32" && normalized.startsWith("~\\")) {
    return path2.join(homeDir, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}
function normalizeDomainPath(value, baseDir, caseInsensitive = false, options = {}) {
  if (value === null || value === void 0 || String(value) === "") return null;
  try {
    const platform = options.platform || process.platform;
    const input = normalizeToolPathInput(value, platform, options.homeDir || homedir());
    let normalized = path2.normalize(path2.isAbsolute(input) ? input : path2.resolve(baseDir, input));
    try {
      const literalTail = [];
      let existingAncestor = normalized;
      while (!existsSync2(existingAncestor)) {
        const parent = path2.dirname(existingAncestor);
        if (parent === existingAncestor) {
          existingAncestor = null;
          break;
        }
        literalTail.unshift(path2.basename(existingAncestor));
        existingAncestor = parent;
      }
      if (existingAncestor) {
        normalized = path2.join(realpathSync.native(existingAncestor), ...literalTail);
      }
    } catch {
    }
    normalized = path2.normalize(path2.resolve(normalized));
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  } catch {
    return null;
  }
}
function isInsidePath(base, candidate) {
  const relative = path2.relative(path2.resolve(base), path2.resolve(candidate));
  return relative === "" || !relative.startsWith(`..${path2.sep}`) && relative !== ".." && !path2.isAbsolute(relative);
}
function parseWriteDomainSpec(raw, { baseDir = process.cwd() } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${WRITE_DOMAIN_ENV} must encode one JSON object`);
  }
  const version = String(parsed.version || "");
  if (version !== PI_CHILD_WRITE_DOMAIN_PROFILE) {
    throw new Error(`${WRITE_DOMAIN_ENV}.version must be ${PI_CHILD_WRITE_DOMAIN_PROFILE}`);
  }
  const caseInsensitive = parsed.caseInsensitive === true;
  const list = (value, label) => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
      throw new Error(`${WRITE_DOMAIN_ENV}.${label} must be a list of non-empty strings`);
    }
    const normalized = value.map((item) => normalizeDomainPath(item, baseDir, caseInsensitive));
    if (normalized.some((item) => !item)) throw new Error(`${WRITE_DOMAIN_ENV}.${label} contains an invalid path`);
    return [...new Set(normalized)];
  };
  const logRaw = String(parsed.log ?? "");
  if (!logRaw) throw new Error(`${WRITE_DOMAIN_ENV}.log is required`);
  const log = normalizeDomainPath(logRaw, baseDir, false);
  if (!log) throw new Error(`${WRITE_DOMAIN_ENV}.log is invalid`);
  const allowed = list(parsed.allowed ?? [], "allowed");
  const roots = list(parsed.roots ?? [], "roots");
  const deleteAllowed = list(parsed.deleteAllowed ?? [], "deleteAllowed");
  const runtimeRoot = parsed.runtimeRoot ? normalizeDomainPath(parsed.runtimeRoot, baseDir, caseInsensitive) : null;
  return {
    version,
    taskId: String(parsed.taskId || "") || null,
    allowed,
    roots,
    deleteAllowed,
    runtimeRoot,
    log,
    caseInsensitive
  };
}
function evaluatePathSet(resolvedPath, entries) {
  if (!resolvedPath) return { allowed: false, matched: null };
  for (const entry of entries) {
    if (resolvedPath === entry || isInsidePath(entry, resolvedPath)) return { allowed: true, matched: entry };
  }
  return { allowed: false, matched: null };
}
function evaluateWriteDomain(resolvedPath, spec) {
  if (resolvedPath && spec.runtimeRoot && isInsidePath(spec.runtimeRoot, resolvedPath)) {
    return { allowed: false, matched: null, reason: "runtime_package_read_only" };
  }
  return evaluatePathSet(resolvedPath, [...spec.allowed, ...spec.roots]);
}
function evaluateDeleteDomain(resolvedPath, spec) {
  return evaluatePathSet(resolvedPath, spec.deleteAllowed || []);
}
function readWriteDomainAudit(logPath) {
  if (!logPath || !existsSync2(logPath)) return { ready: [], records: [], errors: [] };
  const ready = [];
  const records = [];
  const errors = [];
  const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const record = JSON.parse(lines[index]);
      if (record?.kind === "guard_ready" && record.profile === PI_CHILD_WRITE_DOMAIN_PROFILE) {
        ready.push(record);
      } else if (record?.kind === "tool_call" && WRITE_DOMAIN_TOOL_NAMES.includes(record.tool) && typeof record.allowed === "boolean" && typeof record.tool_call_id === "string" && record.tool_call_id.length > 0) {
        records.push(record);
      } else {
        throw new Error("invalid record shape");
      }
    } catch (error) {
      errors.push(`line ${index + 1}: ${error?.message || error}`);
    }
  }
  return { ready, records, errors };
}
function summarizeWriteDomainAudit({ logPath, observedToolCalls = null, requireReady = true } = {}) {
  const audit = readWriteDomainAudit(logPath);
  const observed = Array.isArray(observedToolCalls) ? observedToolCalls.filter((item) => WRITE_DOMAIN_TOOL_NAMES.includes(String(item?.name ?? item?.toolName ?? ""))) : null;
  const expectedIds = observed ? observed.map((item) => String(item?.id ?? item?.toolCallId ?? "")).filter(Boolean).sort() : [];
  const recordedIds = audit.records.map((item) => String(item.tool_call_id)).sort();
  const recordedIdSet = new Set(recordedIds);
  const structuralErrors = [...audit.errors];
  if (requireReady && audit.ready.length !== 1) structuralErrors.push(`guard_ready count: ${audit.ready.length}`);
  if (recordedIdSet.size !== recordedIds.length) structuralErrors.push("duplicate tool_call_id in audit");
  const missingObserved = expectedIds.filter((id) => !recordedIdSet.has(id));
  if (observed && expectedIds.length !== observed.length) structuralErrors.push("observed write/edit call missing tool_call_id");
  if (missingObserved.length) structuralErrors.push(`unrecorded observed tool calls: ${missingObserved.join(", ")}`);
  const auditComplete = structuralErrors.length === 0;
  const violations = audit.records.filter((item) => item.allowed === false);
  return {
    ready_count: audit.ready.length,
    request_count: audit.records.length,
    allowed_count: audit.records.length - violations.length,
    blocked_count: violations.length,
    audit_complete: auditComplete,
    scope_compliant: auditComplete && violations.length === 0,
    audit_errors: structuralErrors,
    violations: violations.slice(0, 50)
  };
}
function evaluateReportedWriteScope(scopeActual, spec, baseDirs = []) {
  const roots = [...new Set(baseDirs.map((item) => String(item || "")).filter(Boolean))];
  const violations = [];
  for (const field of ["written", "deleted"]) {
    const values = Array.isArray(scopeActual?.[field]) ? scopeActual[field] : [];
    const evaluate = field === "deleted" ? evaluateDeleteDomain : evaluateWriteDomain;
    for (const rawPath of values) {
      const candidates = roots.map((root) => normalizeDomainPath(rawPath, root, spec.caseInsensitive)).filter(Boolean);
      const matched = candidates.some((candidate) => evaluate(candidate, spec).allowed);
      if (!matched) violations.push({ field, raw_path: String(rawPath), resolved_candidates: candidates });
    }
  }
  return violations;
}

// ops/tools/pi_task_result_extension.mjs
function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}
function taskPackageFromFile(taskPackagePath) {
  const parsed = JSON.parse(readFileSync2(taskPackagePath, "utf8"));
  const body = parsed && typeof parsed === "object" && parsed.task_package && typeof parsed.task_package === "object" ? parsed.task_package : parsed;
  if (!body || typeof body !== "object" || !body.package_id) throw new Error("task package JSON has no task package body");
  return body;
}
function taskResultParameterSchema(taskPackage) {
  const schema = JSON.parse(JSON.stringify(TASK_RESULT_V1_JSON_SCHEMA));
  schema.required = [];
  schema.properties.payload_path = {
    type: "string",
    description: "\u53EF\u9009\uFF1A\u4EA4\u5377\u5185\u5BB9\u5DF2\u5199\u6210 JSON \u6587\u4EF6\u65F6\u53EA\u4F20\u8FD9\u4E2A\u8DEF\u5F84\uFF08\u76F8\u5BF9\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u6216\u7EDD\u5BF9\u8DEF\u5F84\uFF09\uFF0C\u6587\u4EF6\u91CC\u7684\u5B57\u6BB5\u4E0E\u5185\u8054\u53C2\u6570\u76F8\u540C\uFF1B\u7528\u5B83\u65F6\u4E0D\u8981\u518D\u4F20\u5176\u4ED6\u5B57\u6BB5"
  };
  const verdicts = taskPackage ? acceptVerdicts(taskPackage) : [];
  if (verdicts.length) {
    schema.properties.verdict = {
      type: "string",
      enum: verdicts,
      description: `\u5FC5\u586B\uFF08\u7528 payload_path \u65F6\u5199\u5728\u6587\u4EF6\u91CC\uFF09\uFF1B\u672C\u4EFB\u52A1\u53D6 ${verdicts.join(" | ")} \u4E4B\u4E00`
    };
  }
  const sections = taskPackage ? requiredSections(taskPackage) : [];
  if (sections.length) {
    schema.properties.sections.properties = Object.fromEntries(sections.map((name) => [name, { type: "string", description: `\u300C${name}\u300D\u4E00\u8282\u7684 Markdown \u6B63\u6587` }]));
    schema.properties.sections.description = `\u5FC5\u586B\uFF08\u7528 payload_path \u65F6\u5199\u5728\u6587\u4EF6\u91CC\uFF09\uFF1B\u672C\u4EFB\u52A1\u5FC5\u9700\u7AE0\u8282\uFF1A${sections.join("\u3001")}\u3002partial\u3001needs_owner\u3001needs_split \u53EF\u7F3A\u8282\uFF0C\u5176\u4F59 verdict \u6BCF\u8282\u90FD\u8981\u975E\u7A7A\uFF1B\u952E\u4E3A\u7AE0\u8282\u540D\uFF0C\u503C\u4E3A Markdown \u6B63\u6587\uFF0C\u53EF\u8FFD\u52A0\u989D\u5916\u7AE0\u8282`;
  }
  schema.properties.summary = { ...schema.properties.summary, description: `${schema.properties.summary.description}\uFF08\u7528 payload_path \u65F6\u5199\u5728\u6587\u4EF6\u91CC\uFF09` };
  return schema;
}
function prepareTaskResultArguments(raw, taskPackage = null, cwd = process.cwd()) {
  let input = raw;
  if (input && typeof input === "object" && !Array.isArray(input) && input.payload_path !== void 0) {
    const { payload_path: payloadFile, schema_version: _version, ...inline } = input;
    if (typeof payloadFile !== "string" || !payloadFile.trim()) {
      throw new Error("submit_task_result input error: payload_path must be a non-empty file path string.");
    }
    if (Object.keys(inline).length) {
      throw new Error(`submit_task_result input error: pass payload_path alone; also received ${Object.keys(inline).slice(0, 8).join(", ")}.`);
    }
    const file = path3.resolve(cwd, payloadFile.trim());
    let text;
    try {
      text = readFileSync2(file, "utf8");
    } catch (error) {
      throw new Error(`submit_task_result input error: payload_path cannot be read: ${file} (${error?.code || error?.message || error}).`);
    }
    try {
      input = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`submit_task_result input error: payload_path is not valid JSON: ${file} (${String(error?.message || error).slice(0, 160)}).`);
    }
  }
  const normalized = normalizeTaskResultArguments(input);
  const verdicts = taskPackage ? acceptVerdicts(taskPackage) : [];
  const verdict = String(normalized.verdict || "").trim();
  if (verdicts.length && !verdicts.includes(verdict)) {
    throw new Error(`submit_task_result input error: verdict must be one of ${verdicts.join(" | ")}; received ${JSON.stringify(verdict).slice(0, 40)}.`);
  }
  return normalized;
}
function scopeValidation(taskPackage, candidate, reportPath, handoffPath, spec, cwd) {
  if (!spec) {
    return {
      compliant: null,
      source: "not_configured",
      audit_complete: null,
      violation_count: 0,
      blocked_count: 0,
      reported_violation_count: 0,
      reported_violations: [],
      audit_errors: [],
      audit_path: null
    };
  }
  const runtime = taskPackage?.runtime_context && typeof taskPackage.runtime_context === "object" ? taskPackage.runtime_context : {};
  const baseDirs = [...new Set([
    cwd,
    runtime.target_repo,
    runtime.output_root,
    runtime.cwd
  ].map((item) => String(item || "")).filter(Boolean))];
  const trustedOutputViolations = [reportPath, handoffPath].filter((outputPath) => {
    const resolved = normalizeDomainPath(outputPath, cwd, spec.caseInsensitive);
    return !evaluateWriteDomain(resolved, spec).allowed;
  });
  if (trustedOutputViolations.length) {
    throw new Error(`submit_task_result output is outside the Core direct write domain: ${trustedOutputViolations.join(", ")}`);
  }
  const audit = summarizeWriteDomainAudit({ logPath: spec.log });
  const reportedViolations = evaluateReportedWriteScope(candidate?.scope_actual, spec, baseDirs);
  return {
    compliant: audit.scope_compliant && reportedViolations.length === 0,
    source: PI_CHILD_WRITE_DOMAIN_PROFILE,
    audit_complete: audit.audit_complete,
    violation_count: audit.blocked_count + reportedViolations.length,
    blocked_count: audit.blocked_count,
    reported_violation_count: reportedViolations.length,
    reported_violations: reportedViolations,
    audit_errors: audit.audit_errors,
    audit_path: spec.log
  };
}
function submitTaskResult({ raw, taskPackagePath, reportPath, handoffPath, payloadPath, checkSpec, writeDomainSpec, cwd = process.cwd() }) {
  const candidate = JSON.parse(JSON.stringify(raw ?? {}));
  let taskPackage;
  try {
    taskPackage = taskPackageFromFile(taskPackagePath);
  } catch (error) {
    return { ok: false, saved: false, errors: [`task package unavailable: ${error?.message || error}`] };
  }
  let written;
  let writeScopeValidation;
  try {
    const normalized = prepareTaskResultArguments(candidate, taskPackage, cwd);
    writeScopeValidation = scopeValidation(taskPackage, normalized, reportPath, handoffPath, writeDomainSpec, cwd);
    written = writeTaskResultOutputs({
      payload: normalized,
      taskPackage,
      reportPath,
      handoffPath,
      fallbackRoot: cwd,
      scopeValidation: writeScopeValidation
    });
  } catch (error) {
    return {
      ok: false,
      saved: false,
      errors: [String(error?.message || error)],
      hint: "\u7ED3\u679C\u672A\u4FDD\u5B58\u3002\u4FEE\u6B63\u4E0A\u8FF0\u5B57\u6BB5\u540E\u518D\u63D0\u4EA4\u4E00\u6B21\u3002"
    };
  }
  const handoffCheck = runHandoffCheck(checkSpec);
  const record = {
    submitted_at: (/* @__PURE__ */ new Date()).toISOString(),
    report_path: reportPath,
    handoff_path: handoffPath,
    handoff_check: handoffCheck,
    scope_validation: writeScopeValidation,
    result: written.result
  };
  mkdirSync3(path3.dirname(payloadPath), { recursive: true });
  writeFileSync2(payloadPath, `${JSON.stringify(record, null, 2)}
`, "utf8");
  if (handoffCheck.checked && !["pass", "error"].includes(handoffCheck.status)) {
    return {
      ok: false,
      saved: true,
      report_path: reportPath,
      handoff_path: handoffPath,
      handoff_check: handoffCheck,
      hint: "\u62A5\u544A\u4E0E handoff \u5DF2\u5199\u51FA\u4F46\u673A\u68B0\u81EA\u68C0\u672A\u901A\u8FC7\u3002\u6309 issues \u4FEE\u6B63\u540E\u518D\u63D0\u4EA4\u4E00\u6B21\u3002"
    };
  }
  const scopeViolation = writeScopeValidation?.compliant === false;
  const checkNote = {
    pass: "\u4EA4\u4ED8\u5B8C\u6210",
    not_configured: "\u4EA4\u4ED8\u5B8C\u6210\uFF1B\u672C\u4EFB\u52A1\u672A\u914D\u7F6E handoff \u81EA\u68C0\uFF0C\u7ED3\u679C\u5DF2\u4FDD\u5B58\u4F46\u672A\u7ECF\u673A\u68B0\u6821\u9A8C",
    error: "\u7ED3\u679C\u5DF2\u4FDD\u5B58\uFF1Bhandoff \u81EA\u68C0\u5668\u672C\u8EAB\u8FD0\u884C\u5931\u8D25\uFF0C\u4E0E\u7ED3\u679C\u5185\u5BB9\u65E0\u5173\uFF0C\u7236\u7EA7\u4F1A\u91CD\u65B0\u6821\u9A8C\uFF0C\u65E0\u9700\u518D\u63D0\u4EA4"
  }[handoffCheck.status];
  return {
    ok: true,
    saved: true,
    report_path: reportPath,
    handoff_path: handoffPath,
    verdict: written.result.verdict,
    handoff_check: handoffCheck,
    handoff_check_status: handoffCheck.status,
    scope_compliant: writeScopeValidation?.compliant ?? null,
    write_domain_violation_count: writeScopeValidation?.violation_count ?? 0,
    requires_parent_review: scopeViolation || handoffCheck.status === "error",
    note: scopeViolation ? `${checkNote}\uFF1B\u5199\u57DF\u8BC1\u636E\u4E0D\u5408\u89C4\uFF0C\u7236\u7EA7\u5FC5\u987B\u590D\u6838\u3002\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E\u4EFB\u52A1\u72B6\u6001\u3001\u62A5\u544A\u8DEF\u5F84\u548C\u8D8A\u754C\u4E8B\u5B9E\u3002` : `${checkNote}\u3002\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E\u4EFB\u52A1\u72B6\u6001\u4E0E\u62A5\u544A\u8DEF\u5F84\u5373\u53EF\uFF0C\u4E0D\u518D\u91CD\u5199\u62A5\u544A\u6B63\u6587\u3002`
  };
}
function pi_task_result_extension_default(pi) {
  const env = (name) => String(process.env[name] || "").trim();
  const taskPackagePath = env("PI_TASK_RESULT_TASK_PACKAGE_PATH");
  const reportPath = env("PI_TASK_RESULT_REPORT_PATH");
  const handoffPath = env("PI_TASK_RESULT_HANDOFF_PATH");
  const payloadPath = env("PI_TASK_RESULT_PAYLOAD_PATH");
  if (!taskPackagePath || !reportPath || !handoffPath || !payloadPath) return;
  const checkSpec = parseHandoffCheckSpec(env("PI_TASK_RESULT_HANDOFF_CHECK"));
  const writeDomainSpec = env(WRITE_DOMAIN_ENV) ? parseWriteDomainSpec(env(WRITE_DOMAIN_ENV)) : null;
  const registeredTaskPackage = taskPackageFromFile(taskPackagePath);
  pi.registerTool({
    name: TASK_RESULT_TOOL_NAME,
    label: "Submit Task Result",
    // 自定义工具不设 promptSnippet 就不进系统提示词的工具清单（Pi docs/extensions.md）。09-25 grok 截断续跑：
    // 缺清单条目时长上下文下交卷调用 3/3 被 shell 空转吸走，补上后 2/2 自行交卷，其余条件不变。
    promptSnippet: "Submit the task result from a JSON file (payload_path); this is how the task is delivered",
    promptGuidelines: ["When the work is done, deliver it by calling submit_task_result with payload_path set to the result JSON file you wrote (without a file-writing tool, pass the fields inline); submit_task_result is a tool call, not a shell command."],
    description: [
      "\u63D0\u4EA4\u672C\u4EFB\u52A1\u7ED3\u679C\uFF1A\u5DE5\u5177\u6309\u4EFB\u52A1\u5305\u6821\u9A8C\uFF08verdict \u53D6\u503C\u3001\u5FC5\u9700\u7AE0\u8282\u3001\u4E1A\u52A1\u95E8\u3001\u5F15\u7528\u8DEF\u5F84\u5B58\u5728\uFF09\uFF0C\u901A\u8FC7\u540E\u5199\u51FA\u62A5\u544A\u4E0E FINAL_HANDOFF ",
      "\u5E76\u8FD0\u884C handoff \u81EA\u68C0\u3002\u5148\u7528\u5199\u6587\u4EF6\u5DE5\u5177\u628A\u53C2\u6570\u5199\u6210 JSON \u6587\u4EF6\uFF0C\u518D\u53EA\u4F20 payload_path \u63D0\u4EA4\uFF1B\u6CA1\u6709\u5199\u6587\u4EF6\u5DE5\u5177\u65F6\u76F4\u63A5\u5185\u8054\u4F20\u53C2\u3002",
      "\u8FD4\u56DE ok:false \u65F6\u6309 errors/issues \u4FEE\u6B63\u540E\u518D\u63D0\u4EA4\u4E00\u6B21\u3002scope_compliant \u7531\u5199\u57DF\u5BA1\u8BA1\u751F\u6210\uFF0C\u4E0D\u63A5\u53D7\u81EA\u62A5\u3002",
      "\u8FD4\u56DE ok:true \u5373\u4EA4\u4ED8\u5B8C\u6210\uFF1B\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E\u4EFB\u52A1\u72B6\u6001\u4E0E\u62A5\u544A\u8DEF\u5F84\uFF0C\u4E0D\u518D\u91CD\u5199\u62A5\u544A\u6B63\u6587\u3002"
    ].join(""),
    parameters: taskResultParameterSchema(registeredTaskPackage),
    // SDK 在 schema 校验与 execute 之前调用本钩子：读 payload_path、补固定版本、还原 JSON 字符串包装、
    // 核对 verdict 闭集，形状无法解释时抛短错误，避免 SDK 校验错误把整份长报告回显给模型。
    prepareArguments: (raw) => prepareTaskResultArguments(raw, registeredTaskPackage),
    execute: async (_toolCallId, params) => textResult(submitTaskResult({
      raw: params,
      taskPackagePath,
      reportPath,
      handoffPath,
      payloadPath,
      checkSpec,
      writeDomainSpec
    }))
  });
}
export {
  pi_task_result_extension_default as default,
  prepareTaskResultArguments,
  submitTaskResult,
  taskResultParameterSchema
};
