import {
  isDurableReference,
  normalizePhaseCheckpoint,
  normalizeReferenceList,
  normalizeTaskSummary,
  normalizeTreeSummary,
} from "./control-resource-loader.mjs";

const KIND = "context-compaction/v1";
const SUMMARY_KIND = "context-summary/v1";
const MAX_RETAINED_MESSAGES = 8;
const MAX_MESSAGE_BYTES = 2048;
const MAX_OMITTED_REFS = 64;

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function stableJson(value) {
  return JSON.stringify(value);
}

function unique(values) {
  return [...new Set(values)];
}

function safeId(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be a stable non-empty identity`);
  return value;
}

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  if (utf8ByteLength(text) <= maxBytes) return { text, truncated: false };
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && utf8ByteLength(text.slice(0, end)) > maxBytes) end -= 1;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    else break;
  }
  return { text: text.slice(0, end), truncated: true };
}

function redactMessageText(value) {
  return String(value)
    .replace(/(?:bearer\s+)[^\s]+/giu, "[credential omitted]")
    .replace(/(token|secret|password|api[_-]?key|cookie|authorization)\s*[:=]\s*[^\s,;]+/giu, "$1=[credential omitted]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"']{2,}/gu, "[path omitted]");
}

function messageText(message) {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content
    .map((part) => typeof part === "string" ? part : part && typeof part === "object" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
  return "";
}

function normalizeMessage(message, index) {
  const text = messageText(message);
  if (!text) return null;
  const bounded = truncateUtf8(redactMessageText(text), MAX_MESSAGE_BYTES);
  const role = message && typeof message === "object" && typeof message.role === "string" ? message.role : "message";
  return {
    index,
    role: role.slice(0, 32),
    text: bounded.text,
    ...(bounded.truncated ? { truncated: true } : {}),
  };
}

function normalizeResources(contextResources = {}) {
  const taskRaw = contextResources.task_summary;
  const treeRaw = contextResources.tree_summary;
  const taskSummary = taskRaw ? normalizeTaskSummary(taskRaw, { taskId: taskRaw.task_id }) : null;
  const treeSummary = treeRaw ? normalizeTreeSummary(treeRaw, { treeId: treeRaw.tree_id, taskId: taskSummary?.task_id }) : null;
  const phaseRaw = contextResources.phase_checkpoint;
  const phaseCheckpoint = phaseRaw
    ? normalizePhaseCheckpoint(phaseRaw, {
      phaseId: phaseRaw.phase_id,
      taskSummary,
      treeSummary,
    })
    : null;
  const trustedSpecRefs = normalizeReferenceList(contextResources.trusted_spec_refs);
  const omittedRefs = normalizeReferenceList(contextResources.omitted_refs);
  const evidenceRefs = unique([
    ...(taskSummary?.evidence_refs ?? []),
    ...((treeSummary?.nodes ?? []).flatMap((node) => node.evidence_refs ?? [])),
    ...(phaseCheckpoint?.evidence_refs ?? []),
  ]);
  return {
    taskSummary,
    treeSummary,
    phaseCheckpoint,
    trustedSpecRefs,
    evidenceRefs,
    omittedRefs,
  };
}

function recoveryState(sessionId, resources) {
  const checkpoint = resources.phaseCheckpoint;
  return {
    session_id: sessionId,
    task_id: resources.taskSummary?.task_id ?? checkpoint?.task_summary?.task_id ?? null,
    tree_id: resources.treeSummary?.tree_id ?? checkpoint?.tree_summary?.tree_id ?? null,
    phase_id: checkpoint?.phase_id ?? null,
    checkpoint_id: checkpoint?.checkpoint_id ?? null,
    source_session_id: checkpoint?.source_session_id ?? sessionId,
    next_session_id: checkpoint?.next_session_id ?? null,
    dependency_ids: resources.taskSummary?.dependency_ids ?? [],
    evidence_refs: resources.evidenceRefs,
    ...(isDurableReference(checkpoint?.persisted_ref) ? { checkpoint_ref: checkpoint.persisted_ref } : {}),
  };
}

function omittedForMessages(messages) {
  return messages.map((message) => `session_message:${message.index}`);
}

function makePayload(document, state, retainedRefs, omittedRefs) {
  const summary = stableJson(document);
  return {
    kind: KIND,
    summary,
    recovery_state: state,
    retained_refs: retainedRefs,
    omitted_refs: omittedRefs,
  };
}

function payloadBytes(payload) {
  return utf8ByteLength(stableJson(payload));
}

function compactOmittedRefs(values) {
  const refs = unique(values.filter((value) => typeof value === "string" && value.length > 0));
  return refs.length <= MAX_OMITTED_REFS ? refs : refs.slice(0, MAX_OMITTED_REFS);
}

export class ContextCompactionError extends Error {
  constructor(message, code = "context_compaction_failed") {
    super(message);
    this.name = "ContextCompactionError";
    this.code = code;
  }
}

export function createContextCompaction(options = {}) {
  const defaultThresholdBytes = options.thresholdBytes ?? 64 * 1024;

  const compactContext = async ({ sessionId, messages = [], contextResources = {}, thresholdBytes = defaultThresholdBytes } = {}) => {
    safeId(sessionId, "sessionId");
    if (!Array.isArray(messages)) throw new ContextCompactionError("messages must be an array", "invalid_messages");
    if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes <= 0) throw new ContextCompactionError("thresholdBytes must be a positive integer", "invalid_threshold");

    const beforeBytes = utf8ByteLength(stableJson({ sessionId, messages, contextResources }));
    const resources = normalizeResources(contextResources);
    if (!resources.taskSummary || !resources.treeSummary) {
      throw new ContextCompactionError("task and tree summaries are required for recoverable compaction", "missing_recovery_identity");
    }

    const normalizedMessages = messages.map(normalizeMessage).filter(Boolean);
    const omittedRefs = [...resources.omittedRefs];
    let retainedMessages = normalizedMessages.slice(-MAX_RETAINED_MESSAGES);
    if (normalizedMessages.length > retainedMessages.length) {
      omittedRefs.push(...omittedForMessages(normalizedMessages.slice(0, -MAX_RETAINED_MESSAGES)));
    }
    const resourcesDocument = {
      kind: SUMMARY_KIND,
      task_summary: resources.taskSummary,
      tree_summary: resources.treeSummary,
      phase_checkpoint: resources.phaseCheckpoint,
      trusted_spec_refs: resources.trustedSpecRefs,
      messages: retainedMessages,
    };
    const retainedRefs = unique([
      ...resources.trustedSpecRefs,
      ...resources.evidenceRefs,
      ...(isDurableReference(resources.phaseCheckpoint?.persisted_ref) ? [resources.phaseCheckpoint.persisted_ref] : []),
    ]);
    const recovery = recoveryState(sessionId, resources);
    let truncated = normalizedMessages.length > retainedMessages.length || normalizedMessages.some((message) => message.truncated === true);
    let payload = makePayload(resourcesDocument, recovery, retainedRefs, compactOmittedRefs(omittedRefs));

    const rebuild = () => {
      resourcesDocument.messages = retainedMessages;
      payload = makePayload(resourcesDocument, recovery, retainedRefs, compactOmittedRefs(omittedRefs));
      return payloadBytes(payload);
    };

    while (payloadBytes(payload) > thresholdBytes && retainedMessages.length > 0) {
      const removed = retainedMessages.shift();
      omittedRefs.push(`session_message:${removed.index}`);
      truncated = true;
      rebuild();
    }

    if (payloadBytes(payload) > thresholdBytes) {
      throw new ContextCompactionError(
        `recoverable context core exceeds ${thresholdBytes} UTF-8 bytes`,
        "threshold_unachievable",
      );
    }

    const afterBytes = payloadBytes(payload);
    return {
      kind: KIND,
      summary: payload.summary,
      recovery_state: payload.recovery_state,
      retained_refs: payload.retained_refs,
      omitted_refs: payload.omitted_refs,
      before_bytes: beforeBytes,
      after_bytes: afterBytes,
      truncated,
    };
  };

  return { compactContext };
}

export { KIND as CONTEXT_COMPACTION_KIND, SUMMARY_KIND as CONTEXT_SUMMARY_KIND };
