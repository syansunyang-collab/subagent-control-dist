import { readJson } from "../../_fs-utils.mjs";
import { isTerminalState } from ".././contracts.mjs";
import {
  PROCESS_TREE_TERMINATION_UNCONFIRMED_REASON,
  RETIRED_SALVAGE_REPORT_PATH,
  isUnconfirmedRetainedProcessTree,
} from "./shared.mjs";

export function createStatus(ctx, rt) {
  const writeJson = (...args) => rt.writeJson(...args);
  const isoNow = (...args) => rt.isoNow(...args);
  const processTreeMarker = (...args) => rt.processTreeMarker(...args);
  const writeAttentionNotice = (...args) => rt.writeAttentionNotice(...args);
  const worker = (...args) => rt.worker(...args);

  function writeInitialStatus(files, task) {
    writeJson(files.status, {
      task_id: task.task_id,
      state: "submitted",
      contract_state: null,
      business_state: null,
      business_state_raw: null,
      artifact_state: null,
      requires_parent_review: false,
      salvage_report_path: RETIRED_SALVAGE_REPORT_PATH,
      salvage_evidence_paths: [],
      cancel_reason: null,
      last_progress_line: null,
      created_at: task.created_at,
      updated_at: isoNow(),
      rev: 1,
      pid: null,
      child_pid: null,
      runner_spawn_pending: false,
      active_attempt_id: null,
      cancel_requested_at: null,
      cancel_force_cleanup_requested: false,
      retained_worker: false,
      retained_marker: null,
      task_dir: task.task_dir,
      report: files.report,
      handoff: files.handoff,
      runner_path: task.runner_path,
      runtime_role: task.runtime_role,
      model: task.model,
      effort: task.effort,
      origin_thread_id: task.origin_thread_id || null,
      batch_id: task.batch_id || null,
      slice_id: task.slice_id || null,
      display_title: task.display_title || null,
      attempts: [],
      context_mode: task.context_mode,
      result_mode: task.result_mode || null,
      attestation_path: null,
      attestation_verified: null,
      write_domain_profile: null,
      write_domain_enabled: null,
      write_domain_scope_compliant: null,
      write_domain_audit_complete: null,
      write_domain_violation_count: 0,
      write_domain_reported_violation_count: 0,
      write_domain_covered_tools: [],
      write_domain_command_write_enforced: false,
      write_domain_audit_path: null,
      target_cwd: task.target_cwd,
      task_source_path: task.task_source_path,
      task_package_path: task.task_package_path,
      worker_task_package_path: task.worker_task_package_path || null,
      failure_type: null,
      turn_status: null,
      exit_code: null,
      signal: null,
      error: null,
    });
  }

  function updateStatus(files, patch) {
    const current = readJson(files.status, {});
    const rev = Number(current.rev ?? 0) + 1;
    const next = {
      ...current,
      ...patch,
      rev,
      updated_at: isoNow(),
    };
    writeJson(files.status, next);
    writeAttentionNotice(files, readJson(files.task, {}), next);
    return next;
  }

  function normalizeLiveStatus(files, status, alive) {
    const liveStates = new Set(["queued", "running"]);
    if (liveStates.has(status.state) && status.pid && alive === false) {
      const latest = readJson(files.status, status);
      if (!liveStates.has(latest.state)) {
        return latest;
      }
      if (isUnconfirmedRetainedProcessTree(latest)) {
        const marker = processTreeMarker(
          latest.task_id,
          latest.pid,
          "reconcile",
          latest.retained_marker,
        );
        const patch = {
          state: "cancel_requested",
          cancel_reason: latest.cancel_reason || PROCESS_TREE_TERMINATION_UNCONFIRMED_REASON,
          retained_worker: true,
          retained_marker: {
            ...marker,
            top_pid_alive: false,
            termination_confirmed: false,
          },
          error: "worker top PID is not alive, but process-tree termination remains unconfirmed",
        };
        updateStatus(files, patch);
        return readJson(files.status, { ...latest, ...patch, updated_at: isoNow() });
      }
      const patch = {
        state: "failed",
        contract_state: "invalid_final",
        business_state: "unknown",
        artifact_state: "worker_exit_before_final",
        requires_parent_review: true,
        failure_type: "worker_process_exit",
        error: `worker pid ${status.pid} is not alive before final status`,
        finished_at: isoNow(),
      };
      updateStatus(files, patch);
      return readJson(files.status, { ...status, ...patch, updated_at: isoNow() });
    }
    return status;
  }

  function childLiveHealth(status, childLive, alive) {
    if (isTerminalState(status.state) || status.state === "paused") {
      return status.state;
    }
    if (alive === false) {
      return "dead";
    }
    if (!childLive) {
      return "no_live";
    }
    return "active";
  }

  function mergeChildLiveStatus(files, status, alive) {
    const childLive = readJson(files.childLive, null);
    const statusRev = Number(status.rev ?? 0);
    const liveRev = Number(childLive?.rev ?? 0);
    const revision = `${statusRev}:${liveRev}`;
    const health = childLiveHealth(status, childLive, alive);
    return {
      ...status,
      revision,
      status_rev: statusRev,
      live_rev: liveRev,
      live_health: health,
      live_path: files.childLive,
      live_events_path: files.childEvents,
      live_phase: childLive?.phase ?? null,
      live_status: childLive?.status ?? null,
      live_updated_at: childLive?.updated_at ?? null,
      live_last_event_at: childLive?.last_event_at ?? null,
      live_last_request: childLive?.last_request ?? null,
      last_tool_call: childLive?.last_tool_call ?? null,
      tool_call_counts: childLive?.tool_call_counts ?? [],
      token_usage: childLive?.token_usage ?? null,
      notification_counts: childLive?.notification_counts ?? [],
      raw_response_item_counts: childLive?.raw_response_item_counts ?? [],
    };
  }

  // 从 live 事件流聚合只读遥测。运行时长、静默时长和工具调用数不参与异常判定。
  function progressAggregate(status, task) {
    const now = ctx.host.nowMs();
    const createdAt = Date.parse(status.created_at || "");
    const elapsedSeconds = Number.isFinite(createdAt) ? Math.max(0, Math.round((now - createdAt) / 1000)) : null;
    const lastEvent = Date.parse(status.live_last_event_at || status.live_updated_at || "");
    const liveAgeSeconds = Number.isFinite(lastEvent) ? Math.max(0, Math.round((now - lastEvent) / 1000)) : null;
    const toolCounts = Array.isArray(status.tool_call_counts) ? status.tool_call_counts : [];
    const toolCallCount = toolCounts.reduce((sum, item) => sum + (Number(item?.count) || 0), 0);
    const lastToolType = String(status.last_tool_call?.type ?? "");
    const lastToolKind = /output|result/i.test(lastToolType)
      ? null
      : status.last_tool_call?.name ?? status.last_tool_call?.type ?? null;
    const progressState = isTerminalState(status.state) ? "terminal"
      : status.state === "paused" ? "paused" : "running";
    return {
      elapsed_seconds: elapsedSeconds,
      live_age_seconds: liveAgeSeconds,
      tool_call_count: toolCallCount,
      last_tool_kind: lastToolKind,
      progress_state: progressState,
    };
  }

  return {
    writeInitialStatus,
    updateStatus,
    normalizeLiveStatus,
    childLiveHealth,
    mergeChildLiveStatus,
    progressAggregate,
  };
}
