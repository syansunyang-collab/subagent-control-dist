// ops/tools/pi_review_result_extension.mjs
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import path2 from "node:path";

// ops/tools/review_result_synthesis.mjs
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
var REVIEW_PROFILE = "evidence_only_v1";
var SEMANTIC_REVIEW_PROFILE = "semantic_review_v2";
var ACCEPTANCE_SYNTHESIS_PROFILE = "acceptance_synthesis_v1";
var TARGET_FILES_COVERAGE_MARKER = "$target_files";
var SCOPE_READ_COVERAGE_MARKER = "$scope_read";
var REVIEW_RESULT_V1_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "gate", "summary", "findings", "evidence_gaps", "scope"],
  properties: {
    schema_version: { const: 1 },
    gate: { enum: ["pass", "fail", "needs_owner"], description: "pass \u8981\u6C42 findings \u4E0E evidence_gaps \u7686\u7A7A\uFF1Bfail \u81F3\u5C11\u4E00\u6761 finding\uFF1Bneeds_owner \u8981\u6C42 evidence_gaps \u6216 scope.not_reviewed \u975E\u7A7A" },
    summary: { type: "string", minLength: 1, description: "\u4E00\u53E5\u8BDD\u5BA1\u67E5\u7ED3\u8BBA" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["issue", "impact", "repair", "criteria", "location", "evidence_refs"],
        properties: {
          title: { type: "string", description: "\u95EE\u9898\u77ED\u6807\u9898\uFF1B\u7F3A\u7701\u81EA\u52A8\u53D6 issue \u9996\u53E5" },
          issue: { type: "string", minLength: 1, description: "\u5177\u4F53\u95EE\u9898\u63CF\u8FF0" },
          impact: { type: "string", minLength: 1, description: "\u5B9E\u9645\u5F71\u54CD" },
          repair: { type: "string", minLength: 1, description: "\u4FEE\u590D\u65B9\u5411" },
          criteria: {
            anyOf: [
              { type: "string", minLength: 1 },
              { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }
            ],
            description: "\u547D\u4E2D\u7684\u5224\u636E\u6761\u76EE\u6807\u8BC6"
          },
          location: {
            anyOf: [
              { type: "string", minLength: 1 },
              { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }
            ],
            description: "\u95EE\u9898\u5B9A\u4F4D\uFF08file \u6216 file:line\uFF09\uFF0C\u53EF\u591A\u5904"
          },
          evidence_refs: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            description: "\u8BC1\u636E\u5F15\u7528\uFF08\u8DEF\u5F84\u6216 path:line\uFF09"
          }
        }
      }
    },
    evidence_gaps: { type: "array", description: "\u8BC1\u636E\u7F3A\u53E3\u6E05\u5355\uFF1Bgate=pass \u65F6\u5FC5\u987B\u4E3A\u7A7A" },
    scope: {
      type: "object",
      required: ["reviewed", "not_reviewed"],
      properties: {
        reviewed: { type: "array", items: { type: "string" } },
        not_reviewed: { type: "array", items: { type: "string" }, description: "\u672A\u8986\u76D6\u7684\u76EE\u6807\u6587\u4EF6\u7EAF\u8DEF\u5F84\uFF1B\u539F\u56E0\u5199evidence_gaps\uFF0C\u4E0D\u628A\u8DEF\u5F84\u4E0E\u89E3\u91CA\u6DF7\u5199\u3002" },
        actual_reads: { type: "array", items: { type: "string" }, description: "\u5B9E\u9645\u6D88\u8D39\u7684\u6388\u6743\u8DEF\u5F84\uFF0C\u53EF\u4E3Ascope.read\u5B50\u96C6\uFF1B\u6388\u6743\u76EE\u5F55\u4E0D\u7B49\u4E8E\u5FC5\u8BFB\u5168\u6587\u3002" }
      }
    },
    output: { type: "object" }
  }
});
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function evidenceOnlyPackage(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  return object(extensions.review_execution).profile === REVIEW_PROFILE;
}
function semanticReviewPackage(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  return object(extensions.review_execution).profile === SEMANTIC_REVIEW_PROFILE;
}
function acceptanceSynthesisPackage(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  return object(extensions.review_execution).profile === ACCEPTANCE_SYNTHESIS_PROFILE;
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
  const expected = Array.isArray(contracts.acceptance_ids) ? contracts.acceptance_ids.map((item) => String(item || "").trim()) : [];
  if (!expected.length || expected.some((item) => !item) || new Set(expected).size !== expected.length) {
    throw new Error("acceptance-synthesis task contract requires unique acceptance_ids");
  }
  const expectedSet = new Set(expected);
  const output = object(result.output);
  const disposition = String(output.disposition || "");
  const mechanicalSchema = object(contracts.mechanical_schema);
  const dispositionValues = Array.isArray(mechanicalSchema.disposition_values) ? mechanicalSchema.disposition_values.map((item) => String(item || "").trim()).filter(Boolean) : [];
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
  if (coverageIds.length !== expected.length || new Set(coverageIds).size !== expected.length || coverageIds.some((item) => !expectedSet.has(item))) {
    throw new Error("acceptance-synthesis coverage must partition all task acceptance_ids exactly once");
  }
  if (uncertaintyIds.length !== coverage.uncertain.length || new Set(uncertaintyIds).size !== uncertaintyIds.length || uncertaintyIds.some((item) => !coverage.uncertain.includes(item))) {
    throw new Error("acceptance-synthesis uncertainty groups must partition coverage.uncertain");
  }
  if (result.gate === "pass" && (disposition !== "pass" || failed.length || confirmation.length || regression.length || coverage.failed.length || coverage.uncertain.length || coverage.missing.length)) {
    throw new Error("acceptance-synthesis pass gate is inconsistent with disposition or coverage");
  }
  if (result.gate === "fail") {
    if (disposition !== "rework" || !failed.length && !environmentUncertain.length) {
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
  if (!criteriaItems.length || criteriaItems.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`review_result_v1 findings[${index}].criteria must be a non-empty string or string array`);
  }
  finding.criteria = criteriaItems.join(", ");
  const locations = Array.isArray(finding.location) ? finding.location : [finding.location];
  if (!locations.length || locations.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`review_result_v1 findings[${index}].location must be a non-empty string or string array`);
  }
  if (!Array.isArray(finding.evidence_refs) || !finding.evidence_refs.length || finding.evidence_refs.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`review_result_v1 findings[${index}].evidence_refs must be a non-empty string array`);
  }
}
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
    const acceptanceEnvironmentRework = capabilityName(taskPackage) === "acceptance-synthesis" && Array.isArray(environmentUncertain) && environmentUncertain.length > 0;
    if (!acceptanceEnvironmentRework) {
      throw new Error("review_result_v1 fail requires at least one finding");
    }
  }
  const notReviewed = Array.isArray(result.scope?.not_reviewed) ? result.scope.not_reviewed : [];
  if (result.gate === "needs_owner" && !result.evidence_gaps.length && !notReviewed.length) {
    throw new Error("review_result_v1 needs_owner requires evidence_gaps or scope.not_reviewed");
  }
}
function validateReviewResultPayload(result, taskPackage = null) {
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
  if (result.scope.actual_reads !== void 0 && (!Array.isArray(result.scope.actual_reads) || result.scope.actual_reads.some((item) => typeof item !== "string" || !item.trim()))) {
    throw new Error("review_result_v1 scope.actual_reads must be a string array when present");
  }
  if (result.output !== void 0 && (typeof result.output !== "object" || Array.isArray(result.output) || result.output === null)) {
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
function requiredMaterialDeclaration(taskPackage, root) {
  const agent = object(taskPackage.agent);
  const capability = object(agent.capability);
  const required = agent.required_files;
  if (!String(agent.role || "").trim() || !String(agent.runtime_role || "").trim() || !String(capability.name || "").trim() || !String(capability.file || "").trim() || !Array.isArray(required) || !required.length || required.some((entry) => typeof entry !== "string" || !entry.trim())) return null;
  const runtime = object(taskPackage.runtime_context);
  const binding = object(object(taskPackage.extensions).model_config);
  const materialRoot = String(binding.global_root || runtime.output_root || "").trim() || root;
  const keys = required.map((entry) => pathKey(entry, materialRoot));
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) return null;
  return { required, materialRoot, keys };
}
function contractTargetFiles(taskPackage) {
  const contract = activeCapabilityContract(taskPackage);
  const values = Array.isArray(contract.target_files) ? contract.target_files : Array.isArray(contract.affected_files) ? contract.affected_files : [];
  return values.map(String);
}
function loadReviewEvidence(taskPackage, root) {
  const extensions = object(taskPackage.extensions);
  const reference = object(extensions.review_evidence);
  const rawPath = String(reference.path || "").trim();
  if (!rawPath) throw new Error("review evidence path is missing");
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
  if (evidence?.profile !== SEMANTIC_REVIEW_PROFILE || evidence?.complete !== true || !["full", "index"].includes(materialMode) || evidence?.material_mode !== materialMode) return false;
  const sources = evidence.sources;
  return materialMode !== "full" || Array.isArray(sources) && sources.every((source) => typeof object(source).content === "string");
}
function samePathSet(left, right, root) {
  const leftKeys = left.map((entry) => pathKey(entry, root));
  const rightKeys = right.map((entry) => pathKey(entry, root));
  if (leftKeys.some((key) => !key) || rightKeys.some((key) => !key) || new Set(leftKeys).size !== leftKeys.length || new Set(rightKeys).size !== rightKeys.length) return false;
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
var ReviewPackageDefectError = class extends Error {
};
function validateReviewResultScope(taskPackage, result, root) {
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
    if (!Array.isArray(reportedReads) || !reportedReads.length && result.gate !== "needs_owner") {
      throw new Error("semantic review scope.actual_reads must record consumed scope.read inputs");
    }
    if (reportedReads.some((item) => !scopeAllows(taskPackage, item, root))) {
      throw new Error("semantic review scope.actual_reads must contain paths within scope.read");
    }
    actualReads = [...reportedReads];
  }
  return actualReads;
}
if (process.argv[1] && path.basename(process.argv[1]).toLowerCase() === "review_result_synthesis.mjs") {
  if (process.argv[2] !== "self-test") {
    console.error("usage: node ops/tools/review_result_synthesis.mjs self-test");
    process.exit(2);
  }
  const selfTestModule = "./review_result_synthesis.selftest.mjs";
  import(selfTestModule).then((module) => {
    module.selfTest();
    console.log("review_result_synthesis self-test: pass");
  }).catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}

// ops/tools/pi_review_result_extension.mjs
function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}
function pi_review_result_extension_default(pi) {
  const resultPath = String(process.env.PI_REVIEW_RESULT_PATH || "").trim();
  if (!resultPath) return;
  const taskPackagePath = String(process.env.PI_REVIEW_TASK_PACKAGE_PATH || "").trim();
  pi.registerTool({
    name: "submit_review_result",
    label: "Submit Review Result",
    // 与 submit_task_result 同理：不设 promptSnippet 就不进系统提示词的工具清单。
    promptSnippet: "Submit the structured review result; this is how the review is delivered",
    promptGuidelines: ["When the review is done, deliver it by calling submit_review_result; submit_review_result is a tool call, not a shell command."],
    description: [
      "\u63D0\u4EA4\u672C\u6B21\u7ED3\u6784\u5316\u5BA1\u67E5\u7684 review_result_v1 \u7ED3\u679C\uFF0C\u8FD9\u662F\u7ED3\u679C\u7684\u6B63\u5F0F\u63D0\u4EA4\u901A\u9053\uFF1A\u53C2\u6570\u5373 schema\uFF0C\u63D0\u4EA4\u65F6\u5F53\u573A\u6821\u9A8C\uFF1B",
      "\u6821\u9A8C\u5931\u8D25\u8FD4\u56DE\u5177\u4F53\u9519\u8BEF\uFF0C\u4FEE\u6B63\u540E\u518D\u63D0\u4EA4\u4E00\u6B21\u3002\u8FD4\u56DE ok:true \u5373\u4EA4\u4ED8\u5B8C\u6210\uFF1B\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E gate \u4E0E\u7ED3\u8BBA\uFF0C",
      "\u4E0D\u518D\u5185\u8054 JSON \u6216\u91CD\u5199\u62A5\u544A\u6B63\u6587\u3002\u91CD\u590D\u8C03\u7528\u4EE5\u6700\u540E\u4E00\u6B21\u6210\u529F\u63D0\u4EA4\u4E3A\u51C6\u3002"
    ].join(""),
    parameters: REVIEW_RESULT_V1_JSON_SCHEMA,
    execute: async (_toolCallId, params) => {
      const candidate = JSON.parse(JSON.stringify(params ?? {}));
      const taskPackage = taskPackagePath ? JSON.parse(readFileSync2(taskPackagePath, "utf8")) : null;
      let packageDefect = null;
      try {
        validateReviewResultPayload(candidate, taskPackage);
        if (taskPackage) validateReviewResultScope(taskPackage, candidate, process.env.SUBAGENT_PROJECT_ROOT || process.cwd());
      } catch (error) {
        if (error instanceof ReviewPackageDefectError) packageDefect = error.message;
        else return textResult({
          ok: false,
          error: String(error?.message ?? error),
          hint: "\u7ED3\u679C\u672A\u4FDD\u5B58\u3002\u4FEE\u6B63\u4E0A\u8FF0\u5B57\u6BB5\u540E\u518D\u63D0\u4EA4\u4E00\u6B21\u3002"
        });
      }
      mkdirSync2(path2.dirname(resultPath), { recursive: true });
      writeFileSync2(resultPath, `${JSON.stringify(candidate, null, 2)}
`, "utf8");
      return textResult({
        ok: true,
        saved: true,
        gate: candidate.gate,
        findings_count: candidate.findings.length,
        ...packageDefect ? { requires_parent_review: true, package_defect: packageDefect } : {},
        note: packageDefect ? "\u7ED3\u679C\u5DF2\u4FDD\u5B58\uFF1B\u4EFB\u52A1\u5305\u81EA\u8EAB\u6709\u7F3A\u9677\uFF08\u89C1 package_defect\uFF09\uFF0C\u4E0E\u7ED3\u679C\u5185\u5BB9\u65E0\u5173\uFF0C\u7236\u7EA7\u4F1A\u590D\u6838\uFF0C\u65E0\u9700\u518D\u63D0\u4EA4\u3002\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E gate\u3001\u7ED3\u8BBA\u548C\u8BE5\u7F3A\u9677\u3002" : "\u4EA4\u4ED8\u5B8C\u6210\u3002\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E gate \u4E0E\u7ED3\u8BBA\u5373\u53EF\uFF0C\u4E0D\u518D\u5185\u8054 JSON \u6216\u91CD\u5199\u62A5\u544A\u6B63\u6587\u3002"
      });
    }
  });
}
export {
  pi_review_result_extension_default as default
};
