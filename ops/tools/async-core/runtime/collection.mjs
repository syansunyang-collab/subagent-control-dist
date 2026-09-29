import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pick } from "../../_fs-utils.mjs";
import { normalizeBusinessWord } from ".././contracts.mjs";
import {
  RETIRED_SALVAGE_REPORT_PATH,
} from "./shared.mjs";

export function createCollection(ctx, rt) {
  const pickBool = (...args) => rt.pickBool(...args);
  const loadLocatedTask = (...args) => rt.loadLocatedTask(...args);
  const statusTask = (...args) => rt.statusTask(...args);
  const taskPackageOutputs = (...args) => rt.taskPackageOutputs(...args);
  const parseHandoffSummary = (...args) => rt.parseHandoffSummary(...args);
  const parseHandoffMechanicalState = (...args) => rt.parseHandoffMechanicalState(...args);
  const artifactResult = (...args) => rt.artifactResult(...args);
  const handoffCheckResult = (...args) => rt.handoffCheckResult(...args);

  function collectWarnings(status, artifactManifest, handoffSummary, handoffCheck) {
    const warnings = [];
    const artifact = artifactResult(artifactManifest);
    if (status.state !== "done" && !["missing", "runtime_trace_only"].includes(artifact)) {
      warnings.push("transport_not_done_but_artifact_available");
    }
    const verdict = normalizeBusinessWord(handoffSummary?.verdict);
    if (status.state !== "done" && verdict === "completed") {
      warnings.push("handoff_verdict_done_but_transport_not_done");
    }
    if (handoffCheck?.checked && handoffCheck.status !== "pass") {
      warnings.push("handoff_check_failed");
    }
    if (status.write_domain_scope_compliant === false) {
      warnings.push("write_domain_violation_or_incomplete_audit");
    }
    return warnings;
  }

  function parentConsumptionSummary(status, businessOutputs, artifactManifest, handoffText, handoffCheck) {
    const mechanical = parseHandoffMechanicalState(handoffText);
    const businessState = status.business_state ?? null;
    const businessNeedsReview = new Set(["partial", "failed", "blocked", "unknown"]);
    const reviewRequired = Boolean(
      status.requires_parent_review ||
      status.state !== "done" ||
      businessNeedsReview.has(String(businessState || "unknown")) ||
      mechanical.state !== "pass" ||
      (handoffCheck?.checked && handoffCheck.status !== "pass"),
    );
    return {
      transport_state: status.state ?? null,
      contract_state: status.contract_state ?? null,
      business_result: businessState,
      business_state_raw: status.business_state_raw ?? null,
      artifact_result: artifactResult(artifactManifest),
      artifact_state: status.artifact_state ?? null,
      handoff_mechanical_state: mechanical.state,
      handoff_mechanical_value: mechanical.value,
      mechanical_check_verified_by_parent: Boolean(handoffCheck?.checked && handoffCheck.status === "pass"),
      requires_parent_review: reviewRequired,
      cancel_reason: status.cancel_reason ?? null,
      failure_type: status.failure_type ?? null,
      turn_status: status.turn_status ?? null,
      exit_code: status.exit_code ?? null,
      signal: status.signal ?? null,
      error: status.error ?? null,
      durable_report_path: businessOutputs.business_report_path ?? null,
      durable_handoff_path: businessOutputs.business_handoff_path ?? null,
      declared_report_path: businessOutputs.declared_report_path ?? null,
      declared_handoff_path: businessOutputs.declared_handoff_path ?? null,
      salvage_report_path: RETIRED_SALVAGE_REPORT_PATH,
      salvage_evidence_paths: artifactManifest.salvage_evidence_paths ?? [],
      write_domain: {
        profile: status.write_domain_profile ?? null,
        enabled: status.write_domain_enabled ?? null,
        scope_compliant: status.write_domain_scope_compliant ?? null,
        audit_complete: status.write_domain_audit_complete ?? null,
        violation_count: status.write_domain_violation_count ?? 0,
        reported_violation_count: status.write_domain_reported_violation_count ?? 0,
        covered_tools: Array.isArray(status.write_domain_covered_tools) ? status.write_domain_covered_tools : [],
        command_write_enforced: status.write_domain_command_write_enforced === true,
        audit_path: status.write_domain_audit_path ?? null,
      },
    };
  }

  function collectTask(input = {}) {
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    const { taskRoot, task, files } = loadLocatedTask(input, taskId);
    const status = statusTask({ ...input, task_root: taskRoot });
    const includeReport = pickBool(input, ["include_report", "includeReport"], false);
    const checkHandoff = pickBool(input, ["check-handoff", "check_handoff", "checkHandoff"], false);
    const businessOutputs = taskPackageOutputs(task);
    const handoffPath = businessOutputs.business_handoff_path || status.handoff;
    const reportPath = businessOutputs.business_report_path || status.report;
    const handoffText = handoffPath && existsSync(handoffPath) ? readFileSync(handoffPath, "utf8") : "";
    const reportText = includeReport && reportPath && existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    const childFinalPath = path.join(task.task_dir, "child-final.md");
    // A3：salvage 报告已退役，salvage_report_path 恒 null；诊断原件走 salvage_evidence_paths 指针。
    const salvageEvidencePaths = Array.isArray(status.salvage_evidence_paths)
      ? status.salvage_evidence_paths.filter((candidate) => candidate && existsSync(candidate))
      : [];
    const artifactManifest = {
      runtime_report: existsSync(files.report) ? files.report : null,
      runtime_handoff: existsSync(files.handoff) ? files.handoff : null,
      durable_reports: businessOutputs.business_report_path ? [businessOutputs.business_report_path] : [],
      durable_handoffs: businessOutputs.business_handoff_path ? [businessOutputs.business_handoff_path] : [],
      salvage_report: null,
      salvage_evidence_paths: salvageEvidencePaths,
      child_final: existsSync(childFinalPath) ? childFinalPath : null,
      child_result: existsSync(files.childResult) ? files.childResult : null,
      child_live: existsSync(files.childLive) ? files.childLive : null,
      completion_notice: status.completion_notice_path && existsSync(status.completion_notice_path)
        ? status.completion_notice_path
        : null,
      artifact_contract_ok: status.contract_state === "ok" || status.contract_state === "artifact_path_mismatch",
      artifact_state: status.artifact_state ?? null,
    };
    const handoffCheck = handoffCheckResult(task, handoffPath, checkHandoff);
    const handoffSummary = parseHandoffSummary(handoffText);
    const warnings = collectWarnings(status, artifactManifest, handoffSummary, handoffCheck);
    const parentConsumption = parentConsumptionSummary(status, businessOutputs, artifactManifest, handoffText, handoffCheck);
    return {
      ok: true,
      task_id: status.task_id,
      state: status.state,
      contract_state: status.contract_state ?? null,
      business_state: status.business_state ?? null,
      business_state_raw: status.business_state_raw ?? null,
      requires_parent_review: status.requires_parent_review ?? false,
      salvage_report_path: RETIRED_SALVAGE_REPORT_PATH,
      salvage_evidence_paths: salvageEvidencePaths,
      cancel_reason: status.cancel_reason ?? null,
      last_progress_line: status.last_progress_line ?? null,
      failure_type: status.failure_type ?? null,
      turn_status: status.turn_status ?? null,
      exit_code: status.exit_code ?? null,
      signal: status.signal ?? null,
      status_path: path.join(status.task_dir, "status.json"),
      handoff_path: handoffPath,
      report_path: reportPath,
      handoff_source: businessOutputs.business_handoff_path ? "task_package" : "runtime_wrapper",
      report_source: businessOutputs.business_report_path ? "task_package" : "runtime_wrapper",
      handoff_summary: handoffSummary,
      handoff_check: handoffCheck,
      task_package_source: businessOutputs.task_package_source,
      task_package_path: businessOutputs.task_package_path,
      declared_handoff_path: businessOutputs.declared_handoff_path,
      declared_report_path: businessOutputs.declared_report_path,
      business_handoff_path: businessOutputs.business_handoff_path,
      business_report_path: businessOutputs.business_report_path,
      wrapper_handoff_path: status.handoff,
      wrapper_report_path: status.report,
      artifact_manifest: artifactManifest,
      write_domain: parentConsumption.write_domain,
      parent_consumption: parentConsumption,
      transport_state: parentConsumption.transport_state,
      artifact_result: parentConsumption.artifact_result,
      handoff_mechanical_state: parentConsumption.handoff_mechanical_state,
      handoff_mechanical_value: parentConsumption.handoff_mechanical_value,
      handoff: handoffText,
      report: reportText || undefined,
      collect_warnings: warnings,
      collect_warning: businessOutputs.error || warnings[0] || undefined,
      error: status.error ?? null,
    };
  }

  return {
    collectWarnings,
    parentConsumptionSummary,
    collectTask,
  };
}
