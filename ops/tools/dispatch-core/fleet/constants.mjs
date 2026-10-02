// fleet_scheduler.mjs 按职责拆出的 constants。只搬移代码，不改行为。
import path from "node:path";
import { ROOT } from "../_tool_common.mjs";

export const DEFAULT_STATE_ROOT = path.join(ROOT, ".runtime", "cockpit", "fleet_runs");

export const DEFAULT_ASYNC_TASK_ROOT = path.join(ROOT, ".runtime", "cockpit", "async_tasks");

export const TERMINAL_STATES = new Set(["done", "failed", "cancelled", "blocked", "needs_parent_review"]);

export const ASYNC_TERMINAL_STATES = new Set(["done", "failed", "cancelled"]);

export const ACTIVE_STATES = new Set(["submitted", "queued", "running", "cancel_requested"]);

export const FAILED_DEPENDENCY_STATES = new Set(["failed", "cancelled", "blocked"]);

export const SUMMARY_NODE_LIMIT = 8;

export const SUMMARY_EVENT_LIMIT = 8;

export const SAFE_ID_RE = /[^A-Za-z0-9_.-]+/g;

export const INITIAL_LIVENESS_GRACE_SECONDS = 10 * 60;

export const RUN_LOCK_TIMEOUT_SECONDS = 30.0;

export const LIVENESS_RECHECK_SECONDS = 5 * 60;

export const DISPATCH_PREPARE_TIMEOUT_SECONDS = 5 * 60;

export const MAX_RUNTIME_EVIDENCE_BYTES = 128 * 1024;

export const MAX_RUNTIME_USAGE_VALUE = 2147483647;

export const RUNTIME_USAGE_FIELDS = [
  "total_tokens",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "model_context_window",
];

export const ROUTE_KEYS = ["executor", "model", "effort"];
