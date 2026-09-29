import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pick, readJson } from "../../_fs-utils.mjs";
import { CONTRACT_VERSION, WRITE_CLAIM_CONTRACT_VERSION, isTerminalState } from ".././contracts.mjs";
import {
  REVISION_CONFLICT_NEXT_STEP,
  RESUME_REVISION_CONFLICT_NEXT_STEP,
  isUnconfirmedRetainedProcessTree,
} from "./shared.mjs";

export function createLifecycle(ctx, rt) {
  const writeJson = (...args) => rt.writeJson(...args);
  const isoNow = (...args) => rt.isoNow(...args);
  const truncateText = (...args) => rt.truncateText(...args);
  const loadLocatedTask = (...args) => rt.loadLocatedTask(...args);
  const confirmedProcessTreeMarker = (...args) => rt.confirmedProcessTreeMarker(...args);
  const launchTaskWorker = (...args) => rt.launchTaskWorker(...args);
  const producerRootForTask = (...args) => rt.producerRootForTask(...args);
  const declaredWritePaths = (...args) => rt.declaredWritePaths(...args);
  const claimFilePath = (...args) => rt.claimFilePath(...args);
  const withWriteClaimLock = (...args) => rt.withWriteClaimLock(...args);
  const assertWriteDomainAvailable = (...args) => rt.assertWriteDomainAvailable(...args);
  const releaseWriteClaimForTask = (...args) => rt.releaseWriteClaimForTask(...args);
  const updateStatus = (...args) => rt.updateStatus(...args);
  const completionNoticePath = (...args) => rt.completionNoticePath(...args);
  const stallNoticePath = (...args) => rt.stallNoticePath(...args);
  const taskPackagePathFor = (...args) => rt.taskPackagePathFor(...args);
  const worker = (...args) => rt.worker(...args);

  // The claim lock serializes queued pause with worker admission and resume.
  // A launched queued worker acknowledges the request before any runner is spawned.
  function pauseTask(input = {}) {
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    if (!taskId) throw new Error("缺少task_id。请指定要暂停的任务标识，再调用subagent_pause。");
    const { taskRoot, files, task } = loadLocatedTask(input, taskId);
    const producerRoot = task.producer_root || producerRootForTask({}, taskRoot);
    return withWriteClaimLock(producerRoot, () => {
      const status = readJson(files.status, {});
      const reply = (ok, reason, next_step, current = status) => ({
        ok, task_id: taskId, state: current.state, revision: String(current.rev ?? 0), reason, next_step,
      });
      const expected = pick(input, ["expected-revision", "expected_revision", "expectedRevision"], "");
      if (!expected) return reply(false, "expected_revision_required", "缺少expected_revision。先用subagent_get取得当前revision，再调用subagent_pause。");
      if (expected !== String(status.rev ?? 0)) {
        return reply(false, "revision_conflict", "任务版本已变化。先用subagent_get取得当前revision，再按该版本调用subagent_pause。");
      }
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (!reason || reason.length > 1024) return reply(false, "reason_required", "reason须为1至1024个字符的暂停原因。补充或缩短说明后重试；reason不改变动作或权限。");
      if (status.state === "paused") return reply(true, "already_paused", "执行已停止。若此前由用户要求停止，须取得新的继续指令后再调用subagent_resume。");
      if (!["submitted", "queued", "running"].includes(status.state)) {
        return reply(false, "task_not_running", `任务当前为${status.state}，本次不改变该状态。用subagent_get查看详情；需要继续时按可恢复条件调用subagent_resume。`);
      }
      if (status.pause_requested_at) return reply(true, "pause_pending", "暂停请求已登记，停止尚未确认。可用subagent_get查看进展；本请求不会自动升级为强制终止。");
      const requestedAt = isoNow();
      const next = updateStatus(files, {
        pause_requested_at: requestedAt, pause_reason: reason,
        resume_mode: status.state === "running" ? "session" : "start",
        error: "暂停请求已登记，停止及会话保存尚未确认。用subagent_get查看进展；终止执行需单独发起取消动作。",
      });
      if (status.active_attempt_id) writeJson(files.cancelRequest, {
        contract_version: CONTRACT_VERSION, type: "pause", task_id: taskId,
        attempt_id: status.active_attempt_id, reason, requested_at: requestedAt,
      });
      if (!status.pid && status.state !== "running" && !isUnconfirmedRetainedProcessTree(status)) {
        const paused = updateStatus(files, { state: "paused", resume_mode: "start", resumable: true,
          session_file: null, error: null, business_state: "unknown", paused_at: isoNow(),
          contract_state: "paused", artifact_state: null, failure_type: "none", exit_code: null,
          retained_marker: confirmedProcessTreeMarker(task, status, "queued_pause") });
        releaseWriteClaimForTask(task);
        return reply(true, "paused_before_start", "任务尚未开始，因此没有已有会话；subagent_resume会启动同一个任务。", paused);
      }
      return reply(true, "pause_requested", "等待状态确认为paused，可用subagent_get查看。确认前执行和写域仍保持有效，不自动强杀。", next);
    });
  }

  function resumeTask(input = {}) {
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    if (!taskId) throw new Error("resume requires task_id");
    const { taskRoot, task } = loadLocatedTask(input, taskId);
    return withWriteClaimLock(task.producer_root || producerRootForTask({}, taskRoot), () => resumeTaskLocked(input));
  }

  function resumeTaskLocked(input = {}) {
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    if (!taskId) {
      throw new Error("resume requires task_id");
    }
    const { taskRoot, files, task } = loadLocatedTask(input, taskId);
    const producerRoot = task.producer_root || producerRootForTask({}, taskRoot);
    return withWriteClaimLock(producerRoot, (claimRoot) => {
    const status = readJson(files.status, {});
    const expectedRevision = pick(input, ["expected-revision", "expected_revision", "expectedRevision"], "");
    if (expectedRevision && String(status.rev ?? 0) !== expectedRevision) {
      return {
        ok: false,
        task_id: taskId,
        state: status.state,
        revision: String(status.rev ?? 0),
        reason: "revision_conflict",
        next_step: RESUME_REVISION_CONFLICT_NEXT_STEP,
      };
    }
    if ((!isTerminalState(status.state) && status.state !== "paused") || status.state === "done") {
      return { ok: false, task_id: taskId, state: status.state, revision: String(status.rev ?? 0), reason: "not_resumable" };
    }
    if (status.resumable !== true || isUnconfirmedRetainedProcessTree(status)) {
      return { ok: false, task_id: taskId, state: status.state, revision: String(status.rev ?? 0), reason: "not_resumable" };
    }
    const startMode = status.state === "paused" && status.resume_mode === "start";
    const sessionFile = startMode ? null : status.session_file;
    if (!startMode) {
      try {
        if (!sessionFile || !statSync(sessionFile).isFile()) throw new Error("session file missing");
        readFileSync(sessionFile, "utf8");
      } catch (error) {
        return { ok: false, task_id: taskId, state: status.state, revision: String(status.rev ?? 0), reason: "session_missing",
          next_step: `原会话文件不可读（${error.code || error.message}）。恢复该文件的存在性与读取权限后再调用subagent_resume；重新派发会创建新任务，不能作为原会话续接。` };
      }
    }
    const paths = task.write_claim_paths || declaredWritePaths(taskPackagePathFor(task), { targetCwd: task.target_cwd, producerRoot });
    assertWriteDomainAvailable(claimRoot, ctx.config.registryRoot, taskId, paths, task.parent_task_id || null);
    const claimPath = paths.length ? claimFilePath(claimRoot, taskId) : null;
    if (claimPath) {
      writeJson(claimPath, { contract_version: WRITE_CLAIM_CONTRACT_VERSION, task_id: taskId, parent_task_id: task.parent_task_id || null, producer_root: producerRoot, task_root: taskRoot, registry_root: ctx.config.registryRoot, paths, created_at: isoNow() });
    }
    let launchAttempted = false;
    try {
    const staleNotice = status.completion_notice_path || completionNoticePath(task);
    rmSync(staleNotice, { force: true });
    rmSync(completionNoticePath(task), { force: true });
    rmSync(stallNoticePath(task), { force: true });
    rmSync(files.cancelRequest, { force: true });
    if (existsSync(files.result)) rmSync(files.result, { force: true });
    updateStatus(files, {
      resume_requested_session: sessionFile,
      pause_requested_at: null,
      pause_reason: null,
      paused_at: null,
      resumable: false,
      state: "queued",
      contract_state: null,
      artifact_state: null,
      business_state: null,
      business_state_raw: null,
      requires_parent_review: false,
      failure_type: null,
      turn_status: null,
      exit_code: null,
      signal: null,
      finished_at: null,
      error: null,
      stall: null,
      completion_notice_path: null,
      cancel_reason: null,
      cancel_requested_at: null,
      cancel_force_cleanup_requested: false,
      active_attempt_id: null,
    });
    launchAttempted = true;
    launchTaskWorker({
      registryRoot: ctx.config.registryRoot,
      taskRoot,
      taskId,
      dir: files.dir || path.dirname(files.status),
      files,
      preserveTask: true,
    });
    const next = readJson(files.status, {});
    return {
      ok: true,
      task_id: taskId,
      state: next.state || "queued",
      revision: String(next.rev ?? 0),
      reason: "resume_accepted",
    };
    } catch (error) {
      if (!launchAttempted || error?.no_writer_can_remain === true) {
        updateStatus(files, { ...status, error: String(error.message), resume_requested_session: null });
        if (claimPath) rmSync(claimPath, { force: true });
      }
      throw error;
    }
    });
  }

  // 已读 sidecar：只记录主代理成功取到该终态结果版本，不等于验收、已处理或 Fleet 裁决。
  // 独立低频原子文件，不改 status revision / business_state / requires_parent_review，避免通知循环。
  function recordResultRead(input = {}) {
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    if (!taskId) {
      throw new Error("record_result_read requires task_id");
    }
    const version = String(pick(input, ["result_revision", "result-revision", "resultRevision"], "") || "").trim();
    if (!version) {
      return {
        ok: false,
        recorded: false,
        reason: "missing_result_revision",
        task_id: taskId,
      };
    }
    const { files } = loadLocatedTask(input, taskId);
    const sidecarPath = path.join(files.dir, "result-read.json");
    const existing = existsSync(sidecarPath) ? readJson(sidecarPath, null) : null;
    if (existing?.task_id === taskId && String(existing.result_revision) === version) {
      return {
        ok: true,
        recorded: false,
        reason: "already_recorded",
        task_id: taskId,
        result_revision: version,
      };
    }
    writeJson(sidecarPath, {
      task_id: taskId,
      result_revision: version,
      read_at: isoNow(),
    });
    return {
      ok: true,
      recorded: true,
      reason: "recorded",
      task_id: taskId,
      result_revision: version,
    };
  }

  // 复核销账：collect（subagent_result）是纯读，父代理完成复核在数据层没有出口——
  // 没有这一步，任务一旦进入待复核队列就永远留在里面。只销账不改史：
  // business_state/failure_type 保持原判，review_acked_at 留痕可审计。
  function ackReviewTask(input = {}) {
    const taskId = pick(input, ["task-id", "task_id", "taskId"], "");
    if (!taskId) {
      throw new Error("ack_review requires task_id");
    }
    const { files } = loadLocatedTask(input, taskId);
    const status = readJson(files.status, {});
    const expectedRevision = pick(input, ["expected-revision", "expected_revision", "expectedRevision"], "");
    if (expectedRevision && String(status.rev ?? 0) !== expectedRevision) {
      return {
        ok: false,
        task_id: taskId,
        state: status.state,
        revision: String(status.rev ?? 0),
        acked: false,
        reason: "revision_conflict",
        next_step: REVISION_CONFLICT_NEXT_STEP,
      };
    }
    if (!isTerminalState(status.state)) {
      return {
        ok: false,
        task_id: taskId,
        state: status.state,
        revision: String(status.rev ?? 0),
        acked: false,
        reason: "task_not_terminal",
      };
    }
    if (!status.requires_parent_review && status.review_acked_at) {
      // 幂等：目标状态已达成算成功，acked=false 区分本次没有发生写入
      return {
        ok: true,
        task_id: taskId,
        state: status.state,
        revision: String(status.rev ?? 0),
        acked: false,
        reason: "already_acked",
      };
    }
    // 标志本就为 false 但无确认痕迹时也落 review_acked_at：fleet node 的复核队列
    // 准入来自 run 文件里的 DAG 节点状态（runner 私产，不可写），出队联动只认
    // 关联任务上的确认痕迹——没有这一笔，干净任务的 node 永远赶不出队列。
    const note = String(pick(input, ["note"], "") || "").slice(0, 240);
    updateStatus(files, {
      requires_parent_review: false,
      review_acked_at: isoNow(),
      ...(note ? { review_ack_note: note } : {}),
    });
    const updated = readJson(files.status, {});
    return {
      ok: true,
      task_id: taskId,
      state: updated.state,
      revision: String(updated.rev ?? 0),
      acked: true,
      reason: "acked",
    };
  }

  function reviewGate(status) {
    if (!isTerminalState(status.state)) {
      return "pending";
    }
    if (status.requires_parent_review) {
      return "needs_parent_review";
    }
    if (status.state === "cancelled") {
      return "cancelled";
    }
    if (status.state === "failed" || ["failed", "blocked", "unknown"].includes(String(status.business_state || ""))) {
      return "fail";
    }
    if (status.business_state === "partial" || status.contract_state !== "ok") {
      return "needs_parent_review";
    }
    return "pass";
  }

  function failureSummary(status) {
    const value = status.error || (status.failure_type === "none" ? null : status.failure_type) || status.cancel_reason || "";
    return value ? truncateText(value, 240) : null;
  }

  return {
    pauseTask,
    resumeTask,
    resumeTaskLocked,
    recordResultRead,
    ackReviewTask,
    reviewGate,
    failureSummary,
  };
}
