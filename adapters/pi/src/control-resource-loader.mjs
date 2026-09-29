const DEFAULT_CONTEXT_BYTES = 128 * 1024;
const MAX_REFERENCE_BYTES = 512;
const MAX_ID_BYTES = 200;

export const CONTEXT_RESOURCE_KINDS = Object.freeze({
  taskSummary: "task_summary/v1",
  treeSummary: "tree_summary/v1",
  phaseCheckpoint: "phase_checkpoint/v1",
});

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function stableJson(value) {
  return JSON.stringify(value);
}

function assertNonEmptyId(value, label) {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > MAX_ID_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a stable non-empty identity`);
  }
  return value;
}

function isSensitive(value) {
  return /(?:token|secret|password|credential|api[_-]?key|cookie|authorization|private[_-]?key)/iu.test(value);
}

function isAbsoluteOrUserPath(value) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])/u.test(value);
}

export function isDurableReference(value) {
  return typeof value === "string"
    && value.length > 0
    && utf8ByteLength(value) <= MAX_REFERENCE_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !isSensitive(value)
    && !isAbsoluteOrUserPath(value);
}

function unique(values) {
  return [...new Set(values)];
}

export function normalizeReferenceList(value) {
  const input = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return unique(input.filter(isDurableReference));
}

export function assertDurableReferenceList(value, label = "evidence_refs") {
  const input = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  for (const reference of input) {
    if (!isDurableReference(reference)) throw new Error(`${label} contains a non-durable reference`);
  }
  return input;
}

function normalizeIdList(...values) {
  const output = [];
  for (const value of values) {
    const entries = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    for (const entry of entries) {
      if (typeof entry === "string" && entry.length > 0 && !/[\u0000-\u001f\u007f]/u.test(entry)) output.push(entry);
    }
  }
  return unique(output);
}

function safeState(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must use an existing registry state`);
  }
  return value;
}

function unwrap(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return value[key] ?? value;
}

function safeValue(value, depth = 0) {
  if (depth > 3 || value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (isSensitive(value) || isAbsoluteOrUserPath(value)) return undefined;
    return value.length > 2048 ? value.slice(0, 2048) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => safeValue(entry, depth + 1)).filter((entry) => entry !== undefined);
  if (typeof value !== "object") return undefined;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitive(key) || /^(?:output|raw|transcript|stdout|stderr|content)$/iu.test(key)) continue;
    const normalized = safeValue(entry, depth + 1);
    if (normalized !== undefined) output[key] = normalized;
  }
  return output;
}

export function normalizeTaskSummary(raw, { taskId } = {}) {
  const source = unwrap(raw, "task_summary");
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("task summary is missing");
  const resolvedTaskId = assertNonEmptyId(source.task_id ?? taskId, "task_id");
  if (taskId !== undefined && resolvedTaskId !== taskId) throw new Error("task summary identity does not match taskId");
  const state = safeState(source.state, "task state");
  const dependencyIds = normalizeIdList(source.dependency_ids);
  const rawEvidenceRefs = source.evidence_refs;
  assertDurableReferenceList(rawEvidenceRefs, "task evidence_refs");
  const evidenceRefs = normalizeReferenceList(rawEvidenceRefs);
  return {
    kind: CONTEXT_RESOURCE_KINDS.taskSummary,
    task_id: resolvedTaskId,
    state,
    dependency_ids: dependencyIds,
    evidence_refs: evidenceRefs,
  };
}

function normalizeTreeNode(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("tree node is invalid");
  const taskId = assertNonEmptyId(raw.task_id, "tree node task_id");
  const rawEvidenceRefs = raw.evidence_refs;
  assertDurableReferenceList(rawEvidenceRefs, "tree node evidence_refs");
  return {
    task_id: taskId,
    state: safeState(raw.state, "tree node state"),
    dependency_ids: normalizeIdList(raw.dependency_ids),
    evidence_refs: normalizeReferenceList(rawEvidenceRefs),
  };
}

export function normalizeTreeSummary(raw, { treeId, taskId } = {}) {
  const source = unwrap(raw, "tree_summary");
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("tree summary is missing");
  const resolvedTreeId = assertNonEmptyId(source.tree_id ?? treeId, "tree_id");
  if (treeId !== undefined && resolvedTreeId !== treeId) throw new Error("tree summary identity does not match treeId");
  const nodes = Array.isArray(source.nodes) ? source.nodes.map(normalizeTreeNode) : [];
  const rootTaskId = assertNonEmptyId(source.root_task_id ?? taskId, "root_task_id");
  if (!nodes.some((node) => node.task_id === rootTaskId)) {
    throw new Error("tree summary must contain its root task");
  }
  return {
    kind: CONTEXT_RESOURCE_KINDS.treeSummary,
    tree_id: resolvedTreeId,
    root_task_id: rootTaskId,
    nodes,
  };
}

function normalizeRecoveryState(value) {
  const normalized = safeValue(value);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return {};
  return normalized;
}

export function normalizePhaseCheckpoint(raw, { phaseId, taskSummary, treeSummary } = {}) {
  if (raw === undefined || raw === null) return null;
  const source = unwrap(raw, "phase_checkpoint");
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("phase checkpoint is invalid");
  const resolvedPhaseId = assertNonEmptyId(source.phase_id ?? phaseId, "phase_id");
  if (phaseId !== undefined && resolvedPhaseId !== phaseId) throw new Error("phase checkpoint phase does not match phaseId");
  const checkpointId = assertNonEmptyId(source.checkpoint_id, "checkpoint_id");
  const sourceSessionId = assertNonEmptyId(source.source_session_id, "source_session_id");
  const nextSessionId = assertNonEmptyId(source.next_session_id, "next_session_id");
  const task = source.task_summary
    ? normalizeTaskSummary(source.task_summary, { taskId: taskSummary?.task_id })
    : taskSummary;
  const tree = source.tree_summary
    ? normalizeTreeSummary(source.tree_summary, { treeId: treeSummary?.tree_id, taskId: task?.task_id })
    : treeSummary;
  if (!task || !tree) throw new Error("phase checkpoint must include task and tree summaries");
  const rawEvidenceRefs = source.evidence_refs;
  assertDurableReferenceList(rawEvidenceRefs, "checkpoint evidence_refs");
  const persistedRef = source.persisted_ref;
  if (persistedRef !== undefined && !isDurableReference(persistedRef)) {
    throw new Error("phase checkpoint persisted_ref is outside the durable reference boundary");
  }
  return {
    kind: CONTEXT_RESOURCE_KINDS.phaseCheckpoint,
    checkpoint_id: checkpointId,
    phase_id: resolvedPhaseId,
    source_session_id: sourceSessionId,
    next_session_id: nextSessionId,
    task_summary: task,
    tree_summary: tree,
    recovery_state: normalizeRecoveryState(source.recovery_state),
    evidence_refs: normalizeReferenceList(rawEvidenceRefs),
    ...(persistedRef !== undefined ? { persisted_ref: persistedRef } : {}),
  };
}

async function invokeProvider(provider, methodNames, payload) {
  if (typeof provider === "function") return provider(payload);
  if (!provider || typeof provider !== "object") return undefined;
  for (const methodName of methodNames) {
    if (typeof provider[methodName] === "function") return provider[methodName](payload);
  }
  return undefined;
}

function collectOmitted(...values) {
  return normalizeReferenceList(values.flatMap((value) => Array.isArray(value) ? value : value === undefined ? [] : [value]));
}

function cloneContext(context) {
  return JSON.parse(JSON.stringify(context));
}

function contextBytes(context) {
  return utf8ByteLength(stableJson(context));
}

function trimContextToBudget(context, maxBytes) {
  const working = cloneContext(context);
  const omitted = new Set(working.omitted_refs ?? []);
  const fits = () => {
    working.omitted_refs = [...omitted];
    const measured = contextBytes({ ...working, byte_count: 0 });
    return contextBytes({ ...working, byte_count: measured }) <= maxBytes;
  };
  const refBuckets = [
    working.phase_checkpoint?.evidence_refs,
    ...((working.tree_summary?.nodes ?? []).map((node) => node.evidence_refs)),
    working.task_summary?.evidence_refs,
  ];
  const refs = [];
  for (const bucket of refBuckets) for (const ref of bucket ?? []) refs.push(ref);
  for (let index = refs.length - 1; !fits() && index >= 0; index -= 1) {
    const target = refs[index];
    for (const bucket of [working.phase_checkpoint?.evidence_refs, working.task_summary?.evidence_refs, ...((working.tree_summary?.nodes ?? []).map((node) => node.evidence_refs))]) {
      const position = bucket?.indexOf(target);
      if (position >= 0) bucket.splice(position, 1);
    }
    omitted.add(target);
  }
  if (!fits()) {
    const nodes = working.tree_summary?.nodes ?? [];
    for (let index = nodes.length - 1; !fits() && index >= 0; index -= 1) {
      if (nodes[index].task_id === working.tree_summary.root_task_id) continue;
      omitted.add(`tree_node:${nodes[index].task_id}`);
      nodes.splice(index, 1);
    }
  }
  if (!fits()) {
    throw new Error(`context resources exceed ${maxBytes} UTF-8 bytes after safe pruning`);
  }
  working.omitted_refs = [...omitted];
  working.byte_count = contextBytes({ ...working, byte_count: 0 });
  return working;
}

function baseMethod(base, name, fallback) {
  if (base && typeof base[name] === "function") return (...args) => base[name](...args);
  return fallback;
}

export function createControlResourceLoader(options = {}) {
  const base = options.baseResourceLoader ?? {};
  const taskProvider = options.taskProvider;
  const treeProvider = options.treeProvider;
  const checkpointProvider = options.checkpointProvider;
  const maxBytes = options.maxBytes ?? DEFAULT_CONTEXT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");

  const loadContext = async ({ taskId, treeId, phaseId, requiredRefs = [] } = {}) => {
    assertNonEmptyId(taskId, "taskId");
    assertNonEmptyId(treeId, "treeId");
    assertNonEmptyId(phaseId, "phaseId");
    if (!Array.isArray(requiredRefs) || requiredRefs.some((ref) => !isDurableReference(ref))) {
      throw new Error("requiredRefs must contain only durable references");
    }
    const payload = { taskId, treeId, phaseId, requiredRefs: [...requiredRefs] };
    const taskRaw = await invokeProvider(taskProvider, ["getTaskSummary"], payload);
    const treeRaw = await invokeProvider(treeProvider, ["getTreeSummary"], payload);
    if (taskRaw === undefined || taskRaw === null) throw new Error("task summary provider returned no result");
    if (treeRaw === undefined || treeRaw === null) throw new Error("tree summary provider returned no result");
    const taskSummary = normalizeTaskSummary(taskRaw, { taskId });
    const treeSummary = normalizeTreeSummary(treeRaw, { treeId, taskId });
    const checkpointRaw = await invokeProvider(checkpointProvider, ["recoverLatest"], payload);
    const phaseCheckpoint = normalizePhaseCheckpoint(checkpointRaw, { phaseId, taskSummary, treeSummary });
    const providerOmitted = [taskRaw, treeRaw, checkpointRaw].flatMap((value) => value && typeof value === "object"
      ? value.omitted_refs ?? []
      : []);
    const context = {
      task_summary: taskSummary,
      tree_summary: treeSummary,
      phase_checkpoint: phaseCheckpoint,
      omitted_refs: collectOmitted(providerOmitted),
      byte_count: 0,
    };
    return trimContextToBudget(context, maxBytes);
  };

  return {
    getExtensions: baseMethod(base, "getExtensions", () => ({ extensions: [], errors: [], runtime: undefined })),
    getSkills: baseMethod(base, "getSkills", () => ({ skills: [], diagnostics: [] })),
    getPrompts: baseMethod(base, "getPrompts", () => ({ prompts: [], diagnostics: [] })),
    getThemes: baseMethod(base, "getThemes", () => ({ themes: [], diagnostics: [] })),
    getAgentsFiles: baseMethod(base, "getAgentsFiles", () => ({ agentsFiles: [] })),
    getSystemPrompt: baseMethod(base, "getSystemPrompt", () => undefined),
    getSystemPromptSource: baseMethod(base, "getSystemPromptSource", () => undefined),
    getAppendSystemPrompt: baseMethod(base, "getAppendSystemPrompt", () => []),
    getAppendSystemPromptSources: baseMethod(base, "getAppendSystemPromptSources", () => []),
    extendResources: baseMethod(base, "extendResources", () => {}),
    reload: baseMethod(base, "reload", async () => {}),
    loadContext,
  };
}

export { DEFAULT_CONTEXT_BYTES };
