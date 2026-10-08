"use strict";

/**
 * pi-web liveness adapter.
 *
 * Pi Web keeps a session alive while any registered liveness provider reports
 * active work (E:/ControlPlane/web/app/lib/session-liveness.ts, protocol v1,
 * registry key "@agegr/pi-web/session-liveness/v1"). A scheduler with pending
 * tasks is exactly such a provider: without it Pi Web would evict an idle
 * session after 10 minutes and the pending wake-up would never fire.
 *
 * The registry lives on globalThis, and Pi Web runs sessions in-process, so a
 * registration from this extension is visible to hasActiveSessionLivenessProvider
 * in the same Node process. When no compatible registry exists (plain TUI, json,
 * print) registration is a documented no-op.
 */

const REGISTRY_KEY = "@agegr/pi-web/session-liveness/v1";
const PROTOCOL_VERSION = 1;
const DEFAULT_LEASE_TTL_MS = 90_000;

function isCompatibleRegistry(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.version === PROTOCOL_VERSION &&
      typeof value.register === "function" &&
      typeof value.hasActiveProvider === "function",
  );
}

function getLivenessRegistry(globalObject = globalThis) {
  if (!globalObject) return null;
  const key = Symbol.for(REGISTRY_KEY);
  const existing = globalObject[key];
  return isCompatibleRegistry(existing) ? existing : null;
}

function validateProvider(provider) {
  if (!provider || typeof provider !== "object") return "provider object is required";
  if (typeof provider.name !== "string" || !provider.name.trim()) return "provider.name is required";
  if (typeof provider.sessionId !== "string" || !provider.sessionId.trim()) return "provider.sessionId is required";
  if (typeof provider.isActive !== "function") return "provider.isActive must be a function";
  return null;
}

/**
 * Register a liveness provider with the Pi Web registry.
 * Returns `{ supported, reason, release }`; `release` is always safe to call.
 */
function registerLivenessProvider(provider, { globalObject = globalThis } = {}) {
  const invalid = validateProvider(provider);
  if (invalid) {
    return { supported: false, reason: invalid, release() {} };
  }
  const registry = getLivenessRegistry(globalObject);
  if (!registry) {
    return { supported: false, reason: "pi-web liveness registry is not present in this process", release() {} };
  }
  try {
    const release = registry.register({
      name: provider.name,
      sessionId: provider.sessionId,
      ...(provider.sessionFile ? { sessionFile: provider.sessionFile } : {}),
      leaseTtlMs: provider.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      isActive: provider.isActive,
    });
    let released = false;
    return {
      supported: true,
      reason: null,
      release() {
        if (released) return;
        released = true;
        try {
          if (typeof release === "function") release();
        } catch {
          /* a failed release only costs one keep-alive window */
        }
      },
    };
  } catch (error) {
    return { supported: false, reason: error && error.message ? error.message : String(error), release() {} };
  }
}

function hasActiveProvider(identity, { globalObject = globalThis } = {}) {
  const registry = getLivenessRegistry(globalObject);
  if (!registry) return false;
  try {
    return registry.hasActiveProvider(identity) === true;
  } catch {
    return false;
  }
}

module.exports = {
  REGISTRY_KEY,
  PROTOCOL_VERSION,
  DEFAULT_LEASE_TTL_MS,
  isCompatibleRegistry,
  getLivenessRegistry,
  registerLivenessProvider,
  hasActiveProvider,
};
