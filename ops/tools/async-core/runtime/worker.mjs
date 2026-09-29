import { existsSync, rmSync, writeFileSync } from "node:fs";
import { ensureDir, pick, readJson } from "../../_fs-utils.mjs";
import {
  RETIRED_SALVAGE_REPORT_PATH,
} from "./shared.mjs";

export function createWorker(ctx, rt) {
  const isoNow = (...args) => rt.isoNow(...args);
  const resolveTaskRoot = (...args) => rt.resolveTaskRoot(...args);
  const loadTask = (...args) => rt.loadTask(...args);
  const processTreeMarker = (...args) => rt.processTreeMarker(...args);
  const confirmedProcessTreeMarker = (...args) => rt.confirmedProcessTreeMarker(...args);
  const producerRootForTask = (...args) => rt.producerRootForTask(...args);
  const withWriteClaimLock = (...args) => rt.withWriteClaimLock(...args);
  const releaseWriteClaimForTask = (...args) => rt.releaseWriteClaimForTask(...args);
  const updateStatus = (...args) => rt.updateStatus(...args);
  const completionNoticePath = (...args) => rt.completionNoticePath(...args);
  const stallNoticePath = (...args) => rt.stallNoticePath(...args);
  const writeCompletionNotice = (...args) => rt.writeCompletionNotice(...args);
  const enforceTerminalHandoffContract = (...args) => rt.enforceTerminalHandoffContract(...args);
  const writeResultReceipt = (...args) => rt.writeResultReceipt(...args);
  const runningAttempt = (...args) => rt.runningAttempt(...args);
  const writeResultAttestation = (...args) => rt.writeResultAttestation(...args);
  const runChildAttempt = (...args) => rt.runChildAttempt(...args);
  const slimAttempt = (...args) => rt.slimAttempt(...args);

  async function worker(input = {}) {
    const taskRoot = resolveTaskRoot(input);
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    const { files, task } = loadTask(taskRoot, taskId);
    ensureDir(task.task_dir);
    const startingStatus = withWriteClaimLock(task.producer_root || producerRootForTask({}, taskRoot), () => {
      const current = readJson(files.status, {});
      if (current.state === "paused") return current;
      if (current.pause_requested_at && !current.cancel_requested_at && ["queued", "submitted"].includes(current.state)) {
        return updateStatus(files, { state: "paused", resume_mode: "start", resumable: true,
          session_file: null, business_state: "unknown", paused_at: isoNow(), error: null,
          pid: null, child_pid: null, runner_spawn_pending: false, retained_worker: false,
          retained_marker: confirmedProcessTreeMarker(task, current, "queued_pause") });
      }
      updateStatus(files, { state: current.state === "cancel_requested" ? "cancel_requested" : "running" });
      return current;
    });
    if (startingStatus.state === "paused") {
      releaseWriteClaimForTask(task);
      return;
    }
    updateStatus(files, {
      state: startingStatus.state === "cancel_requested" ? "cancel_requested" : "running",
      pid: ctx.host.pid,
      started_at: isoNow(),
      retained_worker: startingStatus.retained_worker === true,
      retained_marker: processTreeMarker(
        task.task_id,
        startingStatus.pid ?? ctx.host.pid,
        "worker_start",
        startingStatus.retained_marker,
      ),
      runner_spawn_pending: false,
      child_pid: null,
    });

    if (!existsSync(task.runner_path)) {
      const message = `Child runner not found: ${task.runner_path}`;
      const completionNotice = completionNoticePath(task);
      writeFailureFiles(files, task, message);
      updateStatus(files, {
        state: "failed",
        contract_state: "invalid_final",
        business_state: "unknown",
        artifact_state: "runner_missing",
        requires_parent_review: true,
        failure_type: "runner_not_found",
        error: message,
        completion_notice_path: completionNotice,
        finished_at: isoNow(),
        retained_worker: false,
        retained_marker: confirmedProcessTreeMarker(task, readJson(files.status, {}), "worker_finalization"),
        runner_spawn_pending: false,
        child_pid: null,
      });
      writeResultReceipt(files, task);
      writeCompletionNotice(files, task);
      ctx.host.setExitCode(1);
      return;
    }

    const resumeSession = typeof startingStatus.resume_requested_session === "string"
      ? startingStatus.resume_requested_session
      : "";
    const attempts = Array.isArray(startingStatus.attempts)
      ? startingStatus.attempts.filter((item) => item && item.state && item.state !== "running")
      : [];
    const primaryAttempt = {
      attempt: attempts.length + 1,
      attempt_id: `${attempts.length + 1}-${ctx.host.randomHex(8)}`,
      runtime_role: resumeSession ? "resume" : (task.runtime_role || ""),
      model: task.model,
      effort: task.effort,
      ...(resumeSession ? { resume_session: resumeSession } : {}),
    };
    if (startingStatus.state !== "cancel_requested") rmSync(files.cancelRequest, { force: true });
    attempts.push(runningAttempt(task, primaryAttempt));
    updateStatus(files, {
      attempts,
      resume_requested_session: null,
      active_attempt_id: primaryAttempt.attempt_id,
      active_model: primaryAttempt.model,
      active_effort: primaryAttempt.effort,
      active_runtime_role: primaryAttempt.runtime_role,
      last_progress_line: resumeSession ? `attempt ${primaryAttempt.attempt} running (resume)` : "attempt 1 running",
    });
    let outcome = await runChildAttempt(files, task, primaryAttempt);
    if (outcome.child_result?.cleanup?.tree_confirmed === false) {
      outcome = {
        ...outcome,
        retained_worker: true,
        resumable: false,
        requires_parent_review: true,
        error: `process-tree termination is not confirmed; write claim retained${outcome.error ? `; ${outcome.error}` : ""}`,
      };
    }
    attempts[attempts.length - 1] = slimAttempt(outcome);
    updateStatus(files, { attempts });

    if (outcome.state === "paused" || outcome.contract_state === "pause_unconfirmed") {
      // Pause is a control checkpoint, not a business result. A concurrent
      // explicit cancellation wins over the pause acknowledgement.
      withWriteClaimLock(task.producer_root || producerRootForTask({}, taskRoot), () => {
      const latest = readJson(files.status, {});
      const cancelled = latest.cancel_requested_at || latest.state === "cancel_requested" || latest.state === "cancelled";
      const state = cancelled ? (outcome.state === "paused" ? "cancelled" : "cancel_requested") : outcome.state;
      updateStatus(files, { state, transport_state: state,
        contract_state: outcome.contract_state, business_state: "unknown", artifact_state: outcome.artifact_state,
        attempts, resume_mode: outcome.resume_mode, resumable: outcome.resumable === true,
        session_file: outcome.session_file, error: outcome.error, failure_type: outcome.failure_type,
        paused_at: outcome.state === "paused" ? isoNow() : null,
        retained_worker: outcome.retained_worker === true,
        retained_marker: outcome.retained_worker
          ? processTreeMarker(task.task_id, ctx.host.pid, "pause_unconfirmed")
          : confirmedProcessTreeMarker(task, readJson(files.status, {}), "pause_finalization"),
        pid: null, child_pid: null, runner_spawn_pending: false, active_attempt_id: null });
      if (outcome.state === "paused") releaseWriteClaimForTask(task);
      if (state === "cancelled") {
        updateStatus(files, { finished_at: isoNow(), completion_notice_path: completionNoticePath(task) });
        writeResultReceipt(files, task);
        writeCompletionNotice(files, task);
      }
      });
      return;
    }
    const attestation = writeResultAttestation(files, task, outcome);
    if (attestation && !attestation.verified && outcome.state === "done") {
      const failureType = task.result_mode === "real_rerun"
        ? "cross_repo_attestation_failed"
        : "artifact_attestation_failed";
      outcome = {
        ...outcome,
        state: "failed",
        contract_state: failureType,
        artifact_state: failureType,
        requires_parent_review: true,
        failure_type: failureType,
        error: attestation.summary,
        salvage_evidence_paths: [...new Set([...(outcome.salvage_evidence_paths || []), files.attestation])],
      };
    }
    const terminalHandoff = enforceTerminalHandoffContract(task, files, outcome);
    outcome = terminalHandoff.outcome;
    const state = outcome.state;
    const completionNotice = completionNoticePath(task);
    if (state === "failed") {
      ensureFailureOutputs(files, task, outcome.error, outcome.child_result, outcome.final_text, {
        code: outcome.exit_code,
        signal: outcome.signal,
      });
    }
    updateStatus(files, {
      state,
      contract_state: outcome.contract_state,
      business_state: outcome.business_state,
      business_state_raw: outcome.business_state_raw ?? null,
      artifact_state: outcome.artifact_state,
      requires_parent_review: outcome.requires_parent_review,
      salvage_report_path: RETIRED_SALVAGE_REPORT_PATH,
      salvage_evidence_paths: outcome.salvage_evidence_paths ?? [],
      cancel_reason: outcome.cancel_reason ?? null,
      last_progress_line: outcome.last_progress_line || null,
      exit_code: outcome.exit_code,
      signal: outcome.signal,
      failure_type: outcome.failure_type,
      handoff_check_status: terminalHandoff.check.status,
      handoff_check_issues: terminalHandoff.check.issues,
      turn_status: outcome.turn_status,
      attestation_path: attestation ? files.attestation : null,
      attestation_verified: attestation?.verified ?? null,
      write_domain_profile: outcome.write_domain_profile ?? null,
      write_domain_enabled: outcome.write_domain_enabled ?? null,
      write_domain_scope_compliant: outcome.write_domain_scope_compliant ?? null,
      write_domain_audit_complete: outcome.write_domain_audit_complete ?? null,
      write_domain_violation_count: outcome.write_domain_violation_count ?? 0,
      write_domain_reported_violation_count: outcome.write_domain_reported_violation_count ?? 0,
      write_domain_covered_tools: outcome.write_domain_covered_tools ?? [],
      write_domain_command_write_enforced: outcome.write_domain_command_write_enforced === true,
      write_domain_audit_path: outcome.write_domain_audit_path ?? null,
      child_result_path: files.childResult,
      attempts,
      resumable: outcome.resumable === true,
      session_file: outcome.session_file || null,
      stall: null,
      active_model: outcome.model,
      active_effort: outcome.effort,
      active_runtime_role: outcome.runtime_role,
      error: outcome.error ?? null,
      latest_model_error: outcome.latest_model_error ?? null,
      completion_notice_path: completionNotice,
      finished_at: isoNow(),
      retained_marker: outcome.retained_worker === true
        ? { ...processTreeMarker(task.task_id, ctx.host.pid, "runner_cleanup"), tracked_pids: outcome.tracked_pids ?? null }
        : confirmedProcessTreeMarker(task, readJson(files.status, {}), "worker_finalization"),
      runner_spawn_pending: false,
      child_pid: null,
      active_attempt_id: null,
      retained_worker: outcome.retained_worker === true,
    });
    rmSync(stallNoticePath(task), { force: true });
    writeResultReceipt(files, task);
    writeCompletionNotice(files, task);
  }

  function ensureFailureOutputs(files, task, error, childResult, finalText, exit) {
    if (!existsSync(files.report)) {
      const body = [
        `# ${task.task_id} report`,
        "",
        "state: failed",
        `exit_code: ${exit.code}`,
        `error: ${error || "child runner failed"}`,
        "",
        "## child-final",
        "",
        finalText || "(no child final text)",
        "",
        "## child-result",
        "",
        "```json",
        JSON.stringify(childResult ?? {}, null, 2),
        "```",
        "",
      ].join("\n");
      writeFileSync(files.report, body, "utf8");
    }
    if (!existsSync(files.handoff)) {
      const body = [
        "verdict: failed",
        `summary: ${error || ctx.config.promptIdentity.failureSummaryPrefix}`,
        "files_read_or_changed:",
        `  - ${files.report}`,
        "evidence_paths:",
        `  - ${task.task_dir}`,
        `  - ${files.childResult}`,
        "blockers:",
        `  - ${error || childResult?.error || `child runner exited ${exit.code}`}`,
        "",
      ].join("\n");
      writeFileSync(files.handoff, body, "utf8");
    }
  }

  function writeFailureFiles(files, task, message) {
    writeFileSync(
      files.report,
      [`# ${task.task_id} report`, "", "## failure", "", message, ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      files.handoff,
      [
        "verdict: failed",
        `summary: ${message}`,
        "files_read_or_changed: []",
        "evidence_paths:",
        `  - ${task.task_dir}`,
        "blockers:",
        `  - ${message}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  return {
    worker,
    ensureFailureOutputs,
    writeFailureFiles,
  };
}
