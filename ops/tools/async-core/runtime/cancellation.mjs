import path from "node:path";
import { pick, readJson } from "../../_fs-utils.mjs";
import { CONTRACT_VERSION, isTerminalState } from ".././contracts.mjs";
import {
  PROCESS_TREE_TERMINATION_UNCONFIRMED_REASON,
  REVISION_CONFLICT_NEXT_STEP,
  isUnconfirmedRetainedProcessTree,
} from "./shared.mjs";

export function createCancellation(ctx, rt) {
  const writeJson = (...args) => rt.writeJson(...args);
  const isoNow = (...args) => rt.isoNow(...args);
  const loadLocatedTask = (...args) => rt.loadLocatedTask(...args);
  const processTreeMarker = (...args) => rt.processTreeMarker(...args);
  const producerRootForTask = (...args) => rt.producerRootForTask(...args);
  const withWriteClaimLock = (...args) => rt.withWriteClaimLock(...args);
  const releaseWriteClaimForTask = (...args) => rt.releaseWriteClaimForTask(...args);
  const updateStatus = (...args) => rt.updateStatus(...args);
  const completionNoticePath = (...args) => rt.completionNoticePath(...args);
  const writeCompletionNotice = (...args) => rt.writeCompletionNotice(...args);
  const writeResultReceipt = (...args) => rt.writeResultReceipt(...args);
  const processAlive = (...args) => rt.processAlive(...args);
  const worker = (...args) => rt.worker(...args);

  function cancelTask(input = {}) {
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    if (!taskId) throw new Error("cancel requires task_id");
    const { taskRoot, task } = loadLocatedTask(input, taskId);
    return withWriteClaimLock(task.producer_root || producerRootForTask({}, taskRoot), () => cancelTaskLocked(input));
  }

  function cancelTaskLocked(input = {}) {
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    if (!taskId) {
      throw new Error("cancel requires task_id");
    }
    const { taskRoot, files, task } = loadLocatedTask(input, taskId);
    const status = readJson(files.status, {});
    const expectedRevision = pick(input, ["expected-revision", "expected_revision", "expectedRevision"], "");
    if (expectedRevision && String(status.rev ?? 0) !== expectedRevision) {
      return {
        ok: false,
        task_id: taskId,
        state: status.state,
        revision: String(status.rev ?? 0),
        killed: false,
        reason: "revision_conflict",
        next_step: REVISION_CONFLICT_NEXT_STEP,
      };
    }
    const cancelReason = String(pick(input, ["reason"], "") ?? "").trim();
    if (!cancelReason) throw new Error("cancel requires a non-empty reason");
    if (cancelReason.length > 1024) throw new Error("cancel reason must contain at most 1024 characters");

    const requestRunnerCancellation = (currentStatus) => {
      const attemptId = String(currentStatus?.active_attempt_id || "");
      const request = {
        contract_version: CONTRACT_VERSION,
        type: "abort",
        task_id: taskId,
        attempt_id: attemptId || null,
        reason: cancelReason,
        requested_at: currentStatus.cancel_requested_at || isoNow(),
      };
      if (attemptId) writeJson(files.cancelRequest, request);
      const next = updateStatus(files, {
        state: "cancel_requested",
        cancel_reason: cancelReason,
        cancel_requested_at: request.requested_at,
        cancel_force_cleanup_requested: currentStatus.cancel_force_cleanup_requested === true,
        requires_parent_review: cancelReason !== "user_requested",
        completion_notice_path: null,
        finished_at: null,
        error: "cooperative runner abort requested",
      });
      return {
        ok: true,
        task_id: taskId,
        state: "cancel_requested",
        revision: String(next.rev ?? 0),
        killed: false,
        reason: "cancellation_accepted",
      };
    };

    const retainAfterTerminationRequest = (currentStatus) => {
      const priorMarker = currentStatus?.retained_marker;
      // A normal running worker remains alive to perform its own awaited runner
      // finalization; an already-retained/cancel-requested tree may receive the
      // best-effort host termination request again.  Neither path is confirmation.
      const retainedTree = currentStatus?.retained_worker === true
        || currentStatus?.state === "cancel_requested"
        || isTerminalState(currentStatus?.state);
      const directRunnerKnown = Number.isInteger(Number(currentStatus?.child_pid))
        && Number(currentStatus.child_pid) > 0;
      const requestHostTermination = retainedTree || directRunnerKnown;
      const terminationPids = requestHostTermination
        ? [...new Set((retainedTree
            ? [currentStatus?.pid, currentStatus?.child_pid, priorMarker?.pid]
            : [currentStatus?.child_pid]
          ).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))]
        : [];
      let terminationRequested = false;
      const terminationErrors = [];
      for (const terminationPid of terminationPids) {
        try {
          terminationRequested = Boolean(ctx.host.terminateProcessTree(terminationPid)) || terminationRequested;
        } catch (error) {
          terminationErrors.push(error?.message ?? String(error));
        }
      }
      let topPidAlive = null;
      if (currentStatus?.pid) {
        try {
          topPidAlive = processAlive(currentStatus.pid);
        } catch (error) {
          terminationErrors.push(error?.message ?? String(error));
        }
      }
      let childPidAlive = null;
      if (currentStatus?.child_pid) {
        try {
          childPidAlive = processAlive(currentStatus.child_pid);
        } catch (error) {
          terminationErrors.push(error?.message ?? String(error));
        }
      }
      const marker = {
        ...processTreeMarker(taskId, currentStatus?.pid, "cancel", priorMarker),
        termination_requested: Boolean(priorMarker?.termination_requested || terminationRequested),
        termination_confirmed: false,
        top_pid_alive: topPidAlive,
        child_pid: currentStatus?.child_pid ?? priorMarker?.child_pid ?? null,
        child_pid_alive: childPidAlive,
        ...(terminationRequested ? { termination_requested_at: isoNow() } : {}),
        ...(terminationErrors.length ? { termination_errors: terminationErrors } : {}),
      };
      const errorParts = [
        "process-tree termination is not confirmed",
        terminationErrors.length ? terminationErrors.join("; ") : "",
      ].filter(Boolean);
      updateStatus(files, {
        state: "cancel_requested",
        cancel_reason: cancelReason,
        retained_worker: true,
        retained_marker: marker,
        requires_parent_review: false,
        completion_notice_path: null,
        finished_at: null,
        error: errorParts.join(": "),
      });
      const updated = readJson(files.status, {});
      return {
        ok: false,
        task_id: taskId,
        state: "cancel_requested",
        revision: String(updated.rev ?? 0),
        killed: false,
        reason: PROCESS_TREE_TERMINATION_UNCONFIRMED_REASON,
      };
    };

    // A persisted retained marker takes precedence over any apparent terminal state.
    // Cancellation can request termination, but it cannot manufacture confirmation.
    if (
      isUnconfirmedRetainedProcessTree(status)
      && (status.retained_worker === true || status.cancel_force_cleanup_requested === true || isTerminalState(status.state))
    ) {
      return retainAfterTerminationRequest(status);
    }

    if (status.state === "paused" && !isUnconfirmedRetainedProcessTree(status)) {
      const next = updateStatus(files, { state: "cancelled", cancel_reason: cancelReason,
        finished_at: isoNow(), completion_notice_path: completionNoticePath(task), error: null });
      releaseWriteClaimForTask(task);
      writeResultReceipt(files, task);
      writeCompletionNotice(files, task);
      return { ok: true, task_id: taskId, state: "cancelled", revision: String(next.rev), killed: false, reason: "paused_task_cancelled" };
    }
    const pid = status.pid;
    const cancellable = new Set(["submitted", "queued", "running", "cancel_requested"]);
    if (!cancellable.has(status.state)) {
      return {
        ok: true,
        task_id: taskId,
        state: status.state,
        killed: false,
        reason: "task_not_running",
      };
    }
    if (!pid) {
      const latest = readJson(files.status, {});
      if (expectedRevision && String(latest.rev ?? 0) !== expectedRevision) {
        return {
          ok: false,
          task_id: taskId,
          state: latest.state,
          revision: String(latest.rev ?? 0),
          killed: false,
          reason: "revision_conflict",
          next_step: REVISION_CONFLICT_NEXT_STEP,
        };
      }
      if (isUnconfirmedRetainedProcessTree(latest)) {
        return retainAfterTerminationRequest(latest);
      }
      const completionNotice = completionNoticePath(task);
      updateStatus(files, {
        state: "cancelled",
        cancel_reason: cancelReason,
        requires_parent_review: cancelReason !== "user_requested",
        completion_notice_path: completionNotice,
        error: "No worker pid recorded.",
        finished_at: isoNow(),
      });
      writeResultReceipt(files, task);
      writeCompletionNotice(files, task);
      return { ok: true, task_id: taskId, state: "cancelled", killed: false };
    }

    const alive = processAlive(pid);
    if (!alive) {
      // A retained marker still requires an explicit persisted confirmation; top-PID
      // death alone is not evidence that a detached runner descendant stopped.
      const latest = readJson(files.status, {});
      if (isUnconfirmedRetainedProcessTree(latest)) {
        return retainAfterTerminationRequest(latest);
      }
      // 竞态守卫：读 pid 到此处之间 worker 可能已正常收尾，重读终态则不覆写。
      if (isTerminalState(latest.state)) {
        return { ok: true, task_id: taskId, state: latest.state, killed: false, reason: "task_already_finished" };
      }
      updateStatus(files, {
        state: "failed",
        contract_state: "invalid_final",
        business_state: "unknown",
        artifact_state: "worker_exit_before_final",
        requires_parent_review: true,
        failure_type: "worker_process_exit",
        error: `Worker pid ${pid} is not alive and task did not finish cleanly.`,
        completion_notice_path: completionNoticePath(task),
        finished_at: isoNow(),
      });
      writeResultReceipt(files, task);
      writeCompletionNotice(files, task);
      return { ok: false, task_id: taskId, state: "failed", killed: false };
    }

    const beforeKill = readJson(files.status, {});
    if (expectedRevision && String(beforeKill.rev ?? 0) !== expectedRevision) {
      return {
        ok: false,
        task_id: taskId,
        state: beforeKill.state,
        revision: String(beforeKill.rev ?? 0),
        killed: false,
        reason: "revision_conflict",
        next_step: REVISION_CONFLICT_NEXT_STEP,
      };
    }
    if (
      isUnconfirmedRetainedProcessTree(beforeKill)
      && (beforeKill.retained_worker === true || beforeKill.cancel_force_cleanup_requested === true || isTerminalState(beforeKill.state))
    ) {
      return retainAfterTerminationRequest(beforeKill);
    }

    // Active tasks first receive an attempt-bound request. The runner performs Pi RPC abort and
    // persists whether it reached settled/idle; the task's worker owns the force-cleanup deadline.
    return requestRunnerCancellation(beforeKill);
  }

  return {
    cancelTask,
    cancelTaskLocked,
  };
}
