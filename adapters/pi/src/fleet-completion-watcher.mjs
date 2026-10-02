export const FLEET_COMPLETION_NOTICE_EVENT = "fleet_completion_notice";
export const FLEET_WATCH_FAILURE_EVENT = "fleet_watch_failed";

const SETTLED_DRIVER_STATES = new Set(["completed", "blocked", "needs_parent_review", "failed", "cancelled"]);
const watchers = new WeakMap();

// The tool and watcher share the injected core; reads invalidate only the version actually seen.
export function observeFleetToolResult(fleet, action, result) {
  if (!result?.ok || !result.run_id) return;
  watchers.get(fleet)?.observe(result.run_id, action, result);
}

export function fleetNoticeKey(notice) {
  return JSON.stringify([notice.run_id, String(notice.revision ?? "unknown"), notice.driver_status ?? null]);
}

function normalizedRunIds(values) {
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const runId = String(value ?? "").trim();
    if (runId) output.push(runId);
  }
  return [...new Set(output)];
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class FleetCompletionWatcher {
  constructor({
    fleet,
    onNotice,
    onRead = null,
    requireAcknowledgement = false,
    onPending = null,
    onAcknowledged = null,
    persistedNotices = () => [],
    isIdle = () => true,
    waitMs = 60_000,
    noticeRetryBaseMs = 250,
    noticeRetryMaxMs = 5_000,
    sleep = delay,
  } = {}) {
    if (!fleet || typeof fleet.fleet_wait !== "function") {
      throw new TypeError("FleetCompletionWatcher requires fleet_wait()");
    }
    if (typeof onNotice !== "function") {
      throw new TypeError("FleetCompletionWatcher requires onNotice");
    }
    this.fleet = fleet;
    this.onNotice = onNotice;
    this.onRead = onRead;
    Object.assign(this, { requireAcknowledgement, onPending, onAcknowledged, persistedNotices });
    this.pending = new Map();
    this.ackWaiters = new Map();
    this.isIdle = isIdle;
    watchers.set(fleet, this);
    this.waitMs = Math.max(Number(waitMs) || 0, 1_000);
    this.noticeRetryBaseMs = Math.max(Number(noticeRetryBaseMs) || 0, 0);
    this.noticeRetryMaxMs = Math.max(Number(noticeRetryMaxMs) || 0, this.noticeRetryBaseMs);
    this.sleep = sleep;
    this.started = false;
    this.watchedRunIds = new Set();
    this.running = new Map();
    this.runGenerations = new Map();
    this.delivered = new Set();
    this.observed = new Map();
    this.lastDeliveryError = new Map();
    this.lastWatchError = new Map();
    this.sessionGeneration = 0;
  }

  async resetSession({ runIds = [], reads = [], notified = [] } = {}) {
    this.stop();
    this.watchedRunIds = new Set(normalizedRunIds(runIds));
    this.running.clear();
    this.runGenerations.clear();
    this.delivered = new Set(notified.map(fleetNoticeKey));
    this.observed.clear();
    for (const read of reads) {
      if (read.run_id && read.revision != null) this.observed.set(read.run_id, { revision: String(read.revision), driver_status: read.driver_status });
    }
    this.lastDeliveryError.clear();
    this.lastWatchError.clear();
    return this;
  }

  start() {
    if (this.started) return this;
    this.started = true;
    for (const runId of this.watchedRunIds) this.launch(runId);
    return this;
  }

  stop() {
    this.started = false;
    this.sessionGeneration += 1;
    this.watchedRunIds.clear();
    this.pending.clear();
    for (const wake of this.ackWaiters.values()) wake();
    this.ackWaiters.clear();
  }

  trackRunIds(runIds) {
    const ids = normalizedRunIds(runIds);
    const added = ids.filter((runId) => !this.watchedRunIds.has(runId));
    for (const runId of ids) {
      for (const [key, notice] of this.pending) {
        if (notice.run_id !== runId) continue;
        this.pending.delete(key);
        this.ackWaiters.get(key)?.();
      }
      this.watchedRunIds.add(runId);
      this.runGenerations.set(runId, (this.runGenerations.get(runId) ?? 0) + 1);
      if (this.started) this.launch(runId);
    }
    return { added, watched: [...this.watchedRunIds] };
  }

  observe(runId, action, result) {
    if (action === "fleet_status" || action === "fleet_wait") {
      if (result.summary?.revision != null) {
        const read = { revision: String(result.summary.revision), driver_status: result.driver_status };
        const previous = this.observed.get(runId);
        this.observed.set(runId, read);
        if (previous?.revision !== read.revision || previous?.driver_status !== read.driver_status) {
          this.onRead?.({ run_id: runId, ...read });
        }
      }
      return;
    }
    if (action === "fleet_review" || action === "fleet_cancel") {
      // A decision supersedes any pending review notice. The next result must still be seen.
      this.trackRunIds([runId]);
    }
  }

  acknowledge(notice) {
    const key = fleetNoticeKey(notice);
    const pending = this.pending.get(key);
    if (!pending || !this.active(pending.run_id, pending.watch_generation)) return false;
    this.onAcknowledged?.(pending);
    this.pending.delete(key);
    this.delivered.add(key);
    this.ackWaiters.get(key)?.();
    this.lastDeliveryError.delete(pending.run_id);
    return true;
  }

  launch(runId) {
    if (!this.started || this.running.has(runId)) return;
    const generation = this.watchGeneration(runId);
    const promise = this.watch(runId, generation)
      .catch((error) => {
        this.lastWatchError.set(runId, error);
      })
      .finally(() => {
        if (this.running.get(runId) !== promise) return;
        this.running.delete(runId);
        if (this.started && this.watchedRunIds.has(runId) && generation !== this.watchGeneration(runId)) this.launch(runId);
      });
    this.running.set(runId, promise);
  }

  watchGeneration(runId) {
    return `${this.sessionGeneration}:${this.runGenerations.get(runId) ?? 0}`;
  }

  active(runId, generation) {
    return this.started
      && generation === this.watchGeneration(runId)
      && this.watchedRunIds.has(runId);
  }

  async deliver(runId, key, notice, generation) {
    let attempt = 0;
    while (this.active(runId, generation)) {
      if (this.delivered.has(key)) return true;
      if (!this.isIdle()) {
        await this.sleep(Math.max(this.noticeRetryBaseMs, 50));
        continue;
      }
      // Retry paths must not send an obsolete review after the driver has advanced.
      if (notice.event === FLEET_COMPLETION_NOTICE_EVENT && typeof this.fleet.fleet_status === "function") {
        let latest;
        try { latest = await this.fleet.fleet_status({ run_id: runId }); }
        catch (error) { latest = { ok: false, error: { message: String(error) } }; }
        if (!this.active(runId, generation)) return false;
        if (!latest?.ok) {
          this.lastDeliveryError.set(runId, latest?.error ?? new Error("fleet status unavailable"));
          attempt += 1;
          if (attempt < 3) {
            await this.sleep(this.noticeRetryMaxMs);
            continue;
          }
          notice = {
            event: FLEET_WATCH_FAILURE_EVENT, run_id: runId, driver_status: null,
            error: latest?.error ?? { kind: "status_unavailable", message: "fleet status unavailable" },
          };
          this.pending.delete(key);
          key = fleetNoticeKey(notice);
        }
        if (latest?.ok && latest.summary?.revision != null && latest.driver_status != null) {
          if (String(latest.summary.revision) !== String(notice.revision)
            || latest.driver_status !== notice.driver_status) {
            this.pending.delete(key);
            return false;
          }
          const read = this.observed.get(runId);
          if (read?.revision === String(notice.revision) && read.driver_status === notice.driver_status) {
            this.pending.delete(key);
            this.delivered.add(key);
            return true;
          }
        }
      }
      try {
        if (this.requireAcknowledgement) {
          if (!this.pending.has(key)) {
            notice = { ...notice, watch_generation: generation };
            this.onPending?.(notice);
            this.pending.set(key, notice);
          }
          for (const persisted of this.persistedNotices()) this.acknowledge(persisted);
          if (this.delivered.has(key)) return true;
        }
        await this.onNotice(notice);
        if (!this.active(runId, generation)) return false;
        if (!this.requireAcknowledgement) this.delivered.add(key);
        if (this.delivered.has(key)) {
          this.lastDeliveryError.delete(runId);
          return true;
        }
        // The void host API only accepts the send. Retry unacknowledged delivery after backoff.
        await Promise.race([
          this.sleep(Math.max(this.noticeRetryMaxMs, 50)),
          new Promise(resolve => this.ackWaiters.set(key, resolve)),
        ]);
        this.ackWaiters.delete(key);
      } catch (error) {
        attempt += 1;
        this.lastDeliveryError.set(runId, error);
        const backoff = Math.min(
          this.noticeRetryBaseMs * (2 ** Math.min(attempt - 1, 10)),
          this.noticeRetryMaxMs,
        );
        await this.sleep(backoff);
      }
    }
    return false;
  }

  async watch(runId, generation = this.watchGeneration(runId)) {
    while (this.active(runId, generation)) {
      let result;
      try {
        result = await this.fleet.fleet_wait({ run_id: runId, wait_ms: this.waitMs });
      } catch (error) {
        result = {
          ok: false,
          error: { kind: "watch_exception", message: error instanceof Error ? error.message : String(error) },
        };
      }
      if (!this.active(runId, generation)) return;
      if (!result?.ok) {
        const key = fleetNoticeKey({ run_id: runId, driver_status: null });
        if (!this.delivered.has(key)) {
          const delivered = await this.deliver(runId, key, {
            event: FLEET_WATCH_FAILURE_EVENT,
            run_id: runId,
            driver_status: null,
            error: result?.error ?? { kind: "unknown", message: "fleet watcher failed" },
          }, generation);
          if (!delivered) return;
        }
        if (this.active(runId, generation)) this.watchedRunIds.delete(runId);
        return;
      }
      const driverStatus = String(result.driver_status ?? "");
      if (!result.settled && !SETTLED_DRIVER_STATES.has(driverStatus)) continue;
      const key = fleetNoticeKey({ run_id: runId, revision: result.summary?.revision, driver_status: driverStatus || null });
      if (!this.delivered.has(key)) {
        const delivered = await this.deliver(runId, key, {
          event: FLEET_COMPLETION_NOTICE_EVENT,
          run_id: runId,
          watch_generation: generation,
          driver_status: driverStatus || null,
          revision: result.summary?.revision ?? null,
          driver_error: result.driver_error ?? null,
          counts: result.counts ?? null,
          summary: result.summary ?? null,
          state_path: result.state_path ?? null,
        }, generation);
        if (!delivered) {
          // A newer revision displaced this notice; keep following the run.
          if (this.active(runId, generation)) continue;
          return;
        }
      }
      if (driverStatus !== "needs_parent_review" && this.active(runId, generation)) this.watchedRunIds.delete(runId);
      return;
    }
  }
}

export function createFleetCompletionWatcher(options = {}) {
  return new FleetCompletionWatcher(options);
}
