#!/usr/bin/env node
/** review_result_synthesis 的机械自测实现，经 review_result_synthesis.mjs self-test 调用。 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ACCEPTANCE_SYNTHESIS_PROFILE,
  ASSISTED_REVIEW_PROFILE,
  REVIEW_PROFILE,
  REVIEW_RESULT_V1_JSON_SCHEMA,
  ReviewContractError,
  SCOPE_READ_COVERAGE_MARKER,
  SEMANTIC_REVIEW_PROFILE,
  TARGET_FILES_COVERAGE_MARKER,
  loadReviewEvidence,
  parseReviewResult,
  readAssistedReviewGate,
  reportText,
  structuredValidation,
  synthesizeReviewResult,
} from "./review_result_synthesis.mjs";

// 自测夹具把任务包写在任务文本的 json 块里；生产 runner 从任务包文件读取后传入。
function packageFromText(text) {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(String(text));
  const parsed = match ? JSON.parse(match[1]) : {};
  return parsed.task_package ?? parsed;
}
const synth = (args) => synthesizeReviewResult({ taskPackage: packageFromText(args.taskText), ...args });

/** Build the shared fixture tree and the ordered [name, fn] case list that runs against it. */
function selfTestPlan() {
  const root = path.join(process.cwd(), "tmp", `review-result-synthesis-self-test-${Date.now()}`);
  const reportPath = path.join(root, "report.md");
  const handoffPath = path.join(root, "handoff.md");
  const outDir = path.join(root, "runtime");
  mkdirSync(outDir, { recursive: true });
  const requiredPath = path.join(root, "required.md");
  const requiredContent = "# Required review contract\n\nContract body.\n";
  writeFileSync(requiredPath, requiredContent, "utf8");
  const targetPath = path.join(root, "target.py");
  const targetContent = "value = 1\n";
  writeFileSync(targetPath, targetContent, "utf8");
  const otherPath = path.join(root, "other.py");
  const otherContent = "value = 2\n";
  writeFileSync(otherPath, otherContent, "utf8");
  const crossRepoRoot = path.join(root, "cross-target");
  mkdirSync(crossRepoRoot, { recursive: true });
  const reviewContract = { target_files: ["target.py"] };
  const sourceEntry = (sourcePath, content) => ({
    path: sourcePath,
    content,
  });
  const writeEvidence = (filename, evidence) => {
    const evidencePath = path.join(root, filename);
    const evidenceContent = `${JSON.stringify(evidence)}\n`;
    writeFileSync(evidencePath, evidenceContent.replace(/\n/g, "\r\n"), "utf8");
    return { path: path.relative(root, evidencePath) };
  };
  const evidencePayload = {
    profile: SEMANTIC_REVIEW_PROFILE,
    complete: true,
    material_mode: "full",
    contract: reviewContract,
    sources: [sourceEntry("target.py", targetContent), sourceEntry("other.py", otherContent)],
  };
  const evidenceReference = writeEvidence("review-evidence.json", evidencePayload);
  const missingTargetEvidenceReference = writeEvidence("review-evidence-missing-target.json", {
    ...evidencePayload,
    sources: [sourceEntry("other.py", otherContent)],
  });
  const incompleteEvidenceReference = writeEvidence("review-evidence-incomplete.json", {
    ...evidencePayload,
    complete: false,
  });
  const structuredExtensions = {
    review_execution: { profile: SEMANTIC_REVIEW_PROFILE, material_mode: "full" },
    capability_contract: { rule_quality_inspection: reviewContract },
    review_evidence: evidenceReference,
  };
  const taskText = [
    "```json",
    JSON.stringify({
      task_package: {
        package_id: "review-result-self-test",
        agent: {
          role: "semantic-review-agent",
          runtime_role: "semantic-review-agent",
          capability: { name: "rule-quality-inspection", file: requiredPath },
          required_files: [requiredPath],
        },
        scope: { read: ["target.py", "other.py"], write: [] },
        runtime_context: { output_root: root },
        expected_output: { file_path: reportPath, resolved_file_path: reportPath, business_gate: "verdict" },
        handoff_contract: { handoff_file: handoffPath, resolved_handoff_file: handoffPath },
        extensions: structuredExtensions,
      },
    }, null, 2),
    "```",
    `<!-- subagent-required-material:start ${JSON.stringify({ path: requiredPath })} -->`,
    requiredContent,
    "<!-- subagent-required-material:end -->",
  ].join("\n").replace(/\n/g, "\r\n");
  const finalText = [
    "## 结论",
    "mechanical synthesis works",
    "",
    "## 事实与证据",
    "```json",
    JSON.stringify({
      schema_version: 1,
      gate: "pass",
      summary: "mechanical synthesis works",
      findings: [],
      evidence_gaps: [],
      scope: { reviewed: ["target.py"], not_reviewed: [], actual_reads: ["target.py", "other.py"] },
      output: { issue_count: 0 },
    }),
    "```",
    "",
    "## 已检查内容",
    "mechanical evidence",
    "",
    "## 失败检查",
    "无",
    "",
    "## 不确定项",
    "无",
    "",
    "## 边界",
    "未调用工具",
  ].join("\n");
  const markerFinalText = finalText
    .replace('"reviewed":["target.py"]', '"reviewed":["$target_files"]')
    .replace('"actual_reads":["target.py","other.py"]', '"actual_reads":["$scope_read"]');
  const parseGeneric = () => parseReviewResult(finalText);

  const contractPackage = {
    agent: { capability: { name: "contract-drift-inspection" } },
  };
  const contractResult = (output, gate = "pass") => [
    "## 事实与证据",
    "```json review_result_v1",
    JSON.stringify({
      schema_version: 1,
      gate,
      summary: "contract coverage",
      findings: gate === "fail" ? [{
        title: "unchecked identifier",
        location: "contract.md:1",
        criteria: "complete coverage",
        issue: "one identifier was not checked",
        impact: "the review conclusion is incomplete",
        repair: "check every enumerated identifier",
        evidence_refs: ["contract.md:1"],
      }] : [],
      evidence_gaps: [],
      scope: { reviewed: ["a.md"], not_reviewed: [] },
      output,
    }),
    "```",
  ].join("\n");

  const acceptancePackage = {
    agent: { capability: { name: "acceptance-synthesis" } },
    extensions: {
      capability_contract: {
        acceptance_synthesis: {
          acceptance_ids: ["AC-01", "AC-02"],
          mechanical_schema: {
            source: "ops/tools/acceptance_contract_check.py",
            disposition_values: ["needs_owner", "pass", "rework"],
            max_review_rounds: 2,
          },
        },
      },
    },
  };
  const acceptanceFinding = {
    title: "AC-01 fails",
    location: "target.py:1",
    criteria: "AC-01 oracle",
    issue: "observed result differs",
    impact: "AS-01 is not satisfied",
    repair: "repair the mapped lane",
    evidence_refs: ["target.py:1"],
    acceptance_refs: ["AC-01"],
    requirement_refs: ["AS-01"],
  };
  const acceptanceResult = (output, overrides = {}) => [
    "## 事实与证据",
    "```json review_result_v1",
    JSON.stringify({
      schema_version: 1,
      gate: "fail",
      summary: "targeted rework",
      findings: [acceptanceFinding],
      evidence_gaps: [],
      scope: { reviewed: ["target.py"], not_reviewed: [] },
      output,
      ...overrides,
    }),
    "```",
  ].join("\n");
  const validAcceptanceOutput = {
    disposition: "rework",
    acceptance_ids_considered: ["AC-01", "AC-02"],
    failed_acceptance_ids: ["AC-01"],
    confirmation_acceptance_ids: ["AC-01"],
    regression_acceptance_ids: ["AC-02"],
    coverage: { passed: ["AC-02"], failed: ["AC-01"], uncertain: [], missing: [] },
    uncertainty: { environment: [], evidence: [] },
  };
  const acceptanceContractPath = path.join(root, "acceptance-contract.yaml");
  const dependencyIndexPath = path.join(root, "dependency-index.json");
  writeFileSync(acceptanceContractPath, "acceptance_ids:\n  - AC-01\n  - AC-02\n", "utf8");
  writeFileSync(dependencyIndexPath, '{"nodes":[]}\n', "utf8");
  const acceptanceStructuredPackage = {
    ...acceptancePackage,
    package_id: "acceptance-synthesis-self-test",
    agent: {
      role: "verify-agent",
      runtime_role: "verify-agent",
      capability: { name: "acceptance-synthesis", file: requiredPath },
      required_files: [requiredPath],
    },
    scope: { read: ["acceptance-contract.yaml", "dependency-index.json"], write: [] },
    runtime_context: { output_root: root },
    expected_output: { file_path: reportPath, resolved_file_path: reportPath, business_gate: "acceptance_gate" },
    handoff_contract: { handoff_file: handoffPath, resolved_handoff_file: handoffPath },
    extensions: {
      ...acceptancePackage.extensions,
      review_execution: { profile: ACCEPTANCE_SYNTHESIS_PROFILE },
    },
  };
  const acceptanceTaskText = [
    "```json",
    JSON.stringify({ task_package: acceptanceStructuredPackage }, null, 2),
    "```",
    `<!-- subagent-required-material:start ${JSON.stringify({ path: requiredPath })} -->`,
    requiredContent,
    "<!-- subagent-required-material:end -->",
  ].join("\n");
  const parseAcceptance = () => parseReviewResult(acceptanceResult(validAcceptanceOutput), acceptancePackage);
  const parseExactAcceptance = () => parseReviewResult(acceptanceResult(validAcceptanceOutput, {
    scope: { reviewed: ["acceptance-contract.yaml", "dependency-index.json"], not_reviewed: [] },
  }), acceptanceStructuredPackage);

  const validFinding = {
    title: "contract mismatch",
    location: "target.py:1",
    criteria: "closed-set",
    issue: "declared and consumed values differ",
    impact: "runtime may accept an invalid value",
    repair: "align the consumer with the declaration",
    evidence_refs: ["target.py:1", "consumer.py:2"],
  };
  const genericResultText = (overrides) => [
    "## 事实与证据",
    "```json review_result_v1",
    JSON.stringify({
      schema_version: 1,
      gate: "pass",
      summary: "generic review",
      findings: [],
      evidence_gaps: [],
      scope: { reviewed: ["target.py"], not_reviewed: [] },
      output: {},
      ...overrides,
    }),
    "```",
  ].join("\n");

  const cases = [];

  cases.push(["stale-output-cleared-on-invalid-result", () => {
    writeFileSync(reportPath, "stale report", "utf8");
    writeFileSync(handoffPath, "stale handoff", "utf8");
    // 软化语义：结构化结果无效不再抛异常（外层曾误标 transport_failed），
    // 改产 salvage 报告；stale 内容仍必须被覆盖，成果保留给 owner 收割。
    const outcome = synth({
      taskText,
      finalText: "## 事实与证据\n无结构化结果",
      outDir,
      fallbackRoot: root,
      runnerObservations: { turn_completed: true, evidence_tool_guard_passed: true },
    });
    const report = readFileSync(reportPath, "utf8");
    const handoff = readFileSync(handoffPath, "utf8");
    if (
      !outcome.applied || outcome.result_source !== "salvage" || outcome.gate !== "needs_owner" ||
      !String(outcome.parse_error || "").includes("JSON block missing") ||
      report.includes("stale report") || handoff.includes("stale handoff") ||
      !report.includes("child-final.md") || !handoff.includes("    verdict: needs_owner") ||
      !handoff.includes("    mechanical_check: fail")
    ) {
      throw new Error("review result synthesis stale-output regression failed");
    }
  }]);

  cases.push(["semantic-review-read-authorization-is-not-consumption-obligation", () => {
    const outcome = structuredValidation({
      taskPackage: {
        agent: { role: "semantic-review-agent", runtime_role: "semantic-review-agent", capability: { name: "rule-quality-inspection", file: requiredPath }, required_files: [requiredPath] },
        scope: { read: ["target.py", "other.py"], write: [] },
        extensions: structuredExtensions,
      },
      taskText, fallbackRoot: root, reportPath, handoffPath,
      runnerObservations: { turn_completed: true, evidence_tool_guard_passed: true },
      result: { ...parseGeneric(), scope: { reviewed: ["target.py"], not_reviewed: [], actual_reads: ["target.py"] } },
    });
    if (outcome.actual_reads.length !== 1 || outcome.actual_reads[0] !== "target.py") throw new Error("authorized unread auxiliary input blocked completed target review");
  }]);

  cases.push(["submit-tool-file-takes-priority-over-final-text", () => {
    const submittedPath = path.join(outDir, "review-result.json");
    writeFileSync(submittedPath, JSON.stringify({
      schema_version: 1,
      gate: "pass",
      summary: "submitted via tool",
      findings: [],
      evidence_gaps: [],
      scope: { reviewed: ["target.py"], not_reviewed: [], actual_reads: ["target.py", "other.py"] },
      output: { issue_count: 0 },
    }), "utf8");
    try {
      const outcome = synth({
        taskText,
        finalText: "## 事实与证据\n最终回复没有 JSON,结果已经通过 submit_review_result 提交",
        outDir,
        fallbackRoot: root,
        reviewResultPath: submittedPath,
        runnerObservations: { turn_completed: true, evidence_tool_guard_passed: true },
      });
      const report = readFileSync(reportPath, "utf8");
      if (
        !outcome.applied || outcome.result_source !== "submit_tool" ||
        outcome.review_result_path !== submittedPath || outcome.gate !== "pass" ||
        !report.includes("submitted via tool")
      ) {
        throw new Error("submit-tool priority assertion failed");
      }
    } finally {
      rmSync(submittedPath, { force: true });
    }
  }]);

  cases.push(["end-validation-failure-keeps-originals", () => {
    const submittedPath = path.join(outDir, "review-result.json");
    writeFileSync(submittedPath, JSON.stringify({
      schema_version: 1,
      gate: "pass",
      summary: "submitted via tool",
      findings: [],
      evidence_gaps: [],
      scope: { reviewed: ["target.py"], not_reviewed: [], actual_reads: ["target.py"] },
      output: {},
    }), "utf8");
    writeFileSync(reportPath, "ORIGINAL REPORT", "utf8");
    writeFileSync(handoffPath, "ORIGINAL HANDOFF", "utf8");
    try {
      let thrown = null;
      try {
        // 声明齐全但任务正文没带必读材料：只有收尾才能判定，失败归审查合同。
        synthesizeReviewResult({
          taskPackage: packageFromText(taskText),
          taskText: "task text without required material",
          finalText,
          outDir,
          fallbackRoot: root,
          reviewResultPath: submittedPath,
          runnerObservations: { turn_completed: true, evidence_tool_guard_passed: true },
        });
      } catch (error) {
        thrown = error;
      }
      if (
        !(thrown instanceof ReviewContractError) || !thrown.message.includes("required files were not present") ||
        readFileSync(reportPath, "utf8") !== "ORIGINAL REPORT" || readFileSync(handoffPath, "utf8") !== "ORIGINAL HANDOFF"
      ) {
        throw new Error(`end validation failure must throw ReviewContractError and keep originals: ${thrown?.message}`);
      }
    } finally {
      rmSync(submittedPath, { force: true });
    }
  }]);

  cases.push(["submit-tool-file-invalid-falls-to-salvage", () => {
    const submittedPath = path.join(outDir, "review-result.json");
    writeFileSync(submittedPath, JSON.stringify({ schema_version: 1, gate: "bogus" }), "utf8");
    try {
      const outcome = synth({
        taskText,
        finalText,
        outDir,
        fallbackRoot: root,
        reviewResultPath: submittedPath,
        runnerObservations: { turn_completed: true, evidence_tool_guard_passed: true },
      });
      // 工具已提交但内容坏:不退 final_response(避免两个真源打架),直接 salvage 交 owner。
      if (
        !outcome.applied || outcome.result_source !== "salvage" || outcome.gate !== "needs_owner" ||
        !String(outcome.parse_error || "").includes("gate must be")
      ) {
        throw new Error("submit-tool invalid salvage assertion failed");
      }
    } finally {
      rmSync(submittedPath, { force: true });
    }
  }]);

  cases.push(["coverage-marker-synthesis", () => {
    if (markerFinalText === finalText) throw new Error("coverage marker self-test fixture was not rewritten");
    const outcome = synth({
      taskText,
      finalText: markerFinalText,
      outDir,
      fallbackRoot: root,
      runnerObservations: { turn_completed: true, evidence_tool_guard_passed: true },
    });
    const report = readFileSync(reportPath, "utf8");
    const handoff = readFileSync(handoffPath, "utf8");
    if (
      !outcome.applied || !report.includes("## Evidence Gaps") || !handoff.includes("    verdict: pass") ||
      !handoff.includes("    required_files_loaded: true") || !handoff.includes("    scope_compliant: true") ||
      report.includes(TARGET_FILES_COVERAGE_MARKER) || handoff.includes(TARGET_FILES_COVERAGE_MARKER) ||
      report.includes(SCOPE_READ_COVERAGE_MARKER) || handoff.includes(SCOPE_READ_COVERAGE_MARKER) ||
      !report.includes('"target.py"') || !handoff.includes('"target.py"') || !handoff.includes('"other.py"')
    ) {
      throw new Error("review result synthesis self-test assertion failed");
    }
    if (!existsSync(path.join(outDir, "report.md")) || !existsSync(path.join(outDir, "handoff.md"))) {
      throw new Error("review result synthesis runtime artifacts missing");
    }
  }]);

  cases.push(["code-verification-affected-files-coverage", () => {
    const codeVerificationPackage = {
      package_id: "code-verification-coverage-self-test",
      agent: {
        role: "verify-agent",
        runtime_role: "verify-agent",
        capability: { name: "code-verification", file: requiredPath },
        required_files: [requiredPath],
      },
      scope: { read: ["target.py"], write: [] },
      runtime_context: { output_root: root },
      expected_output: { file_path: reportPath, resolved_file_path: reportPath, business_gate: "verdict" },
      handoff_contract: { handoff_file: handoffPath, resolved_handoff_file: handoffPath },
      extensions: {
        review_execution: { profile: REVIEW_PROFILE, contract_slot: "verify" },
        capability_contract: { verify: { affected_files: ["target.py"] } },
      },
    };
    const codeTaskText = [
      "```json",
      JSON.stringify({ task_package: codeVerificationPackage }, null, 2),
      "```",
      `<!-- subagent-required-material:start ${JSON.stringify({ path: requiredPath })} -->`,
      requiredContent,
      "<!-- subagent-required-material:end -->",
    ].join("\n");
    const codeOutcome = synth({
      taskText: codeTaskText,
      finalText: markerFinalText,
      outDir,
      fallbackRoot: root,
      runnerObservations: { turn_completed: true, evidence_tool_guard_passed: true },
    });
    if (!codeOutcome.applied || readFileSync(handoffPath, "utf8").includes(TARGET_FILES_COVERAGE_MARKER)) {
      throw new Error("code-verification affected_files coverage was not synthesized");
    }
  }]);

  cases.push(["cross-repo-evidence-resolves-output-root", () => {
    // 跨仓审查:证据包落在 producer 仓，fallbackRoot 是目标仓。必须靠 runtime_context.output_root
    // 定位，否则 evidence 静默变 null，错误被报成与真因无关的 target_files 不匹配。
    if (!loadReviewEvidence(
      { extensions: { review_evidence: evidenceReference }, runtime_context: { output_root: root } },
      crossRepoRoot,
    )) {
      throw new Error("cross-repo review evidence must resolve against runtime_context.output_root");
    }
  }]);

  cases.push(["evidence-outside-resolved-root-rejected-with-file-error", () => {
    // 缺 output_root 时相对引用按给定 root 解析；该处没有证据文件，必须明确报告，不能吞成 null。
    let rejected = false;
    try {
      loadReviewEvidence({ extensions: { review_evidence: evidenceReference } }, crossRepoRoot);
    } catch (error) {
      rejected = String(error?.message || error).includes("review evidence file is missing");
    }
    if (!rejected) throw new Error("review evidence outside the producer root did not report a file error");
  }]);

  cases.push(["missing-evidence-file-reports-the-real-error", () => {
    let rejected = false;
    try {
      loadReviewEvidence(
        { extensions: { review_evidence: { path: "missing-evidence.json" } }, runtime_context: { output_root: root } },
        root,
      );
    } catch (error) {
      rejected = String(error?.message || error).includes("review evidence file is missing");
    }
    if (!rejected) throw new Error("missing review evidence was not reported explicitly");
  }]);

  cases.push(["invalid-evidence-json-reports-the-real-error", () => {
    const invalidPath = path.join(root, "invalid-evidence.json");
    writeFileSync(invalidPath, "{not-json}\n", "utf8");
    let rejected = false;
    try {
      loadReviewEvidence(
        { extensions: { review_evidence: { path: path.basename(invalidPath) } }, runtime_context: { output_root: root } },
        root,
      );
    } catch (error) {
      rejected = String(error?.message || error).includes("review evidence JSON is invalid");
    }
    if (!rejected) throw new Error("invalid review evidence JSON was not reported explicitly");
  }]);

  const contractDriftRejections = [
    { output: {}, expected: "identifiers_enumerated" },
    {
      output: { identifiers_enumerated: [], identifiers_checked: [] },
      expected: "at least one enumerated identifier",
    },
    {
      output: { identifiers_enumerated: ["field:a", "field:b"], identifiers_checked: ["field:a"] },
      expected: "left identifiers unchecked",
    },
    {
      output: { identifiers_enumerated: ["field:a"], identifiers_checked: ["field:b"] },
      expected: "were not enumerated",
    },
  ];
  contractDriftRejections.forEach(({ output, expected }, index) => {
    cases.push([`contract-drift-reject[${index + 1}] ${expected}`, () => {
      let rejected = false;
      try {
        parseReviewResult(contractResult(output), contractPackage);
      } catch (error) {
        rejected = String(error?.message || error).includes(expected);
      }
      if (!rejected) throw new Error(`contract-drift result validation missed: ${expected}`);
    }]);
  });

  cases.push(["contract-drift-complete-coverage-accepted", () => {
    parseReviewResult(
      contractResult({ identifiers_enumerated: ["field:a", "field:b"], identifiers_checked: ["field:b", "field:a"] }),
      contractPackage,
    );
  }]);

  cases.push(["contract-drift-fail-gate-requires-complete-coverage", () => {
    let failCoverageRejected = false;
    try {
      parseReviewResult(
        contractResult({ identifiers_enumerated: ["field:a", "field:b"], identifiers_checked: ["field:a"] }, "fail"),
        contractPackage,
      );
    } catch (error) {
      failCoverageRejected = String(error?.message || error).includes("left identifiers unchecked");
    }
    if (!failCoverageRejected) throw new Error("contract-drift fail gate bypassed complete identifier coverage");
  }]);

  cases.push(["acceptance-synthesis-valid-output-accepted", () => {
    parseAcceptance();
  }]);

  cases.push(["acceptance-synthesis-coverage-marker-rejected", () => {
    let acceptanceMarkerRejected = false;
    try {
      parseReviewResult(acceptanceResult(validAcceptanceOutput, {
        scope: { reviewed: [TARGET_FILES_COVERAGE_MARKER], not_reviewed: [] },
      }), acceptanceStructuredPackage);
    } catch (error) {
      acceptanceMarkerRejected = String(error?.message || error).includes("requires a non-empty capability coverage file set");
    }
    if (!acceptanceMarkerRejected) throw new Error("acceptance-synthesis accepted the target_files coverage marker");
  }]);

  cases.push(["acceptance-synthesis-exact-scope-read-accepted", () => {
    structuredValidation({
      taskPackage: acceptanceStructuredPackage,
      taskText: acceptanceTaskText,
      result: parseExactAcceptance(),
      fallbackRoot: root,
      reportPath,
      handoffPath,
      runnerObservations: { turn_completed: true },
    });
  }]);

  cases.push(["acceptance-synthesis-incomplete-scope-read-rejected", () => {
    const exactAcceptanceResult = parseExactAcceptance();
    let incompleteAcceptanceCoverageRejected = false;
    try {
      structuredValidation({
        taskPackage: acceptanceStructuredPackage,
        taskText: acceptanceTaskText,
        result: { ...exactAcceptanceResult, scope: { reviewed: ["acceptance-contract.yaml"], not_reviewed: [] } },
        fallbackRoot: root,
        reportPath,
        handoffPath,
        runnerObservations: { turn_completed: true },
      });
    } catch (error) {
      incompleteAcceptanceCoverageRejected = String(error?.message || error).includes("exactly partition scope.read");
    }
    if (!incompleteAcceptanceCoverageRejected) {
      throw new Error("acceptance-synthesis accepted incomplete scope.read coverage");
    }
  }]);

  cases.push(["acceptance-synthesis-environment-uncertain-accepted", () => {
    const environmentUncertainOutput = {
      ...validAcceptanceOutput,
      failed_acceptance_ids: [],
      confirmation_acceptance_ids: ["AC-01"],
      regression_acceptance_ids: [],
      coverage: { passed: ["AC-02"], failed: [], uncertain: ["AC-01"], missing: [] },
      uncertainty: { environment: ["AC-01"], evidence: [] },
    };
    parseReviewResult(acceptanceResult(environmentUncertainOutput, { findings: [] }), acceptancePackage);
  }]);

  cases.push(["acceptance-synthesis-durable-report-keeps-machine-decision", () => {
    const durableAcceptanceReport = reportText(parseAcceptance(), acceptancePackage);
    if (!durableAcceptanceReport.includes("```json review_result") || !durableAcceptanceReport.includes('"disposition": "rework"')) {
      throw new Error("acceptance-synthesis durable report lost machine decision");
    }
  }]);

  const acceptanceRejections = [
    {
      output: { ...validAcceptanceOutput, acceptance_ids_considered: ["AC-01"] },
      expected: "must equal task acceptance_ids",
    },
    {
      output: { ...validAcceptanceOutput, confirmation_acceptance_ids: [] },
      expected: "must include every failed and environment-uncertain id",
    },
    {
      output: { ...validAcceptanceOutput, coverage: { passed: [], failed: ["AC-01"], uncertain: [], missing: [] } },
      expected: "partition all task acceptance_ids",
    },
    {
      output: {
        ...validAcceptanceOutput,
        coverage: { passed: ["AC-02"], failed: [], uncertain: ["AC-01"], missing: [] },
        uncertainty: { environment: [], evidence: ["AC-01"] },
      },
      expected: "cannot contain evidence uncertainty",
    },
    {
      output: {
        ...validAcceptanceOutput,
        regression_acceptance_ids: [],
        coverage: { passed: [], failed: ["AC-01"], uncertain: [], missing: ["AC-02"] },
      },
      expected: "cannot contain evidence uncertainty or missing ids",
    },
    {
      output: {
        ...validAcceptanceOutput,
        disposition: "pass",
        failed_acceptance_ids: [],
        confirmation_acceptance_ids: ["AC-01"],
        regression_acceptance_ids: ["AC-02"],
        coverage: { passed: ["AC-01", "AC-02"], failed: [], uncertain: [], missing: [] },
      },
      expected: "pass gate is inconsistent",
      overrides: { gate: "pass", findings: [] },
    },
  ];
  acceptanceRejections.forEach(({ output, expected, overrides = {} }, index) => {
    cases.push([`acceptance-synthesis-reject[${index + 1}] ${expected}`, () => {
      let rejected = false;
      try {
        parseReviewResult(acceptanceResult(output, overrides), acceptancePackage);
      } catch (error) {
        rejected = String(error?.message || error).includes(expected);
      }
      if (!rejected) throw new Error(`acceptance-synthesis result validation missed: ${expected}`);
    }]);
  });

  const genericSemanticRejections = [
    { overrides: { gate: "pass", findings: [validFinding] }, expected: "pass requires empty findings" },
    { overrides: { gate: "pass", evidence_gaps: ["missing evidence"] }, expected: "pass requires empty findings and evidence_gaps" },
    { overrides: { gate: "fail", findings: [] }, expected: "fail requires at least one finding" },
    { overrides: { gate: "needs_owner" }, expected: "needs_owner requires evidence_gaps or scope.not_reviewed" },
    { overrides: { gate: "fail", findings: [{ ...validFinding, impact: "" }] }, expected: "findings[0].impact is required" },
  ];
  genericSemanticRejections.forEach(({ overrides, expected }, index) => {
    cases.push([`review-result-semantics-reject[${index + 1}] ${expected}`, () => {
      let rejected = false;
      try {
        parseReviewResult(genericResultText(overrides));
      } catch (error) {
        rejected = String(error?.message || error).includes(expected);
      }
      if (!rejected) throw new Error(`review_result semantic validation missed: ${expected}`);
    }]);
  });

  cases.push(["review-result-semantics-accepted", () => {
    parseReviewResult(genericResultText({ gate: "fail", findings: [validFinding] }));
    parseReviewResult(genericResultText({
      gate: "fail",
      findings: [{ ...validFinding, location: ["target.py:1", "consumer.py:2"] }],
    }));
    parseReviewResult(genericResultText({ gate: "needs_owner", evidence_gaps: ["missing evidence"] }));
  }]);

  const structuredValidationRejections = [
    {
      expected: "required files were not present",
      build: () => ({
        taskPackage: {
          scope: { read: ["target.py"] },
          extensions: { review_execution: { profile: SEMANTIC_REVIEW_PROFILE } },
        },
        result: parseGeneric(),
      }),
    },
    {
      expected: "required files were not present",
      build: () => ({
        taskPackage: {
          agent: {
            role: "semantic-review-agent",
            runtime_role: "semantic-review-agent",
            capability: { name: "rule-quality-inspection", file: requiredPath },
            required_files: [requiredPath],
          },
          scope: { read: ["target.py"] },
          extensions: structuredExtensions,
        },
        taskText: taskText.replace("Contract body.\r\n", "Contract body. \r\n"),
        result: parseGeneric(),
      }),
    },
    {
      expected: "required files were not present",
      build: () => ({
        taskPackage: {
          agent: {
            role: "semantic-review-agent",
            runtime_role: "semantic-review-agent",
            capability: { name: "rule-quality-inspection", file: requiredPath },
            required_files: [requiredPath],
          },
          scope: { read: ["target.py"] },
          extensions: structuredExtensions,
        },
        taskText: `mechanical evidence copy only\n${requiredContent}`,
        result: parseGeneric(),
      }),
    },
    {
      expected: "target_files must be non-empty",
      build: () => ({
        taskPackage: {
          agent: {
            role: "semantic-review-agent",
            runtime_role: "semantic-review-agent",
            capability: { name: "rule-quality-inspection", file: requiredPath },
            required_files: [requiredPath],
          },
          scope: { read: ["target.py"] },
          extensions: {
            ...structuredExtensions,
            capability_contract: { rule_quality_inspection: { target_files: [] } },
          },
        },
        result: parseGeneric(),
      }),
    },
    {
      expected: "capability contract and evidence target_files must match",
      build: () => ({
        taskPackage: {
          agent: {
            role: "semantic-review-agent",
            runtime_role: "semantic-review-agent",
            capability: { name: "rule-quality-inspection", file: requiredPath },
            required_files: [requiredPath],
          },
          scope: { read: ["target.py", "other.py"] },
          extensions: {
            ...structuredExtensions,
            capability_contract: { rule_quality_inspection: { target_files: ["other.py"] } },
          },
        },
        result: parseGeneric(),
      }),
    },
    {
      expected: "evidence metadata does not match",
      build: () => ({
        taskPackage: {
          agent: {
            role: "semantic-review-agent",
            runtime_role: "semantic-review-agent",
            capability: { name: "rule-quality-inspection", file: requiredPath },
            required_files: [requiredPath],
          },
          scope: { read: ["target.py", "other.py"] },
          extensions: { ...structuredExtensions, review_evidence: incompleteEvidenceReference },
        },
        result: parseGeneric(),
      }),
    },
    {
      expected: "target_files are missing from evidence sources",
      build: () => ({
        taskPackage: {
          agent: {
            role: "semantic-review-agent",
            runtime_role: "semantic-review-agent",
            capability: { name: "rule-quality-inspection", file: requiredPath },
            required_files: [requiredPath],
          },
          scope: { read: ["target.py", "other.py"] },
          extensions: { ...structuredExtensions, review_evidence: missingTargetEvidenceReference },
        },
        result: parseGeneric(),
      }),
    },
    {
      expected: "scope.actual_reads must record consumed scope.read inputs",
      build: () => ({
        taskPackage: {
          agent: {
            role: "semantic-review-agent",
            runtime_role: "semantic-review-agent",
            capability: { name: "rule-quality-inspection", file: requiredPath },
            required_files: [requiredPath],
          },
          scope: { read: ["target.py", "other.py"], write: [] },
          extensions: structuredExtensions,
        },
        result: { ...parseGeneric(), scope: { reviewed: ["target.py"], not_reviewed: [] } },
      }),
    },
    {
      expected: "scope.reviewed files are missing from evidence sources",
      build: () => ({
        taskPackage: {
          agent: {
            role: "semantic-review-agent",
            runtime_role: "semantic-review-agent",
            capability: { name: "rule-quality-inspection", file: requiredPath },
            required_files: [requiredPath],
          },
          scope: { read: ["target.py", "other.py", "unindexed.py"] },
          extensions: structuredExtensions,
        },
        result: { ...parseGeneric(), scope: { reviewed: ["unindexed.py"], not_reviewed: [], actual_reads: ["target.py", "other.py", "unindexed.py"] } },
      }),
    },
    {
      expected: "required files were not present",
      build: () => ({
        taskPackage: {
          agent: {
            role: "semantic-review-agent",
            runtime_role: "semantic-review-agent",
            capability: { name: "rule-quality-inspection", file: requiredPath },
            required_files: [],
          },
          scope: { read: ["target.py"] },
          extensions: { review_execution: { profile: SEMANTIC_REVIEW_PROFILE } },
        },
        result: parseGeneric(),
      }),
    },
    {
      expected: "required files were not present",
      build: () => ({
        taskPackage: {
          agent: {
            role: "semantic-review-agent",
            runtime_role: "semantic-review-agent",
            capability: { name: "rule-quality-inspection", file: requiredPath },
            required_files: ["missing-required.md"],
          },
          scope: { read: ["target.py"] },
          extensions: { review_execution: { profile: SEMANTIC_REVIEW_PROFILE } },
        },
        result: parseGeneric(),
      }),
    },
    {
      expected: "exact paths within scope.read",
      build: () => ({
        taskPackage: {
          agent: {
            role: "semantic-review-agent",
            runtime_role: "semantic-review-agent",
            capability: { name: "rule-quality-inspection", file: requiredPath },
            required_files: [requiredPath],
          },
          scope: { read: ["target.py"] },
          extensions: structuredExtensions,
        },
        result: { ...parseGeneric(), scope: { reviewed: ["outside.py"], not_reviewed: [] } },
      }),
    },
  ];
  structuredValidationRejections.forEach(({ expected, build }, index) => {
    cases.push([`structured-validation-reject[${index + 1}] ${expected}`, () => {
      const validationInput = build();
      let rejected = false;
      try {
        structuredValidation({
          ...validationInput,
          taskText: validationInput.taskText ?? taskText,
          fallbackRoot: root,
          reportPath,
          handoffPath,
          runnerObservations: { turn_completed: true, evidence_tool_guard_passed: true },
        });
      } catch (error) {
        rejected = String(error?.message || error).includes(expected);
      }
      if (!rejected) throw new Error(`structured review validation missed: ${expected}`);
    }]);
  });

  cases.push(["assisted-review-business-gate", () => {
    const assistedHandoffPath = path.join(root, "assisted-handoff.md");
    const assistedTaskText = [
      "```json",
      JSON.stringify({
        task_package: {
          package_id: "assisted-review-self-test",
          runtime_context: { output_root: root },
          expected_output: { business_gate: "contract_drift_gate" },
          handoff_contract: { handoff_file: assistedHandoffPath, resolved_handoff_file: assistedHandoffPath },
          extensions: { review_execution: { profile: ASSISTED_REVIEW_PROFILE } },
        },
      }),
      "```",
    ].join("\n");
    writeFileSync(
      assistedHandoffPath,
      "FINAL_HANDOFF:\n  verdict: done\n  output:\n    target_repo: null\n    file_path: notes/verify/self-test.md\n    contract_drift_gate: fail\n  validation:\n    mechanical_check: pass\n",
      "utf8",
    );
    const assisted = readAssistedReviewGate({ taskPackage: packageFromText(assistedTaskText), fallbackRoot: root });
    if (!assisted.applied || assisted.gate !== "fail") {
      throw new Error("assisted review business gate extraction failed");
    }
    // 已是 assisted 任务但门值非法或 handoff 缺失：applied:true + needs_owner，并记录缺口。
    writeFileSync(assistedHandoffPath, "FINAL_HANDOFF:\n  verdict: done\n  output:\n    contract_drift_gate: maybe\n", "utf8");
    const invalidGate = readAssistedReviewGate({ taskPackage: packageFromText(assistedTaskText), fallbackRoot: root });
    if (!invalidGate.applied || invalidGate.gate !== "needs_owner" || !invalidGate.gate_error.includes("contract_drift_gate")) {
      throw new Error(`assisted review invalid gate should close as needs_owner: ${JSON.stringify(invalidGate)}`);
    }
    rmSync(assistedHandoffPath, { force: true });
    const missingHandoff = readAssistedReviewGate({ taskPackage: packageFromText(assistedTaskText), fallbackRoot: root });
    if (!missingHandoff.applied || missingHandoff.gate !== "needs_owner" || !missingHandoff.gate_error.includes("handoff not found")) {
      throw new Error(`assisted review missing handoff should close as needs_owner: ${JSON.stringify(missingHandoff)}`);
    }
    if (readAssistedReviewGate({ taskPackage: { package_id: "plain" }, fallbackRoot: root }).applied !== false) {
      throw new Error("non-assisted task must stay applied:false");
    }
  }]);

  return { root, cases };
}

export function selfTest() {
  const { root, cases } = selfTestPlan();
  const failures = [];
  const runCase = (name, fn) => {
    try {
      fn();
    } catch (error) {
      failures.push(`${name}: ${String(error?.message || error)}`);
    }
  };
  try {
    for (const [name, fn] of cases) runCase(name, fn);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (failures.length) {
    throw new Error([
      `review_result_synthesis self-test: ${failures.length} of ${cases.length} cases failed`,
      ...failures.map((item) => `- ${item}`),
    ].join("\n"));
  }
}
