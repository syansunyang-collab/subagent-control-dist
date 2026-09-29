#!/usr/bin/env node
/** Convert a compact semantic review result into durable report and handoff files. */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const REVIEW_PROFILE = "evidence_only_v1";
export const ASSISTED_REVIEW_PROFILE = "evidence_assisted_v1";
export const SEMANTIC_REVIEW_PROFILE = "semantic_review_v2";
export const ACCEPTANCE_SYNTHESIS_PROFILE = "acceptance_synthesis_v1";
export const TARGET_FILES_COVERAGE_MARKER = "$target_files";
export const SCOPE_READ_COVERAGE_MARKER = "$scope_read";

// review_result_v1 的机器可读 schema：submit_review_result 工具参数与任务提示的
// 单一真源，字段口径必须与 parseReviewResult/validateFinding 保持一致（selftest 锁同步）。
// title 是展示字段：缺失时校验层从 issue 首句确定性补齐，故不入 required。
export const REVIEW_RESULT_V1_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "gate", "summary", "findings", "evidence_gaps", "scope"],
  properties: {
    schema_version: { const: 1 },
    gate: { enum: ["pass", "fail", "needs_owner"], description: "pass 要求 findings 与 evidence_gaps 皆空；fail 至少一条 finding；needs_owner 要求 evidence_gaps 或 scope.not_reviewed 非空" },
    summary: { type: "string", minLength: 1, description: "一句话审查结论" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["issue", "impact", "repair", "criteria", "location", "evidence_refs"],
        properties: {
          title: { type: "string", description: "问题短标题；缺省自动取 issue 首句" },
          issue: { type: "string", minLength: 1, description: "具体问题描述" },
          impact: { type: "string", minLength: 1, description: "实际影响" },
          repair: { type: "string", minLength: 1, description: "修复方向" },
          criteria: {
            anyOf: [
              { type: "string", minLength: 1 },
              { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
            ],
            description: "命中的判据条目标识",
          },
          location: {
            anyOf: [
              { type: "string", minLength: 1 },
              { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
            ],
            description: "问题定位（file 或 file:line），可多处",
          },
          evidence_refs: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            description: "证据引用（路径或 path:line）",
          },
        },
      },
    },
    evidence_gaps: { type: "array", description: "证据缺口清单；gate=pass 时必须为空" },
    scope: {
      type: "object",
      required: ["reviewed", "not_reviewed"],
      properties: {
        reviewed: { type: "array", items: { type: "string" } },
        not_reviewed: { type: "array", items: { type: "string" }, description: "未覆盖的目标文件纯路径；原因写evidence_gaps，不把路径与解释混写。" },
        actual_reads: { type: "array", items: { type: "string" }, description: "实际消费的授权路径，可为scope.read子集；授权目录不等于必读全文。" },
      },
    },
    output: { type: "object" },
  },
});

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizedLineEndings(value) {
  return String(value || "").replace(/\r\n?/g, "\n");
}

function requiredMaterialBlocks(taskText, root) {
  const pattern = /<!-- subagent-required-material:start ([^\n]*?) -->\n([\s\S]*?)\n<!-- subagent-required-material:end -->/g;
  const blocks = new Map();
  for (const match of normalizedLineEndings(taskText).matchAll(pattern)) {
    let metadata;
    try {
      metadata = JSON.parse(match[1]);
    } catch {
      return null;
    }
    const key = pathKey(object(metadata).path, root);
    if (!key || blocks.has(key)) return null;
    blocks.set(key, normalizedLineEndings(match[2]));
  }
  return blocks;
}

function jsonBlocks(text) {
  return [...String(text || "").matchAll(/```json(?:\s+review_result(?:_v1)?)?\s*\n([\s\S]*?)```/gi)].map((match) => match[1]);
}

export function evidenceOnlyPackage(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  return object(extensions.review_execution).profile === REVIEW_PROFILE;
}

export function semanticReviewPackage(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  return object(extensions.review_execution).profile === SEMANTIC_REVIEW_PROFILE;
}

export function acceptanceSynthesisPackage(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  return object(extensions.review_execution).profile === ACCEPTANCE_SYNTHESIS_PROFILE;
}

export function structuredReviewPackage(taskPackage) {
  return evidenceOnlyPackage(taskPackage) || semanticReviewPackage(taskPackage) || acceptanceSynthesisPackage(taskPackage);
}

function reviewProfile(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  return String(object(extensions.review_execution).profile || "");
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function yamlScalarValue(value) {
  const raw = String(value || "").trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function handoffOutputScalar(text, key) {
  let inOutput = false;
  const field = new RegExp(`^    ${regexEscape(key)}:\\s*(.*?)\\s*$`);
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/^  output:\s*$/.test(line)) {
      inOutput = true;
      continue;
    }
    if (!inOutput) continue;
    if (/^  [A-Za-z_][A-Za-z0-9_]*:\s*/.test(line)) break;
    const match = field.exec(line);
    if (match) return yamlScalarValue(match[1]);
  }
  return "";
}

export function readAssistedReviewGate({ taskPackage, fallbackRoot }) {
  if (!taskPackage || reviewProfile(taskPackage) !== ASSISTED_REVIEW_PROFILE) return { applied: false };
  const expected = object(taskPackage.expected_output);
  const handoff = object(taskPackage.handoff_contract);
  const businessGate = String(expected.business_gate || "").replace(/^FINAL_HANDOFF\.output\./, "").trim();
  const handoffPath = resolvedPath(taskPackage, handoff.resolved_handoff_file || handoff.handoff_file, fallbackRoot);
  // 已是 assisted 任务却读不到业务门：按 needs_owner 收口并记录缺口，不与「非 assisted 任务」共用 applied:false。
  const unreadable = (gateError) => ({
    applied: true,
    profile: ASSISTED_REVIEW_PROFILE,
    gate: "needs_owner",
    gate_error: gateError,
    handoff_path: handoffPath || null,
  });
  if (!businessGate) return unreadable("task package declares no expected_output.business_gate");
  if (!handoffPath || !existsSync(handoffPath)) return unreadable(`handoff not found: ${handoffPath || "(no handoff path)"}`);
  const text = readFileSync(handoffPath, "utf8");
  const gate = handoffOutputScalar(text, businessGate);
  if (!["pass", "fail", "needs_owner"].includes(gate)) {
    return unreadable(`FINAL_HANDOFF.output.${businessGate}=${JSON.stringify(gate)} is not pass | fail | needs_owner`);
  }
  return {
    applied: true,
    profile: ASSISTED_REVIEW_PROFILE,
    gate,
    handoff_path: handoffPath,
  };
}

function capabilityName(taskPackage) {
  const agent = object(taskPackage?.agent);
  return String(object(agent.capability).name || "").trim();
}

function activeCapabilityContract(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  const contracts = object(extensions.capability_contract);
  const contractSlot = String(object(extensions.review_execution).contract_slot || "").trim();
  const direct = contracts[contractSlot || capabilityName(taskPackage).replace(/-/g, "_")];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  if (contractSlot) return {};
  const candidates = Object.values(contracts).filter((value) => value && typeof value === "object" && !Array.isArray(value));
  return candidates.length === 1 ? candidates[0] : {};
}

function identifierArray(output, field) {
  const value = output[field];
  if (!Array.isArray(value)) {
    throw new Error(`review_result_v1 output.${field} must be a string array`);
  }
  const normalized = value.map((item) => String(item || "").trim());
  if (normalized.some((item) => !item)) {
    throw new Error(`review_result_v1 output.${field} must not contain empty identifiers`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`review_result_v1 output.${field} must contain unique identifiers`);
  }
  return normalized;
}

function validateContractDriftResult(result) {
  const output = object(result.output);
  const enumerated = identifierArray(output, "identifiers_enumerated");
  const checked = identifierArray(output, "identifiers_checked");
  const enumeratedSet = new Set(enumerated);
  const unknownChecked = checked.filter((item) => !enumeratedSet.has(item));
  if (unknownChecked.length) {
    throw new Error(`contract-drift identifiers_checked were not enumerated: ${unknownChecked.join(", ")}`);
  }
  if (result.gate !== "needs_owner") {
    if (!enumerated.length) {
      throw new Error("contract-drift pass/fail requires at least one enumerated identifier");
    }
    const checkedSet = new Set(checked);
    const unchecked = enumerated.filter((item) => !checkedSet.has(item));
    if (unchecked.length) {
      throw new Error(`contract-drift pass/fail left identifiers unchecked: ${unchecked.join(", ")}`);
    }
  }
}

function normalizeTargetFilesCoverage(taskPackage, result) {
  const reviewed = result.scope.reviewed;
  const notReviewed = result.scope.not_reviewed;
  const markerInReviewed = reviewed.includes(TARGET_FILES_COVERAGE_MARKER);
  const markerInNotReviewed = notReviewed.includes(TARGET_FILES_COVERAGE_MARKER);
  if (!markerInReviewed && !markerInNotReviewed) return;
  if (markerInNotReviewed || reviewed.length !== 1 || notReviewed.length !== 0) {
    throw new Error("$target_files must be the sole scope.reviewed item for full coverage");
  }
  const targetFiles = contractTargetFiles(taskPackage);
  if (!targetFiles.length) {
    throw new Error("$target_files requires a non-empty capability coverage file set");
  }
  result.scope.reviewed = [...targetFiles];
}

function normalizeScopeReadCoverage(taskPackage, result) {
  const actualReads = result.scope.actual_reads;
  if (!Array.isArray(actualReads) || !actualReads.includes(SCOPE_READ_COVERAGE_MARKER)) return;
  if (actualReads.length !== 1) {
    throw new Error("$scope_read must be the sole scope.actual_reads item for full input coverage");
  }
  const declared = object(taskPackage.scope).read;
  if (!Array.isArray(declared) || !declared.length) {
    throw new Error("$scope_read requires non-empty task_package.scope.read");
  }
  result.scope.actual_reads = [...declared];
}

function validateAcceptanceSynthesisResult(taskPackage, result) {
  const extensions = object(taskPackage?.extensions);
  const contracts = object(object(extensions.capability_contract).acceptance_synthesis);
  const expected = Array.isArray(contracts.acceptance_ids)
    ? contracts.acceptance_ids.map((item) => String(item || "").trim())
    : [];
  if (!expected.length || expected.some((item) => !item) || new Set(expected).size !== expected.length) {
    throw new Error("acceptance-synthesis task contract requires unique acceptance_ids");
  }
  const expectedSet = new Set(expected);
  const output = object(result.output);
  const disposition = String(output.disposition || "");
  const mechanicalSchema = object(contracts.mechanical_schema);
  const dispositionValues = Array.isArray(mechanicalSchema.disposition_values)
    ? mechanicalSchema.disposition_values.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (!dispositionValues.length || new Set(dispositionValues).size !== dispositionValues.length) {
    throw new Error("acceptance-synthesis task contract requires mechanical_schema.disposition_values");
  }
  if (!dispositionValues.includes(disposition)) {
    throw new Error(`acceptance-synthesis output.disposition must be one of ${dispositionValues.join(", ")}`);
  }
  const considered = identifierArray(output, "acceptance_ids_considered");
  const failed = identifierArray(output, "failed_acceptance_ids");
  const confirmation = identifierArray(output, "confirmation_acceptance_ids");
  const regression = identifierArray(output, "regression_acceptance_ids");
  const uncertainty = object(output.uncertainty);
  const environmentUncertain = identifierArray(uncertainty, "environment");
  const evidenceUncertain = identifierArray(uncertainty, "evidence");
  if (considered.length !== expected.length || considered.some((item) => !expectedSet.has(item))) {
    throw new Error("acceptance-synthesis acceptance_ids_considered must equal task acceptance_ids");
  }
  for (const [label, values] of [["failed", failed], ["confirmation", confirmation], ["regression", regression]]) {
    const unknown = values.filter((item) => !expectedSet.has(item));
    if (unknown.length) throw new Error(`acceptance-synthesis ${label} ids are unknown: ${unknown.join(", ")}`);
  }
  const coverage = object(output.coverage);
  const coverageGroups = ["passed", "failed", "uncertain", "missing"].map((field) => [field, identifierArray(coverage, field)]);
  const coverageIds = coverageGroups.flatMap(([, values]) => values);
  const uncertaintyIds = [...environmentUncertain, ...evidenceUncertain];
  if (
    coverageIds.length !== expected.length ||
    new Set(coverageIds).size !== expected.length ||
    coverageIds.some((item) => !expectedSet.has(item))
  ) {
    throw new Error("acceptance-synthesis coverage must partition all task acceptance_ids exactly once");
  }
  if (
    uncertaintyIds.length !== coverage.uncertain.length ||
    new Set(uncertaintyIds).size !== uncertaintyIds.length ||
    uncertaintyIds.some((item) => !coverage.uncertain.includes(item))
  ) {
    throw new Error("acceptance-synthesis uncertainty groups must partition coverage.uncertain");
  }
  if (result.gate === "pass" && (disposition !== "pass" || failed.length || confirmation.length || regression.length || coverage.failed.length || coverage.uncertain.length || coverage.missing.length)) {
    throw new Error("acceptance-synthesis pass gate is inconsistent with disposition or coverage");
  }
  if (result.gate === "fail") {
    if (disposition !== "rework" || (!failed.length && !environmentUncertain.length)) {
      throw new Error("acceptance-synthesis fail gate requires disposition=rework and failed or environment-uncertain ids");
    }
    if (evidenceUncertain.length || coverage.missing.length) {
      throw new Error("acceptance-synthesis rework cannot contain evidence uncertainty or missing ids");
    }
    const confirmationSet = new Set(confirmation);
    const confirmationRequired = [...failed, ...environmentUncertain];
    if (confirmationRequired.some((item) => !confirmationSet.has(item))) {
      throw new Error("acceptance-synthesis confirmation_acceptance_ids must include every failed and environment-uncertain id");
    }
  }
  if (result.gate === "needs_owner" && disposition !== "needs_owner") {
    throw new Error("acceptance-synthesis needs_owner gate requires disposition=needs_owner");
  }
  for (const [index, finding] of result.findings.entries()) {
    for (const field of ["acceptance_refs", "requirement_refs"]) {
      const values = Array.isArray(finding?.[field]) ? finding[field] : [];
      if (!values.length || values.some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`acceptance-synthesis findings[${index}].${field} is required`);
      }
    }
    if (finding.acceptance_refs.some((item) => !expectedSet.has(String(item)))) {
      throw new Error(`acceptance-synthesis findings[${index}] references unknown acceptance id`);
    }
  }
}

function validateCapabilityResult(taskPackage, result) {
  const capability = capabilityName(taskPackage);
  if (capability === "contract-drift-inspection") validateContractDriftResult(result);
  if (capability === "acceptance-synthesis") validateAcceptanceSynthesisResult(taskPackage, result);
}

function validateFinding(finding, index) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    throw new Error(`review_result_v1 findings[${index}] must be an object`);
  }
  for (const field of ["title", "issue", "impact", "repair"]) {
    if (typeof finding[field] !== "string" || !finding[field].trim()) {
      throw new Error(`review_result_v1 findings[${index}].${field} is required`);
    }
  }
  const criteriaItems = Array.isArray(finding.criteria) ? finding.criteria : [finding.criteria];
  if (
    !criteriaItems.length ||
    criteriaItems.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`review_result_v1 findings[${index}].criteria must be a non-empty string or string array`);
  }
  finding.criteria = criteriaItems.join(", ");
  const locations = Array.isArray(finding.location) ? finding.location : [finding.location];
  if (
    !locations.length ||
    locations.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`review_result_v1 findings[${index}].location must be a non-empty string or string array`);
  }
  if (
    !Array.isArray(finding.evidence_refs) ||
    !finding.evidence_refs.length ||
    finding.evidence_refs.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`review_result_v1 findings[${index}].evidence_refs must be a non-empty string array`);
  }
}

// 展示字段确定性补齐：title 只是报告导航字段。缺失时取 issue 首句，
// 不让整单已完成的审查因导航字段作废。渲染端只使用补齐后的 title。
// 语义证据字段（issue/impact/repair/criteria/location/evidence_refs）继续硬校验
//（owner 裁决，工具病 20260831-structured-review-final-schema-no-repair）。
function backfillFindingTitles(findings) {
  for (const finding of findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) continue;
    const hasTitle = typeof finding.title === "string" && finding.title.trim();
    const issue = typeof finding.issue === "string" ? finding.issue.trim() : "";
    if (!hasTitle && issue) {
      finding.title = issue.split(/[。.!！?？;；\n]/)[0].trim().slice(0, 80);
    }
  }
}

function validateReviewResultSemantics(result, taskPackage = null) {
  backfillFindingTitles(result.findings);
  result.findings.forEach(validateFinding);
  if (result.gate === "pass" && (result.findings.length || result.evidence_gaps.length)) {
    throw new Error("review_result_v1 pass requires empty findings and evidence_gaps");
  }
  if (result.gate === "fail" && !result.findings.length) {
    const environmentUncertain = object(object(result.output).uncertainty).environment;
    const acceptanceEnvironmentRework = capabilityName(taskPackage) === "acceptance-synthesis"
      && Array.isArray(environmentUncertain) && environmentUncertain.length > 0;
    if (!acceptanceEnvironmentRework) {
      throw new Error("review_result_v1 fail requires at least one finding");
    }
  }
  const notReviewed = Array.isArray(result.scope?.not_reviewed) ? result.scope.not_reviewed : [];
  if (result.gate === "needs_owner" && !result.evidence_gaps.length && !notReviewed.length) {
    throw new Error("review_result_v1 needs_owner requires evidence_gaps or scope.not_reviewed");
  }
}

// 结构+语义校验的单一入口：runner 事后解析与 pi 扩展工具 submit_review_result 的
// 当场校验共用同一实现，杜绝双源漂移。会原地归一化（criteria join、coverage marker
// 展开），归一化后重跑幂等。
export function validateReviewResultPayload(result, taskPackage = null) {
  if (result?.schema_version !== 1) throw new Error("review_result_v1 schema_version must be 1");
  if (!["pass", "fail", "needs_owner"].includes(result?.gate)) {
    throw new Error("review_result_v1 gate must be pass, fail or needs_owner");
  }
  if (typeof result?.summary !== "string" || !result.summary.trim()) {
    throw new Error("review_result_v1 summary is required");
  }
  for (const field of ["findings", "evidence_gaps"]) {
    if (!Array.isArray(result[field])) throw new Error(`review_result_v1 ${field} must be an array`);
  }
  if (!result.scope || typeof result.scope !== "object" || Array.isArray(result.scope)) {
    throw new Error("review_result_v1 scope must be an object");
  }
  for (const field of ["reviewed", "not_reviewed"]) {
    if (!Array.isArray(result.scope[field]) || result.scope[field].some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`review_result_v1 scope.${field} must be a string array`);
    }
  }
  if (result.scope.actual_reads !== undefined && (
    !Array.isArray(result.scope.actual_reads) || result.scope.actual_reads.some((item) => typeof item !== "string" || !item.trim())
  )) {
    throw new Error("review_result_v1 scope.actual_reads must be a string array when present");
  }
  if (result.output !== undefined && (typeof result.output !== "object" || Array.isArray(result.output) || result.output === null)) {
    throw new Error("review_result_v1 output must be an object when present");
  }
  if (taskPackage) {
    normalizeTargetFilesCoverage(taskPackage, result);
    normalizeScopeReadCoverage(taskPackage, result);
  }
  validateReviewResultSemantics(result, taskPackage);
  if (taskPackage) validateCapabilityResult(taskPackage, result);
  return result;
}

export function parseReviewResult(finalText, taskPackage = null) {
  const text = String(finalText || "");
  const facts = /## 事实与证据\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(text)?.[1] ?? text;
  const trimmedFacts = facts.trim();
  const [fencedBlock] = jsonBlocks(facts);
  const block = fencedBlock || (trimmedFacts.startsWith("{") && trimmedFacts.endsWith("}") ? trimmedFacts : "");
  if (!block) throw new Error("review_result_v1 JSON block missing");
  let result;
  try {
    result = JSON.parse(block);
  } catch (error) {
    throw new Error(`review_result_v1 is invalid JSON: ${error.message}`);
  }
  return validateReviewResultPayload(result, taskPackage);
}

function resolvedPath(taskPackage, value, fallbackRoot) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const runtime = object(taskPackage.runtime_context);
  return path.resolve(String(runtime.output_root || fallbackRoot), raw);
}

function yamlScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

function pathKey(value, root) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const absolute = path.resolve(root, raw);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function scopeAllows(taskPackage, reviewedPath, root) {
  const candidate = pathKey(reviewedPath, root);
  if (!candidate) return false;
  const declared = object(taskPackage.scope).read;
  if (!Array.isArray(declared)) return false;
  return declared.some((entry) => {
    const key = pathKey(entry, root);
    if (!key) return false;
    if (/^https?:\/\//i.test(key)) return candidate === key;
    if (candidate === key) return true;
    const raw = String(entry || "").trim();
    const absolute = path.resolve(root, raw);
    return existsSync(absolute) && statSync(absolute).isDirectory() && candidate.startsWith(`${key}${path.sep}`);
  });
}

// 必读材料声明只看任务包；声明齐全不代表已加载，加载由 requiredMaterialLoaded 对照任务正文与磁盘确认。
function requiredMaterialDeclaration(taskPackage, root) {
  const agent = object(taskPackage.agent);
  const capability = object(agent.capability);
  const required = agent.required_files;
  if (
    !String(agent.role || "").trim() ||
    !String(agent.runtime_role || "").trim() ||
    !String(capability.name || "").trim() ||
    !String(capability.file || "").trim() ||
    !Array.isArray(required) ||
    !required.length ||
    required.some((entry) => typeof entry !== "string" || !entry.trim())
  ) return null;
  // 新任务的提示词来自编译器绑定的发布根；旧的无绑定任务保留producer根口径。
  const runtime = object(taskPackage.runtime_context);
  const binding = object(object(taskPackage.extensions).model_config);
  const materialRoot = String(binding.global_root || runtime.output_root || "").trim() || root;
  const keys = required.map((entry) => pathKey(entry, materialRoot));
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) return null;
  return { required, materialRoot, keys };
}

function requiredMaterialLoaded(taskPackage, taskText, root) {
  const declaration = requiredMaterialDeclaration(taskPackage, root);
  if (!declaration) return false;
  const { required, materialRoot, keys } = declaration;
  const blocks = requiredMaterialBlocks(taskText, materialRoot);
  if (!blocks || blocks.size !== keys.length || keys.some((key) => !blocks.has(key))) return false;
  return required.every((entry) => {
    const pathname = path.resolve(materialRoot, String(entry || ""));
    if (!existsSync(pathname) || !statSync(pathname).isFile()) return false;
    const content = normalizedLineEndings(readFileSync(pathname, "utf8"));
    return Boolean(content) && blocks.get(pathKey(entry, materialRoot)) === content;
  });
}

function contractTargetFiles(taskPackage) {
  const contract = activeCapabilityContract(taskPackage);
  const values = Array.isArray(contract.target_files)
    ? contract.target_files
    : Array.isArray(contract.affected_files)
      ? contract.affected_files
      : [];
  return values.map(String);
}

export function loadReviewEvidence(taskPackage, root) {
  const extensions = object(taskPackage.extensions);
  const reference = object(extensions.review_evidence);
  const rawPath = String(reference.path || "").trim();
  if (!rawPath) throw new Error("review evidence path is missing");
  // 证据包由 producer 构包时落在 producer 仓内，reference.path 相对 producer 根。跨仓审查时
  // fallbackRoot 是目标仓，因此与 resolvedPath() 同口径优先取 runtime_context.output_root。
  const runtime = object(taskPackage.runtime_context);
  const rootPath = path.resolve(String(runtime.output_root || root));
  const evidencePath = path.resolve(rootPath, rawPath);
  const relative = path.relative(rootPath, evidencePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`review evidence path escapes resolved root: ${rawPath}`);
  }
  if (!existsSync(evidencePath)) {
    throw new Error(`review evidence file is missing: ${evidencePath}`);
  }
  if (!statSync(evidencePath).isFile()) {
    throw new Error(`review evidence path is not a file: ${evidencePath}`);
  }
  const content = readFileSync(evidencePath, "utf8").replace(/\r\n?/g, "\n");
  let evidence;
  try {
    evidence = JSON.parse(content);
  } catch (error) {
    throw new Error(`review evidence JSON is invalid: ${evidencePath}: ${error.message}`);
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error(`review evidence JSON root must be an object: ${evidencePath}`);
  }
  return evidence;
}

function evidenceContractTargetFiles(evidence) {
  const contract = object(evidence?.contract);
  return Array.isArray(contract.target_files) ? contract.target_files.map(String) : [];
}

function evidenceSourcePathSet(evidence, root) {
  const sources = evidence?.sources;
  if (!Array.isArray(sources) || !sources.length) return null;
  const keys = sources.map((source) => pathKey(object(source).path, root));
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) return null;
  return new Set(keys);
}

function evidenceMetadataMatchesExecution(evidence, taskPackage) {
  const extensions = object(taskPackage.extensions);
  const execution = object(extensions.review_execution);
  const materialMode = String(execution.material_mode || "").trim();
  if (
    evidence?.profile !== SEMANTIC_REVIEW_PROFILE ||
    evidence?.complete !== true ||
    !["full", "index"].includes(materialMode) ||
    evidence?.material_mode !== materialMode
  ) return false;
  const sources = evidence.sources;
  return materialMode !== "full" || (
    Array.isArray(sources) && sources.every((source) => typeof object(source).content === "string")
  );
}

function samePathSet(left, right, root) {
  const leftKeys = left.map((entry) => pathKey(entry, root));
  const rightKeys = right.map((entry) => pathKey(entry, root));
  if (
    leftKeys.some((key) => !key) ||
    rightKeys.some((key) => !key) ||
    new Set(leftKeys).size !== leftKeys.length ||
    new Set(rightKeys).size !== rightKeys.length
  ) return false;
  const rightSet = new Set(rightKeys);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => rightSet.has(key));
}

function validateAcceptanceInputCoverage(taskPackage, result, root) {
  const declared = object(taskPackage.scope).read;
  if (!Array.isArray(declared) || !declared.length || declared.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("acceptance-synthesis scope.read must contain exact input paths");
  }
  const reviewed = Array.isArray(result.scope.reviewed) ? result.scope.reviewed : [];
  const notReviewed = Array.isArray(result.scope.not_reviewed) ? result.scope.not_reviewed : [];
  const combined = [...reviewed, ...notReviewed];
  if (!samePathSet(combined, declared, root)) {
    throw new Error("acceptance-synthesis reviewed/not_reviewed must exactly partition scope.read");
  }
  if (notReviewed.length && result.gate !== "needs_owner") {
    throw new Error("partial acceptance-synthesis input coverage requires needs_owner");
  }
}

function validateTargetFilesCoverage(taskPackage, result, root, targetFiles, evidenceSourceKeys = null) {
  const reviewed = Array.isArray(result.scope.reviewed) ? result.scope.reviewed : [];
  if (!reviewed.length || reviewed.some((item) => typeof item !== "string" || !scopeAllows(taskPackage, item, root))) {
    throw new Error("structured review scope.reviewed must contain exact paths within scope.read");
  }
  if (evidenceSourceKeys) {
    const missingReviewedSources = reviewed.filter((item) => !evidenceSourceKeys.has(pathKey(item, root)));
    if (missingReviewedSources.length) {
      throw new Error(`structured review scope.reviewed files are missing from evidence sources: ${missingReviewedSources.join(", ")}`);
    }
  }
  const notReviewed = Array.isArray(result.scope.not_reviewed) ? result.scope.not_reviewed : [];
  if (notReviewed.some((item) => !scopeAllows(taskPackage, item, root))) {
    throw new Error("structured review scope.not_reviewed must contain exact paths within scope.read");
  }
  const targetKeys = new Set(targetFiles.map((item) => pathKey(item, root)));
  const reviewedKeys = new Set(reviewed.map((item) => pathKey(item, root)));
  const notReviewedKeys = new Set(notReviewed.map((item) => pathKey(item, root)));
  const unknownNotReviewed = notReviewed.filter((item) => !targetKeys.has(pathKey(item, root)));
  if (unknownNotReviewed.length || [...notReviewedKeys].some((key) => reviewedKeys.has(key))) {
    throw new Error("structured review scope.not_reviewed must be a disjoint subset of the coverage file set");
  }
  const missingTargets = targetFiles.filter((item) => !reviewedKeys.has(pathKey(item, root)));
  if (notReviewed.length) {
    if (result.gate !== "needs_owner" || !samePathSet(missingTargets, notReviewed, root)) {
      throw new Error("partial structured review must exactly list reviewed/not_reviewed coverage files and use needs_owner");
    }
  } else if (missingTargets.length) {
    throw new Error(`structured review pass/fail did not review all coverage files: ${missingTargets.join(", ")}`);
  }
}

// 任务包或审查证据自身的缺陷：模型改结果修不好，提交时照常保存并交父级复核，收尾按合同失败处理。
export class ReviewPackageDefectError extends Error {}

// 只依赖任务包、审查证据与提交负载的规则：submit_review_result 提交时与收尾 structuredValidation
// 共用这一实现。返回 handoff 记录的 actual_reads。
export function validateReviewResultScope(taskPackage, result, root) {
  if (!requiredMaterialDeclaration(taskPackage, root)) {
    throw new ReviewPackageDefectError("task package required material declaration is incomplete (agent.role, agent.runtime_role, agent.capability.name/file, unique agent.required_files)");
  }
  let actualReads = Array.isArray(result.scope.reviewed) ? [...result.scope.reviewed] : [];
  if (acceptanceSynthesisPackage(taskPackage)) {
    validateAcceptanceInputCoverage(taskPackage, result, root);
  }
  if (evidenceOnlyPackage(taskPackage)) {
    const targetFiles = contractTargetFiles(taskPackage);
    if (!targetFiles.length) {
      throw new ReviewPackageDefectError("evidence-only capability contract coverage files must be non-empty");
    }
    validateTargetFilesCoverage(taskPackage, result, root, targetFiles);
  }
  if (semanticReviewPackage(taskPackage)) {
    const targetFiles = contractTargetFiles(taskPackage);
    if (!targetFiles.length) {
      throw new ReviewPackageDefectError("semantic review capability contract target_files must be non-empty");
    }
    const evidence = loadReviewEvidence(taskPackage, root);
    const evidenceTargetFiles = evidenceContractTargetFiles(evidence);
    if (!evidenceTargetFiles.length || !samePathSet(targetFiles, evidenceTargetFiles, root)) {
      throw new ReviewPackageDefectError("semantic review capability contract and evidence target_files must match");
    }
    if (!evidenceMetadataMatchesExecution(evidence, taskPackage)) {
      throw new ReviewPackageDefectError("semantic review evidence metadata does not match the execution contract");
    }
    const evidenceSourceKeys = evidenceSourcePathSet(evidence, root);
    if (!evidenceSourceKeys) {
      throw new ReviewPackageDefectError("semantic review evidence sources must be a non-empty unique path set");
    }
    const missingTargetSources = targetFiles.filter((item) => !evidenceSourceKeys.has(pathKey(item, root)));
    if (missingTargetSources.length) {
      throw new ReviewPackageDefectError(`semantic review target_files are missing from evidence sources: ${missingTargetSources.join(", ")}`);
    }
    validateTargetFilesCoverage(taskPackage, result, root, targetFiles, evidenceSourceKeys);
    const reportedReads = result.scope.actual_reads;
    if (!Array.isArray(reportedReads) || (!reportedReads.length && result.gate !== "needs_owner")) {
      throw new Error("semantic review scope.actual_reads must record consumed scope.read inputs");
    }
    if (reportedReads.some((item) => !scopeAllows(taskPackage, item, root))) {
      throw new Error("semantic review scope.actual_reads must contain paths within scope.read");
    }
    actualReads = [...reportedReads];
  }
  return actualReads;
}

export function structuredValidation({ taskPackage, taskText, result, fallbackRoot, reportPath, handoffPath, runnerObservations }) {
  if (object(runnerObservations).turn_completed !== true) {
    throw new Error("structured review synthesis requires a completed model turn");
  }
  if (evidenceOnlyPackage(taskPackage) && object(runnerObservations).evidence_tool_guard_passed !== true) {
    throw new Error("evidence-only review synthesis requires the tool guard to pass");
  }
  if (!requiredMaterialLoaded(taskPackage, taskText, fallbackRoot)) {
    throw new Error("structured review required files were not present in task material");
  }
  if (!reportPath || !handoffPath) {
    throw new Error("structured review output paths are incomplete");
  }
  const actualReads = validateReviewResultScope(taskPackage, result, fallbackRoot);
  return {
    required_files_loaded: true,
    expected_output_satisfied: true,
    scope_compliant: true,
    mechanical_check: "pass",
    actual_reads: actualReads,
  };
}

function markdownFinding(finding, index) {
  const item = object(finding);
  const title = String(item.title).trim();
  const lines = [`### F${index + 1} - ${title}`];
  for (const [key, value] of [
    ["location", item.location],
    ["criteria", item.criteria],
    ["issue", item.issue],
    ["impact", item.impact],
    ["repair", item.repair],
    ["acceptance_refs", item.acceptance_refs],
    ["requirement_refs", item.requirement_refs],
  ]) {
    const rendered = Array.isArray(value) ? value.map(String).join(", ") : String(value ?? "");
    if (rendered.trim()) lines.push(`- ${key}: ${rendered.trim()}`);
  }
  const refs = Array.isArray(item.evidence_refs) ? item.evidence_refs : [];
  if (refs.length) lines.push(`- evidence_refs: ${refs.map(String).join(", ")}`);
  return lines.join("\n");
}

export function reportText(result, taskPackage) {
  const findings = result.findings.length
    ? result.findings.map(markdownFinding).join("\n\n")
    : "(none)";
  const gaps = result.evidence_gaps.length
    ? result.evidence_gaps.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n")
    : "(none)";
  const machineDecision = capabilityName(taskPackage) === "acceptance-synthesis"
    ? ["", "```json review_result", JSON.stringify(result, null, 2), "```"]
    : [];
  return [
    "# Review Report",
    "",
    "## Verdict",
    result.gate,
    "",
    result.summary.trim(),
    ...machineDecision,
    "",
    "## Findings",
    findings,
    "",
    "## Evidence Gaps",
    gaps,
    "",
    "## Capability Output",
    "```json",
    JSON.stringify(object(result.output), null, 2),
    "```",
    "",
    "## Scope",
    "```json",
    JSON.stringify(result.scope, null, 2),
    "```",
    "",
  ].join("\n");
}

function handoffText(taskPackage, result, reportPath, handoffPath, validation) {
  const expected = object(taskPackage.expected_output);
  const handoff = object(taskPackage.handoff_contract);
  const runtime = object(taskPackage.runtime_context);
  const extensions = object(taskPackage.extensions);
  const evidence = object(extensions.review_evidence);
  const businessGate = String(expected.business_gate || "verdict").replace(/^FINAL_HANDOFF\.output\./, "");
  const verdict = result.gate === "needs_owner" ? "needs_owner" : "done";
  const actualReads = Array.isArray(validation.actual_reads) ? validation.actual_reads : [];
  const evidenceRefs = [expected.file_path || reportPath, evidence.path].filter(Boolean);
  const capabilityOutput = object(result.output);
  const capabilityLines = Object.entries(capabilityOutput)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined)
    .map(([key, value]) => `    ${key}: ${Array.isArray(value) || (value && typeof value === "object") ? JSON.stringify(value) : yamlScalar(value)}`);
  const lines = [
    "FINAL_HANDOFF:",
    `  package_id: ${yamlScalar(taskPackage.package_id)}`,
    `  verdict: ${verdict}`,
    `  summary: ${yamlScalar(result.summary.trim())}`,
    "  output:",
    `    target_repo: ${yamlScalar(runtime.target_repo || null)}`,
    `    file_path: ${yamlScalar(expected.file_path || reportPath)}`,
    `    resolved_file_path: ${yamlScalar(expected.resolved_file_path || reportPath)}`,
    `    handoff_file: ${yamlScalar(handoff.handoff_file || handoffPath)}`,
    `    resolved_handoff_file: ${yamlScalar(handoff.resolved_handoff_file || handoffPath)}`,
    `    ${businessGate}: ${result.gate}`,
    `    findings_count: ${result.findings.length}`,
    `    evidence_gaps_count: ${result.evidence_gaps.length}`,
    ...capabilityLines,
    "  scope_actual:",
    "    read:",
    ...(actualReads.length ? actualReads.map((item) => `      - ${yamlScalar(item)}`) : ["      - null"]),
    "    written:",
    `      - ${yamlScalar(expected.file_path || reportPath)}`,
    `      - ${yamlScalar(handoff.handoff_file || handoffPath)}`,
    "    deleted: []",
    "  validation:",
    `    required_files_loaded: ${validation.required_files_loaded}`,
    "    required_files_loaded_detail: provided",
    `    expected_output_satisfied: ${validation.expected_output_satisfied}`,
    `    scope_compliant: ${validation.scope_compliant}`,
    `    mechanical_check: ${validation.mechanical_check}`,
    "  evidence_refs:",
    ...(evidenceRefs.length ? evidenceRefs.map((item) => `    - ${yamlScalar(item)}`) : ["    - null"]),
    "",
  ];
  return lines.join("\n");
}

function write(pathname, content) {
  mkdirSync(path.dirname(pathname), { recursive: true });
  writeFileSync(pathname, content, "utf8");
}

// 结构化结果获取：优先取 submit_review_result 工具落盘的文件（扩展侧已当场校验，
// 这里重跑同一校验作防御），文件缺失时退最终回复解析。两路都失败时抛出，由
// synthesizeReviewResult 转 salvage——审查内容已产出，格式坏不升级为运输失败。
function obtainReviewResult({ finalText, taskPackage, reviewResultPath }) {
  if (reviewResultPath && existsSync(reviewResultPath)) {
    const raw = readFileSync(reviewResultPath, "utf8");
    let submitted;
    try {
      submitted = JSON.parse(raw);
    } catch (error) {
      throw new Error(`submitted review-result.json is invalid JSON: ${error.message}`);
    }
    return { result: validateReviewResultPayload(submitted, taskPackage), source: "submit_tool" };
  }
  return { result: parseReviewResult(finalText, taskPackage), source: "final_response" };
}

// 结构化结果无效时的降级产物：gate 判 needs_owner、失败原因进 evidence_gaps，
// 报告与 handoff 照常机械生成，原始最终回复留在 outDir/child-final.md 供人工收割。
function salvageReviewResult(parseError) {
  return {
    schema_version: 1,
    gate: "needs_owner",
    summary: `结构化审查结果无效，保留原始回复待 owner 收割:${parseError}`,
    findings: [],
    evidence_gaps: [`review_result_v1 解析失败:${parseError};原始最终回复见 run 目录 child-final.md`],
    scope: { reviewed: [], not_reviewed: [] },
    output: {},
  };
}

// 收尾校验不过：审查交付违反审查合同（不是运输失败）。抛出时报告与 handoff 路径上的原件未被改动。
export class ReviewContractError extends Error {}

export function synthesizeReviewResult({ taskPackage, taskText, finalText, outDir, fallbackRoot, reviewResultPath = null, runnerObservations = {} }) {
  if (!taskPackage || !structuredReviewPackage(taskPackage)) return { applied: false };
  const expected = object(taskPackage.expected_output);
  const handoff = object(taskPackage.handoff_contract);
  const reportPath = resolvedPath(taskPackage, expected.resolved_file_path || expected.file_path, fallbackRoot);
  const handoffPath = resolvedPath(taskPackage, handoff.resolved_handoff_file || handoff.handoff_file, fallbackRoot);
  if (!reportPath || !handoffPath) throw new Error("evidence review requires resolved report and handoff paths");
  let result;
  let resultSource;
  let parseError = null;
  try {
    ({ result, source: resultSource } = obtainReviewResult({ finalText, taskPackage, reviewResultPath }));
  } catch (error) {
    parseError = String(error?.message ?? error);
    result = salvageReviewResult(parseError);
    resultSource = "salvage";
  }
  if (resultSource === "salvage") {
    const report = reportText(result, taskPackage);
    const handoffBody = handoffText(taskPackage, result, reportPath, handoffPath, {
      actual_reads: [],
      required_files_loaded: false,
      expected_output_satisfied: false,
      scope_compliant: false,
      mechanical_check: "fail",
    });
    write(reportPath, report);
    write(handoffPath, handoffBody);
    write(path.join(outDir, "report.md"), report);
    write(path.join(outDir, "handoff.md"), handoffBody);
    return {
      applied: true,
      profile: reviewProfile(taskPackage),
      gate: result.gate,
      result_source: resultSource,
      review_result_path: null,
      parse_error: parseError,
      findings_count: 0,
      evidence_gaps_count: result.evidence_gaps.length,
      report_path: reportPath,
      handoff_path: handoffPath,
    };
  }
  let validation;
  try {
    validation = structuredValidation({
      taskPackage,
      taskText,
      result,
      fallbackRoot,
      reportPath,
      handoffPath,
      runnerObservations,
    });
  } catch (error) {
    throw new ReviewContractError(String(error?.message ?? error));
  }
  const report = reportText(result, taskPackage);
  const handoffBody = handoffText(taskPackage, result, reportPath, handoffPath, validation);
  write(reportPath, report);
  write(handoffPath, handoffBody);
  write(path.join(outDir, "report.md"), report);
  write(path.join(outDir, "handoff.md"), handoffBody);
  return {
    applied: true,
    profile: reviewProfile(taskPackage),
    gate: result.gate,
    result_source: resultSource,
    review_result_path: resultSource === "submit_tool" ? reviewResultPath : null,
    findings_count: result.findings.length,
    evidence_gaps_count: result.evidence_gaps.length,
    report_path: reportPath,
    handoff_path: handoffPath,
  };
}

if (process.argv[1] && path.basename(process.argv[1]).toLowerCase() === "review_result_synthesis.mjs") {
  if (process.argv[2] !== "self-test") {
    console.error("usage: node ops/tools/review_result_synthesis.mjs self-test");
    process.exit(2);
  }
  // 说明符走变量:esbuild 只内联字面量动态 import,变量形式可把自测代码留在 ops/dist 运行时 bundle
  // 之外(打包产物的 argv[1] basename 不匹配,本分支在 bundle 里不会触发)。
  const selfTestModule = "./review_result_synthesis.selftest.mjs";
  // 不能用 top-level await:伴生模块静态 import 本模块,await 会让两边互等成 unsettled TLA(退出码 13)。
  import(selfTestModule).then((module) => {
    module.selfTest();
    console.log("review_result_synthesis self-test: pass");
  }).catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
