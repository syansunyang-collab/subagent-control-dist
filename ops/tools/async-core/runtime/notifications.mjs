import { existsSync, rmSync, watch } from "node:fs";
import path from "node:path";
import { pick, readJson } from "../../_fs-utils.mjs";
import { MAX_WAIT_MS, isTerminalState } from ".././contracts.mjs";
import {
  PROCESS_TREE_TERMINATION_UNCONFIRMED_REASON,
  STALL_CHECK_INTERVAL_MAX_MS,
  RETIRED_SALVAGE_REPORT_PATH,
  isUnconfirmedRetainedProcessTree,
} from "./shared.mjs";

export function createNotifications(ctx, rt) {
  const pickBool = (...args) => rt.pickBool(...args);
  const pickNumber = (...args) => rt.pickNumber(...args);
  const writeJson = (...args) => rt.writeJson(...args);
  const isoNow = (...args) => rt.isoNow(...args);
  const loadLocatedTask = (...args) => rt.loadLocatedTask(...args);
  const processTreeMarker = (...args) => rt.processTreeMarker(...args);
  const releaseWriteClaimForTask = (...args) => rt.releaseWriteClaimForTask(...args);
  const updateStatus = (...args) => rt.updateStatus(...args);
  const normalizeLiveStatus = (...args) => rt.normalizeLiveStatus(...args);
  const mergeChildLiveStatus = (...args) => rt.mergeChildLiveStatus(...args);
  const progressAggregate = (...args) => rt.progressAggregate(...args);
  const taskPackageOutputs = (...args) => rt.taskPackageOutputs(...args);
  const writeResultReceipt = (...args) => rt.writeResultReceipt(...args);
  const processAlive = (...args) => rt.processAlive(...args);
  const hostRebootAfterTask = (...args) => rt.hostRebootAfterTask(...args);
  const confirmProcessTreeAfterHostReboot = (...args) => rt.confirmProcessTreeAfterHostReboot(...args);
  const resultAttestationRequired = (...args) => rt.resultAttestationRequired(...args);
  const writeResultAttestation = (...args) => rt.writeResultAttestation(...args);
  const worker = (...args) => rt.worker(...args);

  function completionInboxDir(taskRoot) {
    return path.join(path.dirname(path.resolve(taskRoot)), "async_inbox");
  }

  function completionNoticePath(task) {
    return path.join(completionInboxDir(task.task_root), `${task.task_id}.json`);
  }

  function attentionNoticePath(task) {
    return path.join(completionInboxDir(task.task_root), `${task.task_id}.attention.json`);
  }

  function writeAttentionNotice(files, task, status) {
    // 正在收敛的 cancel / pause 不打扰等待者；只有 worker 被保留或已无人收敛时才叫醒。
    const workerGone = () => !status.pid || !processAlive(status.pid);
    const reason = status.state === "paused" ? "paused"
      : status.retained_worker === true || (status.state === "cancel_requested" && workerGone()) ? "cleanup_required"
      : status.contract_state === "pause_unconfirmed" && workerGone() ? "pause_unconfirmed" : null;
    if (!reason || !task.task_root) return;
    const noticePath = attentionNoticePath(task);
    const revision = String(status.rev);
    if (readJson(noticePath, null)?.revision === revision) return;
    writeJson(noticePath, {
      type: "attention", task_id: task.task_id, revision, state: status.state, reason,
      next_action: reason === "paused"
        ? "Use subagent_resume after a new continue instruction, or subagent_cancel to stop."
        : "Inspect subagent_get diagnostics; explicitly subagent_cancel to confirm cleanup.",
      status_path: files.status,
    });
  }

  function stallNoticePath(task) {
    return path.join(completionInboxDir(task.task_root), `${task.task_id}.stall.json`);
  }

  function writeCompletionNotice(files, task) {
    const status = statusTask({ task_root: task.task_root, task_id: task.task_id });
    const businessOutputs = taskPackageOutputs(task);
    const noticePath = status.completion_notice_path || completionNoticePath(task);
    const notice = {
      task_id: task.task_id,
      state: status.state,
      contract_state: status.contract_state ?? null,
      business_state: status.business_state ?? null,
      business_state_raw: status.business_state_raw ?? null,
      artifact_state: status.artifact_state ?? null,
      requires_parent_review: status.requires_parent_review ?? false,
      salvage_report_path: RETIRED_SALVAGE_REPORT_PATH,
      salvage_evidence_paths: status.salvage_evidence_paths ?? [],
      cancel_reason: status.cancel_reason ?? null,
      failure_type: status.failure_type ?? null,
      turn_status: status.turn_status ?? null,
      exit_code: status.exit_code ?? null,
      signal: status.signal ?? null,
      revision: status.revision,
      status_rev: status.status_rev,
      live_rev: status.live_rev,
      finished_at: status.finished_at ?? isoNow(),
      task_dir: task.task_dir,
      status_path: files.status,
      report_path: businessOutputs.business_report_path || status.report,
      handoff_path: businessOutputs.business_handoff_path || status.handoff,
      report_source: businessOutputs.business_report_path ? "task_package" : "runtime_wrapper",
      handoff_source: businessOutputs.business_handoff_path ? "task_package" : "runtime_wrapper",
      wrapper_report_path: status.report,
      wrapper_handoff_path: status.handoff,
      declared_report_path: businessOutputs.declared_report_path,
      declared_handoff_path: businessOutputs.declared_handoff_path,
      business_report_path: businessOutputs.business_report_path,
      business_handoff_path: businessOutputs.business_handoff_path,
      child_result_path: status.child_result_path ?? files.childResult,
      resumable: status.resumable === true,
      session_file: status.session_file ?? null,
      attestation_path: status.attestation_path ?? null,
      attestation_verified: status.attestation_verified ?? null,
      write_domain_profile: status.write_domain_profile ?? null,
      write_domain_enabled: status.write_domain_enabled ?? null,
      write_domain_scope_compliant: status.write_domain_scope_compliant ?? null,
      write_domain_audit_complete: status.write_domain_audit_complete ?? null,
      write_domain_violation_count: status.write_domain_violation_count ?? 0,
      write_domain_reported_violation_count: status.write_domain_reported_violation_count ?? 0,
      write_domain_covered_tools: Array.isArray(status.write_domain_covered_tools) ? status.write_domain_covered_tools : [],
      write_domain_command_write_enforced: status.write_domain_command_write_enforced === true,
      write_domain_audit_path: status.write_domain_audit_path ?? null,
      live_path: status.live_path,
      error: status.error ?? null,
      latest_model_error: status.latest_model_error ?? null,
    };
    writeJson(noticePath, notice);
    return noticePath;
  }

  function statusTask(input = {}) {
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    if (!taskId) {
      throw new Error("status requires task_id");
    }
    const { taskRoot, files, task } = loadLocatedTask(input, taskId);
    const status = readJson(files.status, {});
    const alive = status.pid ? processAlive(status.pid) : null;
    const merged = mergeChildLiveStatus(files, status, alive);
    if ((isTerminalState(merged.state) || merged.state === "paused") && !isUnconfirmedRetainedProcessTree(merged)) {
      releaseWriteClaimForTask(task);
    }
    const aggregate = progressAggregate(merged, task);
    // 终态项补声明/业务产物路径，主代理不进 runtime 目录即可判断有无可用产物。
    let terminalOutputs = {};
    if (isTerminalState(merged.state)) {
      const businessOutputs = taskPackageOutputs(task);
      terminalOutputs = {
        declared_report_path: businessOutputs.declared_report_path,
        declared_handoff_path: businessOutputs.declared_handoff_path,
        business_report_path: businessOutputs.business_report_path,
        business_handoff_path: businessOutputs.business_handoff_path,
      };
    }
    return {
      ok: true,
      ...merged,
      ...aggregate,
      ...terminalOutputs,
      // Active fields identify the selected runtime attempt, not provider-attested execution.
      model: merged.active_model ?? task.model ?? null,
      effort: merged.active_effort ?? task.effort ?? null,
      model_source: merged.active_model != null ? "runtime_attempt" : task.model != null ? "task_config" : "unknown",
      effort_source: merged.active_effort != null ? "runtime_attempt" : task.effort != null ? "task_config" : "unknown",
      process_alive: status.pid ? alive : null,
    };
  }

  function reconcileTask(input = {}) {
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    if (!taskId) {
      throw new Error("reconcile requires task_id");
    }
    const { taskRoot, files, task } = loadLocatedTask(input, taskId);
    const status = readJson(files.status, {});
    const reboot = isUnconfirmedRetainedProcessTree(status) ? hostRebootAfterTask(status) : null;
    if (reboot) {
      confirmProcessTreeAfterHostReboot(files, task, status, reboot);
    }
    const current = reboot ? readJson(files.status, status) : status;
    const alive = current.pid ? processAlive(current.pid) : null;
    writeAttentionNotice(files, task, current);
    if (current.state === "paused" || (current.pause_requested_at && !current.cancel_requested_at)) {
      return statusTask({ ...input, task_root: taskRoot, task_id: taskId });
    }
    // worker 已写出的业务终态与资源保留分别消费；不改成无法投递终态的取消中状态。
    if (isTerminalState(current.state) && isUnconfirmedRetainedProcessTree(current) && current.retained_marker?.source === "runner_cleanup") {
      return statusTask({ ...input, task_root: taskRoot, task_id: taskId });
    }
    if (
      isUnconfirmedRetainedProcessTree(current)
      && (isTerminalState(current.state) || current.state === "cancel_requested" || alive === false)
    ) {
      const latest = readJson(files.status, status);
      const marker = processTreeMarker(latest.task_id || taskId, latest.pid, "reconcile", latest.retained_marker);
      const patch = {
        state: "cancel_requested",
        cancel_reason: latest.cancel_reason || PROCESS_TREE_TERMINATION_UNCONFIRMED_REASON,
        retained_worker: true,
        retained_marker: {
          ...marker,
          top_pid_alive: latest.pid ? processAlive(latest.pid) : null,
          termination_confirmed: false,
        },
        completion_notice_path: null,
        finished_at: null,
        error: "process-tree termination is not confirmed; reconciliation remains fail-closed",
      };
      if (
        latest.state !== patch.state
        || latest.cancel_reason !== patch.cancel_reason
        || latest.error !== patch.error
        || latest.completion_notice_path !== null
        || latest.finished_at !== null
      ) {
        updateStatus(files, patch);
      }
      return statusTask({ ...input, task_root: taskRoot, task_id: taskId });
    }
    const normalized = normalizeLiveStatus(files, current, alive);
    const attestationMissing = (
      normalized.state === "done"
      && resultAttestationRequired(task)
      && !existsSync(files.attestation)
    );
    if (
      isTerminalState(normalized.state)
      && !isUnconfirmedRetainedProcessTree(normalized)
      && (!isTerminalState(status.state) || !existsSync(completionNoticePath(task)) || attestationMissing || reboot)
    ) {
      let attestation = existsSync(files.attestation) ? readJson(files.attestation, null) : null;
      if (attestationMissing) {
        attestation = writeResultAttestation(files, task, {
          state: normalized.state,
          child_result: readJson(files.childResult, null),
        });
        if (attestation) {
          if (!attestation.verified && normalized.state === "done") {
            const failureType = task.result_mode === "real_rerun"
              ? "cross_repo_attestation_failed"
              : "artifact_attestation_failed";
            updateStatus(files, {
              state: "failed",
              contract_state: failureType,
              artifact_state: failureType,
              requires_parent_review: true,
              failure_type: failureType,
              error: attestation.summary,
              salvage_evidence_paths: [...new Set([...(normalized.salvage_evidence_paths || []), files.attestation])],
              attestation_path: files.attestation,
              attestation_verified: false,
            });
          } else {
            updateStatus(files, {
              attestation_path: files.attestation,
              attestation_verified: Boolean(attestation.verified),
            });
          }
        }
      }
      const latest = readJson(files.status, normalized);
      if (!isTerminalState(status.state) || !latest.completion_notice_path) {
        updateStatus(files, { completion_notice_path: completionNoticePath(task) });
      }
      writeResultReceipt(files, task);
      writeCompletionNotice(files, task);
    }
    return statusTask({ ...input, task_root: taskRoot, task_id: taskId });
  }

  function waitForCompletionNotice(noticePath, waitMs) {
    return waitForNotices({ completionPath: noticePath }, waitMs).then((observed) => observed.completion);
  }

  // 完成优先；attention / stall 按调用方的 revision 游标过滤已读通知。
  function waitForNotices({ completionPath, stallPath = null, stallAccept = () => true,
    attentionPath = null, attentionAccept = () => true }, waitMs) {
    const none = { completion: false, stall: false };
    const observe = () => {
      if (existsSync(completionPath)) return { completion: true, stall: false };
      if (attentionPath && existsSync(attentionPath) && attentionAccept(readJson(attentionPath, {}))) {
        return { completion: false, stall: false, attention: true };
      }
      if (stallPath && existsSync(stallPath) && stallAccept(readJson(stallPath, {}))) {
        return { completion: false, stall: true };
      }
      return null;
    };
    const initial = observe();
    if (initial || waitMs <= 0) {
      return Promise.resolve(initial || none);
    }
    const inbox = path.dirname(completionPath);
    if (!existsSync(inbox)) {
      return new Promise((resolve) => {
        ctx.host.setTimer(() => resolve(observe() || none), waitMs);
      });
    }
    return new Promise((resolve) => {
      let settled = false;
      let watcher = null;
      const finish = (observed) => {
        if (settled) {
          return;
        }
        settled = true;
        ctx.host.clearTimer(timer);
        watcher?.close();
        resolve(observed || none);
      };
      const timer = ctx.host.setTimer(() => finish(observe()), waitMs);
      try {
        watcher = watch(inbox, { persistent: true }, () => {
          const observed = observe();
          if (observed) {
            finish(observed);
          }
        });
        watcher.on("error", () => {
          watcher?.close();
          watcher = null;
        });
      } catch {
        // 文件系统不支持 watch 时保持纯 idle，到期后只检查一次。
      }
      const observed = observe();
      if (observed) {
        finish(observed);
      }
    });
  }

  async function waitTask(input = {}) {
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    if (!taskId) {
      throw new Error("wait requires task_id");
    }
    const { taskRoot, task, files } = loadLocatedTask(input, taskId);
    const afterRevision = pick(input, ["after-rev", "after_rev", "afterRev", "revision"], "");
    const terminalOnly = pickBool(input, ["terminal-only", "terminal_only", "terminalOnly", "until-terminal", "until_terminal", "untilTerminal"], true);
    const waitMs = Math.min(
      Math.max(pickNumber(input, ["wait-ms", "wait_ms", "waitMs"], 60000) ?? 60000, 0),
      MAX_WAIT_MS,
    );
    const stallPath = stallNoticePath(task);
    // after_rev 可能是 "statusRev:liveRev" 复合格式，只取 status rev 比较。
    const afterStatusRev = Number(String(afterRevision).split(":")[0]);
    const stallAccept = (notice) => !afterRevision
      || !Number.isFinite(afterStatusRev)
      || Number(notice?.status_rev ?? 0) > afterStatusRev;
    const observed = await waitForNotices(
      { completionPath: completionNoticePath(task), stallPath, stallAccept,
        attentionPath: attentionNoticePath(task), attentionAccept: (notice) =>
          String(readJson(files.status, {}).rev) === notice.revision
          && (!afterRevision || Number(notice.revision) > afterStatusRev) },
      waitMs,
    );
    if (observed.attention) {
      return { task_id: taskId, attention_notice_observed: true, completion_notice_observed: false };
    }
    if (observed.stall) {
      const status = statusTask({ ...input, task_root: taskRoot });
      return {
        ...status,
        changed: true,
        terminal_only: terminalOnly,
        completion_notice_observed: false,
        stall_notice_observed: true,
        stall_notice_path: stallPath,
        status_checked: true,
        timed_out: false,
        wait_ms: waitMs,
      };
    }
    if (!observed.completion) {
      return {
        ok: true,
        task_id: taskId,
        changed: false,
        terminal_only: terminalOnly,
        completion_notice_observed: false,
        stall_notice_observed: false,
        status_checked: false,
        timed_out: true,
        wait_ms: waitMs,
      };
    }
    const status = statusTask({ ...input, task_root: taskRoot });
    const revision = String(status.revision ?? status.rev ?? "");
    const changed = !afterRevision || revision !== String(afterRevision);
    return {
      ...status,
      changed,
      terminal_only: terminalOnly,
      completion_notice_observed: true,
      stall_notice_observed: false,
      status_checked: true,
      timed_out: false,
      wait_ms: waitMs,
    };
  }

  // 静默监视：按周期读 live 的 last_event_at，静默达到 task.stall_silence_ms 就在 status 写 stall 段并
  // 投递 stall notice；live 再有新事件即清除并删文件，之后可再次触发。attempt 结束时一并清理。
  function startStallMonitor(files, task, attempt) {
    const thresholdMs = Number(task.stall_silence_ms);
    if (!(thresholdMs > 0)) {
      return { stop() {} };
    }
    const noticePath = stallNoticePath(task);
    const startedAt = ctx.host.nowMs();
    const intervalMs = Math.max(250, Math.min(STALL_CHECK_INTERVAL_MAX_MS, Math.floor(thresholdMs / 4)));
    let timer = null;
    let stopped = false;
    const clearStall = (status) => {
      if (!status.stall) return;
      updateStatus(files, { stall: null });
      rmSync(noticePath, { force: true });
    };
    const schedule = () => {
      if (stopped) return;
      timer = ctx.host.setTimer(tick, intervalMs);
      timer?.unref?.();
    };
    function tick() {
      if (stopped) return;
      try {
        const status = readJson(files.status, {});
        if (status.state !== "running") {
          clearStall(status);
          schedule();
          return;
        }
        const live = readJson(files.childLive, null);
        const lastEventIso = live?.last_event_at || live?.updated_at || null;
        const parsed = lastEventIso ? Date.parse(lastEventIso) : Number.NaN;
        const silentMs = ctx.host.nowMs() - (Number.isFinite(parsed) ? parsed : startedAt);
        if (silentMs < thresholdMs) {
          clearStall(status);
        } else if (!status.stall || status.stall.last_event_at !== lastEventIso) {
          const lastTool = live?.last_tool_call;
          updateStatus(files, {
            stall: {
              suspected_at: isoNow(),
              silent_seconds: Math.round(silentMs / 1000),
              threshold_seconds: Math.round(thresholdMs / 1000),
              last_event_at: lastEventIso,
              live_phase: live?.phase ?? null,
              last_tool: lastTool ? (String(lastTool.name ?? lastTool.type ?? "") || null) : null,
              attempt: attempt.attempt,
            },
          });
          const next = readJson(files.status, {});
          writeJson(noticePath, {
            task_id: task.task_id,
            state: next.state,
            status_rev: Number(next.rev ?? 0),
            revision: String(next.rev ?? 0),
            ...next.stall,
            status_path: files.status,
            live_path: files.childLive,
          });
        }
      } catch {
        // 检测失败不影响任务本身，下一周期再试。
      }
      schedule();
    }
    schedule();
    return {
      stop() {
        stopped = true;
        if (timer) ctx.host.clearTimer(timer);
        clearStall(readJson(files.status, {}));
      },
    };
  }

  return {
    completionInboxDir,
    completionNoticePath,
    attentionNoticePath,
    writeAttentionNotice,
    stallNoticePath,
    writeCompletionNotice,
    statusTask,
    reconcileTask,
    waitForCompletionNotice,
    waitForNotices,
    waitTask,
    startStallMonitor,
  };
}
