// Neutral async lifecycle contracts. Adapter identity, tool names, and environment defaults stay outside Core.

export const CONTRACT_VERSION = "async-task-service/v1";
export const DISPATCH_ENVELOPE_VERSION = "async-dispatch/v2";
export const SUPPORTED_DISPATCH_ENVELOPE_VERSIONS = Object.freeze([
  "async-dispatch/v1",
  DISPATCH_ENVELOPE_VERSION,
]);

export const WRITE_CLAIM_CONTRACT_VERSION = "async-write-claim/v1";
export const WRITE_CLAIM_LOCK_WAIT_MS = 5000;
export const WRITE_CLAIM_LOCK_STALE_MS = 60000;
export const WRITE_CLAIM_STALE_MS = 5 * 60 * 1000;

// wait 上限单真源：runtime 的等待循环与 service 的 timeout_ms schema 上限共用本值。
export const MAX_WAIT_MS = 600000;

export const CROSS_REPO_RESULT_MODES = Object.freeze([
  "read_only_audit",
  "simulated_planning",
  "real_rerun",
]);
export const CROSS_REPO_ATTESTATION_VERSION = "cross-repo-attestation/v2";
export const ARTIFACT_ATTESTATION_VERSION = "artifact-attestation/v2";

export const TERMINAL_STATES = Object.freeze(["done", "failed", "cancelled"]);
export const BUSINESS_STATE_CANON = Object.freeze([
  "completed",
  "completed_with_uncertainty",
  "partial",
  "blocked",
  "failed",
  "unknown",
]);
export const BUSINESS_STATE_SYNONYMS = Object.freeze({
  done: "completed",
  complete: "completed",
  success: "completed",
  succeeded: "completed",
  完成: "completed",
  成功: "completed",
  已完成: "completed",
  partially_completed: "partial",
  partial_success: "partial",
  部分完成: "partial",
  部分: "partial",
  stuck: "blocked",
  受阻: "blocked",
  阻塞: "blocked",
  被阻塞: "blocked",
  error: "failed",
  failure: "failed",
  失败: "failed",
  出错: "failed",
});

export const FINAL_OUTPUT_HEADINGS = Object.freeze([
  "## 结论",
  "## 事实与证据",
  "## 已检查内容",
  "## 失败检查",
  "## 不确定项",
  "## 边界",
]);

export const TOKEN_BUDGETS = Object.freeze({
  submit: 250,
  wait: 300,
  getPerTask: 250,
  getDiagnostic: 1500,
  result: 700,
  cancel: 200,
});

export function isTerminalState(state) {
  return TERMINAL_STATES.includes(String(state ?? ""));
}

export function normalizeBusinessWord(word) {
  const raw = String(word ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (BUSINESS_STATE_CANON.includes(lower)) return lower;
  if (lower.startsWith("completed_with")) return "completed_with_uncertainty";
  return BUSINESS_STATE_SYNONYMS[raw] || BUSINESS_STATE_SYNONYMS[lower] || null;
}
