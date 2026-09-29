import { rmSync } from "node:fs";
import { readJson } from "../../_fs-utils.mjs";
import { isTerminalState } from ".././contracts.mjs";
import {
  RETAINED_WORKER_ERROR_CODE,
  PROCESS_TREE_CONFIRMATION_MARKER_CODE,
  HOST_REBOOT_MARGIN_MS,
  WORKER_START_ROLLBACK_INCOMPLETE_ERROR_CODE,
  annotateInternalError,
} from "./shared.mjs";

export function createProcessTree(ctx, rt) {
  const isoNow = (...args) => rt.isoNow(...args);
  const registerTaskLocation = (...args) => rt.registerTaskLocation(...args);
  const unregisterTaskLocation = (...args) => rt.unregisterTaskLocation(...args);
  const updateStatus = (...args) => rt.updateStatus(...args);
  const worker = (...args) => rt.worker(...args);

  function processTreeMarker(taskId, pid, source, existing = null) {
    const prior = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
    return {
      ...prior,
      code: prior.code || PROCESS_TREE_CONFIRMATION_MARKER_CODE,
      task_id: taskId,
      pid: prior.pid ?? pid ?? null,
      scope: "process_tree",
      source: prior.source || source,
      termination_requested: Boolean(prior.termination_requested),
      termination_confirmed: false,
    };
  }

  function confirmedProcessTreeMarker(task, status, source = "worker_finalization") {
    const marker = processTreeMarker(
      task.task_id,
      status?.pid ?? ctx.host.pid,
      source,
      status?.retained_marker,
    );
    return {
      ...marker,
      source,
      termination_confirmed: true,
      termination_confirmation_source: source,
      termination_confirmed_at: isoNow(),
    };
  }

  function launchTaskWorker({ registryRoot, taskRoot, taskId, dir, files, preserveTask = false }) {
    let child = null;
    let spawnedPid = null;
    try {
      registerTaskLocation(registryRoot, taskRoot, taskId);
      // 丢弃 worker 的 OS 级 stdio；worker 进程自身把错误惰性写入 worker.stderr.log，
      // 成功路径不再落 worker.stdout.log / worker.stderr.log 两个空文件。
      child = ctx.host.spawn(
        ctx.host.nodeExecutable,
        [ctx.config.workerEntrypoint, "worker", "--task-root", taskRoot, "--task-id", taskId],
        {
          cwd: ctx.config.workerSpawnCwd,
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
          windowsHide: true,
          env: ctx.config.childEnv,
        },
      );
      const numericPid = Number(child?.pid);
      if (Number.isInteger(numericPid) && numericPid > 0) {
        spawnedPid = numericPid;
      }
      const queuedStatus = updateStatus(files, {
        pid: child.pid,
        state: "queued",
        retained_worker: false,
        retained_marker: processTreeMarker(taskId, child.pid, "worker_launch"),
        runner_spawn_pending: false,
      });
      child.unref();
      return { child, status: queuedStatus };
    } catch (startError) {
      const cleanupErrors = [];
      if (spawnedPid !== null) {
        // spawn() 已返回 PID 后，直接终止顶层对象和顶层 PID 的死亡都不能证明
        // 后代 writer 已经停止。terminateProcessTree 只是一项尽力的整树终止请求；本
        // 合同没有强整树确认结果，因此这个分支永远 retained、永远不回滚 claim。
        let terminationRequested = false;
        try {
          terminationRequested = Boolean(ctx.host.terminateProcessTree(spawnedPid));
        } catch (error) {
          cleanupErrors.push(error);
        }
        let topPidAlive = null;
        try {
          topPidAlive = processAlive(spawnedPid);
        } catch (error) {
          cleanupErrors.push(error);
        }
        const retainedMarker = {
          ...processTreeMarker(
            taskId,
            spawnedPid,
            "worker_start_cleanup",
            readJson(files.status, {})?.retained_marker,
          ),
          code: RETAINED_WORKER_ERROR_CODE,
          termination_requested: terminationRequested,
          termination_confirmed: false,
          top_pid_alive: topPidAlive,
        };
        const cleanupMessage = cleanupErrors.map((error) => error?.message ?? String(error)).join("; ");
        try {
          updateStatus(files, {
            state: "cancel_requested",
            pid: child.pid,
            failure_type: "worker_start_cleanup_failed",
            retained_worker: true,
            retained_marker: retainedMarker,
            error: `worker start failed and process-tree termination was not confirmed: ${cleanupMessage}`,
          });
        } catch (error) {
          cleanupErrors.push(error);
        }
        const finalRetainedMarker = {
          ...retainedMarker,
          cleanup_errors: cleanupErrors.map((error) => error?.message ?? String(error)),
        };
        throw annotateInternalError(
          new AggregateError(
            [startError, ...cleanupErrors],
            `cannot start async task; task ${taskId} retained because worker termination was not confirmed`,
          ),
          {
            code: RETAINED_WORKER_ERROR_CODE,
            internal: {
              ...finalRetainedMarker,
              retained_worker: true,
            },
            retained_worker: true,
            retained_marker: finalRetainedMarker,
            rollback_complete: false,
            no_writer_can_remain: false,
          },
        );
      }
      if (preserveTask) {
        throw annotateInternalError(new Error(`cannot resume async task: ${startError?.message ?? startError}`, { cause: startError }), {
          rollback_complete: true,
          no_writer_can_remain: true,
        });
      }
      let taskDirRemoved = false;
      let registryEntryRemoved = false;
      try {
        rmSync(dir, { recursive: true, force: true });
        taskDirRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (taskDirRemoved) {
        try {
          unregisterTaskLocation(registryRoot, taskId);
          registryEntryRemoved = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      const rollbackComplete = taskDirRemoved && registryEntryRemoved;
      if (cleanupErrors.length || !rollbackComplete) {
        throw annotateInternalError(
          new AggregateError([startError, ...cleanupErrors], `cannot start async task ${taskId}; cleanup was incomplete`),
          {
            code: WORKER_START_ROLLBACK_INCOMPLETE_ERROR_CODE,
            internal: {
              code: WORKER_START_ROLLBACK_INCOMPLETE_ERROR_CODE,
              task_id: taskId,
              retained_worker: false,
              rollback_complete: rollbackComplete,
            },
            retained_worker: false,
            rollback_complete: rollbackComplete,
            no_writer_can_remain: rollbackComplete,
          },
        );
      }
      throw annotateInternalError(
        new Error(`cannot start async task: ${startError?.message ?? startError}`, { cause: startError }),
        {
          rollback_complete: true,
          no_writer_can_remain: true,
        },
      );
    }
  }

  function processAlive(pid) {
    return Boolean(ctx.host.isProcessAlive(pid));
  }

  // 顶层 PID 死亡不是进程树终止的证明，但主机在任务创建之后重新启动是：上一启动周期的进程
  // 全部消失。host 未提供启动时刻、或任务创建于本次启动之后时返回 null，恢复保持 fail-closed。
  function hostRebootAfterTask(status) {
    if (typeof ctx.host.bootTimeMs !== "function") return null;
    const createdAt = Date.parse(status?.created_at || "");
    const bootTimeMs = Number(ctx.host.bootTimeMs());
    if (!Number.isFinite(createdAt) || !Number.isFinite(bootTimeMs)) return null;
    if (createdAt + HOST_REBOOT_MARGIN_MS >= bootTimeMs) return null;
    return { boot_time: new Date(bootTimeMs).toISOString(), task_created_at: status.created_at };
  }

  function confirmProcessTreeAfterHostReboot(files, task, status, reboot) {
    const marker = {
      ...processTreeMarker(status.task_id || task.task_id, status.pid, "reconcile", status.retained_marker),
      top_pid_alive: false,
      termination_confirmed: true,
      termination_confirmation_source: "host_reboot",
      termination_confirmed_at: isoNow(),
      host_boot_time: reboot.boot_time,
    };
    const patch = { retained_worker: false, retained_marker: marker };
    if (!isTerminalState(status.state)) {
      Object.assign(patch, {
        state: "failed",
        contract_state: "invalid_final",
        business_state: "unknown",
        artifact_state: "worker_exit_before_final",
        requires_parent_review: true,
        failure_type: "worker_process_exit",
        error: `host rebooted at ${reboot.boot_time} after task creation at ${reboot.task_created_at}; the worker process tree did not survive`,
        finished_at: isoNow(),
      });
    }
    updateStatus(files, patch);
  }

  return {
    processTreeMarker,
    confirmedProcessTreeMarker,
    launchTaskWorker,
    processAlive,
    hostRebootAfterTask,
    confirmProcessTreeAfterHostReboot,
  };
}
