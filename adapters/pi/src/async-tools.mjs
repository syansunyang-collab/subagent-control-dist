import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitUnlessAborted } from "./abortable-wait.mjs";
import { PAUSE_TOOL_DESCRIPTION, RESUME_TOOL_DESCRIPTION } from "../../../ops/tools/pause-surface.mjs";

export const SUBAGENT_LIFECYCLE_TOOL_NAMES = Object.freeze([
  "subagent_wait",
  "subagent_get",
  "subagent_result",
  "subagent_server_info",
  "subagent_cancel",
  "subagent_pause",
  "subagent_resume",
]);

const taskIdentity = {
  task_id: { type: "string", minLength: 1 },
  task_root: { type: "string", minLength: 1 },
};

const waitSchema = Object.freeze({
  type: "object",
  required: ["task_id"],
  properties: {
    ...taskIdentity,
    after_revision: { type: "string", minLength: 1 },
    timeout_ms: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
});

const publicGetSchema = Object.freeze({
  type: "object",
  required: ["task_id"],
  properties: {
    ...taskIdentity,
    detail: { type: "string", enum: ["compact", "diagnostic"] },
  },
  additionalProperties: false,
});

const resultSchema = Object.freeze({
  type: "object",
  required: ["task_id"],
  properties: taskIdentity,
  additionalProperties: false,
});

const resumeSchema = Object.freeze({
  type: "object",
  required: ["task_id", "expected_revision"],
  properties: {
    ...taskIdentity,
    expected_revision: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
});

const cancelSchema = Object.freeze({
  type: "object",
  required: ["task_id", "expected_revision", "reason"],
  properties: {
    ...taskIdentity,
    expected_revision: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1, maxLength: 1024, description: "Why this execution should stop. Use user_requested only for an explicit user stop." },
  },
  additionalProperties: false,
});

const pauseSchema = Object.freeze({
  type: "object",
  required: ["task_id", "expected_revision", "reason"],
  properties: {
    ...taskIdentity,
    expected_revision: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1, maxLength: 1024, description: "暂停原因，仅作说明，不改变动作或权限。" },
  },
  additionalProperties: false,
});

const serverInfoSchema = Object.freeze({
  type: "object",
  properties: {},
  additionalProperties: false,
});

const CONTROL_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const BUILD_MANIFEST_PATH = path.join(CONTROL_ROOT, "ops", "dist", "subagent_service.manifest.json");
const SERVER_NAME = "async-subagent";
const SERVER_VERSION = "1.0.0";

function buildManifestIdentity() {
  try {
    const manifest = JSON.parse(readFileSync(BUILD_MANIFEST_PATH, "utf8"));
    const buildId = typeof manifest?.build_id === "string" ? manifest.build_id.trim() : "";
    if (!buildId) return { manifest, build_id: null, reason: "dist manifest has no build_id" };
    return { manifest, build_id: buildId, reason: null };
  } catch (error) {
    return {
      manifest: null,
      build_id: null,
      reason: `dist manifest unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function serverInfo(service, tools) {
  const contract = service.contractInfo();
  const identity = buildManifestIdentity();
  const result = {
    server_name: identity.manifest?.server_name ?? SERVER_NAME,
    server_version: identity.manifest?.server_version ?? SERVER_VERSION,
    contract_version: contract?.contract_version ?? contract?.core_contract ?? contract?.version ?? null,
    dispatch_contract_version: contract?.dispatch_contract_version ?? null,
    supported_dispatch_contract_versions: Array.isArray(contract?.supported_dispatch_contract_versions)
      ? [...contract.supported_dispatch_contract_versions]
      : [],
    build_id: identity.build_id,
    tools: [...tools],
  };
  if (identity.reason) result.build_id_reason = identity.reason;
  return result;
}

// promptSnippet 让工具进系统提示词的工具清单；Pi 自定义工具不设它就只在 API 工具数组里。
function tool({ name, label, description, promptSnippet, promptGuidelines, parameters, execute }) {
  return {
    name,
    label,
    description,
    ...(promptSnippet ? { promptSnippet } : {}),
    ...(promptGuidelines ? { promptGuidelines } : {}),
    parameters,
    executionMode: "sequential",
    execute,
  };
}

// Stop pressed while waiting: release the tool call; the task itself keeps running and still reports by follow-up.
function abortedWait(params) {
  return { task_id: params?.task_id ?? null, event: "aborted", changed: false, note: "wait released by user stop; task unaffected" };
}

function piToolResult(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new TypeError("Async service result must be JSON-serializable");
  return {
    content: [{ type: "text", text }],
    details: value,
  };
}

export function createSubagentLifecycleTools({ service, onResumed } = {}) {
  if (!service) throw new TypeError("createSubagentLifecycleTools requires one PiAsyncService instance");
  return [
    tool({
      name: "subagent_wait",
      promptSnippet: "Wait for a subagent task to finish or stall; completion normally arrives by follow-up",
      label: "Subagent Wait",
      description: "Wait for completion, a nonterminal stall or attention (parked) notice, or timeout. Use for explicitly requested synchronous waiting or notification troubleshooting; normal completion arrives by follow-up.",
      parameters: waitSchema,
      execute: async (_toolCallId, params, signal) => piToolResult(
        await waitUnlessAborted(service.wait(params), signal, () => abortedWait(params)),
      ),
    }),
    tool({
      name: "subagent_get",
      promptSnippet: "Read a subagent task's compact state or diagnostics",
      label: "Subagent Get",
      description: "Read compact task state without changing it. When compact is insufficient, use diagnostic for the live phase, last request/tool and task-local log entry points, including for the same revision. diagnostic_omitted lists omitted detail. Use subagent_result when a terminal business result is available; otherwise inspect the terminal failure here.",
      parameters: publicGetSchema,
      execute: async (_toolCallId, params) => piToolResult(await service.get(params)),
    }),
    tool({
      name: "subagent_result",
      promptSnippet: "Read a finished subagent task's business result and artifact paths",
      label: "Subagent Result",
      description: "Read an available terminal business result and artifact paths after execution and artifact-presence checks. Reuse a result already read for the same task_id + revision; re-read on a new revision, a corrupted receipt, or a user-requested recheck. Open underlying evidence when the summary is insufficient for judgment. If unavailable, inspect subagent_get for the task state.",
      parameters: resultSchema,
      execute: async (_toolCallId, params) => piToolResult(await service.result(params)),
    }),
    tool({
      name: "subagent_server_info",
      promptSnippet: "Show the deployed subagent service build and contract versions",
      label: "Subagent Server Info",
      description: "Return the deployed AsyncTaskService build identity, contract versions, and tool names used by this Pi session.",
      parameters: serverInfoSchema,
      execute: async () => piToolResult(serverInfo(service, SUBAGENT_LIFECYCLE_TOOL_NAMES)),
    }),
    tool({
      name: "subagent_cancel",
      promptSnippet: "Cancel a subagent task (expected revision and reason required)",
      label: "Subagent Cancel",
      description: "Request cancellation of one subagent task with a required expected revision and non-empty free-text reason. user_requested is the only reason with user-stop semantics; omission never implies user authorization.",
      parameters: cancelSchema,
      execute: async (_toolCallId, params) => piToolResult(await service.cancel(params)),
    }),
    tool({
      name: "subagent_pause",
      promptSnippet: "Pause a running subagent task",
      label: "Subagent Pause",
      description: PAUSE_TOOL_DESCRIPTION,
      parameters: pauseSchema,
      execute: async (_toolCallId, params) => piToolResult(await service.pause(params)),
    }),
    tool({
      name: "subagent_resume",
      promptSnippet: "Resume a paused subagent task",
      label: "Subagent Resume",
      description: RESUME_TOOL_DESCRIPTION,
      parameters: resumeSchema,
      execute: async (_toolCallId, params) => {
        const result = await service.resume(params);
        if (result.accepted && onResumed) {
          try {
            Object.assign(result, await onResumed(result));
          } catch (error) {
            result.post_submit_failures = [{ step: "resume_tracking", error: String(error?.message ?? error) }];
          }
        }
        return piToolResult(result);
      },
    }),
  ];
}
