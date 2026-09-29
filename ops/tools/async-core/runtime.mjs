import path from "node:path";
import { readTaskOutcome } from "../task-outcome.mjs";
import { ensureDir, readJson } from "../_fs-utils.mjs";
import {
  CONTRACT_VERSION,
  DISPATCH_ENVELOPE_VERSION,
  MAX_WAIT_MS,
  SUPPORTED_DISPATCH_ENVELOPE_VERSIONS,
  TOKEN_BUDGETS,
  WRITE_CLAIM_CONTRACT_VERSION,
  normalizeBusinessWord,
} from "./contracts.mjs";
import {
  cloneValue,
  deepFreeze,
  RETAINED_WORKER_ERROR_CODE,
} from "./runtime/shared.mjs";
import { createUtilities } from "./runtime/utilities.mjs";
import { createRegistry } from "./runtime/registry.mjs";
import { createProcessTree } from "./runtime/process-tree.mjs";
import { createDispatch } from "./runtime/dispatch.mjs";
import { createClaims } from "./runtime/claims.mjs";
import { createStatus } from "./runtime/status.mjs";
import { createSubmit } from "./runtime/submit.mjs";
import { createNotifications } from "./runtime/notifications.mjs";
import { createTaskPackage } from "./runtime/task-package.mjs";
import { createHandoff } from "./runtime/handoff.mjs";
import { createCollection } from "./runtime/collection.mjs";
import { createLifecycle } from "./runtime/lifecycle.mjs";
import { createProjection } from "./runtime/projection.mjs";
import { createListing } from "./runtime/listing.mjs";
import { createCancellation } from "./runtime/cancellation.mjs";
import { createAttemptPolicy } from "./runtime/attempt-policy.mjs";
import { createArtifacts } from "./runtime/artifacts.mjs";
import { createChildAttempt } from "./runtime/child-attempt.mjs";
import { createWorker } from "./runtime/worker.mjs";

function createContext(options = {}) {
  const configKeys = [
    "cwd", "registryRoot", "defaultTaskRoot", "workerEntrypoint", "workerSpawnCwd",
    "trustedRunnerRoot", "defaultRunnerPath", "runnerCatalog", "defaultRunnerKey", "defaultRunnerEntry",
    "trustedRunnerBasenames", "taskIdPrefix", "defaultModel", "defaultEffort",
    "defaultTaskRootLayout", "writeClaimRootSegments", "selfTestEnvironment", "runnerTrustFailureMessage",
    "defaultContextMode", "allowCustomRunner", "promptIdentity",
    "handoffCheckerPolicy", "childEnv",
  ];
  const hostKeys = [
    "pid", "hostname", "nodeExecutable", "caseInsensitivePaths", "spawn", "spawnSync",
    "isProcessAlive", "terminateProcessTree", "setExitCode", "nowMs", "nowIso", "randomHex",
    "sleepSync", "setTimer", "clearTimer",
  ];
  for (const key of configKeys) {
    if (options[key] === undefined) throw new TypeError(`Core config requires ${key}`);
  }
  for (const key of hostKeys) {
    if (options.host?.[key] === undefined) throw new TypeError(`Core host requires ${key}`);
  }
  if (!options.runnerCatalog || typeof options.runnerCatalog !== "object" || Array.isArray(options.runnerCatalog)) {
    throw new TypeError("Core config requires a runner catalog object");
  }
  if (!options.handoffCheckerPolicy || typeof options.handoffCheckerPolicy !== "object") {
    throw new TypeError("Core config requires a handoff checker policy");
  }
  if (!options.promptIdentity || typeof options.promptIdentity !== "object") {
    throw new TypeError("Core config requires a prompt identity policy");
  }
  if (!String(options.handoffCheckerPolicy.command || "").trim()) {
    throw new TypeError("Core handoff checker policy requires a command");
  }
  const config = {
    cwd: path.resolve(String(options.cwd)),
    registryRoot: path.resolve(String(options.registryRoot)),
    defaultTaskRoot: path.resolve(String(options.defaultTaskRoot)),
    workerEntrypoint: path.resolve(String(options.workerEntrypoint)),
    workerSpawnCwd: path.resolve(String(options.workerSpawnCwd)),
    trustedRunnerRoot: path.resolve(String(options.trustedRunnerRoot)),
    defaultRunnerPath: path.resolve(String(options.defaultRunnerPath)),
    runnerCatalog: cloneValue(options.runnerCatalog),
    defaultRunnerKey: String(options.defaultRunnerKey),
    defaultRunnerEntry: cloneValue(options.defaultRunnerEntry),
    trustedRunnerBasenames: [...options.trustedRunnerBasenames].map((value) => String(value)),
    taskIdPrefix: String(options.taskIdPrefix),
    defaultTaskRootLayout: cloneValue(options.defaultTaskRootLayout),
    writeClaimRootSegments: [...options.writeClaimRootSegments].map((value) => String(value)),
    selfTestEnvironment: cloneValue(options.selfTestEnvironment),
    runnerTrustFailureMessage: String(options.runnerTrustFailureMessage),
    defaultModel: String(options.defaultModel),
    defaultEffort: String(options.defaultEffort),
    defaultContextMode: String(options.defaultContextMode),
    allowCustomRunner: Boolean(options.allowCustomRunner),
    promptIdentity: cloneValue(options.promptIdentity),
    handoffCheckerPolicy: cloneValue(options.handoffCheckerPolicy),
    childEnv: cloneValue(options.childEnv),
  };
  const host = cloneValue(options.host);
  return { config: deepFreeze(config), host: deepFreeze(host) };
}

function createRuntime(ctx) {
  const rt = {};
  Object.assign(rt, createUtilities(ctx, rt));
  Object.assign(rt, createRegistry(ctx, rt));
  Object.assign(rt, createProcessTree(ctx, rt));
  Object.assign(rt, createDispatch(ctx, rt));
  Object.assign(rt, createClaims(ctx, rt));
  Object.assign(rt, createStatus(ctx, rt));
  Object.assign(rt, createSubmit(ctx, rt));
  Object.assign(rt, createNotifications(ctx, rt));
  Object.assign(rt, createTaskPackage(ctx, rt));
  Object.assign(rt, createHandoff(ctx, rt));
  Object.assign(rt, createCollection(ctx, rt));
  Object.assign(rt, createLifecycle(ctx, rt));
  Object.assign(rt, createProjection(ctx, rt));
  Object.assign(rt, createListing(ctx, rt));
  Object.assign(rt, createCancellation(ctx, rt));
  Object.assign(rt, createAttemptPolicy(ctx, rt));
  Object.assign(rt, createArtifacts(ctx, rt));
  Object.assign(rt, createChildAttempt(ctx, rt));
  Object.assign(rt, createWorker(ctx, rt));
  const {
    writeJson,
    isoNow,
    isInside,
    truncateUtf8Text,
    assertTokenBudget,
    boundedDisplay,
    estimateTokens,
    boundedResultReceipt,
    buildSubmitReceipt,
    safeTaskId,
    taskDir,
    taskFiles,
    registryFile,
    unregisterTaskLocation,
    loadTask,
    loadLocatedTask,
    resolveChildRunnerPath,
    isTrustedChildRunner,
    loadPreparedDispatch,
    writeClaimRootForProducer,
    normalizeWriteDomainPath,
    writeInitialStatus,
    updateStatus,
    submitTask,
    submitPreparedTask,
    completionInboxDir,
    completionNoticePath,
    statusTask,
    reconcileTask,
    waitTask,
    collectTask,
    pauseTask,
    resumeTask,
    recordResultRead,
    ackReviewTask,
    reviewGate,
    compactTaskStatus,
    diagnosticTaskStatus,
    buildResultReceipt,
    taskStatusSummary,
    cancelTask,
    processAlive,
    worker,
  } = rt;
  return {
    submitPreparedTask,
    waitTask,
    statusTask,
    collectTask,
    cancelTask,
    pauseTask,
    resumeTask,
    recordResultRead,
    ackReviewTask,
    reconcileTask,
    taskStatusSummary,
    worker,
    submitTask,
    normalizeWriteDomainPath,
    writeClaimRootForProducer,
    resolveChildRunnerPath,
    isTrustedChildRunner,
    completionNoticePath,
    taskFiles,
    loadTask,
    loadLocatedTask,
    compactTaskStatus,
    reviewGate,
    diagnosticTaskStatus,
    buildResultReceipt,
    buildSubmitReceipt,
    assertTokenBudget,
    boundedDisplay,
    estimateTokens,
    boundedResultReceipt,
    truncateUtf8Text,
    readJson,
    // Low-level helpers the companion self-test module drives through this runtime.
    completionInboxDir,
    ensureDir,
    isInside,
    isoNow,
    loadPreparedDispatch,
    processAlive,
    registryFile,
    safeTaskId,
    taskDir,
    unregisterTaskLocation,
    updateStatus,
    writeInitialStatus,
    writeJson,
  };
}

export class AsyncTaskService {
  #ctx;
  #runtime;

  constructor(options = {}) {
    const ctx = createContext(options);
    this.#ctx = ctx;
    this.#runtime = createRuntime(ctx);
    Object.defineProperty(this, "config", { enumerable: false, value: ctx.config });
    Object.defineProperty(this, "host", { enumerable: false, value: ctx.host });
  }

  submitPrepared(input) {
    const dispatchFile = input && typeof input === "object" ? input.dispatch_file : "";
    const submitted = this.#runtime.submitPreparedTask(dispatchFile);
    return this.#runtime.buildSubmitReceipt(submitted);
  }
  async wait({ task_id, after_revision = "", timeout_ms = 60000, task_root = "" }) {
    const waitMs = Math.min(Math.max(Number(timeout_ms) || 0, 0), MAX_WAIT_MS);
    const raw = await this.#runtime.waitTask({
      task_id,
      after_rev: after_revision,
      wait_ms: waitMs,
      task_root,
    });
    if (raw.stall_notice_observed || raw.attention_notice_observed) {
      const stalled = this.#runtime.statusTask({
        task_id,
        task_root,
        registry_root: this.#ctx.config.registryRoot,
      });
      return this.#runtime.assertTokenBudget("wait", {
        contract_version: CONTRACT_VERSION,
        task_id,
        event: raw.attention_notice_observed ? "attention" : "stall",
        changed: true,
        after_revision: after_revision || null,
        waited_ms: waitMs,
        task: this.#runtime.compactTaskStatus(stalled),
      }, TOKEN_BUDGETS.wait, { task_root, registry_root: this.#ctx.config.registryRoot });
    }
    if (!raw.completion_notice_observed) {
      return this.#runtime.assertTokenBudget("wait", {
        contract_version: CONTRACT_VERSION,
        task_id,
        event: "timeout",
        changed: false,
        after_revision: after_revision || null,
        waited_ms: waitMs,
      }, TOKEN_BUDGETS.wait, { task_root, registry_root: this.#ctx.config.registryRoot });
    }
    const status = this.#runtime.statusTask({
      task_id,
      task_root,
      registry_root: this.#ctx.config.registryRoot,
    });
    const compact = this.#runtime.compactTaskStatus(status);
    return this.#runtime.assertTokenBudget("wait", {
      contract_version: CONTRACT_VERSION,
      task_id,
      event: "completion",
      changed: !after_revision || compact.revision !== String(after_revision),
      task: compact,
    }, TOKEN_BUDGETS.wait, { task_root, registry_root: this.#ctx.config.registryRoot });
  }
  get(input) {
    const { task_ids, detail = "compact", task_root = "" } = input;
    if (detail === "diagnostic" && task_ids.length > 5) {
      throw new Error("diagnostic get accepts at most 5 task_ids so the total response stays within 1,500 tokens");
    }
    const statuses = task_ids.map((taskId) => {
      const value = { task_id: taskId, registry_root: this.#ctx.config.registryRoot };
      if (task_root) value.task_root = task_root;
      return this.#runtime.statusTask(value);
    });
    if (detail !== "diagnostic") {
      return { contract_version: CONTRACT_VERSION, detail, tasks: statuses.map((status) => this.#runtime.compactTaskStatus(status)) };
    }
    // A diagnostic query must degrade bounded detail instead of failing merely because paths or
    // the last request are long. One task gets the richer projection; multi-task queries use a
    // smaller base while preserving the live/tool/log entry points.
    for (const options of [
      { minimal: statuses.length > 1, includeRequest: true },
      { minimal: true, includeRequest: false },
    ]) {
      const response = {
        contract_version: CONTRACT_VERSION,
        detail,
        tasks: statuses.map((status) => this.#runtime.diagnosticTaskStatus(status, options)),
      };
      if (this.#runtime.estimateTokens(response) <= TOKEN_BUDGETS.getDiagnostic) return response;
    }
    return this.#runtime.boundedDisplay("get diagnostic", {
      contract_version: CONTRACT_VERSION,
      detail,
      tasks: statuses.map((status) => ({
        task_id: status.task_id,
        state: status.state,
        contract_state: status.contract_state ?? null,
        business_state: status.business_state ?? null,
        review_gate: this.#runtime.reviewGate(status),
        revision: String(status.rev ?? 0),
        updated_at: status.updated_at ?? null,
        failure_summary: this.#runtime.truncateUtf8Text(status.error || (status.failure_type === "none" ? null : status.failure_type) || "", 80) || null,
        process_alive: status.process_alive ?? null,
        live_phase: this.#runtime.truncateUtf8Text(status.live_phase || "", 48) || null,
        last_tool_call: status.last_tool_call ? {
          name: this.#runtime.truncateUtf8Text(status.last_tool_call.name || "", 48),
          status: this.#runtime.truncateUtf8Text(status.last_tool_call.status || "", 24),
        } : null,
        diagnostic_omitted: ["request", "paths", "progress", "stall"],
      })),
    }, TOKEN_BUDGETS.getDiagnostic, { task_root, registry_root: this.#ctx.config.registryRoot });
  }
  result(input) {
    // 纯读缓存/收据；已读记录由适配器在回执返回后调用 recordResultRead。
    const { task_id, task_root = "" } = input;
    const value = { task_id, registry_root: this.#ctx.config.registryRoot };
    if (task_root) value.task_root = task_root;
    const { taskRoot, files } = this.#runtime.loadLocatedTask(value, task_id);
    const cached = this.#runtime.readJson(files.result, null);
    if (cached?.contract_version === CONTRACT_VERSION && cached.task_id === task_id) {
      const { origin_thread_id: _legacyOriginThreadId, ...compatible } = cached;
      compatible.task_outcome = readTaskOutcome({
        ...this.#runtime.readJson(files.status, {}), task_dir: path.dirname(files.status),
      });
      return this.#runtime.boundedResultReceipt(compatible, TOKEN_BUDGETS.result);
    }
    return this.#runtime.buildResultReceipt(taskRoot, task_id);
  }
  resume(input) {
    const taskId = input?.task_id;
    const expectedRevision = input?.expected_revision;
    const value = {
      task_id: taskId,
      expected_revision: expectedRevision,
      registry_root: this.#ctx.config.registryRoot,
    };
    if (input?.task_root) value.task_root = input.task_root;
    const outcome = this.#runtime.resumeTask(value);
    return this.#runtime.boundedDisplay("resume", {
      contract_version: CONTRACT_VERSION,
      task_id: taskId,
      accepted: Boolean(outcome.ok),
      state: outcome.state,
      revision: String(outcome.revision ?? 0),
      reason: outcome.reason,
      ...(outcome.next_step ? { next_step: String(outcome.next_step) } : {}),
    }, TOKEN_BUDGETS.cancel, value);
  }
  pause(input) {
    const outcome = this.#runtime.pauseTask(input || {});
    return { contract_version: CONTRACT_VERSION, task_id: outcome.task_id,
      accepted: Boolean(outcome.ok), state: outcome.state, revision: outcome.revision,
      reason: outcome.reason, next_step: outcome.next_step };
  }
  cancel(input) {
    const taskId = input?.task_id;
    const expectedRevision = input?.expected_revision;
    const reason = String(input?.reason ?? "").trim();
    if (!reason) throw new TypeError("cancel requires a non-empty reason");
    const value = {
      task_id: taskId,
      expected_revision: expectedRevision,
      reason,
      registry_root: this.#ctx.config.registryRoot,
    };
    if (input?.task_root) value.task_root = input.task_root;
    const outcome = this.#runtime.cancelTask(value);
    const diagnostics = [];
    let revision = outcome.revision;
    if (revision == null) {
      try { revision = this.#runtime.statusTask(value).rev; }
      catch (error) { diagnostics.push({ step: "status_task", error: String(error?.message ?? error) }); }
    }
    return this.#runtime.boundedDisplay("cancel", {
      contract_version: CONTRACT_VERSION,
      task_id: taskId,
      accepted: Boolean(outcome.ok),
      state: outcome.state,
      revision: String(revision ?? 0),
      ...(diagnostics.length ? { diagnostics } : {}),
      reason: this.#runtime.truncateUtf8Text(outcome.reason ?? (outcome.ok ? "cancellation_accepted" : "not_accepted"), 180),
      ...(outcome.next_step ? { next_step: String(outcome.next_step) } : {}),
    }, TOKEN_BUDGETS.cancel, value);
  }
  recordResultRead(input) {
    const taskId = input?.task_id;
    const value = {
      task_id: taskId,
      result_revision: input?.result_revision,
      registry_root: this.#ctx.config.registryRoot,
    };
    if (input?.task_root) value.task_root = input.task_root;
    return this.#runtime.recordResultRead(value);
  }
  ackReview(input) {
    const taskId = input?.task_id;
    const value = {
      task_id: taskId,
      expected_revision: input?.expected_revision,
      note: input?.note,
      registry_root: this.#ctx.config.registryRoot,
    };
    if (input?.task_root) value.task_root = input.task_root;
    const outcome = this.#runtime.ackReviewTask(value);
    return this.#runtime.assertTokenBudget("ack_review", {
      contract_version: CONTRACT_VERSION,
      task_id: taskId,
      accepted: Boolean(outcome.ok),
      acked: Boolean(outcome.acked),
      state: outcome.state,
      revision: String(outcome.revision ?? 0),
      reason: outcome.reason,
      ...(outcome.next_step ? { next_step: String(outcome.next_step) } : {}),
    }, TOKEN_BUDGETS.cancel);
  }
  reconcile({ task_ids, task_root = "" }) {
    return {
      contract_version: CONTRACT_VERSION,
      tasks: task_ids.map((taskId) => this.#runtime.reconcileTask({
        task_id: taskId, task_root: task_root || undefined, registry_root: this.#ctx.config.registryRoot,
      })).map((status) => this.#runtime.compactTaskStatus(status)),
    };
  }
  snapshot({ task_root = "", limit = 200 } = {}) {
    return this.#runtime.taskStatusSummary({
      task_root: task_root || undefined, registry_root: this.#ctx.config.registryRoot, limit,
    });
  }
  async runWorker(input = {}) { return this.#runtime.worker(input); }
  contractInfo() {
    return {
      contract_version: CONTRACT_VERSION,
      dispatch_contract_version: DISPATCH_ENVELOPE_VERSION,
      supported_dispatch_contract_versions: [...SUPPORTED_DISPATCH_ENVELOPE_VERSIONS],
      write_claim_contract_version: WRITE_CLAIM_CONTRACT_VERSION,
    };
  }
}

export function createAsyncTaskCore(options) {
  return new AsyncTaskService(options);
}

// The self-test fixtures live in ./selftest.mjs and are only loaded when a self-test runs.
export async function runAsyncTaskCoreSelfTest(options) {
  const { runAsyncTaskCoreSelfTest: runSelfTest } = await import("./selftest.mjs");
  return runSelfTest(options);
}

export {
  CONTRACT_VERSION,
  DISPATCH_ENVELOPE_VERSION,
  SUPPORTED_DISPATCH_ENVELOPE_VERSIONS,
  WRITE_CLAIM_CONTRACT_VERSION,
  normalizeBusinessWord,
  MAX_WAIT_MS,
  RETAINED_WORKER_ERROR_CODE,
  cloneValue,
  createContext,
  createRuntime,
};
