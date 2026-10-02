// fleet_scheduler.mjs 按职责拆出的 route。只搬移代码，不改行为。
import { pyStr, pyStrip } from "../_py.mjs";
import { isRecord, ToolError } from "../_tool_common.mjs";
import { deepCopy, nodeRoute, nodeRouteSource } from "../fleet_manifest_check.mjs";
import { ROUTE_KEYS } from "./constants.mjs";
import { notEmptyValue, pyDictEqual } from "./py-utils.mjs";

// ---- route 记录 ----
export function newRouteRecord(requested, source) {
  return {
    source,
    requested: requested ? deepCopy(requested) : null,
    frozen: null,
    actual: null,
    identity_evidence: null,
    usage: { provenance: null, token_usage: null },
  };
}

export function ensureRouteRecord(node) {
  let record = node.route;
  if (!isRecord(record) || !Object.hasOwn(record, "requested")) {
    record = newRouteRecord(
      isRecord(node.requested_route) ? node.requested_route : null,
      pyStr(node.route_source || "agent_config"),
    );
    node.route = record;
  }
  if (!Object.hasOwn(record, "source")) record.source = pyStr(node.route_source || "agent_config");
  if (!Object.hasOwn(record, "actual")) record.actual = null;
  if (!Object.hasOwn(record, "frozen")) record.frozen = null;
  let usage = record.usage;
  if (!isRecord(usage)) {
    usage = {};
    record.usage = usage;
  }
  if (!Object.hasOwn(usage, "provenance")) usage.provenance = null;
  if (!Object.hasOwn(usage, "token_usage")) usage.token_usage = null;
  if (record.identity_evidence !== null && record.identity_evidence !== undefined && !isRecord(record.identity_evidence)) {
    record.identity_evidence = null;
  }
  node.route_source = record.source;
  node.requested_route = deepCopy(record.requested ?? null);
  node.actual_route = deepCopy(record.actual ?? null);
  delete node.fallback;
  node.usage_provenance = usage.provenance ?? null;
  return record;
}

export function routeSnapshot(node) {
  return deepCopy(ensureRouteRecord(node));
}

export function frozenRequestedRoute(node) {
  const requested = ensureRouteRecord(node).requested;
  return isRecord(requested) ? deepCopy(requested) : null;
}

export function routeFromPayload(payload) {
  let nested = {};
  for (const key of ["actual_route", "actual", "route"]) {
    const value = payload[key];
    if (isRecord(value)) {
      nested = value;
      break;
    }
  }
  const values = {};
  const aliases = {
    executor: ["actual_executor", "executor"],
    model: ["actual_model", "model"],
    effort: ["actual_effort", "effort"],
  };
  for (const [key, names] of Object.entries(aliases)) {
    let value = null;
    for (const name of [key, ...names]) {
      const candidate = nested[name];
      if (notEmptyValue(candidate)) {
        value = candidate;
        break;
      }
    }
    if (!notEmptyValue(value)) {
      value = null;
      for (const name of names) {
        const candidate = payload[name];
        if (notEmptyValue(candidate)) {
          value = candidate;
          break;
        }
      }
    }
    if (notEmptyValue(value)) values[key] = pyStr(value);
  }
  if (!Object.keys(values).length) return null;
  const result = {};
  for (const key of ROUTE_KEYS) result[key] = Object.hasOwn(values, key) ? values[key] : null;
  if (Object.hasOwn(nested, "provider") || Object.hasOwn(payload, "provider")) {
    result.provider = Object.hasOwn(nested, "provider") ? nested.provider : payload.provider;
  }
  return result;
}

export function updateRouteFromPayload(node, payload, source) {
  const record = ensureRouteRecord(node);
  const actual = routeFromPayload(payload);
  if (actual) {
    const previous = isRecord(record.actual) ? record.actual : {};
    record.actual = { ...previous, ...actual, source };
  }

  const usage = isRecord(payload.usage) ? payload.usage : {};
  const usageProvenance = payload.usage_provenance || usage.provenance;
  if (notEmptyValue(usageProvenance)) record.usage.provenance = pyStr(usageProvenance);
  ensureRouteRecord(node);
  return null;
}

export function routeMatchesManifest(node, manifestNode) {
  const record = ensureRouteRecord(node);
  return record.source === nodeRouteSource(manifestNode)
    && pyDictEqual(record.requested ?? null, nodeRoute(manifestNode));
}

export function normalizeDispatchOverrides(contextMode = "") {
  const context = pyStrip(pyStr(contextMode || ""));
  if (context && !["isolated", "project-aware"].includes(context)) {
    throw new ToolError(`unsupported async context mode: ${context}`);
  }
  return context ? { context_mode: context } : {};
}
