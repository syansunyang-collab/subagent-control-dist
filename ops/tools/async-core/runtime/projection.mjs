import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readTaskOutcome, summarizeTaskOutcome } from "../../task-outcome.mjs";
import { readJson } from "../../_fs-utils.mjs";
import { CONTRACT_VERSION, TOKEN_BUDGETS, isTerminalState } from ".././contracts.mjs";

export function createProjection(ctx, rt) {
  const writeJson = (...args) => rt.writeJson(...args);
  const truncateText = (...args) => rt.truncateText(...args);
  const truncateUtf8Text = (...args) => rt.truncateUtf8Text(...args);
  const estimateTokens = (...args) => rt.estimateTokens(...args);
  const assertTokenBudget = (...args) => rt.assertTokenBudget(...args);
  const boundedResultReceipt = (...args) => rt.boundedResultReceipt(...args);
  const loadTask = (...args) => rt.loadTask(...args);
  const statusTask = (...args) => rt.statusTask(...args);
  const taskPackageOutputs = (...args) => rt.taskPackageOutputs(...args);
  const parseHandoffSummary = (...args) => rt.parseHandoffSummary(...args);
  const parseHandoffMechanicalState = (...args) => rt.parseHandoffMechanicalState(...args);
  const reviewGate = (...args) => rt.reviewGate(...args);
  const failureSummary = (...args) => rt.failureSummary(...args);

  // Previous attempt evidence can outlive pause/resume. Until the task settles,
  // a stopped session or newly running attempt is not a failed final execution.
  function displayTaskOutcome(status) {
    const outcome = readTaskOutcome(status);
    if (isTerminalState(status.state) || outcome.execution !== "failed") return outcome;
    const active = { ...outcome, execution: "unknown" };
    return { ...active, summary: summarizeTaskOutcome(active) };
  }

  function compactTaskStatus(status) {
    const optionalText = (value, maxBytes) => {
      if (value === null || value === undefined || maxBytes <= 0) return null;
      const compact = truncateUtf8Text(value, maxBytes);
      return compact || null;
    };
    const rawFailureSummary = failureSummary(status);
    const taskOutcome = displayTaskOutcome(status);
    const profiles = [
      { batch: 120, slice: 120, title: 120, failure: 180 },
      { batch: 72, slice: 72, title: 96, failure: 120 },
      { batch: 36, slice: 36, title: 72, failure: 96 },
      { batch: 0, slice: 0, title: 48, failure: 72 },
      { batch: 0, slice: 0, title: 0, failure: 48 },
      { batch: 0, slice: 0, title: 0, failure: 0 },
    ];
    let minimal = null;
    for (const profile of profiles) {
      const compact = {
        model: status.model ?? null,
        effort: status.effort ?? null,
        model_source: status.model_source ?? "unknown",
        effort_source: status.effort_source ?? "unknown",
        task_id: status.task_id,
        batch_id: optionalText(status.batch_id, profile.batch),
        slice_id: optionalText(status.slice_id, profile.slice),
        display_title: optionalText(status.display_title, profile.title),
        state: status.state,
        contract_state: status.contract_state ?? null,
        business_state: status.business_state ?? null,
        review_gate: reviewGate(status),
        task_outcome: taskOutcome,
        revision: String(status.rev ?? 0),
        updated_at: status.updated_at ?? null,
        failure_summary: optionalText(rawFailureSummary, profile.failure),
        progress: {
          elapsed_seconds: status.elapsed_seconds ?? null,
          tool_call_count: status.tool_call_count ?? 0,
          progress_state: status.progress_state ?? null,
        },
        ...(status.write_domain_scope_compliant === false
          ? { write_domain_violation_count: status.write_domain_violation_count ?? 0 }
          : {}),
        ...(status.pause_requested_at || status.state === "paused" ? {
          transport_state: status.state, pause_requested_at: status.pause_requested_at ?? null,
          resumable: status.resumable === true && (status.resume_mode === "start" || Boolean(status.session_file && existsSync(status.session_file))),
          session_file: status.session_file ?? null, resume_mode: status.resume_mode ?? "session",
        } : {}),
        ...(status.stall ? { stall: status.stall } : {}),
      };
      minimal = compact;
      if (estimateTokens(compact) <= TOKEN_BUDGETS.getPerTask) return compact;
    }
    // The projection is display data: overflow must not reject a previously valid compact status.
    // Diagnostic retains the full projection, including gate identity and provenance; receipts are independently bounded.
    const { summary, ...facts } = minimal.task_outcome;
    minimal.task_outcome = facts;
    if (estimateTokens(minimal) <= TOKEN_BUDGETS.getPerTask) return minimal;
    minimal.task_outcome = { ...facts, object_gate: { value: facts.object_gate.value } };
    if (estimateTokens(minimal) <= TOKEN_BUDGETS.getPerTask) return minimal;
    delete minimal.task_outcome;
    return assertTokenBudget(`get compact ${status.task_id}`, minimal, TOKEN_BUDGETS.getPerTask);
  }

  function diagnosticTaskStatus(status, { minimal = false, includeRequest = true } = {}) {
    const attempts = Array.isArray(status.attempts) ? status.attempts : [];
    const currentAttempt = attempts.length ? attempts[attempts.length - 1] : null;
    const compactTool = status.last_tool_call && typeof status.last_tool_call === "object"
      ? {
          id: status.last_tool_call.id == null ? null : truncateText(String(status.last_tool_call.id), 80),
          type: status.last_tool_call.type == null ? null : truncateText(String(status.last_tool_call.type), 80),
          name: status.last_tool_call.name == null ? null : truncateText(String(status.last_tool_call.name), 80),
          status: status.last_tool_call.status == null ? null : truncateText(String(status.last_tool_call.status), 40),
        }
      : null;
    const requestText = status.live_last_request == null
      ? null
      : truncateText(
          typeof status.live_last_request === "string"
            ? status.live_last_request
            : JSON.stringify(status.live_last_request),
          minimal ? 96 : 240,
        );
    const base = minimal
      ? {
          model: status.model ?? null,
          effort: status.effort ?? null,
          model_source: status.model_source ?? "unknown",
          effort_source: status.effort_source ?? "unknown",
          task_id: status.task_id,
          state: status.state,
          contract_state: status.contract_state ?? null,
          business_state: status.business_state ?? null,
          review_gate: reviewGate(status),
          revision: String(status.rev ?? 0),
          updated_at: status.updated_at ?? null,
          failure_summary: null,
        }
      : compactTaskStatus(status);
    return {
      ...base,
      ...(!minimal ? { task_outcome: displayTaskOutcome(status) } : {}),
      ...(!minimal ? {
        artifact_state: status.artifact_state ?? null,
        failure_type: status.failure_type ?? null,
        ...(status.result_receipt_error ? { result_receipt_error: truncateText(String(status.result_receipt_error), 300) } : {}),
        ...(status.latest_model_error ? { latest_model_error: truncateText(String(status.latest_model_error), 300) } : {}),
        turn_status: status.turn_status ?? null,
        resumable: status.resumable === true,
        session_file: status.session_file ?? null,
      } : status.resumable === true ? { resumable: true } : {}),
      process_alive: status.process_alive ?? null,
      progress: {
        elapsed_seconds: status.elapsed_seconds ?? null,
        live_age_seconds: status.live_age_seconds ?? null,
        tool_call_count: status.tool_call_count ?? 0,
        last_tool_kind: status.last_tool_kind ?? null,
        live_health: status.live_health ?? null,
        progress_state: status.progress_state ?? null,
      },
      live_phase: status.live_phase ?? null,
      ...(includeRequest ? { live_last_request: requestText } : {}),
      last_tool_call: minimal && compactTool ? { name: compactTool.name, status: compactTool.status } : compactTool,
      diagnostic_paths: {
        task_dir: status.task_dir,
        stdout: currentAttempt?.stdout_path ? path.basename(currentAttempt.stdout_path) : null,
        stderr: currentAttempt?.stderr_path ? path.basename(currentAttempt.stderr_path) : null,
        live: path.basename(status.live_path || "child-task-live.json"),
        events: path.basename(status.live_events_path || "child-task-events.jsonl"),
      },
      ...(status.stall ? { stall: status.stall } : {}),
    };
  }

  function resultReceiptValue(taskRoot, taskId) {
    const status = statusTask({ task_root: taskRoot, task_id: taskId });
    if (!isTerminalState(status.state)) {
      throw new Error(`result is available only for terminal tasks: ${taskId}`);
    }
    const { task, files } = loadTask(taskRoot, taskId);
    const outputs = taskPackageOutputs(task);
    const handoffPath = outputs.business_handoff_path || (existsSync(files.handoff) ? files.handoff : null);
    const reportPath = outputs.business_report_path || (existsSync(files.report) ? files.report : null);
    const handoffText = handoffPath ? readFileSync(handoffPath, "utf8") : "";
    const handoff = parseHandoffSummary(handoffText);
    const mechanical = parseHandoffMechanicalState(handoffText);
    const attestation = existsSync(files.attestation) ? readJson(files.attestation, null) : null;
    return {
      contract_version: CONTRACT_VERSION,
      task_id: taskId,
      batch_id: task.batch_id ?? null,
      slice_id: task.slice_id ?? null,
      display_title: task.display_title ?? null,
      state: status.state,
      business_state: status.business_state ?? null,
      review_gate: reviewGate(status),
      task_outcome: readTaskOutcome(status),
      revision: String(status.rev ?? 0),
      finished_at: status.finished_at ?? status.updated_at ?? null,
      handoff_summary: {
        verdict: truncateText(handoff.verdict || status.business_state || "unknown", 80),
        summary: truncateText(handoff.summary || failureSummary(status) || "", 360),
      },
      mechanical_summary: {
        contract_state: status.contract_state ?? null,
        artifact_state: status.artifact_state ?? null,
        handoff_check: mechanical.state,
        requires_parent_review: Boolean(status.requires_parent_review),
        write_domain_enabled: status.write_domain_enabled ?? null,
        write_domain_scope_compliant: status.write_domain_scope_compliant ?? null,
        write_domain_audit_complete: status.write_domain_audit_complete ?? null,
        write_domain_violation_count: status.write_domain_violation_count ?? 0,
        write_domain_reported_violation_count: status.write_domain_reported_violation_count ?? 0,
        write_domain_covered_tools: Array.isArray(status.write_domain_covered_tools) ? status.write_domain_covered_tools : [],
        write_domain_command_write_enforced: status.write_domain_command_write_enforced === true,
      },
      // 新生成有效结果才带追踪版本标记；缺此字段的历史收据保持 unknown，不能从无读记录推断 unread。
      result_tracking_version: String(status.rev ?? 0),
      artifacts: {
        report_path: reportPath,
        handoff_path: handoffPath,
        salvage_report_path: status.salvage_report_path ?? null,
        attestation_path: attestation ? files.attestation : null,
        full_result_path: null,
      },
      session: {
        resumable: status.resumable === true,
        file: status.session_file ?? null,
      },
      attestation: attestation
        ? {
            result_mode: String(attestation.result_mode || ""),
            verified: Boolean(attestation.verified),
            summary: truncateText(String(attestation.summary || ""), 240),
          }
        : null,
    };
  }

  function buildResultReceipt(taskRoot, taskId) {
    return boundedResultReceipt(
      resultReceiptValue(taskRoot, taskId),
      TOKEN_BUDGETS.result,
    );
  }

  // 展示层失败不覆盖真实终态：完整收据先落盘，短回执写失败时只登记独立字段，
  // 终态通知仍由调用方照常写出，也不推进 rev（revision 是结果消费身份）。
  function noteResultReceiptError(files, message) {
    const current = readJson(files.status, {});
    const next = message ?? null;
    if ((current.result_receipt_error ?? null) === next) return current;
    const patched = { ...current, result_receipt_error: next };
    writeJson(files.status, patched);
    return patched;
  }

  function writeResultReceipt(files, task) {
    try {
      const full = resultReceiptValue(task.task_root, task.task_id);
      let copyError = null;
      full.artifacts.full_result_path = files.resultFull;
      try {
        writeJson(files.resultFull, full);
      } catch (error) {
        copyError = truncateUtf8Text(error?.message ?? String(error), 300);
        full.artifacts.full_result_path = null;
      }
      const receipt = boundedResultReceipt(full, TOKEN_BUDGETS.result);
      writeJson(files.result, receipt);
      noteResultReceiptError(files, copyError);
      return receipt;
    } catch (error) {
      noteResultReceiptError(files, truncateUtf8Text(error?.message ?? String(error), 300));
      return null;
    }
  }

  return {
    compactTaskStatus,
    diagnosticTaskStatus,
    resultReceiptValue,
    buildResultReceipt,
    noteResultReceiptError,
    writeResultReceipt,
  };
}
