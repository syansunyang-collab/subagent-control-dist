#!/usr/bin/env node
// subagent_preload --self-test 的机械用例集（ops/tools/subagent_preload_selftest.py 的移植），
// 经 node ops/tools/subagent_preload.mjs --self-test 调用。checks 键名与真假语义与 Python 逐条一致。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ROOT, ToolError } from "./dispatch-core/_tool_common.mjs";
import { packageFromData, outputTemplateFor, renderTaskMaterialFile } from "./dispatch-core/subagent_preload.mjs";
import { agentConfigEntry } from "./dispatch-core/dispatch_prepare.mjs";

// 角色提示词正文可编辑：核对当前完整正文是否被注入。
const rolePrompt = (role) => String(agentConfigEntry(role).developer_instructions || "").trim();

export function selfTest() {
  const fixtureDir = path.join(ROOT, "tmp", "subagent-preload-self-test");
  mkdirSync(fixtureDir, { recursive: true });
  const packagePath = path.join(fixtureDir, "preload-self-test.task-package.json");
  const evidencePath = path.join(fixtureDir, "preload-self-test.review-evidence.json");
  // Python json.dumps 默认分隔符带空格；这里逐字复刻，供 render_file_has_review_evidence 断言子串。
  const evidenceText = '{"schema_version": 1, "complete": true, "fact": "mechanical"}\n';
  writeFileSync(evidencePath, evidenceText, "utf8");
  const evidenceRelative = path.relative(ROOT, evidencePath).replaceAll("\\", "/");

  const generalCapability = "ops/agent-prompts/general-agent/general-default.md";
  const reviewCommonPrompt = "ops/agent-prompts/_review-common.md";
  const driftCapability = "ops/agent-prompts/semantic-review-agent/contract-drift-inspection.md";
  const acceptanceCapability = "ops/agent-prompts/verify-agent/acceptance-synthesis.md";

  const pkg = {
    task_package: {
      package_id: "preload-self-test",
      agent: {
        role: "general-agent",
        runtime_role: "general-agent",
        capability: { name: "general-default", file: generalCapability },
        required_files: ["ops/agent-prompts/_common.md", generalCapability],
      },
      goal: "self test",
      scope: { read: [], write: [], delete: [], out_of_scope: [] },
      expected_output: { mode: "message" },
      handoff_contract: { require_final_handoff: true },
      extensions: { review_evidence: { path: evidenceRelative } },
    },
  };
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  const rendered = renderTaskMaterialFile(packagePath);

  const compactPath = path.join(fixtureDir, "preload-self-test-evidence-only.task-package.json");
  const compactPackage = JSON.parse(JSON.stringify(pkg));
  compactPackage.task_package.agent = {
    role: "semantic-review-agent",
    runtime_role: "semantic-review-agent",
    capability: { name: "contract-drift-inspection", file: driftCapability },
    required_files: ["ops/agent-prompts/_common.md", reviewCommonPrompt, driftCapability],
  };
  compactPackage.task_package.extensions.review_execution = { profile: "evidence_only_v1" };
  compactPackage.task_package.extensions.capability_contract = {
    contract_drift_inspection: { target_files: ["target.py"] },
  };
  Object.assign(compactPackage.task_package.expected_output, {
    mode: "file",
    file_path: "notes/verify/self-test.md",
    business_gate: "verdict",
  });
  Object.assign(compactPackage.task_package.handoff_contract, {
    handoff_file: "notes/handoffs/self-test.md",
    accept_verdicts: ["done", "needs_owner"],
  });
  writeFileSync(compactPath, JSON.stringify(compactPackage), "utf8");
  const compactRendered = renderTaskMaterialFile(compactPath);

  compactPackage.task_package.scope.read = [evidenceRelative];
  compactPackage.task_package.tool_contract = { allowed: [] };
  writeFileSync(compactPath, JSON.stringify(compactPackage), "utf8");
  const compactToollessRendered = renderTaskMaterialFile(compactPath);
  delete compactPackage.task_package.tool_contract;
  compactPackage.task_package.scope.read = [];

  const semanticPath = path.join(fixtureDir, "preload-self-test-semantic.task-package.json");
  const semanticPackage = JSON.parse(JSON.stringify(compactPackage));
  semanticPackage.task_package.extensions.review_execution = { profile: "semantic_review_v2", material_mode: "index" };
  writeFileSync(semanticPath, JSON.stringify(semanticPackage), "utf8");
  const semanticRendered = renderTaskMaterialFile(semanticPath);

  const acceptancePath = path.join(fixtureDir, "preload-self-test-acceptance.task-package.json");
  const acceptancePackage = JSON.parse(JSON.stringify(compactPackage));
  acceptancePackage.task_package.agent = {
    role: "verify-agent",
    runtime_role: "verify-agent",
    capability: { name: "acceptance-synthesis", file: acceptanceCapability },
    required_files: ["ops/agent-prompts/_common.md", reviewCommonPrompt, acceptanceCapability],
  };
  acceptancePackage.task_package.scope.read = ["acceptance-contract.yaml", "dependency-index.json"];
  acceptancePackage.task_package.extensions.review_execution = { profile: "acceptance_synthesis_v1" };
  acceptancePackage.task_package.extensions.capability_contract = {
    acceptance_synthesis: { acceptance_ids: ["AC-01"] },
  };
  writeFileSync(acceptancePath, JSON.stringify(acceptancePackage), "utf8");
  const acceptanceRendered = renderTaskMaterialFile(acceptancePath);

  const consultPath = path.join(fixtureDir, "preload-self-test-consult.task-package.json");
  const consultPackage = JSON.parse(JSON.stringify(pkg));
  consultPackage.task_package.scope.read = [evidenceRelative];
  consultPackage.task_package.tool_contract = { allowed: [] };
  writeFileSync(consultPath, JSON.stringify(consultPackage), "utf8");
  const consultRendered = renderTaskMaterialFile(consultPath);
  consultPackage.task_package.scope.read = [path.relative(ROOT, fixtureDir).replaceAll("\\", "/")];
  writeFileSync(consultPath, JSON.stringify(consultPackage), "utf8");
  const consultDirRendered = renderTaskMaterialFile(consultPath);
  consultPackage.task_package.tool_contract = { allowed: [" read "] };
  writeFileSync(consultPath, JSON.stringify(consultPackage), "utf8");
  const paddedReadRendered = renderTaskMaterialFile(consultPath);

  const codeCoverageTemplate = outputTemplateFor({
    agent: { capability: { name: "code-verification" } },
    extensions: {
      review_execution: { profile: "evidence_only_v1", contract_slot: "verify" },
      capability_contract: { verify: { affected_files: ["target.py"] } },
    },
  });

  const checks = {
    render_opens_with_task: rendered.startsWith("本次任务：self test"),
    render_ends_with_task_card: rendered.includes("## 任务卡") && rendered.indexOf("## 任务卡") > rendered.indexOf("## 能力规则"),
    render_points_to_package_file: rendered.includes("`preload-self-test`") && rendered.includes(path.resolve(packagePath)),
    render_omits_inline_package: !rendered.includes('"package_id"'),
    render_omits_role_prompt: !rendered.includes(rolePrompt("general-agent")),
    render_omits_manual_handoff_template: !rendered.includes("FINAL_HANDOFF:"),
    render_file_has_common_prompt_path: rendered.includes("ops/agent-prompts/_common.md"),
    render_file_has_capability_prompt: rendered.includes("general-default"),
    render_file_has_review_evidence: rendered.includes('"fact": "mechanical"'),
    evidence_only_uses_compact_result: compactRendered.includes("review_result") && !compactRendered.includes("FINAL_HANDOFF:"),
    evidence_only_uses_target_files_marker: compactRendered.includes('"reviewed":["$target_files"]'),
    evidence_only_keeps_contract_and_required_files: [
      "### 能力合同",
      '"target_files": [',
      '<!-- subagent-required-material:start {"path":"ops/agent-prompts/_common.md"} -->',
    ].every((marker) => compactRendered.includes(marker)),
    semantic_review_uses_compact_result: semanticRendered.includes("review_result") && !semanticRendered.includes("FINAL_HANDOFF:"),
    semantic_review_uses_target_files_marker: semanticRendered.includes('"reviewed":["$target_files"]'),
    semantic_review_records_actual_scope_reads: semanticRendered.includes('"actual_reads":['),
    semantic_review_keeps_scope: semanticRendered.includes("### 范围"),
    acceptance_review_uses_exact_scope_paths:
      acceptanceRendered.includes('"reviewed":["<exact path from task_package.scope.read>"]') &&
      !acceptanceRendered.includes('"reviewed":["$target_files"]'),
    code_verification_affected_files_use_marker: codeCoverageTemplate.includes('"reviewed":["$target_files"]'),
    render_omits_hashes: !rendered.includes("sha256:"),
    toolless_task_inlines_scope_read: consultRendered.includes(`## 卷宗：${evidenceRelative}`) &&
      consultRendered.includes(evidenceText.trim()) &&
      consultRendered.includes("必读（全文已在上文「卷宗」各节）"),
    toolless_task_expands_scope_directory: consultDirRendered.includes(`## 卷宗：${evidenceRelative}`),
    padded_read_tool_keeps_scope_read_as_paths: !paddedReadRendered.includes("## 卷宗："),
    structured_review_never_inlines_scope_read: !compactToollessRendered.includes("## 卷宗："),
    read_capable_task_keeps_scope_read_as_paths: !rendered.includes("## 卷宗："),
  };

  try {
    rmSync(packagePath, { force: true });
    rmSync(compactPath, { force: true });
    rmSync(semanticPath, { force: true });
    rmSync(acceptancePath, { force: true });
    rmSync(consultPath, { force: true });
    rmSync(evidencePath, { force: true });
    rmSync(fixtureDir, { force: true });
  } catch {
    // Python 用 rmdir 静默忽略失败，这里同样不让清理失败影响自测结果。
  }

  return { status: Object.values(checks).every(Boolean) ? "ok" : "failed", checks };
}
