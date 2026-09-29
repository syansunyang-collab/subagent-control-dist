import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pick, readJson } from "../../_fs-utils.mjs";
import {
  RETIRED_SALVAGE_REPORT_PATH,
} from "./shared.mjs";

export function createListing(ctx, rt) {
  const pickNumber = (...args) => rt.pickNumber(...args);
  const isoNow = (...args) => rt.isoNow(...args);
  const resolveTaskRoot = (...args) => rt.resolveTaskRoot(...args);
  const taskFiles = (...args) => rt.taskFiles(...args);
  const normalizeLiveStatus = (...args) => rt.normalizeLiveStatus(...args);
  const mergeChildLiveStatus = (...args) => rt.mergeChildLiveStatus(...args);
  const progressAggregate = (...args) => rt.progressAggregate(...args);
  const processAlive = (...args) => rt.processAlive(...args);

  function listTasks(input = {}) {
    const taskRoot = resolveTaskRoot(input);
    const filter = pick(input, ["state"], "");
    const limit = pickNumber(input, ["limit"], 50);
    if (!existsSync(taskRoot)) {
      return { ok: true, task_root: taskRoot, tasks: [] };
    }
    const tasks = readdirSync(taskRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(taskRoot, entry.name);
        const files = taskFiles(dir);
        const status = readJson(files.status, null);
        if (!status) {
          return null;
        }
        const task = readJson(files.task, {});
        // 只读合并 live 事件流并算进度聚合（不触发 normalizeLiveStatus 的落盘副作用）。
        const alive = status.pid ? processAlive(status.pid) : null;
        const merged = mergeChildLiveStatus(files, status, alive);
        const aggregate = progressAggregate(merged, task);
        return {
          task_id: status.task_id ?? entry.name,
          revision: String(status.rev ?? 0),
          origin_thread_id: task.origin_thread_id ?? status.origin_thread_id ?? null,
          batch_id: task.batch_id ?? status.batch_id ?? null,
          slice_id: task.slice_id ?? status.slice_id ?? null,
          display_title: task.display_title ?? status.display_title ?? null,
          runtime_role: task.runtime_role ?? status.runtime_role ?? null,
          model: task.model ?? status.model ?? null,
          effort: task.effort ?? status.effort ?? null,
          state: status.state,
          contract_state: status.contract_state ?? null,
          business_state: status.business_state ?? null,
          business_state_raw: status.business_state_raw ?? null,
          artifact_state: status.artifact_state ?? null,
          requires_parent_review: status.requires_parent_review ?? false,
          review_acked_at: status.review_acked_at ?? null,
          salvage_report_path: RETIRED_SALVAGE_REPORT_PATH,
          salvage_evidence_paths: status.salvage_evidence_paths ?? [],
          cancel_reason: status.cancel_reason ?? null,
          failure_type: status.failure_type ?? null,
          turn_status: status.turn_status ?? null,
          exit_code: status.exit_code ?? null,
          signal: status.signal ?? null,
          error: status.error ?? null,
          elapsed_seconds: aggregate.elapsed_seconds,
          live_age_seconds: aggregate.live_age_seconds,
          tool_call_count: aggregate.tool_call_count,
          last_tool_kind: aggregate.last_tool_kind,
          token_usage: merged.token_usage ?? null,
          progress_state: aggregate.progress_state,
          process_alive: status.pid ? alive : null,
          live_health: merged.live_health,
          created_at: status.created_at,
          updated_at: status.updated_at,
          finished_at: status.finished_at,
          task_dir: dir,
          handoff: status.handoff,
          report: status.report,
          completion_notice_path: status.completion_notice_path,
          live_path: status.live_path,
          last_progress_line: status.last_progress_line ?? null,
          pid: status.pid,
        };
      })
      .filter(Boolean)
      .filter((entry) => !filter || entry.state === filter)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, limit);
    return { ok: true, task_root: taskRoot, tasks };
  }

  function incrementBucket(bucket, key) {
    const name = String(key || "unknown");
    bucket[name] = (bucket[name] ?? 0) + 1;
  }

  function taskStatusSummary(input = {}) {
    const listed = listTasks(input);
    const tasks = listed.tasks.map((task) => ({
      task_id: task.task_id,
      revision: String(task.revision ?? task.rev ?? 0),
      origin_thread_id: task.origin_thread_id,
      batch_id: task.batch_id,
      slice_id: task.slice_id,
      display_title: task.display_title,
      runtime_role: task.runtime_role,
      model: task.model,
      effort: task.effort,
      state: task.state,
      contract_state: task.contract_state,
      business_state: task.business_state,
      artifact_state: task.artifact_state,
      requires_parent_review: task.requires_parent_review,
      review_acked_at: task.review_acked_at ?? null,
      cancel_reason: task.cancel_reason,
      failure_type: task.failure_type,
      turn_status: task.turn_status,
      exit_code: task.exit_code,
      signal: task.signal,
      error: task.error,
      progress_state: task.progress_state,
      elapsed_seconds: task.elapsed_seconds,
      live_age_seconds: task.live_age_seconds,
      tool_call_count: task.tool_call_count,
      last_tool_kind: task.last_tool_kind,
      process_alive: task.process_alive,
      token_usage: task.token_usage,
      report_path: task.report,
      handoff_path: task.handoff,
      salvage_report_path: RETIRED_SALVAGE_REPORT_PATH,
      salvage_evidence_paths: task.salvage_evidence_paths ?? [],
      completion_notice_path: task.completion_notice_path,
      last_progress_line: task.last_progress_line,
      created_at: task.created_at,
      updated_at: task.updated_at,
      finished_at: task.finished_at,
      task_dir: task.task_dir,
    }));
    const buckets = {
      by_state: {},
      by_business_state: {},
      by_progress_state: {},
      requires_parent_review: 0,
      cancelled_by_reason: {},
    };
    for (const task of tasks) {
      incrementBucket(buckets.by_state, task.state);
      incrementBucket(buckets.by_business_state, task.business_state);
      incrementBucket(buckets.by_progress_state, task.progress_state);
      if (task.requires_parent_review) {
        buckets.requires_parent_review += 1;
      }
      if (task.cancel_reason) {
        incrementBucket(buckets.cancelled_by_reason, task.cancel_reason);
      }
    }
    return {
      ok: true,
      task_root: listed.task_root,
      generated_at: isoNow(),
      task_count: tasks.length,
      buckets,
      tasks,
    };
  }

  return {
    listTasks,
    incrementBucket,
    taskStatusSummary,
  };
}
