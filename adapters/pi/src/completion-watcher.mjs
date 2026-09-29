import {
  ArtifactAttestationError,
  isTerminalTransportState,
  normalizeTaskState,
  resultTrackingVersion,
} from "./async-service.mjs";

export const COMPLETION_NOTICE_EVENT = "completion_notice";
export const STALL_NOTICE_EVENT = "stall_notice";
export const PAUSE_NOTICE_EVENT = "pause_notice";
export const DEFAULT_COMPLETION_MAX_POLLS = Number.POSITIVE_INFINITY;

// Core 在 running 任务静默超阈值时写 status.stall；每个 suspected_at 只投递一次，任务继续被跟踪。
function stallOf(value) {
  const stall = value && typeof value === "object" ? value.stall : null;
  return stall && typeof stall === "object" && stall.suspected_at ? stall : null;
}

function firstDefined(value, keys) {
  for (const key of keys) {
    if (value && value[key] !== undefined) return value[key];
  }
  return undefined;
}

function taskIdOf(value) {
  return firstDefined(value, ["task_id"]);
}

function revisionOf(value) {
  return firstDefined(value, ["revision"]);
}

function eventsFromReconcile(value) {
  if (Array.isArray(value.events)) return value.events;
  if (Array.isArray(value.tasks)) return value.tasks;
  return undefined;
}

function normalizedTaskIds(values) {
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const taskId = String(value ?? "").trim();
    if (taskId) output.push(taskId);
  }
  return [...new Set(output)];
}

function attested(value) {
  const state = normalizeTaskState(value);
  if (state.artifact_refs.length === 0) return true;
  const candidate = firstDefined(value, ["artifact_attestation", "attestation"]);
  return Boolean(candidate) && typeof candidate === "object" && candidate.verified === true;
}

function sameRevision(left, right) {
  return left !== undefined
    && right !== undefined
    && String(left) === String(right);
}

export async function readCompletionNotice(service, current, sessionId, expectedRefs = current.artifact_refs) {
  let result = current;
  let observed = null;
  let available = false;
  let error = null;
  let retryable = false;
  try {
    const read = service.peekResult ?? service.result;
    const candidate = normalizeTaskState(await read.call(service, { task_id: current.task_id }));
    observed = candidate;
    if (sameRevision(candidate.revision, current.revision) && attested(candidate)
      && (expectedRefs.length === 0 || candidate.artifact_refs.length > 0)) {
      result = candidate;
      available = true;
    } else error = "artifact_attestation_or_revision_mismatch";
  } catch (cause) {
    // 读取抛错分两类：未通过证明的契约性拒绝重读不会改变结论；收据缺失、派生失败、
    // IO 等异常可能是瞬时的，重读后可以补投结果。
    error = cause instanceof Error ? cause.message : String(cause);
    retryable = !(cause instanceof ArtifactAttestationError) && cause?.code !== "artifact_attestation_failed";
  }
  return {
    event: COMPLETION_NOTICE_EVENT,
    session_id: sessionId,
    task_id: result.task_id,
    revision: result.revision,
    transport_state: result.transport_state,
    business_state: result.business_state,
    ...((result.task_outcome ?? current.task_outcome) ? { task_outcome: result.task_outcome ?? current.task_outcome } : {}),
    ...(typeof current.failure_summary === "string" && current.failure_summary.trim()
      ? { failure_summary: current.failure_summary.trim() } : {}),
    review_gate: result.review_gate ?? null,
    registry_ref: result.registry_ref,
    artifact_refs: available ? result.artifact_refs : [],
    result_available: available,
    result_error: error,
    // 状态已知但结果未释放时，标识这次失败能否随重读自行解除。
    result_retryable: retryable,
    // 消费身份：即使收据因 revision 未对齐而不释放，它仍标识已读的是哪个结果版本。
    result_tracking_version: resultTrackingVersion(observed) ?? resultTrackingVersion(current),
  };
}

// 暂停提醒的唯一构造入口：watcher 现场投递和投递缓冲刷新都取同一形状，避免两处各写一份字段规则。
export function pauseNoticeFrom(current, sessionId) {
  return {
    event: PAUSE_NOTICE_EVENT,
    session_id: sessionId,
    task_id: current.task_id,
    revision: current.revision,
    transport_state: "paused",
    business_state: current.business_state ?? null,
    registry_ref: current.registry_ref ?? null,
    resumable: current.resumable === true,
    session_file: current.session_file ?? null,
    resume_mode: current.resume_mode ?? null,
    ...(typeof current.next_step === "string" && current.next_step.trim()
      ? { next_step: current.next_step.trim() }
      : {}),
  };
}

export class CompletionWatcher {
  constructor({
    service,
    onNotice,
    onRecovery = null,
    reconcileInput = {},
    sessionId = null,
    pollIntervalMs = 1000,
    maxPolls = DEFAULT_COMPLETION_MAX_POLLS,
    discoverSnapshot = false,
  } = {}) {
    if (!service) throw new TypeError("CompletionWatcher requires a PiAsyncService");
    if (typeof onNotice !== "function") throw new TypeError("CompletionWatcher requires onNotice");
    this.service = service;
    this.onNotice = onNotice;
    this.onRecovery = typeof onRecovery === "function" ? onRecovery : null;
    this.reconcileInput = { ...reconcileInput };
    this.sessionId = sessionId;
    this.discoverSnapshot = discoverSnapshot;
    this.watchedTaskIds = new Set(normalizedTaskIds(reconcileInput.task_ids));
    this.started = false;
    this.unsubscribe = null;
    this.delivered = new Set();
    this.pending = new Set();
    this.pollIntervalMs = Math.max(Number(pollIntervalMs) || 0, 0);
    const normalizedMaxPolls = Number(maxPolls);
    this.maxPolls = normalizedMaxPolls === Number.POSITIVE_INFINITY
      ? normalizedMaxPolls
      : Math.max(normalizedMaxPolls || 0, 0);
    this.pollCount = 0;
    this.pollTimer = null;
    this.polling = false;
    this.lastPollError = null;
    this.sessionGeneration = 0;
    this.recoveryPending = false;
    this.observationErrors = new Map();
    // 已投递过的“状态已知但结果读取失败”提醒：同任务同 revision 同原因只发一次，
    // 任务保留跟踪，故障解除后仍能补投带结果的通知。
    this.pendingResults = new Map();
  }

  async resetSession({ sessionId = null, taskIds = [] } = {}) {
    await this.stop();
    this.sessionId = sessionId;
    this.watchedTaskIds = new Set(normalizedTaskIds(taskIds));
    this.delivered.clear();
    this.pending.clear();
    this.pollCount = 0;
    this.polling = false;
    this.lastPollError = null;
    this.recoveryPending = false;
    this.observationErrors = new Map();
    this.pendingResults = new Map();
    return this;
  }

  async start() {
    if (this.started) return this;
    this.started = true;
    const generation = this.sessionGeneration;
    try {
      const unsubscribe = this.service.subscribeStateEvents?.(
        (event) => this.handleStateEvent(event, { generation }),
      );
      this.unsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;
      const reconciled = await this.reconcileCurrentTasks();
      if (!this.started || generation !== this.sessionGeneration) return this;
      const reconciledEvents = eventsFromReconcile(reconciled);
      this.recoveryPending = Boolean(this.onRecovery);
      try {
        await this.deliverRecovery(reconciledEvents, generation);
      } catch (error) {
        // 提示投递失败不关闭现有观察链；下一次既有 poll 使用新现场重试。
        this.lastPollError = error;
      }
      if (!this.started || generation !== this.sessionGeneration) return this;
      for (const event of reconciledEvents) {
        await this.handleStateEvent(event, { generation });
      }
      this.schedulePoll();
      return this;
    } catch (error) {
      if (this.started && generation === this.sessionGeneration) {
        this.lastPollError = error;
        this.schedulePoll();
      }
    }
    return this;
  }

  async deliverRecovery(events, generation) {
    if (!this.recoveryPending || !this.onRecovery || !this.started || generation !== this.sessionGeneration) return;
    const tasks = events.map((event) => normalizeTaskState(event)).filter((event) => (
      this.watchedTaskIds.has(String(taskIdOf(event) ?? "").trim())
      && !isTerminalTransportState(event.transport_state)
    ));
    const observationErrors = [...this.observationErrors]
      // 已经不再跟踪的任务不再汇报：登记已清，旧故障不能继续声称“登记仍保留”。
      .filter(([task_id]) => this.watchedTaskIds.has(task_id))
      .map(([task_id, error]) => ({ task_id, error }));
    if (tasks.length || observationErrors.length) {
      await this.onRecovery({ session_id: this.sessionId, generation, tasks, observation_errors: observationErrors });
    }
    if (this.started && generation === this.sessionGeneration) this.recoveryPending = false;
  }

  async stop() {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    this.started = false;
    this.sessionGeneration += 1;
    this.clearPollTimer();
    if (typeof unsubscribe === "function") await unsubscribe();
  }

  async trackTaskIds(taskIds) {
    const added = normalizedTaskIds(taskIds).filter((taskId) => !this.watchedTaskIds.has(taskId));
    for (const taskId of added) this.watchedTaskIds.add(taskId);
    if (this.started && added.length > 0) {
      const generation = this.sessionGeneration;
      const reconciled = await this.reconcileCurrentTasks(added);
      if (!this.started || generation !== this.sessionGeneration) {
        return { added: [], watched: [...this.watchedTaskIds] };
      }
      for (const event of eventsFromReconcile(reconciled)) {
        await this.handleStateEvent(event, { generation });
      }
      this.schedulePoll();
    }
    return { added, watched: [...this.watchedTaskIds] };
  }

  async reconcileCurrentTasks(taskIds = [...this.watchedTaskIds]) {
    let selected = normalizedTaskIds(taskIds);
    let discoveredTaskRoot = null;
    if (selected.length === 0 && this.discoverSnapshot && typeof this.service.snapshot === "function") {
      const snapshot = await this.service.snapshot({
        task_root: this.reconcileInput.task_root,
        limit: this.reconcileInput.limit ?? 200,
      });
      selected = normalizedTaskIds(snapshot?.tasks?.map((task) => task?.task_id));
      discoveredTaskRoot = snapshot?.task_root ?? null;
      for (const taskId of selected) this.watchedTaskIds.add(taskId);
    }
    // 退出跟踪的任务同步丢弃旧故障与旧重试记录，避免反复提醒或无限增长。
    for (const taskId of [...this.observationErrors.keys()]) {
      if (!this.watchedTaskIds.has(taskId)) this.observationErrors.delete(taskId);
    }
    for (const taskId of [...this.pendingResults.keys()]) {
      if (!this.watchedTaskIds.has(taskId)) this.pendingResults.delete(taskId);
    }
    if (selected.length === 0) return { events: [] };
    const generation = this.sessionGeneration;
    const request = {
      ...this.reconcileInput,
      task_ids: selected,
      ...(this.reconcileInput.task_root || !discoveredTaskRoot ? {} : { task_root: discoveredTaskRoot }),
    };
    try {
      const result = await this.service.reconcile(request);
      if (generation === this.sessionGeneration) {
        for (const id of selected) this.observationErrors.delete(id);
      }
      return result;
    } catch {
      // A restored task may belong to a different service registry. Keep its
      // unknown state visible without preventing other registered tasks from progressing.
      const events = [];
      for (const taskId of selected) {
        if (generation !== this.sessionGeneration) break;
        try {
          const result = await this.service.reconcile({ ...request, task_ids: [taskId] });
          if (generation !== this.sessionGeneration) break;
          this.observationErrors.delete(taskId);
          events.push(...eventsFromReconcile(result));
        } catch (error) {
          if (generation !== this.sessionGeneration) break;
          const message = error instanceof Error ? error.message : String(error);
          if (this.observationErrors.get(taskId) !== message && this.onRecovery) this.recoveryPending = true;
          this.observationErrors.set(taskId, message);
        }
      }
      return { events };
    }
  }

  clearPollTimer() {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  schedulePoll() {
    if (
      !this.started
      || this.watchedTaskIds.size === 0
      || this.pollIntervalMs <= 0
      || this.maxPolls <= 0
      || this.pollCount >= this.maxPolls
      || this.pollTimer !== null
    ) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async pollOnce() {
    if (!this.started || this.polling || this.pollCount >= this.maxPolls || this.watchedTaskIds.size === 0) return;
    const generation = this.sessionGeneration;
    this.polling = true;
    this.pollCount += 1;
    try {
      const reconciled = await this.reconcileCurrentTasks();
      if (!this.started || generation !== this.sessionGeneration) return;
      const events = eventsFromReconcile(reconciled);
      for (const event of events) {
        await this.handleStateEvent(event, { generation });
      }
      await this.deliverRecovery(events, generation);
      if (!this.started || generation !== this.sessionGeneration) return;
      this.lastPollError = null;
    } catch (error) {
      this.lastPollError = error;
    } finally {
      if (generation === this.sessionGeneration) {
        this.polling = false;
        this.schedulePoll();
      }
    }
  }

  async handleStateEvent(rawEvent, { generation = this.sessionGeneration } = {}) {
    if (!this.started || generation !== this.sessionGeneration) {
      return { delivered: false, reason: "stale_session" };
    }
    const sessionId = this.sessionId;
    const sessionIsCurrent = () => (
      this.started
      && generation === this.sessionGeneration
    );
    const event = normalizeTaskState(rawEvent);
    const taskId = String(taskIdOf(event) ?? "").trim();
    const revision = revisionOf(event);
    if (!taskId || !this.watchedTaskIds.has(taskId)) {
      return { delivered: false, reason: "untracked_task" };
    }
    if (event.transport_state === "paused") {
      return this.deliverPauseNotice(taskId, event, { generation, sessionId, sessionIsCurrent });
    }
    if (revision === undefined || !isTerminalTransportState(event.transport_state)) {
      const stall = stallOf(event);
      if (!stall) return { delivered: false, reason: "not_terminal" };
      return this.deliverStallNotice(taskId, stall, { generation, sessionId, sessionIsCurrent });
    }

    const key = `${generation}:${taskId}:${revision}`;
    if (this.delivered.has(key) || this.pending.has(key)) {
      return { delivered: false, reason: "duplicate" };
    }
    this.pending.add(key);
    try {
      let current;
      try {
        current = normalizeTaskState(await this.service.get({ task_id: taskId }));
      } catch {
        return { delivered: false, reason: "state_read_failed" };
      }
      if (!sessionIsCurrent() || !this.watchedTaskIds.has(taskId)) {
        return { delivered: false, reason: "stale_session" };
      }
      if (!sameRevision(current.revision, revision)) return { delivered: false, reason: "stale_revision" };
      if (!isTerminalTransportState(current.transport_state)) {
        return { delivered: false, reason: "non_terminal_current_state" };
      }

      const notice = await readCompletionNotice(this.service, current, sessionId, event.artifact_refs);
      if (!sessionIsCurrent() || !this.watchedTaskIds.has(taskId)) {
        return { delivered: false, reason: "stale_session" };
      }
      if (notice.result_available === false && notice.result_retryable === true) {
        // 状态已知，只是结果读取失败：终态提醒只投递一次（同任务同 revision 同原因），
        // 任务保留跟踪，故障解除后同一 revision 仍能补投带结果的通知。
        const retryKey = `${taskId}:${revision}:${notice.result_error}`;
        const seen = this.pendingResults.get(taskId) ?? new Set();
        if (seen.has(retryKey)) return { delivered: false, reason: "result_unavailable" };
        seen.add(retryKey);
        this.pendingResults.set(taskId, seen);
        await this.onNotice(notice);
        if (!sessionIsCurrent() || !this.watchedTaskIds.has(taskId)) {
          return { delivered: false, reason: "stale_session" };
        }
        return { delivered: true, notice, result_pending: true };
      }
      await this.onNotice(notice);
      if (!sessionIsCurrent() || !this.watchedTaskIds.has(taskId)) {
        return { delivered: false, reason: "stale_session" };
      }
      this.delivered.add(key);
      this.pendingResults.delete(taskId);
      this.watchedTaskIds.delete(taskId);
      return { delivered: true, notice };
    } finally {
      this.pending.delete(key);
    }
  }

  async deliverPauseNotice(taskId, event, { generation, sessionId, sessionIsCurrent }) {
    const revision = revisionOf(event);
    if (revision === undefined) return { delivered: false, reason: "not_terminal" };
    const key = `${generation}:${taskId}:pause:${revision}`;
    if (this.delivered.has(key) || this.pending.has(key)) {
      return { delivered: false, reason: "duplicate" };
    }
    this.pending.add(key);
    try {
      let current;
      try {
        current = normalizeTaskState(await this.service.get({ task_id: taskId }));
      } catch {
        return { delivered: false, reason: "state_read_failed" };
      }
      if (!sessionIsCurrent() || !this.watchedTaskIds.has(taskId)) {
        return { delivered: false, reason: "stale_session" };
      }
      if (current.transport_state !== "paused" || !sameRevision(current.revision, revision)) {
        return { delivered: false, reason: "pause_cleared" };
      }
      const notice = pauseNoticeFrom(current, sessionId);
      await this.onNotice(notice);
      if (!sessionIsCurrent()) return { delivered: false, reason: "stale_session" };
      this.delivered.add(key);
      return { delivered: true, notice };
    } finally {
      this.pending.delete(key);
    }
  }

  async deliverStallNotice(taskId, stall, { generation, sessionId, sessionIsCurrent }) {
    const key = `${generation}:${taskId}:stall:${stall.suspected_at}`;
    if (this.delivered.has(key) || this.pending.has(key)) {
      return { delivered: false, reason: "duplicate" };
    }
    this.pending.add(key);
    try {
      let current;
      try {
        current = normalizeTaskState(await this.service.get({ task_id: taskId }));
      } catch {
        return { delivered: false, reason: "state_read_failed" };
      }
      if (!sessionIsCurrent() || !this.watchedTaskIds.has(taskId)) {
        return { delivered: false, reason: "stale_session" };
      }
      const currentStall = stallOf(current);
      if (!currentStall || currentStall.suspected_at !== stall.suspected_at) {
        return { delivered: false, reason: "stall_cleared" };
      }
      if (isTerminalTransportState(current.transport_state)) {
        return { delivered: false, reason: "already_terminal" };
      }
      const notice = {
        event: STALL_NOTICE_EVENT,
        session_id: sessionId,
        task_id: taskId,
        revision: current.revision,
        transport_state: current.transport_state,
        business_state: current.business_state,
        registry_ref: current.registry_ref,
        stall: currentStall,
      };
      await this.onNotice(notice);
      if (!sessionIsCurrent()) {
        return { delivered: false, reason: "stale_session" };
      }
      this.delivered.add(key);
      return { delivered: true, notice };
    } finally {
      this.pending.delete(key);
    }
  }
}

export function createCompletionWatcher(options = {}) {
  return new CompletionWatcher(options);
}

export const createPiCompletionWatcher = createCompletionWatcher;
