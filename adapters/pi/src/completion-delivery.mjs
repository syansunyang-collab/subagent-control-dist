import { resultTrackingVersion } from "./async-service.mjs";
import { PAUSE_NOTICE_EVENT } from "./completion-watcher.mjs";

function keyOf(notice) {
  return JSON.stringify([notice.task_id, String(notice.revision)]);
}

function isPauseNotice(notice) {
  return notice?.event === PAUSE_NOTICE_EVENT;
}

// 终态指纹：提醒只剩终态摘要时，用它判定两次提醒是否同一个现场。
export function terminalFingerprint(state) {
  return JSON.stringify([state?.transport_state ?? null, state?.business_state ?? null]);
}

function sameIdentity(left, right) {
  return left !== null && right !== null && left === right;
}

// 已读判定按消费身份，不按会随 ack/复核自增的 revision。
// 结果版本取自结果收据；没有正式结果时退回终态指纹；两者都缺的旧记录才按 revision 精确匹配。
function consumedByRead(record, notice) {
  const sameRevision = String(record.revision) === String(notice.revision);
  const noticeVersion = resultTrackingVersion(notice);
  const sameResult = sameIdentity(record.result_version, noticeVersion);
  if (record.result_version !== null && noticeVersion !== null && !sameResult) return false;
  const sameTerminal = sameIdentity(record.terminal, terminalFingerprint(notice));
  if (record.kinds.has("result")) {
    if (sameResult) return true;
    // 提醒不再携带正式结果：与已读的同一终态现场不重复叫醒。
    if (notice.result_available === false) return sameTerminal || (record.result_version === null && sameRevision);
    return record.result_version === null && sameRevision;
  }
  if (record.kinds.has("state")) {
    return notice.result_available === false && (sameTerminal || (record.terminal === null && sameRevision));
  }
  return false;
}

// 待投递任务由既有 session tracking 恢复；这里只保存本次会话的缓冲和读取索引。
export class CompletionDelivery {
  constructor({ isIdle, refresh, send, onRead, onConsumed, onStale, delayMs = 100, retryMs = 1000, batchSize = 20 }) {
    Object.assign(this, { isIdle, refresh, send, onRead, onConsumed, onStale, delayMs, retryMs, batchSize });
    this.generation = 0;
    this.active = false;
    this.pending = new Map();
    this.reads = new Map();
    this.notified = new Map();
    this.timer = null;
    this.inFlight = null;
    this.lastError = null;
  }

  reset(reads = []) {
    this.stop();
    this.active = true;
    this.reads = new Map();
    this.notified = new Map();
    for (const read of reads) this.rememberRead(read, false);
  }

  stop() {
    this.active = false;
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.inFlight = null;
    this.lastError = null;
  }

  rememberRead(read, persist = true) {
    if (!this.active || !read?.task_id || read.revision == null) return;
    const key = keyOf(read);
    const record = this.reads.get(key) ?? {
      task_id: read.task_id,
      revision: read.revision,
      kinds: new Set(),
      result_version: read.result_tracking_version ?? null,
      terminal: read.terminal_fingerprint ?? null,
    };
    if (record.result_version === null) record.result_version = read.result_tracking_version ?? null;
    if (record.terminal === null) record.terminal = read.terminal_fingerprint ?? null;
    this.reads.set(key, record);
    if (record.kinds.has(read.kind)) return;
    if (persist) this.onRead?.(read);
    record.kinds.add(read.kind);
  }

  // 已投递 ≠ 已读：暂停提醒送达后只登记「通知已到过」，不写 read 索引。
  // 公开读取（subagent_get 看到 paused）仍走 rememberRead，恢复后旧标记随 invalidateTask 失效。
  rememberNotified(notice) {
    if (!this.active || !notice?.task_id || notice.revision == null) return;
    this.notified.set(keyOf(notice), notice);
  }

  consumedPause(notice) {
    if (!notice?.task_id || notice.revision == null) return false;
    if (this.notified.has(keyOf(notice))) return true;
    for (const record of this.reads.values()) {
      if (record.task_id !== notice.task_id) continue;
      if (!record.kinds.has("pause")) continue;
      if (String(record.revision) === String(notice.revision)) return true;
    }
    return false;
  }

  consumed(notice) {
    if (isPauseNotice(notice)) return this.consumedPause(notice);
    for (const record of this.reads.values()) {
      if (record.task_id !== notice.task_id) continue;
      if (consumedByRead(record, notice)) return true;
    }
    return false;
  }

  enqueue(notice) {
    if (!this.active) return;
    this.pending.set(keyOf(notice), notice);
    this.schedule();
  }

  acknowledge(notices) {
    for (const notice of notices) {
      this.pending.delete(keyOf(notice));
      if (isPauseNotice(notice)) this.rememberNotified(notice);
    }
  }

  invalidateTask(taskId) {
    for (const [key, notice] of this.pending) {
      if (notice.task_id === taskId) this.pending.delete(key);
    }
    for (const [key, notice] of this.notified) {
      if (notice.task_id === taskId) this.notified.delete(key);
    }
    // 恢复运行是新一次执行：旧终态的读取不代表这次的结果。
    for (const [key, record] of this.reads) {
      if (record.task_id === taskId) this.reads.delete(key);
    }
  }

  schedule(delay = this.delayMs) {
    if (!this.active || this.timer || !this.pending.size || !this.isIdle()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  flush() {
    if (this.inFlight) return this.inFlight;
    if (!this.active || !this.isIdle()) return Promise.resolve();
    clearTimeout(this.timer);
    this.timer = null;
    const generation = this.generation;
    const current = () => this.active && generation === this.generation;
    const work = this.drain(current).catch(error => {
      if (current()) this.lastError = error;
    }).finally(() => {
      if (!current()) return;
      this.inFlight = null;
      this.schedule(this.retryMs);
    });
    this.inFlight = work;
    return work;
  }

  async drain(current) {
    this.lastError = null;
    const candidates = [];
    for (const [key, original] of [...this.pending]) {
      if (!current() || !this.isIdle()) return;
      if (candidates.length >= this.batchSize) break;
      let notice;
      try {
        notice = await this.refresh(original);
      } catch (error) {
        if (current()) this.lastError = error;
        continue;
      }
      if (!current() || !this.isIdle()) return;
      if (this.pending.get(key) !== original) continue;
      if (!notice || keyOf(notice) !== key) {
        // 新 revision 或恢复运行：旧通知退出，新状态仍沿原观察器跟踪。
        await this.onStale?.(original);
        if (!current()) return;
        if (this.pending.get(key) === original) this.pending.delete(key);
      } else {
        candidates.push({ key, original, notice });
      }
    }
    if (!current() || !this.isIdle()) return;
    const batch = [];
    for (const item of candidates) {
      if (this.pending.get(item.key) !== item.original) continue;
      if (this.consumed(item.notice)) {
        // 暂停或可重试状态的已读只撤下提醒，不注销仍需继续观察的 task。
        if (!isPauseNotice(item.notice) && item.notice.result_retryable !== true) this.onConsumed?.(item.notice);
        this.pending.delete(item.key);
      } else batch.push(item);
    }
    if (!batch.length) return;
    await this.send(batch.map(item => item.notice));
    // 发送被接受不等于实际送达。message_end 确认后才 acknowledge；恢复以 custom_message 为据。
  }
}
