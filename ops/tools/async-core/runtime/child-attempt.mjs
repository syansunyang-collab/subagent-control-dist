import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { readJson } from "../../_fs-utils.mjs";
import { PI_CHILD_WRITE_DOMAIN_PROFILE } from "../../pi_write_domain_extension.mjs";
import { CONTRACT_VERSION } from ".././contracts.mjs";
import {
  DEFAULT_ATTEMPT_ELAPSED_LIMIT_MINUTES,
  CANCEL_FORCE_CLEANUP_MS,
  RETIRED_SALVAGE_REPORT_PATH,
  reportedSessionFile,
} from "./shared.mjs";

export function createChildAttempt(ctx, rt) {
  const writeJson = (...args) => rt.writeJson(...args);
  const isoNow = (...args) => rt.isoNow(...args);
  const processTreeMarker = (...args) => rt.processTreeMarker(...args);
  const confirmedProcessTreeMarker = (...args) => rt.confirmedProcessTreeMarker(...args);
  const producerRootForTask = (...args) => rt.producerRootForTask(...args);
  const declaredWritePaths = (...args) => rt.declaredWritePaths(...args);
  const updateStatus = (...args) => rt.updateStatus(...args);
  const objectOrEmpty = (...args) => rt.objectOrEmpty(...args);
  const taskPackagePathFor = (...args) => rt.taskPackagePathFor(...args);
  const taskPackageOutputs = (...args) => rt.taskPackageOutputs(...args);
  const handoffCheckSpec = (...args) => rt.handoffCheckSpec(...args);
  const attemptLogPath = (...args) => rt.attemptLogPath(...args);
  const fallbackFailureType = (...args) => rt.fallbackFailureType(...args);
  const lastProgressLine = (...args) => rt.lastProgressLine(...args);
  const synthesizeArtifactPointer = (...args) => rt.synthesizeArtifactPointer(...args);
  const synthesizeArtifactsFromChildFinal = (...args) => rt.synthesizeArtifactsFromChildFinal(...args);
  const classifyContractState = (...args) => rt.classifyContractState(...args);
  const classifyBusinessState = (...args) => rt.classifyBusinessState(...args);
  const collectSalvageEvidencePaths = (...args) => rt.collectSalvageEvidencePaths(...args);
  const startStallMonitor = (...args) => rt.startStallMonitor(...args);
  const worker = (...args) => rt.worker(...args);

  async function runChildAttempt(files, task, attempt) {
    // 保留上一次回执，但不把它误读为新 attempt 被中断前已交付的结果。
    if (attempt.attempt > 1 && existsSync(files.childResult)) {
      renameSync(files.childResult, path.join(task.task_dir, `child-task-result.attempt-${attempt.attempt - 1}.json`));
    }
    // task-local spec 每个 attempt 启动前由 Core 重写；终态释放全局 claim 后 resume 仍持有同一写域。
    const writeDomainPaths = Array.isArray(task.write_domain_paths)
      ? task.write_domain_paths
      : declaredWritePaths(taskPackagePathFor(task), {
          targetCwd: task.target_cwd,
          producerRoot: task.producer_root || producerRootForTask({}, task.task_root),
          includeDelete: false,
        });
    const writeDomainDeletePaths = Array.isArray(task.write_domain_delete_paths)
      ? task.write_domain_delete_paths
      : declaredWritePaths(taskPackagePathFor(task), {
          targetCwd: task.target_cwd,
          producerRoot: task.producer_root || producerRootForTask({}, task.task_root),
          includeOutputs: false,
          includeWrites: false,
        });
    writeJson(files.writeDomain, {
      contract_version: PI_CHILD_WRITE_DOMAIN_PROFILE,
      task_id: task.task_id,
      paths: writeDomainPaths,
      delete_paths: writeDomainDeletePaths,
      case_insensitive: ctx.host.caseInsensitivePaths === true,
    });
    const args = [
      task.runner_path,
      "--contextMode",
      task.context_mode,
      "--targetCwd",
      task.target_cwd,
      "--taskFile",
      task.prompt_path,
      "--model",
      attempt.model,
      "--effort",
      attempt.effort,
      "--outDir",
      task.task_dir,
      "--artifactsDir",
      path.join(task.task_dir, "artifacts"),
      "--saveRawEvidence",
      task.save_raw_evidence ? "true" : "false",
      "--writeDomainSpec",
      files.writeDomain,
    ];
    const runnerTaskPackagePath = taskPackagePathFor(task);
    if (runnerTaskPackagePath) args.push("--taskPackageFile", runnerTaskPackagePath);
    if (task.selection && typeof task.selection === "object") {
      writeJson(files.selection, task.selection);
      args.push("--selectionFile", files.selection);
    }
    if (task.simulation_profile && task.simulation_profile.persona) {
      args.push("--simProfileJson", JSON.stringify({
        role: task.simulation_profile.role || "",
        persona: task.simulation_profile.persona,
      }));
    }
    if (Number(task.turn_timeout_ms) > 0) {
      args.push("--turnTimeoutMs", String(task.turn_timeout_ms));
    }
    const elapsedLimitMinutes = Number(task.budget?.max_elapsed_minutes) > 0
      ? Number(task.budget.max_elapsed_minutes)
      : DEFAULT_ATTEMPT_ELAPSED_LIMIT_MINUTES;
    args.push("--timeoutMs", String(Math.round(elapsedLimitMinutes * 60000)));
    if (attempt.resume_session) {
      args.push("--resumeSession", String(attempt.resume_session));
    }
    args.push("--controlFile", files.cancelRequest, "--attemptId", attempt.attempt_id);
    const handoffCheck = handoffCheckSpec(task);
    if (handoffCheck) {
      args.push("--handoffCheck", JSON.stringify(handoffCheck));
    }

    const stdout = [];
    const stderr = [];
    const stdoutPath = attemptLogPath(task, "stdout", attempt.attempt);
    const stderrPath = attemptLogPath(task, "stderr", attempt.attempt);
    // Persist the edge before spawn and clear it only after the child PID is
    // persisted.  A worker crash while this edge is true is process-tree
    // confirmation-unknown unless a child PID can later be recovered from status.
    updateStatus(files, {
      runner_spawn_pending: true,
      child_pid: null,
      active_model: attempt.model,
      active_effort: attempt.effort,
      active_runtime_role: attempt.runtime_role,
    });
    const child = ctx.host.spawn(ctx.host.nodeExecutable, args, {
      cwd: task.target_cwd,
      windowsHide: true,
      // worker 内再派的子任务凭此身份在本任务写域内嵌套写入（claims.mjs assertWriteDomainAvailable）。
      env: { ...ctx.config.childEnv, SUBAGENT_PARENT_TASK_ID: task.task_id },
    });
    updateStatus(files, {
      child_pid: child.pid,
      runner_spawn_pending: false,
      active_attempt_id: attempt.attempt_id,
      active_model: attempt.model,
      active_effort: attempt.effort,
      active_runtime_role: attempt.runtime_role,
    });
    // Cancellation may race the tiny interval before active_attempt_id/child_pid were persisted.
    // Bind that already-persisted request to this exact attempt after spawn.
    const cancellationAtSpawn = readJson(files.status, {});
    if (cancellationAtSpawn.cancel_reason && cancellationAtSpawn.cancel_requested_at) {
      writeJson(files.cancelRequest, {
        contract_version: CONTRACT_VERSION,
        type: "abort",
        task_id: task.task_id,
        attempt_id: attempt.attempt_id,
        reason: cancellationAtSpawn.cancel_reason,
        requested_at: cancellationAtSpawn.cancel_requested_at || isoNow(),
      });
    }
    else if (cancellationAtSpawn.pause_requested_at) {
      writeJson(files.cancelRequest, { contract_version: CONTRACT_VERSION, type: "pause",
        task_id: task.task_id, attempt_id: attempt.attempt_id,
        reason: cancellationAtSpawn.pause_reason || "pause_requested",
        requested_at: cancellationAtSpawn.pause_requested_at });
    }
    // 逐 chunk 追加到 per-attempt 日志；首个 chunk 由 appendFileSync 惰性建文件，
    // 成功且无 stderr 输出时不落 child-runner.attempt-N.stderr.log 空文件。
    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      appendFileSync(stdoutPath, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      appendFileSync(stderrPath, chunk);
    });

    const stallMonitor = startStallMonitor(files, task, attempt);
    // 取消请求方可能是一次性 CLI；截止时间由持有 runner 的 worker 观察。
    let cancellationTimer = null;
    // 回合完成边界一经观察到即锁存：runner 收尾阶段可能整体重写 live 文件，边界字段短暂缺席不能触发强制清理。
    let attemptBoundaryCompleted = false;
    const checkCancellationDeadline = () => {
      const latest = readJson(files.status, {});
      const requestedAt = Date.parse(latest.cancel_requested_at || "");
      const boundary = readJson(files.childLive, {});
      attemptBoundaryCompleted = attemptBoundaryCompleted
        || (boundary.attempt_id === attempt.attempt_id && boundary.turn_completed === true);
      const turnCompleted = attemptBoundaryCompleted;
      if (!turnCompleted && latest.cancel_reason && latest.cancel_requested_at
          && latest.active_attempt_id === attempt.attempt_id
          && latest.child_pid === child.pid
          && !latest.cancel_force_cleanup_requested
          && Number.isFinite(requestedAt)
          && ctx.host.nowMs() - requestedAt >= CANCEL_FORCE_CLEANUP_MS) {
        // 先记强制收尾事实，避免 child close 抢先将结果标为可续跑。
        updateStatus(files, {
          cancel_force_cleanup_requested: true,
          error: "cooperative abort did not settle; process-tree cleanup requested",
        });
        try {
          const proof = typeof ctx.host.terminateProcessTreeConfirmed === "function"
            ? ctx.host.terminateProcessTreeConfirmed(child.pid)
            : { requested: Boolean(ctx.host.terminateProcessTree(child.pid)), confirmed: false };
          updateStatus(files, {
            retained_marker: proof.confirmed === true
              ? confirmedProcessTreeMarker(task, latest, "runner_force_cleanup")
              : { ...processTreeMarker(task.task_id, latest.pid, "runner_force_cleanup", latest.retained_marker), tracked_pids: proof.tracked_pids ?? null },
          });
        } catch (error) {
          updateStatus(files, { error: `process-tree cleanup failed: ${error?.message ?? error}` });
        }
      }
      cancellationTimer = ctx.host.setTimer(checkCancellationDeadline, 250);
      cancellationTimer?.unref?.();
    };
    checkCancellationDeadline();
    const exit = await new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    ctx.host.clearTimer(cancellationTimer);
    stallMonitor.stop();
    const cancellationStatus = readJson(files.status, {});
    const cancellationRequest = readJson(files.cancelRequest, null);
    const cancellationBound = Boolean(cancellationStatus.cancel_reason && cancellationStatus.cancel_requested_at)
      && String(cancellationStatus.active_attempt_id || "") === attempt.attempt_id;
    if (cancellationRequest?.attempt_id === attempt.attempt_id) rmSync(files.cancelRequest, { force: true });
    updateStatus(files, { runner_spawn_pending: false, child_pid: null });
    const childResult = readJson(files.childResult, null);
    const childWriteDomain = objectOrEmpty(childResult?.write_domain);
    const writeDomainEnabled = typeof childWriteDomain.enabled === "boolean" ? childWriteDomain.enabled : null;
    const writeDomainScopeCompliant = typeof childWriteDomain.scope_compliant === "boolean"
      ? childWriteDomain.scope_compliant
      : null;
    const writeDomainAuditComplete = typeof childWriteDomain.audit_complete === "boolean"
      ? childWriteDomain.audit_complete
      : null;
    const writeDomainViolationCount = Math.max(
      0,
      Number(childWriteDomain.violation_count ?? childWriteDomain.blocked_count) || 0,
    );
    const writeDomainReportedViolationCount = Math.max(0, Number(childWriteDomain.reported_violation_count) || 0);
    const writeDomainCoveredTools = Array.isArray(childWriteDomain.covered_tools)
      ? childWriteDomain.covered_tools.map((item) => String(item))
      : [];
    const writeDomainCommandWriteEnforced = childWriteDomain.command_write_enforced === true;
    const writeDomainAuditPath = typeof childWriteDomain.audit_path === "string" && childWriteDomain.audit_path
      ? childWriteDomain.audit_path
      : null;
    const finalPath = path.join(task.task_dir, "child-final.md");
    const finalText = existsSync(finalPath) ? readFileSync(finalPath, "utf8") : "";
    const runnerCancellation = childResult?.cancellation;
    const completedBoundary = readJson(files.childLive, {});
    const completedBeforeCancellation = !runnerCancellation?.requested
      && (childResult?.turn?.completed === true
        || (completedBoundary.attempt_id === attempt.attempt_id && completedBoundary.turn_completed === true));
    const runnerPause = childResult?.pause;
    if (!cancellationBound && runnerPause?.requested === true && runnerPause.attempt_id === attempt.attempt_id) {
      const sessionFile = reportedSessionFile(childResult);
      let readable = false;
      try { readable = Boolean(sessionFile && statSync(sessionFile).isFile() && readFileSync(sessionFile, "utf8").trim()); } catch {}
      const stopped = runnerPause.graceful === true && childResult?.cleanup?.tree_confirmed === true;
      const restart = stopped && !sessionFile && !childResult?.session?.read_error;
      const paused = restart || (stopped && readable && childResult?.session?.resumable === true);
      return { ...attempt, state: paused ? "paused" : "running", resume_mode: restart ? "start" : "session",
        retained_worker: !stopped, contract_state: paused ? "paused" : "pause_unconfirmed",
        business_state: "unknown", artifact_state: paused ? "paused_session" : "pause_unconfirmed",
        requires_parent_review: !paused, resumable: paused, session_file: sessionFile,
        child_result: childResult, final_text: finalText, exit_code: exit.code, signal: exit.signal,
        stdout_path: stdoutPath, stderr_path: stderrPath, failure_type: paused ? "none" : "pause_unconfirmed",
        error: paused ? null : "Pause could not prove stop and a readable saved session; inspect runner evidence and restore the original session, or explicitly cancel to terminate. Write claims remain reserved." };
    }
    if (!completedBeforeCancellation && (cancellationBound || runnerCancellation?.requested === true)) {
      const cancelReason = String(
        cancellationStatus.cancel_reason
          || cancellationRequest?.reason
          || runnerCancellation?.reason
          || "cancelled",
      );
      const treeConfirmed = childResult?.cleanup?.tree_confirmed === true
        || (cancellationStatus.cancel_force_cleanup_requested === true && cancellationStatus.retained_marker?.termination_confirmed === true);
      const graceful = treeConfirmed && runnerCancellation?.graceful === true
        && runnerCancellation?.attempt_id === attempt.attempt_id
        && cancellationStatus.cancel_force_cleanup_requested !== true;
      const sessionFile = reportedSessionFile(childResult);
      return {
        ...attempt,
        state: treeConfirmed ? "cancelled" : "failed",
        retained_worker: !treeConfirmed,
        tracked_pids: childResult?.cleanup?.remaining_pids ?? cancellationStatus.retained_marker?.tracked_pids ?? null,
        contract_state: "cancelled",
        business_state: "unknown",
        business_state_raw: null,
        artifact_state: graceful ? "cancelled_resumable" : "cancelled_forced",
        requires_parent_review: !treeConfirmed || cancelReason !== "user_requested",
        salvage_report_path: RETIRED_SALVAGE_REPORT_PATH,
        salvage_evidence_paths: [],
        synthetic_artifacts: [],
        exit_code: exit.code,
        signal: exit.signal,
        failure_type: "cancelled",
        turn_status: childResult?.turn?.status ?? null,
        error: !treeConfirmed ? "process-tree termination is not confirmed; write claim retained"
          : graceful ? "runner aborted and reached settled/idle" : "runner cancellation required force cleanup or did not prove settled/idle",
        cancel_reason: cancelReason,
        last_progress_line: "",
        child_result: childResult,
        final_text: finalText,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        // Path is observational; resumable stays gated on cooperative abort proof.
        resumable: graceful && childResult?.session?.resumable === true,
        session_file: sessionFile,
        write_domain_profile: childWriteDomain.profile ?? null,
        write_domain_enabled: writeDomainEnabled,
        write_domain_scope_compliant: writeDomainScopeCompliant,
        write_domain_audit_complete: writeDomainAuditComplete,
        write_domain_violation_count: writeDomainViolationCount,
        write_domain_reported_violation_count: writeDomainReportedViolationCount,
        write_domain_covered_tools: writeDomainCoveredTools,
        write_domain_command_write_enforced: writeDomainCommandWriteEnforced,
        write_domain_audit_path: writeDomainAuditPath,
      };
    }
    // 运输是否完成不能只看 exit code：child runner 在 task 非 completed（如 partial/blocked）时
    // 仍会正常跑完一整轮 turn，但因顶层 result.ok=false 而以非零码退出。有 orchestration 字段时，
    // 以 orchestration.ok（turn 是否正常结束）为准；没有该字段（如未升级的 child runner）时退回旧的 exit-code 判定。
    const orchestration = childResult?.orchestration;
    const rawDone =
      orchestration && typeof orchestration.ok === "boolean"
        ? orchestration.ok
        : exit.code === 0 && childResult?.ok !== false;
    // 跨仓与同仓同口径：声明的 report/handoff 由 child 写，wrapper 不代写；缺失走 missing_required_output。
    const businessOutputs = taskPackageOutputs(task);
    const missingOutputs = rawDone
      ? [
          !existsSync(files.report) ? "report" : "",
          !existsSync(files.handoff) ? "handoff" : "",
        ].filter(Boolean)
      : [];

    let contractState = classifyContractState(rawDone, missingOutputs, businessOutputs);
    const businessClassification = rawDone
      ? classifyBusinessState(childResult)
      : { state: "unknown", raw: null };
    const businessState = businessClassification.state;
    const businessStateRaw = businessClassification.raw;

    let syntheticArtifacts = [];
    let artifactState = missingOutputs.length ? "runtime_artifact_missing" : "runtime_artifact_present";
    if (contractState === "artifact_path_mismatch") {
      if (missingOutputs.includes("report") && businessOutputs.business_report_path) {
        if (synthesizeArtifactPointer(files.report, businessOutputs.business_report_path, "report")) {
          syntheticArtifacts.push("report");
        }
      }
      if (missingOutputs.includes("handoff") && businessOutputs.business_handoff_path) {
        if (synthesizeArtifactPointer(files.handoff, businessOutputs.business_handoff_path, "handoff")) {
          syntheticArtifacts.push("handoff");
        }
      }
      if (missingOutputs.every((item) => syntheticArtifacts.includes(item))) {
        contractState = "ok";
        artifactState = "durable_artifact_pointer";
      } else {
        artifactState = "durable_artifact_pointer_incomplete";
      }
    }
    if (contractState === "missing_required_output") {
      const childFinalArtifacts = synthesizeArtifactsFromChildFinal(files, finalPath, finalText, task);
      if (missingOutputs.length > 0 && missingOutputs.every((item) => childFinalArtifacts.includes(item))) {
        syntheticArtifacts = [...syntheticArtifacts, ...childFinalArtifacts];
        contractState = "ok";
        artifactState = "child_final_synthesized";
      }
    }

    // 判失败的唯一入口：运输/契约层判定为 invalid_final 或 missing_required_output
    // （即 rawDone=false，或 rawDone=true 但 runtime 与 durable 报告都缺）。
    // task_partial、completed_with_uncertainty 等业务状态不再降级为 failed。
    const state = contractState === "ok" || contractState === "artifact_path_mismatch" ? "done" : "failed";
    // A3：非 ok 终态不再合成 partial-observation.md，改为指针化——列出 task_dir 内实际存在的原件路径，
    // 主代理直接读原件排障。salvage 证据不改变 business_state 判定。
    const salvageEvidencePaths = state === "failed" ? collectSalvageEvidencePaths(files) : [];
    // A1 review 联动不变量：business_state ∈ {partial,blocked,failed,unknown} 或 contract_state ≠ ok
    // 或有 salvage 证据 → requires_parent_review=true。completed_with_uncertainty 与合成产物沿用既有触发。
    const reviewBusinessStates = new Set(["partial", "blocked", "failed", "unknown", "completed_with_uncertainty"]);
    const requiresParentReview =
      reviewBusinessStates.has(businessState) ||
      contractState !== "ok" ||
      salvageEvidencePaths.length > 0 ||
      artifactState === "child_final_synthesized" ||
      writeDomainScopeCompliant === false;
    // 模型错误只取最后一条回执的 errorMessage。缺交付时把缺口和该错误写在摘要前部，截断后两者仍可见；
    // 交付已齐时不把尾部错误写进 status.error，避免推翻已有效结果。
    const finalModelError = childResult?.diagnostics?.stop_reason === "error"
      ? String(childResult?.diagnostics?.last_error_message || "").trim() : "";
    const errorLead = finalModelError.match(/service(?:\s+is)?\s+temporarily\s+unavailable|availability is currently degraded/i)?.[0]
      || finalModelError.slice(0, 80);
    const missingOutputError = missingOutputs.length
      ? finalModelError
        ? `缺少${missingOutputs.join("、")}。${errorLead}。模型错误：${finalModelError.slice(0, 300)}。用subagent_get核对会话恢复条件。`
        : `child runner completed without required output: ${missingOutputs.join(", ")}`
      : "";
    const progressLine = state === "failed" ? lastProgressLine(finalText) : "";
    const sessionFile = reportedSessionFile(childResult);

    return {
      ...attempt,
      state,
      contract_state: contractState,
      business_state: businessState,
      business_state_raw: businessStateRaw,
      artifact_state: artifactState,
      requires_parent_review: requiresParentReview,
      salvage_report_path: RETIRED_SALVAGE_REPORT_PATH,
      salvage_evidence_paths: salvageEvidencePaths,
      synthetic_artifacts: syntheticArtifacts,
      exit_code: exit.code,
      signal: exit.signal,
      failure_type: state === "done" ? "none" : missingOutputError && contractState === "missing_required_output" ? "missing_required_output" : fallbackFailureType(childResult, exit),
      turn_status: childResult?.turn?.status ?? (childResult?.turn?.completed === true ? "completed" : null),
      error: state === "done" ? null : finalModelError && missingOutputs.length
        ? missingOutputError
        : childResult?.error ?? (missingOutputError || `child runner exited ${exit.code}`),
      latest_model_error: finalModelError || null,
      last_progress_line: progressLine,
      child_result: childResult,
      final_text: finalText,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      resumable: state === "failed" && childResult?.session?.resumable === true,
      session_file: state === "failed" ? sessionFile : null,
      write_domain_profile: childWriteDomain.profile ?? null,
      write_domain_enabled: writeDomainEnabled,
      write_domain_scope_compliant: writeDomainScopeCompliant,
      write_domain_audit_complete: writeDomainAuditComplete,
      write_domain_violation_count: writeDomainViolationCount,
      write_domain_reported_violation_count: writeDomainReportedViolationCount,
      write_domain_covered_tools: writeDomainCoveredTools,
      write_domain_command_write_enforced: writeDomainCommandWriteEnforced,
      write_domain_audit_path: writeDomainAuditPath,
    };
  }

  return {
    runChildAttempt,
  };
}
