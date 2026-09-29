import {
  createFleetCore,
  FLEET_DECISIONS,
  FLEET_TOOL_NAMES,
  FLEET_WAIT_MS_MAX,
  FLEET_WAIT_MS_MIN,
} from "../../../ops/tools/fleet-tools-core.mjs";

import { waitUnlessAborted } from "./abortable-wait.mjs";
import { observeFleetToolResult } from "./fleet-completion-watcher.mjs";

export { FLEET_TOOL_NAMES };

const startSchema = Object.freeze({
  type: "object",
  required: ["manifest_path"],
  properties: {
    manifest_path: { type: "string", minLength: 1 },
    run_id: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
});

const statusSchema = Object.freeze({
  type: "object",
  required: ["run_id"],
  properties: {
    run_id: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
});

const waitSchema = Object.freeze({
  type: "object",
  required: ["run_id"],
  properties: {
    run_id: { type: "string", minLength: 1 },
    wait_ms: { type: "integer", description: `Wait budget in milliseconds, clamped to [${FLEET_WAIT_MS_MIN}, ${FLEET_WAIT_MS_MAX}].` },
  },
  additionalProperties: false,
});

const reviewSchema = Object.freeze({
  type: "object",
  required: ["run_id", "node_id", "decision"],
  properties: {
    run_id: { type: "string", minLength: 1 },
    node_id: { type: "string", minLength: 1 },
    decision: { type: "string", enum: [...FLEET_DECISIONS] },
    reason: { type: "string" },
    evidence: { type: "string", minLength: 1, description: "Repo-internal evidence path. May be omitted for requeue; required for other decisions." },
  },
  additionalProperties: false,
});

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

function piToolResult(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new TypeError("Fleet tool result must be JSON-serializable");
  return {
    content: [{ type: "text", text }],
    details: value,
  };
}

export function createFleetTools({ coreOptions = {}, core = null, onRunStarted = null } = {}) {
  const fleet = core ?? createFleetCore(coreOptions);
  async function watchStartedRun(result, ctx) {
    if (!result?.ok || !result.run_id || typeof onRunStarted !== "function") return result;
    try {
      const watch = await onRunStarted({ run_id: result.run_id, result, ctx });
      return watch && typeof watch === "object" ? { ...result, ...watch } : result;
    } catch (error) {
      return { ...result, completion_watch: { status: "failed", error: error instanceof Error ? error.message : String(error) } };
    }
  }
  return [
    tool({
      name: "fleet_start",
      promptSnippet: "Launch a fleet manifest (a DAG of subagent tasks) under a background scheduler",
      label: "Fleet Start",
      description: "Validate a fleet manifest and launch its DAG under a detached scheduler driver. Returns run_id, state_root and node_count; the driver keeps dispatching without further parent calls.",
      parameters: startSchema,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const result = await fleet.fleet_start(params ?? {});
        return piToolResult(await watchStartedRun(result, ctx));
      },
    }),
    tool({
      name: "fleet_status",
      promptSnippet: "Read a fleet run's state summary",
      label: "Fleet Status",
      description: "Read one fleet run's bounded state summary: node counts, active nodes, nodes waiting for parent review, failures and the next ready nodes.",
      parameters: statusSchema,
      execute: async (_toolCallId, params) => {
        const result = await fleet.fleet_status(params ?? {});
        observeFleetToolResult(fleet, "fleet_status", result);
        return piToolResult(result);
      },
    }),
    tool({
      name: "fleet_wait",
      promptSnippet: "Wait for a fleet run to settle; completion normally arrives by follow-up",
      label: "Fleet Wait",
      description: "Wait synchronously for fleet settlement or budget expiry and return a bounded summary. Use for explicitly requested synchronous waiting or notification troubleshooting; normal completion arrives by follow-up.",
      parameters: waitSchema,
      execute: async (_toolCallId, params, signal) => {
        const result = await waitUnlessAborted(fleet.fleet_wait(params ?? {}), signal, () => ({
          ok: true, run_id: params?.run_id ?? null, event: "aborted", note: "wait released by user stop; fleet unaffected",
        }));
        if (result.event !== "aborted") observeFleetToolResult(fleet, "fleet_wait", result);
        return piToolResult(result);
      },
    }),
    tool({
      name: "fleet_review",
      promptSnippet: "Record the parent review decision for a fleet node awaiting review",
      label: "Fleet Review",
      description: `Record a parent review decision for a node in needs_parent_review: ${FLEET_DECISIONS.join(", ")}. Accepting relaunches the driver so downstream nodes keep moving.`,
      parameters: reviewSchema,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const result = await fleet.fleet_review(params ?? {});
        observeFleetToolResult(fleet, "fleet_review", result);
        return piToolResult(["accept", "requeue"].includes(params?.decision)
          ? await watchStartedRun(result, ctx) : result);
      },
    }),
    tool({
      name: "fleet_cancel",
      promptSnippet: "Cancel an entire fleet run after an explicit user stop request",
      label: "Fleet Cancel",
      description: "Cancel an entire fleet after an explicit user stop request. Stops further dispatch, cancels active tasks and unstarted nodes, and preserves finished results. A cancelling result means termination is not yet confirmed; the completion watcher reconciles it automatically and reports the final state.",
      parameters: { type: "object", required: ["run_id", "reason"], properties: { run_id: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 } }, additionalProperties: false },
      execute: async (_toolCallId, params) => {
        const result = await fleet.fleet_cancel(params ?? {});
        observeFleetToolResult(fleet, "fleet_cancel", { ...result, cancellation_reason: params?.reason });
        return piToolResult(result);
      },
    }),
  ];
}
