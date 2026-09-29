// ops/tools/pi_transient_retry.mjs
import { existsSync } from "node:fs";
import path from "node:path";
var TRANSIENT_SERVICE_RETRY_TAG = "[transient-service-retry]";
var NATIVE_RETRY_HINT = "provider returned error";
var TRANSIENT_RETRY_EXTENSION_NAMES = Object.freeze([
  "pi_transient_retry.mjs",
  "pi_transient_retry.bundle.mjs"
]);
var TRANSIENT_SERVICE_ERROR = /service(?:\s+is)?\s+temporarily\s+unavailable|availability is currently degraded/i;
var ALREADY_NATIVE_RETRYABLE = /overloaded|rate.?limit|too many requests|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|\b524\b|provider.?returned.?error|fetch failed|timed?\s*out|timeout|terminated|connection.?error|server.?error|internal.?error/i;
function isTransientServiceError(errorMessage) {
  return TRANSIENT_SERVICE_ERROR.test(String(errorMessage ?? ""));
}
function annotateTransientServiceError(message) {
  if (!message || message.role && message.role !== "assistant") return null;
  if (message.stopReason !== "error" || typeof message.errorMessage !== "string") return null;
  if (message.errorMessage.includes(TRANSIENT_SERVICE_RETRY_TAG)) return null;
  if (!isTransientServiceError(message.errorMessage)) return null;
  if (ALREADY_NATIVE_RETRYABLE.test(message.errorMessage)) return null;
  return {
    ...message,
    errorMessage: `${message.errorMessage}

${TRANSIENT_SERVICE_RETRY_TAG} ${NATIVE_RETRY_HINT}; treating temporary service unavailability as retryable.`
  };
}
function transientRetryExtensionPath(dir, exists = existsSync) {
  for (const name of TRANSIENT_RETRY_EXTENSION_NAMES) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}
function transientServiceRetry(pi) {
  pi.on("message_end", (event) => {
    const message = annotateTransientServiceError(event?.message);
    return message ? { message } : void 0;
  });
}
export {
  NATIVE_RETRY_HINT,
  TRANSIENT_RETRY_EXTENSION_NAMES,
  TRANSIENT_SERVICE_RETRY_TAG,
  annotateTransientServiceError,
  transientServiceRetry as default,
  isTransientServiceError,
  transientRetryExtensionPath
};
