import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const WORK_RESULT_TYPE = "delegate-work-result";
export const WORK_STATUS_TYPE = "delegate-work-status";
export const WORK_TEXT = Object.freeze({
  delegate: "将明确目标交给同工作区、同权限的后台分身。仅 goal 必填；默认 luna_xhigh。可选 pick：luna_xhigh、luna_max、sol_high；或同时给出 model 与 effort 使用指定模型，不限推荐池与推荐行档位范围，effort 须在该模型可选档位内。pick 与 model 二选一。只给 model 或只给 effort 会报错并列出三档。选型在受理前确认；不可用时返回原因和可选项，不产生 work_id。受理后立即返回 work_id、revision、state，分支后台运行并自动交接。用 task_id=work_id 查询或控制。",
  submit: "明确提交本工作的 completed、needs_decision 或 failed 结果及结论、证据、剩余问题。needs_decision 必须写具体问题与可选项；failed 必须写实际原因和可执行下一步。完成时先结清本次受管理执行，再单独调用 submit_work_result；待决或失败提交会协作暂停仍在执行的本次活动，未确认时须等待后重试。提交后停止，不再派发。",
  kickoff: "你是本目标的后台工作分身，继承来源上下文、现有权限和当前工作区。自行完成准备、派发、自动跟进与结果消费；复用 dispatch_prepare 和现有叶子服务，不要求来源补任务包或主动领取。不要接管继承的旧任务。派发后可以空闲等待完成通知，空闲不等于失败或完成。只在证据充分且本次受管理执行停止后，单独调用 submit_work_result。需要取舍时用 needs_decision 写明具体问题和可选项；失败写真实原因和合法调整办法。",
  resume: "继续同一工作及分支；已保存结果不要重复提交，完成本轮后提交新的 submit_work_result。",
});
const allowedResults = new Set(["completed", "needs_decision", "failed"]);
const allowedStatuses = new Set(["failed", "interrupted"]);
// Old records may contain progress notices and duplicate revisions. A result owns its
// submitted state; only a separate failure/interruption is a status notification.
function migrateNotices(record) {
  const seen = new Map();
  for (const notice of record.status_notices ?? []) {
    if (!allowedStatuses.has(notice.state) || notice.revision == null) continue;
    if (record.results?.some(result => (result.revision != null && String(result.revision) === String(notice.revision))
      || (result.revision == null && result.status === "failed" && notice.state === "failed"
        && record.state === "failed" && String(notice.revision) === String(record.revision)))) continue;
    const key = String(notice.revision);
    const previous = seen.get(key);
    if (!previous) seen.set(key, notice);
    else if (notice.delivered) previous.delivered = true;
  }
  record.status_notices = [...seen.values()];
  return record;
}
const clone = value => structuredClone(value);
const terminal = state => ["completed", "done", "failed", "cancelled", "canceled", "succeeded"].includes(state);
const stateOf = value => value?.transport_state ?? value?.summary?.run_state ?? value?.run_state ?? value?.state ?? value?.driver_status ?? value?.status;
const identity = source => source.sessionManager.getSessionId();
// 同一来源文件可能以相对或绝对路径打开，按解析后的路径比较。
const sessionFileOf = source => {
  const file = source.sessionManager.getSessionFile();
  return file ? path.resolve(file) : null;
};
const sameSource = (record, source) => Boolean(source && identity(source) === record.source_session_id
  && sessionFileOf(source) === (record.source_session_file ? path.resolve(record.source_session_file) : null));
const textOf = message => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");

/** Select the last fully paired tool boundary, never a partial parallel tool batch. */
export function completedBoundary(entries) {
  const pending = new Set();
  let boundary = -1;
  for (let i = 0; i < entries.length; i++) {
    const message = entries[i].message;
    if (message?.role === "assistant") {
      for (const block of message.content ?? []) if (block.type === "toolCall") pending.add(block.id);
    }
    if (message?.role === "toolResult") pending.delete(message.toolCallId);
    if (!pending.size) boundary = i;
  }
  return entries.slice(0, boundary + 1);
}

/** Include assistant, tool-nested, compaction and miscellaneous usage; inherited IDs never count. */
export function incrementalUsage(entries, inheritedIds = []) {
  const inherited = new Set(inheritedIds);
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 }, entry_ids: [] };
  const seen = new Set();
  for (const entry of entries) {
    if (inherited.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const usage = entry.message?.usage ?? entry.usage;
    if (!usage) continue;
    totals.entry_ids.push(entry.id);
    for (const [key, value] of Object.entries(usage)) {
      if (key === "cost") {
        for (const [part, amount] of Object.entries(value ?? {})) {
          if (Number.isFinite(amount)) totals.cost[part] = (totals.cost[part] ?? 0) + amount;
        }
      } else if (Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

export function createWorkStore(root) {
  const file = id => {
    if (!/^work-[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid work_id; use the accepted work_id.");
    return path.join(root, `${id}.json`);
  };
  return {
    root,
    list() {
      if (!existsSync(root)) return [];
      return readdirSync(root).filter(name => /^work-[a-zA-Z0-9-]+\.json$/.test(name))
        .map(name => JSON.parse(readFileSync(path.join(root, name), "utf8")));
    },
    save(record) {
      mkdirSync(root, { recursive: true });
      const destination = file(record.work_id);
      const temp = `${destination}.tmp`;
      writeFileSync(temp, JSON.stringify(record, null, 2));
      renameSync(temp, destination);
    },
  };
}

// Same-process branch binding survives native extension module reloads, without sharing Pi closures.
const bindingsKey = Symbol.for("control-plane.delegate-work.branch-bindings.v1");
export const workBranchBindings = globalThis[bindingsKey] ??= new Map();
export const workBranchBinding = sessionId => workBranchBindings.get(sessionId);

export function createDelegateWorkCore({ store, branchFactory, source = null, onError = () => {} } = {}) {
  if (!store || !branchFactory) throw new TypeError("delegate_work requires store and branchFactory");
  const records = new Map(store.list().map(record => [record.work_id, migrateNotices(record)]));
  const runtimes = new Map();
  const locks = new Map();
  const delivering = new Set();
  // deliver 只是入队：消息落进来源会话前不重投同一版本；进程重启后队列随之丢失，允许重投。
  const inflight = new Map(); // 结果或通知键 → 正在投往的来源；换来源后旧标记不拦新来源。
  const followups = new Map();
  const recoveredSources = new Set();
  let activeSource = source;
  let closed = false;
  const save = record => { store.save(record); return record; };
  const bump = record => { record.revision = String(Number(record.revision) + 1); return save(record); };
  const requireRecord = input => {
    const record = records.get(input.task_id ?? input.work_id);
    if (!record) throw new Error("Unknown work_id; use the receipt from delegate_work.");
    if (!sameSource(record, activeSource)) {
      throw new Error("Source session mismatch; return to the originating Pi session before controlling this work.");
    }
    return record;
  };
  const locked = (id, operation) => {
    const next = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    locks.set(id, next);
    next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => {});
    return next;
  };
  const cas = (record, input) => {
    if (String(input.expected_revision ?? "") !== record.revision) {
      throw new Error(`Revision conflict: current revision=${record.revision}; call subagent_get and retry with expected_revision.`);
    }
  };
  const updateUsage = record => {
    const runtime = runtimes.get(record.work_id);
    if (runtime?.branch) {
      record.usage = incrementalUsage(runtime.branch.entries(), record.inherited_entry_ids);
      record.session_file = runtime.branch.sessionFile;
    }
  };
  const snapshot = record => {
    updateUsage(record);
    const { branch_entries: _context, inherited_entry_ids: _inherited, ...publicRecord } = record;
    return clone({ ...publicRecord, task_id: record.work_id, transport_state: record.state });
  };
  function bindingFor(record) {
    return {
      work_id: record.work_id,
      get active() { return record.state === "running" && !record.pending_result; },
      get taskIds() { return [...record.task_ids]; },
      get runIds() { return [...record.run_ids]; },
      trackTasks(ids) { record.task_ids = [...new Set([...record.task_ids, ...ids])]; save(record); },
      trackFleet(id) { record.run_ids = [...new Set([...record.run_ids, id])]; save(record); },
      attachServices(services) { runtimes.get(record.work_id).services = services; },
      submit: result => submit(record, result),
      settled: () => { setImmediate(() => settle(record.work_id).catch(onError)); },
    };
  }
  async function observations(record) {
    const services = runtimes.get(record.work_id)?.services;
    const values = [];
    for (const task_id of record.task_ids) {
      if (!services?.asyncService) throw new Error("Owned task service unavailable; restore the original branch service before continuing.");
      values.push({ kind: "task", id: task_id, value: await services.asyncService.get({ task_id }) });
    }
    for (const run_id of record.run_ids) {
      if (!services?.fleetCore) throw new Error("Owned Fleet service unavailable; restore the original branch Fleet binding.");
      values.push({ kind: "fleet", id: run_id, value: await services.fleetCore.fleet_status({ run_id }) });
    }
    return values;
  }
  async function submit(record, result) {
    if (record.state !== "running" || record.pending_result) throw new Error("Work is not accepting a result; wait for the pending submission or resume it from the source.");
    if (!["completed", "needs_decision", "failed"].includes(result?.status) || !result.summary?.trim()
      || !Array.isArray(result.evidence) || !Array.isArray(result.residuals)) {
      throw new Error("submit_work_result requires status, nonempty summary, evidence[] and residuals[].");
    }
    if (result.status !== "completed" && !result.next_step?.trim()) {
      throw new Error("needs_decision/failed requires next_step: a concrete question with options, or actual cause and actionable adjustment.");
    }
    if (result.status !== "completed") {
      const pending = await pauseActivities(record, `work_${result.status}: ${result.next_step}`);
      if (pending.length) throw new Error(`Owned execution is still pausing (${pending.join(", ")}); wait for confirmation and retry submit_work_result. No result has been delivered.`);
    }
    const owned = await observations(record);
    if (owned.some(item => !terminal(stateOf(item.value)) && stateOf(item.value) !== "paused")) {
      throw new Error("Owned execution is still active. Wait for leaf notifications and consume results, or submit needs_decision with the concrete question so the work can cooperatively pause its activities.");
    }
    // A submission is a proposal until the SDK run has ended; subsequent settled events are not results themselves.
    if (record.state !== "running" || record.pending_result) throw new Error("Work changed while submitting; inspect the current work state before retrying.");
    record.pending_result = clone(result);
    save(record);
    return { accepted: true, work_id: record.work_id, next_step: "Stop now; delivery follows only after execution settles." };
  }
  async function pauseActivities(record, reason) {
    const services = runtimes.get(record.work_id)?.services;
    const pending = [];
    for (const item of await observations(record)) {
      if (terminal(stateOf(item.value)) || stateOf(item.value) === "paused") continue;
      const ownedPauses = item.kind === "task" ? record.paused_task_ids : record.paused_run_ids;
      const value = item.kind === "task"
        ? await services.asyncService.pause({ task_id: item.id, expected_revision: String(item.value.revision), reason })
        : await services.fleetCore.pause({ run_id: item.id, reason });
      if (value.accepted && !ownedPauses.includes(item.id)) ownedPauses.push(item.id);
      save(record);
      if (stateOf(value) !== "paused" && !terminal(stateOf(value))) pending.push(item.id);
    }
    return pending;
  }
  async function ensureControlServices(record) {
    if ((!record.task_ids.length && !record.run_ids.length) || runtimes.get(record.work_id)?.services) return;
    const runtime = runtimes.get(record.work_id) ?? {};
    runtimes.set(record.work_id, runtime);
    runtime.branch = await branchFactory({ record, source: activeSource, store, binding: bindingFor(record), resume: true });
  }
  function statusNotice(record) {
    if (!allowedStatuses.has(record.state) || record.results.some(result => String(result.revision) === record.revision)) return;
    record.status_notices ??= [];
    if (record.status_notices.some(notice => String(notice.revision) === record.revision)) return;
    record.status_notices.push({ revision: record.revision, state: record.state, work_id: record.work_id,
      summary: record.last_error ?? `Work execution is ${record.state}; this is not a submitted business result.`,
      next_step: record.state === "interrupted"
        ? "用 subagent_get 读取当前 revision 和失败原因；修复依赖后用 subagent_resume 续跑，或明确授权 subagent_cancel。"
        : "用 subagent_get 查看失败原因及当前 revision；该业务失败结果已另行提交时不重复通知。",
      usage: clone(record.usage), delivered: false });
    save(record); void flush();
  }
  async function disposeBranch(record) {
    const runtime = runtimes.get(record.work_id);
    if (!runtime?.branch) return;
    await runtime.branch.stop();
    updateUsage(record);
    save(record);
    await runtime.branch.dispose();
    runtime.branch = null;
  }
  async function settle(id) {
    return locked(id, async () => {
      const record = records.get(id), runtime = runtimes.get(id);
      if (!record || record.state !== "running" || !runtime?.branch?.isIdle()) return;
      updateUsage(record);
      if (!record.pending_result) { save(record); return; } // Idle awaiting leaves is valid.
      if ((await observations(record)).some(item => !terminal(stateOf(item.value)) && stateOf(item.value) !== "paused")) return;
      const result = record.pending_result;
      // Block completion watchers before emitting extension shutdown, so no automatic turn can race delivery.
      record.state = "finalizing";
      save(record);
      try { await disposeBranch(record); }
      catch (error) {
        record.state = "running";
        record.last_error = `${error.message}; finalization remains pending and will retry after the branch stops.`;
        bump(record); statusNotice(record); onError(error);
        scheduleFollowup(record, () => settle(id));
        return;
      }
      record.state = result.status;
      record.result_version += 1;
      record.pending_result = null;
      record.revision = String(Number(record.revision) + 1);
      record.results.push({ version: record.result_version, revision: record.revision, ...result, usage: clone(record.usage), delivered: false });
      save(record);
      void flush();
    });
  }
  function scheduleFollowup(record, operation) {
    if (closed || followups.has(record.work_id)) return;
    const timer = setTimeout(() => {
      followups.delete(record.work_id);
      void Promise.resolve().then(operation).catch(onError);
    }, 250);
    timer.unref?.();
    followups.set(record.work_id, timer);
  }
  function scheduleStop(record) {
    if (["pausing", "cancelling"].includes(record.state)) scheduleFollowup(record, () => locked(record.work_id, () => advanceStop(record)));
  }
  async function advanceStop(record) {
    if (!["pausing", "cancelling"].includes(record.state) || !record.control) return snapshot(record);
    const before = JSON.stringify([record.state, record.pending_activity_ids, record.last_error]);
    const { action, reason, final_state } = record.control;
    try {
      await ensureControlServices(record);
      await disposeBranch(record);
      const runtime = runtimes.get(record.work_id);
      const pending = [];
      if (action === "pause") pending.push(...await pauseActivities(record, reason));
      else {
        for (const item of await observations(record)) {
          if (terminal(stateOf(item.value))) continue;
          const value = item.kind === "task"
            ? await runtime.services.asyncService.cancel({ task_id: item.id, expected_revision: String(item.value.revision), reason })
            : await runtime.services.fleetCore.fleet_cancel({ run_id: item.id, reason });
          if (!terminal(stateOf(value))) pending.push(item.id);
        }
      }
      record.pending_activity_ids = pending;
      if (!pending.length && !runtime?.building && (action === "cancel" || record.session_file || final_state === "interrupted")) {
        record.state = final_state;
        if (action === "cancel") record.pending_result = null;
      }
    } catch (error) {
      record.last_error = `${error.message}; ${action} remains pending; restore the named service and retry with the current revision.`;
    }
    if (before !== JSON.stringify([record.state, record.pending_activity_ids, record.last_error])) {
      bump(record);
      if (record.state === "interrupted") statusNotice(record);
    }
    scheduleStop(record);
    return snapshot(record);
  }
  async function start(record, prompt, resume = false) {
    const runtime = runtimes.get(record.work_id) ?? {};
    runtimes.set(record.work_id, runtime);
    runtime.building = true;
    try {
      runtime.branch = await branchFactory({ record, source: runtime.source ?? activeSource, store, binding: bindingFor(record), resume });
      runtime.building = false;
      record.session_file = runtime.branch.sessionFile;
      record.inherited_entry_ids ??= runtime.branch.inheritedIds;
      if (closed || !["starting", "running"].includes(record.state)) { await disposeBranch(record); return; }
      record.state = "running";
      bump(record);
      // Do not hold the control lock across a model turn or an idle wait for leaves.
      Promise.resolve(runtime.branch.prompt(prompt)).then(() => settle(record.work_id))
        .catch(error => fail(record, error));
    } catch (error) {
      // The native factory may have written its header before throwing. Reopen that
      // durable file on resume rather than clobbering it with a second first-run header.
      if (!record.session_file) {
        const candidate = path.join(store.root, `${record.work_id}.session.jsonl`);
        if (existsSync(candidate)) { record.session_file = candidate; save(record); }
      }
      await fail(record, error);
    }
    finally {
      runtime.building = false;
      if (["pausing", "cancelling"].includes(record.state)) await locked(record.work_id, () => advanceStop(record));
    }
  }
  async function fail(record, error) {
    if (["pausing", "cancelling", "paused", "cancelled"].includes(record.state)) return;
    record.last_error = String(error?.message ?? error);
    if (["starting", "running"].includes(record.state)) {
      record.control = { action: "pause", reason: record.last_error, final_state: "interrupted" };
      record.state = "pausing"; bump(record);
      await locked(record.work_id, () => advanceStop(record));
    } else save(record);
    // advanceStop emits once on confirmed interruption; a pending stop is not a source event.
    onError(error);
  }
  async function flush() {
    const target = activeSource;
    if (!target || closed || !target.isIdle()) return;
    for (const record of records.values()) {
      if (!sameSource(record, target) || delivering.has(record.work_id)) continue;
      migrateNotices(record); // Also filter persisted old outbox entries before every replay.
      delivering.add(record.work_id);
      try {
        for (const result of record.results) {
          if (result.delivered || !allowedResults.has(result.status)) continue;
          const prior = target.entries().find(entry => entry.type === "custom_message" && entry.customType === WORK_RESULT_TYPE
            && entry.details?.work_id === record.work_id && entry.details?.version === result.version);
          const resultKey = `${record.work_id}:v${result.version}`;
          if (!prior && inflight.get(resultKey) !== target) {
            if (activeSource !== target || !target.isIdle()) break;
            const details = { work_id: record.work_id, revision: record.revision, ...clone(result) };
            await target.deliver({ customType: WORK_RESULT_TYPE, display: true, details,
              content: `[后台工作结果]\n${JSON.stringify(details)}${result.status === "needs_decision" ? "\n请在来源会话写明决定，再用当前 revision 调用 subagent_resume；无需新增参数。" : ""}` });
            inflight.set(resultKey, target);
          }
          const receipt = target.entries().find(entry => entry.type === "custom_message" && entry.customType === WORK_RESULT_TYPE
            && entry.details?.work_id === record.work_id && entry.details?.version === result.version);
          if (!receipt) break; // Enqueue is not durable acknowledgement.
          inflight.delete(resultKey);
          if (!result.delivered) {
            result.delivered = true;
            if (result.version === record.result_version) record.source_cursor = receipt.id;
            save(record);
          }
        }
        for (const notice of record.status_notices ?? []) {
          if (notice.delivered || !allowedStatuses.has(notice.state)) continue;
          const received = () => target.entries().some(entry => entry.type === "custom_message" && entry.customType === WORK_STATUS_TYPE
            && entry.details?.work_id === record.work_id && entry.details?.revision === notice.revision);
          const noticeKey = `${record.work_id}:r${notice.revision}`;
          if (!received() && inflight.get(noticeKey) !== target) {
            if (activeSource !== target || !target.isIdle()) break;
            await target.deliver({ customType: WORK_STATUS_TYPE, display: true, details: clone(notice), content: `[后台工作执行状态]\n${JSON.stringify(notice)}` });
            inflight.set(noticeKey, target);
          }
          if (received()) { inflight.delete(noticeKey); notice.delivered = true; save(record); }
        }
      } catch (error) { record.last_delivery_error = String(error.message ?? error); save(record); onError(error); }
      finally { delivering.delete(record.work_id); }
    }
  }
  const api = {
    has: id => records.has(id),
    list: () => [...records.values()].map(snapshot),
    async delegate({ goal, selection }) {
      if (closed || !activeSource) throw new Error("No active source session; start the Pi session before delegate_work.");
      if (typeof goal !== "string" || !goal.trim()) throw new Error("goal must describe a nonempty work target.");
      if (!selection || typeof selection.provider !== "string" || !selection.provider
        || typeof selection.model_id !== "string" || !selection.model_id
        || typeof selection.effort !== "string" || !selection.effort
        || !selection.provenance || typeof selection.provenance !== "object") {
        throw new TypeError("delegate_work requires a preflighted selection before creating work.");
      }
      const record = { work_id: `work-${randomUUID()}`, goal: goal.trim(), revision: "1", state: "starting",
        selection: clone(selection),
        source_session_id: identity(activeSource), source_session_file: sessionFileOf(activeSource),
        source_cursor: activeSource.sessionManager.getLeafId(), session_file: null, inherited_entry_ids: null,
        task_ids: [], run_ids: [], paused_task_ids: [], paused_run_ids: [], results: [], result_version: 0, pending_result: null,
        usage: incrementalUsage([]) };
      // Freeze the source object and completed context now, not after the source changes pages.
      const captured = activeSource;
      record.branch_entries = clone(completedBoundary(captured.sessionManager.getBranch()));
      records.set(record.work_id, record);
      runtimes.set(record.work_id, { source: captured });
      save(record);
      setImmediate(() => start(record, `${WORK_TEXT.kickoff}\n\n目标：${record.goal}`));
      return snapshot(record);
    },
    get(input) { return snapshot(requireRecord(input)); },
    async pause(input) {
      return locked(input.task_id, async () => {
        const record = requireRecord(input); cas(record, input);
        if (!input.reason?.trim()) throw new Error("pause requires a nonempty reason.");
        if (record.state === "cancelling") return {
          ...snapshot(record),
          next_step: "Cancellation is in progress; use subagent_get to check for confirmed cancellation.",
        };
        if (["pausing", "paused"].includes(record.state) || terminal(record.state)) return snapshot(record);
        record.control = { action: "pause", reason: input.reason, final_state: "paused" };
        record.state = "pausing"; bump(record);
        const result = await advanceStop(record);
        statusNotice(record);
        return result;
      });
    },
    async resume(input) {
      return locked(input.task_id, async () => {
        const record = requireRecord(input); cas(record, input);
        if (!["paused", "needs_decision", "interrupted"].includes(record.state)) throw new Error(`Cannot resume ${record.state}; wait for confirmed pause, or inspect subagent_get.`);
        let explanation = "";
        if (record.state === "needs_decision") {
          const entries = activeSource.sessionManager.getBranch();
          const index = entries.findIndex(entry => entry.id === record.source_cursor);
          if (index < 0) throw new Error("Decision cursor is not on this source branch; return to the original source history before resume.");
          explanation = entries.slice(index + 1).filter(entry => ["user", "assistant"].includes(entry.message?.role))
            .map(entry => textOf(entry.message)).filter(text => text.trim()).join("\n\n");
        }
        const previous = record.state;
        record.state = "starting"; bump(record);
        const runtime = runtimes.get(record.work_id) ?? { source: activeSource };
        runtimes.set(record.work_id, runtime);
        try {
          // Rebuild stopped extensions before resuming owned services, but gate their notifications until running.
          // Crash may have happened after native header creation but before the work record was saved.
          if (!record.session_file) {
            const candidate = path.join(store.root, `${record.work_id}.session.jsonl`);
            if (existsSync(candidate)) { record.session_file = candidate; save(record); }
          }
          runtime.branch = await branchFactory({ record, source: activeSource, store, binding: bindingFor(record), resume: Boolean(record.session_file) });
          record.session_file = runtime.branch.sessionFile;
          record.inherited_entry_ids ??= runtime.branch.inheritedIds;
          save(record);
          for (const id of record.paused_run_ids) {
            const value = await runtime.services.fleetCore.resume({ run_id: id });
            if (!value.accepted || ["paused", "pausing"].includes(stateOf(value))) throw new Error(`Fleet ${id} has not resumed: ${value.reason ?? value.error?.message ?? "unconfirmed"}; ${(value.errors ?? []).join("; ")}. Inspect fleet_status and retry after resolving the cause.`);
          }
          for (const id of record.paused_task_ids) {
            const current = await runtime.services.asyncService.get({ task_id: id });
            if (terminal(stateOf(current))) continue;
            const value = await runtime.services.asyncService.resume({ task_id: id, expected_revision: String(current.revision) });
            if (!value.accepted) throw new Error(`Task ${id} resume rejected: ${value.reason ?? value.error?.message ?? "unconfirmed"}; inspect subagent_get and retry after resolving the cause.`);
          }
          record.paused_task_ids = []; record.paused_run_ids = [];
          record.pending_result = null; record.last_error = null; record.state = "running"; bump(record);
          Promise.resolve(runtime.branch.prompt(`${WORK_TEXT.resume}\n${explanation}`)).then(() => settle(record.work_id)).catch(error => fail(record, error));
        } catch (error) {
          record.last_error = `${error.message}; inspect the owned activity states before retrying resume.`;
          record.control = { action: "pause", reason: record.last_error, final_state: previous === "needs_decision" ? previous : "interrupted" };
          record.state = "pausing"; bump(record);
          await advanceStop(record);
        }
        return snapshot(record);
      });
    },
    async cancel(input) {
      return locked(input.task_id, async () => {
        const record = requireRecord(input); cas(record, input);
        if (!input.reason?.trim()) throw new Error("cancel requires a nonempty reason; use only explicit stop authorization.");
        if (["cancelling", "cancelled"].includes(record.state)) return snapshot(record);
        record.control = { action: "cancel", reason: input.reason, final_state: "cancelled" };
        record.state = "cancelling"; bump(record);
        const result = await advanceStop(record);
        statusNotice(record);
        return result;
      });
    },
    acknowledge(message, sourceId) {
      if (message?.customType !== WORK_RESULT_TYPE) return;
      const record = records.get(message.details?.work_id);
      if (!record || record.source_session_id !== sourceId || !sameSource(record, activeSource)) return;
      const result = record.results.find(item => item.version === message.details?.version);
      const entry = activeSource.entries().find(item => item.type === "custom_message" && item.customType === WORK_RESULT_TYPE
        && item.details?.work_id === record.work_id && item.details?.version === result?.version);
      if (!result || !entry) return;
      result.delivered = true;
      if (result.version === record.result_version) record.source_cursor = entry.id;
      save(record);
    },
    attachSource(next) { activeSource = next; closed = false; recoverSource(next); void flush(); },
    detachSource() { activeSource = null; },
    flush,
    settle,
    async close() {
      closed = true;
      for (const timer of followups.values()) clearTimeout(timer);
      followups.clear();
      for (const record of records.values()) {
        if (runtimes.has(record.work_id) && ["starting", "running", "pausing", "cancelling"].includes(record.state)) {
          await locked(record.work_id, async () => {
            if (record.state !== "cancelling") record.control = { action: "pause", reason: "source session closed", final_state: "interrupted" };
            record.state = record.control.action === "cancel" ? "cancelling" : "pausing";
            bump(record); await advanceStop(record);
          });
        }
      }
      activeSource = null;
    },
  };
  function recoverSource(next) {
    const id = identity(next);
    if (recoveredSources.has(id)) return;
    recoveredSources.add(id);
    for (const record of records.values()) {
      if (sameSource(record, next) && !runtimes.has(record.work_id) && ["starting", "running", "finalizing", "pausing", "cancelling"].includes(record.state)) {
        record.last_error ??= "Source process ended during branch execution; inspect saved work and resume or cancel.";
        record.state = "interrupted"; bump(record); statusNotice(record);
      }
    }
  }
  if (source) recoverSource(source);
  return api;
}
