import {
  CONTRACT_VERSION,
  createAsyncTaskCore,
} from "../../../ops/tools/async-core/index.mjs";
import { normalizePauseReceipt, pauseRejection } from "../../../ops/tools/pause-surface.mjs";

export const PI_ASYNC_SERVICE_VERSION = "pi-async-service/v1";
export const REQUIRED_STATE_FIELDS = Object.freeze([
  "task_id",
  "revision",
  "transport_state",
  "business_state",
  "registry_ref",
  "artifact_refs",
]);

const TERMINAL_TRANSPORT_STATES = new Set(["done", "failed", "cancelled"]);

function firstDefined(value, keys) {
  for (const key of keys) {
    if (value && value[key] !== undefined) return value[key];
  }
  return undefined;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function expectedRevisionFrom(input) {
  return firstDefined(input, ["expected_revision"]);
}

function taskIdFrom(input) {
  if (!isRecord(input)) throw new TypeError("Async task request must be an object");
  const taskId = firstDefined(input, ["task_id"]);
  if (taskId === undefined || taskId === null || String(taskId).trim() === "") {
    throw new TypeError("Async task request requires task_id");
  }
  return taskId;
}

function taskRootFrom(input) {
  const taskRoot = firstDefined(input, ["task_root"]);
  return taskRoot === undefined || taskRoot === null || String(taskRoot).trim() === ""
    ? undefined
    : taskRoot;
}

export function attestationPassed(value) {
  const attestation = firstDefined(value, [
    "artifact_attestation",
    "attestation",
  ]);
  return Boolean(attestation) && typeof attestation === "object" && attestation.verified === true;
}

function artifactRefsFrom(value) {
  const explicit = firstDefined(value, ["artifact_refs"]);
  if (explicit !== undefined) return Array.isArray(explicit) ? explicit : [];
  const artifacts = isRecord(value?.artifacts) ? value.artifacts : null;
  if (!artifacts) return [];
  return ["report_path", "handoff_path", "salvage_report_path", "attestation_path", "full_result_path"]
    .map((key) => artifacts[key])
    .filter((item) => typeof item === "string" && item.trim() !== "")
    .map((path) => ({ path }));
}

function hasArtifactData(value) {
  return firstDefined(value, ["artifact_refs"]) !== undefined
    || isRecord(value?.artifacts);
}

// 结果发布时的追踪版本：Core 的结果收据固定携带，ack/复核只自增 revision，不改它。
export function resultTrackingVersion(value) {
  const version = firstDefined(value, ["result_tracking_version"]);
  if (version === undefined || version === null || String(version).trim() === "") return null;
  return String(version);
}

export function normalizeTaskState(value, fallback = {}) {
  const source = isRecord(value) ? value : {};
  const output = { ...source };
  const taskId = firstDefined(source, ["task_id"])
    ?? firstDefined(fallback, ["task_id"])
    ?? null;
  const revision = firstDefined(source, ["revision"])
    ?? firstDefined(fallback, ["revision"])
    ?? null;
  const transportState = firstDefined(source, ["transport_state", "state"])
    ?? firstDefined(fallback, ["transport_state", "state"])
    ?? null;
  const businessState = firstDefined(source, ["business_state"])
    ?? firstDefined(fallback, ["business_state"])
    ?? null;
  const registryRef = firstDefined(source, ["registry_ref"])
    ?? firstDefined(fallback, ["registry_ref"])
    ?? null;
  const artifactRefs = artifactRefsFrom(source);
  const fallbackArtifactRefs = artifactRefsFrom(fallback);

  output.task_id = taskId;
  output.revision = revision;
  output.transport_state = transportState;
  output.business_state = businessState;
  output.registry_ref = registryRef;
  output.artifact_refs = hasArtifactData(source) ? artifactRefs : fallbackArtifactRefs;
  return output;
}

function normalizeReadResult(value, fallback = {}) {
  if (!isRecord(value)) return normalizeTaskState({}, fallback);
  if (Array.isArray(value.tasks)) {
    return normalizeTaskState(value.tasks[0] ?? {}, fallback);
  }
  if (isRecord(value.task)) return normalizeTaskState(value.task, fallback);
  return normalizeTaskState(value, fallback);
}

export class ArtifactAttestationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ArtifactAttestationError";
    this.code = "artifact_attestation_failed";
    this.details = details;
  }
}

function method(core, name) {
  if (!core || typeof core[name] !== "function") {
    throw new TypeError(`AsyncTaskService is missing ${name}()`);
  }
  return core[name].bind(core);
}

function subscribeTo(source, handler) {
  if (!source) return null;
  if (typeof source.subscribe === "function") return source.subscribe(handler);
  return null;
}

export class PiAsyncService {
  constructor({
    core,
    coreFactory = createAsyncTaskCore,
    coreOptions = {},
    executor = null,
    router = null,
    stateEventSource = null,
    registryRef = null,
  } = {}) {
    const factoryOptions = { ...coreOptions };
    if (executor !== null && factoryOptions.executor === undefined) factoryOptions.executor = executor;
    if (router !== null && factoryOptions.router === undefined) factoryOptions.router = router;
    if (!core) core = coreFactory(factoryOptions);
    if (!core) throw new TypeError("PiAsyncService requires an AsyncTaskService Core");

    this.core = core;
    this.stateEventSource = stateEventSource;
    this.registryRef = registryRef;
  }

  async submitPrepared(prepared) {
    const envelope = isRecord(prepared?.prepared) ? prepared.prepared : prepared;
    if (!isRecord(envelope)) throw new TypeError("submit requires a prepared envelope object");
    const dispatchFile = firstDefined(envelope, ["dispatch_file"]);
    if (dispatchFile === undefined || dispatchFile === null || String(dispatchFile).trim() === "") {
      throw new TypeError("submit requires prepared.dispatch_file");
    }
    const result = await method(this.core, "submitPrepared")({ dispatch_file: dispatchFile });
    return normalizeTaskState(result, { registry_ref: this.registryRef });
  }

  async wait(input) {
    const taskId = taskIdFrom(input);
    const afterRevision = firstDefined(input, ["after_revision"]);
    const request = { task_id: taskId };
    if (afterRevision !== undefined && afterRevision !== null && String(afterRevision) !== "") {
      request.after_revision = String(afterRevision);
    }
    if (hasOwn(input, "timeout_ms")) request.timeout_ms = input.timeout_ms;
    const taskRoot = taskRootFrom(input);
    if (taskRoot !== undefined) request.task_root = taskRoot;
    const result = await method(this.core, "wait")(request);
    return normalizeReadResult(result, { registry_ref: this.registryRef });
  }

  async get(input) {
    const taskId = taskIdFrom(input);
    const request = {
      task_ids: [taskId],
      detail: firstDefined(input, ["detail"]) ?? "compact",
    };
    const taskRoot = taskRootFrom(input);
    if (taskRoot !== undefined) request.task_root = taskRoot;
    const result = await method(this.core, "get")(request);
    return normalizeReadResult(result, { task_id: taskId, registry_ref: this.registryRef });
  }

  async peekResult(input) {
    return this.result(input, { markRead: false });
  }

  async result(input, { markRead = true } = {}) {
    const taskId = taskIdFrom(input);
    const request = { task_id: taskId };
    const taskRoot = taskRootFrom(input);
    if (taskRoot !== undefined) request.task_root = taskRoot;
    const result = await method(this.core, "result")(request);
    const receipt = normalizeReadResult(result, { registry_ref: this.registryRef });
    // 回执成功返回即记已读，包括失败或未证明结果；get/wait/snapshot 不记读。
    const resultRevision = receipt.result_tracking_version ?? receipt.revision;
    if (
      markRead
      && receipt.task_id
      && resultRevision !== undefined
      && resultRevision !== null
      && String(resultRevision).trim() !== ""
      && typeof this.core.recordResultRead === "function"
    ) {
      try {
        this.core.recordResultRead({
          task_id: receipt.task_id,
          result_revision: String(resultRevision),
          ...(taskRoot !== undefined ? { task_root: taskRoot } : {}),
        });
      } catch {
        // 已读 sidecar 失败不撤回已返回的回执
      }
    }
    return receipt;
  }

  async cancel(input) {
    const taskId = taskIdFrom(input);
    const expectedRevision = expectedRevisionFrom(input);
    if (expectedRevision === undefined || expectedRevision === null) {
      throw new TypeError("cancel requires expected_revision");
    }
    const reason = hasOwn(input, "reason") ? String(input.reason ?? "").trim() : "";
    if (!reason) throw new TypeError("cancel requires a non-empty reason");
    const request = {
      task_id: taskId,
      expected_revision: String(expectedRevision),
      reason,
    };
    const taskRoot = taskRootFrom(input);
    if (taskRoot !== undefined) request.task_root = taskRoot;
    const result = await method(this.core, "cancel")(request);
    return normalizeTaskState(result, { registry_ref: this.registryRef });
  }

  async pause(input) {
    if (!isRecord(input)) return pauseRejection({}, "pause_failed");
    const taskId = firstDefined(input, ["task_id"]);
    if (taskId === undefined || taskId === null || String(taskId).trim() === "") {
      return pauseRejection(input, "pause_failed");
    }
    const expectedRevision = expectedRevisionFrom(input);
    if (expectedRevision === undefined || expectedRevision === null || String(expectedRevision).trim() === "") {
      return pauseRejection(input, "expected_revision_required");
    }
    const reason = hasOwn(input, "reason") ? String(input.reason ?? "").trim() : "";
    if (!reason) return pauseRejection(input, "reason_required");
    if (typeof this.core?.pause !== "function") return pauseRejection(input, "pause_unavailable");
    const request = {
      task_id: taskId,
      expected_revision: String(expectedRevision),
      reason,
    };
    const taskRoot = taskRootFrom(input);
    if (taskRoot !== undefined) request.task_root = taskRoot;
    try {
      const receipt = normalizePauseReceipt(input, await this.core.pause(request));
      if (receipt.accepted === false) return receipt;
      return normalizeTaskState(receipt, { registry_ref: this.registryRef });
    } catch (error) {
      const failed = pauseRejection(input, "pause_failed");
      const detail = error instanceof Error ? error.message : String(error);
      failed.next_step = `${failed.next_step} 具体原因：${detail}`;
      return failed;
    }
  }

  async resume(input) {
    const taskId = taskIdFrom(input);
    const revision = expectedRevisionFrom(input);
    if (revision === undefined || revision === null || String(revision).length === 0) {
      throw new TypeError("resume requires expected_revision");
    }
    const request = { task_id: taskId, expected_revision: String(revision) };
    const taskRoot = taskRootFrom(input);
    if (taskRoot !== undefined) request.task_root = taskRoot;
    return normalizeTaskState(await method(this.core, "resume")(request), { registry_ref: this.registryRef });
  }

  async reconcile(input = {}) {
    if (!isRecord(input)) throw new TypeError("reconcile request must be an object");
    const request = {
      task_ids: Array.isArray(input.task_ids)
        ? input.task_ids
        : input.task_id !== undefined
          ? [input.task_id]
          : [],
    };
    const taskRoot = taskRootFrom(input);
    if (taskRoot !== undefined) request.task_root = taskRoot;
    return method(this.core, "reconcile")(request);
  }

  snapshot(input = {}) {
    return method(this.core, "snapshot")(input);
  }

  contractInfo() {
    const info = method(this.core, "contractInfo")();
    return {
      ...info,
      service_version: PI_ASYNC_SERVICE_VERSION,
      core_contract: info?.contract_version ?? CONTRACT_VERSION,
    };
  }

  runWorker(...args) {
    return method(this.core, "runWorker")(...args);
  }

  subscribeStateEvents(handler) {
    if (typeof handler !== "function") throw new TypeError("state event handler must be a function");
    const source = this.stateEventSource ?? this.core;
    return subscribeTo(source, handler);
  }
}

export function createPiAsyncService(options = {}) {
  return new PiAsyncService(options);
}

export const createAsyncService = createPiAsyncService;

export function isTerminalTransportState(value) {
  return TERMINAL_TRANSPORT_STATES.has(String(value ?? ""));
}
