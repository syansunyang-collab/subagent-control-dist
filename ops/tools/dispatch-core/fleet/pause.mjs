// fleet_scheduler.mjs 按职责拆出的 pause。只搬移代码，不改行为。
import { api } from "./api.mjs";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pyJsonLoads, pyStr } from "../_py.mjs";
import { isRecord, loadJson as readJson, ROOT, ToolError, utcNow } from "../_tool_common.mjs";
import { ACTIVE_STATES, TERMINAL_STATES } from "./constants.mjs";
import { deps } from "./deps.mjs";
import { hostPaths } from "./host-paths.mjs";
import { runMutationLock } from "./locks.mjs";
import { requireRepoInternal, runDir, statePath, writeJson } from "./paths.mjs";

export function pauseRequestPath(root, runId) {
  return path.join(runDir(root, runId), "pause-request.json");
}

/** 停派意图的权威来源是独立控制文件，不是状态快照；读不到返回 null。 */
export function readPauseIntent(root, runId) {
  const target = pauseRequestPath(root, runId);
  return existsSync(target) ? readJson(target) : null;
}

export const PAUSE_UNCONFIRMED_NEXT_STEP = "已登记的暂停请求尚未确认停止：用 status 观察收敛，或等任务会话保存完成；"
  + "Fleet 不自动强杀，也不释放未停止任务的写域；确实需要终止请显式 cancel。";

export const RESUME_SEAM_NEXT_STEP = "恢复尚未完成，停派意图和未恢复任务已保留；根据 errors 排除原因后重试 resume。";

/** 解析 async service 控制子命令的 JSON 回执；非 0 退出或非对象一律返回 null。 */
export function parseControlReply(result, label) {
  if (!result || result.exit_code !== 0) return null;
  try {
    const data = pyJsonLoads(String(result.stdout ?? ""));
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

export function controlFailureDetail(result) {
  return String(result?.stderr || result?.stdout || "").trim().slice(0, 300);
}

/** 以当前 revision 调用 Core 的协作暂停/恢复；不强杀、不释放写域。 */
export function runAsyncControl(operation, taskRoot, taskId, { expectedRevision = "", reason = "" } = {}) {
  const argv = [
    process.execPath,
    hostPaths.ASYNC_SERVICE_PATH,
    "internal",
    operation,
    "--task-root",
    pyStr(taskRoot),
    "--task-id",
    pyStr(taskId),
  ];
  if (expectedRevision) argv.push("--expected-revision", pyStr(expectedRevision));
  if (reason) argv.push("--reason", pyStr(reason));
  const result = deps.runCommand(argv, ROOT);
  return { reply: parseControlReply(result, `async internal ${operation}`), detail: controlFailureDetail(result) };
}

/**
 * 记录本次 run 的停派意图并逐任务发起 Core.pause，返回冻结回执。
 * 只记录本次 pause 实际发起的 task_ids；此前已独立暂停的任务进 independent_task_ids，不自动恢复。
 */
export function settlePause(state, { reason = null } = {}) {
  const errors = [];
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  const intent = readPauseIntent(root, runId);
  const intentReason = pyStr(reason || intent?.reason || state.pause_request?.reason || "pause_requested");
  const recorded = new Set(
    [...(intent?.task_ids ?? []), ...(state.pause_request?.task_ids ?? [])].map((item) => pyStr(item)).filter(Boolean),
  );
  const independent = new Set(
    [...(intent?.independent_task_ids ?? []), ...(state.pause_request?.independent_task_ids ?? [])]
      .map((item) => pyStr(item)).filter(Boolean),
  );
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).filter((node) => isRecord(node));

  // cancel 优先：已有取消请求时暂停不再动作，也不改写既有终态。
  if (existsSync(api.cancellationPath(root, runId))) {
    const cancellation = readJson(api.cancellationPath(root, runId));
    const cancellationState = ["cancelled", "cancelling"].includes(pyStr(state.run_state))
      ? pyStr(state.run_state)
      : "cancelling";
    return {
      run_id: runId,
      accepted: false,
      state: cancellationState,
      reason: "cancel_priority",
      paused_task_ids: [],
      pending_task_ids: [],
      next_step: `已存在取消请求（${pyStr(cancellation?.reason || "")}），暂停不再执行；用 status 观察取消收敛，`
        + "取消完成后需要继续时按新 run 处理。",
    };
  }

  if (nodes.length && nodes.every((node) => TERMINAL_STATES.has(node.state))) {
    // 已收口的 run 保持原终态，不改成 paused。
    const settled = api.driverOutcome({ ...state, run_state: "running" });
    state.run_state = settled;
    state.updated_at = utcNow();
    return {
      run_id: runId,
      accepted: true,
      state: settled,
      reason: "run_already_settled",
      paused_task_ids: [],
      pending_task_ids: [],
    };
  }

  for (const node of nodes) {
    const taskId = pyStr(node.task_id || "");
    if (!taskId) continue;
    if (!(ACTIVE_STATES.has(node.state) || node.state === "paused")) continue;
    const taskRoot = api.nodeTaskRoot(state, node);
    const [statuses, failures] = api.asyncInternalBatch("get", taskRoot, [taskId], { detail: "diagnostic" });
    errors.push(...failures);
    const status = statuses[taskId];
    if (!status) {
      errors.push(`${pyStr(node.id)}: async get missing task ${taskId}`);
      continue;
    }
    if (status.state === "paused") {
      // 本次 pause 之前就已暂停的任务保持独立，不列入自动恢复集合。
      if (!recorded.has(taskId)) independent.add(taskId);
      api.applyAsyncStatus(node, status, "fleet_pause", state);
      continue;
    }
    if (!ACTIVE_STATES.has(status.state)) {
      api.applyAsyncStatus(node, status, "fleet_pause", state);
      continue;
    }
    if (node.pause_requested) continue;
    const control = runAsyncControl("pause", taskRoot, taskId, {
      expectedRevision: pyStr(status.revision),
      reason: intentReason,
    });
    if (!control.reply) {
      errors.push(`${pyStr(node.id)}: internal pause 未取得回执${control.detail ? `：${control.detail}` : ""}`);
      continue;
    }
    node.pause_request_reason = pyStr(control.reply.reason || "");
    if (control.reply.reason === "already_paused") {
      independent.add(taskId);
      continue;
    }
    if (control.reply.accepted === false || control.reply.ok === false) {
      errors.push(`${pyStr(node.id)}: ${pyStr(control.reply.reason || "pause_rejected")}`
        + `${control.reply.next_step ? ` — ${pyStr(control.reply.next_step)}` : ""}`);
      continue;
    }
    node.pause_requested = true;
    recorded.add(taskId);
  }

  // 收敛观察：本次发起的任务只有确认停止后才算 paused。
  const pausedTaskIds = [];
  const pendingTaskIds = [];
  for (const taskId of [...recorded]) {
    const node = nodes.find((item) => pyStr(item.task_id || "") === taskId);
    if (!node) {
      pendingTaskIds.push(taskId);
      continue;
    }
    const [statuses, failures] = api.asyncInternalBatch("get", api.nodeTaskRoot(state, node), [taskId], { detail: "diagnostic" });
    errors.push(...failures);
    const status = statuses[taskId];
    if (status) api.applyAsyncStatus(node, status, "fleet_pause", state);
    if (status?.state === "paused") pausedTaskIds.push(taskId);
    else if (!status || !TERMINAL_STATES.has(status.state)) pendingTaskIds.push(taskId);
  }

  const unmanagedActive = nodes
    .filter((node) => ACTIVE_STATES.has(node.state) && !pyStr(node.task_id || ""))
    .map((node) => pyStr(node.id));
  const activeAny = nodes.some((node) => ACTIVE_STATES.has(node.state));
  const runState = pendingTaskIds.length || activeAny ? "pausing" : "paused";
  state.pause_request = {
    reason: intentReason,
    requested_at: pyStr(intent?.requested_at || state.pause_request?.requested_at || utcNow()),
    task_ids: [...recorded],
    independent_task_ids: [...independent],
    paused_task_ids: pausedTaskIds,
    pending_task_ids: pendingTaskIds,
    updated_at: utcNow(),
  };
  state.run_state = runState;
  state.updated_at = utcNow();
  if (intent) {
    // 锁内唯一写者：把已发起的 task_ids 回写控制文件，旧状态快照无法丢掉暂停意图。
    writeJson(pauseRequestPath(root, runId), {
      ...intent,
      reason: intentReason,
      task_ids: [...recorded],
      independent_task_ids: [...independent],
      updated_at: utcNow(),
    });
  }
  const receipt = {
    run_id: runId,
    accepted: true,
    state: runState,
    reason: pendingTaskIds.length ? "pause_requested" : (recorded.size ? "pause_confirmed" : "pause_idle"),
    paused_task_ids: pausedTaskIds,
    pending_task_ids: pendingTaskIds,
  };
  if (errors.length) {
    receipt.errors = errors.slice(0, 20);
    receipt.next_step = PAUSE_UNCONFIRMED_NEXT_STEP;
  } else if (unmanagedActive.length) {
    receipt.next_step = `节点 ${unmanagedActive.join(", ")} 为同步执行，不能协作暂停；`
      + "等其本轮结束且无其他活动执行后 run 才进入 paused。";
  }
  return receipt;
}

/** 先持久停派意图，再以各任务当前 revision 调用 Core.pause；不强杀、不释放写域。 */
export function pauseRun(runId, root, reason) {
  const resolvedRoot = requireRepoInternal(root, "state root");
  const text = String(reason || "").trim();
  if (!text) throw new ToolError("pause reason is required");
  readJson(statePath(resolvedRoot, runId));
  const intentPath = pauseRequestPath(resolvedRoot, runId);
  if (!existsSync(intentPath)) {
    // 独立于 tick 锁落盘：意图先于任务暂停持久，driver 的旧快照不能再派新节点。
    writeJson(intentPath, { reason: text, requested_at: utcNow(), task_ids: [], independent_task_ids: [] });
  }
  try {
    return runMutationLock(resolvedRoot, runId, () => {
      const state = readJson(statePath(resolvedRoot, runId));
      state.resume_pending = false;
      const receipt = settlePause(state, { reason: text });
      writeJson(statePath(resolvedRoot, runId), state);
      // cancel 优先：取消已在途时不留下悬挂的停派意图。
      if (receipt.reason === "cancel_priority") rmSync(intentPath, { force: true });
      return receipt;
    }, { timeoutSeconds: 15 });
  } catch (error) {
    if (!String(error.message).startsWith("fleet run mutation lock busy:")) throw error;
    return {
      run_id: runId,
      accepted: true,
      state: "pausing",
      reason: "waiting_for_inflight_operation",
      paused_task_ids: [],
      pending_task_ids: [],
      next_step: "调度器正在处理本轮派发，停派意图已落盘；driver 下一轮 tick 会继续协作暂停，用 status 观察收敛。",
    };
  }
}

/** 只恢复本次 pause 记录的任务；独立暂停的任务保持暂停，会话路径与 task_id 不变。 */
export function resumePausedTasks(state, intent) {
  const errors = [];
  const pendingTaskIds = [];
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).filter((node) => isRecord(node));
  for (const rawTaskId of (intent?.task_ids ?? [])) {
    const taskId = pyStr(rawTaskId);
    if (!taskId) continue;
    const node = nodes.find((item) => pyStr(item.task_id || "") === taskId);
    if (!node) {
      pendingTaskIds.push(taskId);
      errors.push(`${taskId}: 已不再绑定到任何节点，未恢复`);
      continue;
    }
    const taskRoot = api.nodeTaskRoot(state, node);
    const [statuses, failures] = api.asyncInternalBatch("get", taskRoot, [taskId], { detail: "diagnostic" });
    errors.push(...failures);
    const status = statuses[taskId];
    if (!status) {
      pendingTaskIds.push(taskId);
      errors.push(`${taskId}: async get missing task`);
      continue;
    }
    if (status.state !== "paused") {
      api.applyAsyncStatus(node, status, "fleet_resume", state);
      if (ACTIVE_STATES.has(status.state) && node.pause_requested) pendingTaskIds.push(taskId);
      continue;
    }
    const control = runAsyncControl("resume", taskRoot, taskId, { expectedRevision: pyStr(status.revision) });
    if (!control.reply || control.reply.ok === false || control.reply.accepted === false) {
      pendingTaskIds.push(taskId);
      const reason = control.reply ? pyStr(control.reply.reason || "resume_rejected") : `internal resume 未取得回执${control.detail ? `：${control.detail}` : ""}`;
      errors.push(`${taskId}: ${reason}`);
      continue;
    }
    node.pause_requested = false;
    node.pause_request_reason = null;
  }
  return { pending_task_ids: pendingTaskIds, errors };
}

Object.assign(api, {
  pauseRequestPath,
  readPauseIntent,
  parseControlReply,
  controlFailureDetail,
  runAsyncControl,
  settlePause,
  pauseRun,
  resumePausedTasks,
  PAUSE_UNCONFIRMED_NEXT_STEP,
  RESUME_SEAM_NEXT_STEP,
});
