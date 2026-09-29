// CLI、MCP、Pi共用的暂停回执与下一步说明。
export const PAUSE_UNAVAILABLE_REASON = "pause_unavailable";
export const PAUSE_TOOL_DESCRIPTION = "以当前revision执行CAS，协作暂停排队或运行中的任务，保存已有会话供续接，不自动强杀。paused表示执行已停止，不表示业务完成；未确认停止时保留实际状态和写域。重复暂停已暂停任务为幂等成功，已有完成或取消终态保持不变。";
export const RESUME_TOOL_DESCRIPTION = "恢复paused任务或具备可恢复Pi会话的终态任务，沿原task开启新attempt。resume_mode=session载入原会话；start启动尚未开始的原任务。用户要求停止后，须取得新的继续指令。使用subagent_get返回的当前revision执行CAS。";

const NEXT_STEPS = Object.freeze({
  expected_revision_required: "缺少用于CAS的expected_revision。先用subagent_get取得当前revision，再调用subagent_pause。",
  reason_required: "缺少暂停原因。补充非空reason后调用subagent_pause；reason只作说明，不改变动作或权限。",
  pause_unavailable: "当前服务未提供pause(input)，本次未发送暂停请求。核对服务版本，接入暂停实现后先用subagent_get读取当前状态再重试。暂停不会自动改为取消。",
  revision_conflict: "任务版本已变化。先用subagent_get读取当前状态和revision，再按该revision调用subagent_pause。",
  pause_unconfirmed: "尚未确认执行停止，不能判为已暂停。保留当前状态和写域，等待停止确认或用subagent_get查看进展；终止执行需要单独的明确指令。",
  pause_rejected: "暂停请求未被接受。用subagent_get核对当前状态和revision；仍在排队或运行时可重试，已有终态则保留该终态。",
  pause_failed: "本次暂停调用未取得有效回执，任务实际状态尚不确定。先用subagent_get核对，再决定是否重试subagent_pause。",
});

export function pauseNextStep(reason) {
  return NEXT_STEPS[reason] ?? NEXT_STEPS.pause_failed;
}

export function pauseRejection(input, reason, contractVersion) {
  return {
    ...(contractVersion ? { contract_version: contractVersion } : {}),
    task_id: String(input?.task_id ?? ""),
    accepted: false,
    state: "unknown",
    revision: "",
    reason,
    next_step: pauseNextStep(reason),
  };
}

export function normalizePauseReceipt(input, result, contractVersion) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return pauseRejection(input, "pause_failed", contractVersion);
  }
  const accepted = typeof result.accepted === "boolean" ? result.accepted : result.ok === true;
  const reason = typeof result.reason === "string" && result.reason.trim()
    ? result.reason.trim() : accepted ? "pause_accepted" : "pause_rejected";
  const receipt = {
    task_id: result.task_id ?? String(input?.task_id ?? ""), accepted,
    state: typeof result.state === "string" && result.state.trim() ? result.state : "unknown",
    revision: result.revision == null ? "" : String(result.revision), reason,
  };
  if (contractVersion || result.contract_version) receipt.contract_version = result.contract_version ?? contractVersion;
  if (typeof result.next_step === "string" && result.next_step.trim()) receipt.next_step = result.next_step.trim();
  else if (!accepted || receipt.state === "unknown") receipt.next_step = pauseNextStep(reason);
  return receipt;
}
