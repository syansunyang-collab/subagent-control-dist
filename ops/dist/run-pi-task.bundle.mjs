#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ops/tools/_stdio-jsonrpc.mjs
import { mkdirSync as mkdirSync6, writeFileSync as writeFileSync3 } from "node:fs";
import path9 from "node:path";
function parseArgs(argv = process.argv.slice(2)) {
  const args2 = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args2[key] = true;
    } else {
      args2[key] = next;
      i += 1;
    }
  }
  return args2;
}
function stringArg(args2, key, fallback = "") {
  const value = args2[key];
  if (value === void 0 || value === null || value === true) {
    return fallback;
  }
  const text3 = String(value);
  return text3.length > 0 ? text3 : fallback;
}
function numberArg(args2, key, fallback) {
  const value = Number(args2[key]);
  return Number.isFinite(value) ? value : fallback;
}
function boolArg(args2, key, fallback = false) {
  if (args2[key] === void 0) {
    return fallback;
  }
  const value = String(args2[key]).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
function ensureDir(dir) {
  mkdirSync6(dir, { recursive: true });
}
function stampForPath(date = /* @__PURE__ */ new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}
function defaultControlHome() {
  const base = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || process.env.APPDATA || process.env.TMPDIR || process.cwd();
  return path9.join(base, "SubagentControl", "subagent-control");
}
function redactAuth(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactAuth(entry));
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret|key|password|credential|cookie|authorization|email/i.test(key)) {
      out[key] = entry ? "[redacted]" : entry;
    } else {
      out[key] = redactAuth(entry);
    }
  }
  return out;
}
function redactText(text3) {
  return String(text3).replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g, "[redacted-openai-key]").replace(/__cf_chl_tk=[^&\s"'<>]+/gi, "__cf_chl_tk=[redacted]").replace(/__cf_chl_rt_tk=[^&\s"'<>]+/gi, "__cf_chl_rt_tk=[redacted]").replace(/cf_chl_rt_tk=[^&\s"'<>]+/gi, "cf_chl_rt_tk=[redacted]").replace(/cf_clearance=[^&;\s"'<>]+/gi, "cf_clearance=[redacted]").replace(/(["']?(?:session|jwt|token|challenge)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]").replace(/([?&](?:md|mdrd|token|session|jwt|challenge)=[^&\s"'<>]{16,})/gi, (value) => {
    const key = value.split("=")[0];
    return `${key}=[redacted]`;
  }).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]").replace(/"email"\s*:\s*"[^"]+"/gi, '"email":"[redacted]"').replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"').replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token":"[redacted]"').replace(/"id_token"\s*:\s*"[^"]+"/gi, '"id_token":"[redacted]"');
}
function countBy(items, keyFn) {
  const counts = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count }));
}
var init_stdio_jsonrpc = __esm({
  "ops/tools/_stdio-jsonrpc.mjs"() {
  }
});

// ops/tools/_child-task-contract.mjs
import { appendFileSync as appendFileSync4, readFileSync as readFileSync9, renameSync as renameSync3, rmSync as rmSync2, writeFileSync as writeFileSync7, writeSync as writeSync2 } from "node:fs";
import path13 from "node:path";
function runtimeLabels(runtimeName) {
  const name = String(runtimeName ?? "").trim();
  return {
    agent: name ? `\u5B50 ${name}` : "\u5B50\u4EE3\u7406",
    child: name ? `child ${name}` : "\u5B50\u6267\u884C\u4F53",
    tools: name ? `${name} runtime` : "\u6267\u884C\u5668 runtime"
  };
}
function literalReplaceAll(text3, needle, value) {
  return String(text3).replaceAll(needle, () => String(value));
}
function applyTemplateReplacements(template2, replacements) {
  let rendered = String(template2);
  for (const [needle, value] of Object.entries(replacements)) {
    if (needle === "{{GOAL}}") continue;
    rendered = literalReplaceAll(rendered, needle, value);
  }
  return literalReplaceAll(rendered, "{{GOAL}}", replacements["{{GOAL}}"] ?? "");
}
function normalizeTaskStatus(word) {
  const raw = String(word ?? "").trim();
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();
  if (TASK_STATUS_CANON.includes(lower)) {
    return lower;
  }
  if (Object.prototype.hasOwnProperty.call(TASK_STATUS_SYNONYMS, raw)) {
    return TASK_STATUS_SYNONYMS[raw];
  }
  if (Object.prototype.hasOwnProperty.call(TASK_STATUS_SYNONYMS, lower)) {
    return TASK_STATUS_SYNONYMS[lower];
  }
  return null;
}
function matchTaskStatusLine(line) {
  const match = String(line || "").match(/^任务状态\s*[:：]\s*(.+?)\s*$/);
  if (!match) {
    return null;
  }
  const raw = match[1].trim();
  const canonical = normalizeTaskStatus(raw);
  return canonical ? { canonical, raw } : null;
}
function escapeRegex(text3) {
  return String(text3).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function sectionText(text3, heading) {
  const body = String(text3);
  const pattern = new RegExp(`(^|\\r?\\n)${escapeRegex(heading)}\\s*\\r?\\n(?<content>[\\s\\S]*?)(?=\\r?\\n##\\s|$)`, "m");
  return pattern.exec(body)?.groups?.content?.trim() ?? "";
}
function sectionLines(text3, heading) {
  const content = sectionText(text3, heading);
  if (!content) {
    return [];
  }
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0);
}
function parseTaskStatus(text3) {
  const firstConclusionLine = sectionLines(text3, "## \u7ED3\u8BBA")[0]?.trim() ?? "";
  return matchTaskStatusLine(firstConclusionLine);
}
function sectionHasMeaningfulContent(text3, heading) {
  const content = sectionText(text3, heading).replace(/^[-*]\s*/gm, "").replace(/\s+/g, "").replace(/[。.!！；;]+$/g, "").trim();
  if (!content) {
    return false;
  }
  return !(/^(无|暂无|没有|无未成功检查|无失败检查|无不确定项|没有不确定项|不适用|none|n\/a)$/i.test(content) || /^(无|没有)(任何)?会改变(本任务)?(gate|verdict|结论|下一步动作)?的?(不确定项|证据缺口|未决事实)$/i.test(content));
}
function analyzeTaskResult(text3, options = {}) {
  const body = String(text3);
  const parsedStatus = parseTaskStatus(body);
  const explicitStatus = parsedStatus?.canonical ?? null;
  const explicitStatusRaw = parsedStatus && parsedStatus.raw && parsedStatus.raw.toLowerCase() !== parsedStatus.canonical ? parsedStatus.raw : null;
  const blockedPatterns = [
    /blocked by policy/i,
    /rejected:\s*blocked/i,
    /被策略拦截/,
    /被.*拦截/,
    /权限不足/,
    /权限.*不足/,
    /无法执行/,
    /无法完成/,
    /无法判定/,
    /无法确认/,
    /没能拿到/,
    /未能拿到/,
    /命令.*失败/
  ];
  const blockedSignals = blockedPatterns.filter((pattern) => pattern.test(body)).map((pattern) => pattern.source);
  const mechanicalSignals = options.mechanicalSignals;
  const selfReportHeadings = options.selfReportHeadings ?? ["## \u5931\u8D25\u68C0\u67E5"];
  let effectiveBlockedSignals = blockedSignals;
  let suppressedBlockedSignals = [];
  let verdictBasis = blockedSignals.length === 0 ? "clean" : "text_heuristic";
  if (mechanicalSignals && blockedSignals.length > 0) {
    const selfReportText = selfReportHeadings.map((heading) => sectionText(body, heading)).join("\n");
    const selfReportHits = blockedPatterns.filter((pattern) => pattern.test(selfReportText)).map((pattern) => pattern.source);
    const mechanicalDirty = (mechanicalSignals.deniedPermissions ?? 0) > 0 || (mechanicalSignals.failedToolCalls ?? 0) > 0 || (mechanicalSignals.errorTurns ?? 0) > 0;
    if (selfReportHits.length > 0) {
      effectiveBlockedSignals = selfReportHits;
      verdictBasis = "self_report";
    } else if (!mechanicalDirty) {
      suppressedBlockedSignals = blockedSignals;
      effectiveBlockedSignals = [];
      verdictBasis = "suppressed_text_hits";
    } else {
      verdictBasis = "mechanical_evidence";
    }
  }
  const rescuePatterns = [
    /替代.*(成功|完成|拿到|获取|确认)/,
    /(成功|完成|拿到|获取|确认).*替代/,
    /救场.*(成功|完成|已完成)/,
    /不需要升级权限/,
    /不影响.*结论/
  ];
  const rescueSignals = rescuePatterns.filter((pattern) => pattern.test(body)).map((pattern) => pattern.source);
  const failureSectionHasContent = sectionHasMeaningfulContent(body, "## \u5931\u8D25\u68C0\u67E5");
  const uncertaintySectionHasContent = sectionHasMeaningfulContent(body, "## \u4E0D\u786E\u5B9A\u9879");
  const warnings = [];
  let ok = explicitStatus === "completed";
  let failureType = "none";
  let status = explicitStatus ?? "missing";
  if (!explicitStatus) {
    ok = false;
    failureType = "task_status_missing";
  } else if (explicitStatus === "partial") {
    ok = false;
    failureType = "task_partial";
  } else if (explicitStatus === "blocked") {
    ok = false;
    failureType = "task_blocked";
  } else if (explicitStatus === "failed") {
    ok = false;
    failureType = "task_failed";
  }
  if (effectiveBlockedSignals.length > 0 && explicitStatus !== "completed" && !ok) {
    failureType = "blocked_by_policy";
  }
  if (explicitStatus === "completed" && effectiveBlockedSignals.length > 0) {
    if (rescueSignals.length > 0 || failureSectionHasContent) {
      status = "completed_with_recorded_failures";
      warnings.push("\u5B50\u4EFB\u52A1\u58F0\u660E completed,\u4F46\u6587\u672C\u5305\u542B\u5931\u8D25\u6216\u53D7\u963B\u4FE1\u53F7;\u5DF2\u6309\u5931\u8D25\u68C0\u67E5/\u6551\u573A\u8BF4\u660E\u8BB0\u5F55\u4E3A\u5E26\u5931\u8D25\u8BB0\u5F55\u7684\u5B8C\u6210\u3002");
    } else {
      ok = false;
      status = "completed_with_unresolved_failures";
      failureType = "completed_with_unresolved_failures";
      warnings.push("\u5B50\u4EFB\u52A1\u58F0\u660E completed,\u4F46\u5B58\u5728\u672A\u89E3\u91CA\u7684\u5931\u8D25\u6216\u53D7\u963B\u4FE1\u53F7\u3002");
    }
  }
  if (explicitStatus === "completed" && uncertaintySectionHasContent) {
    if (status === "completed") {
      status = "completed_with_uncertainty";
    }
    warnings.push("\u5B50\u4EFB\u52A1\u5B8C\u6210,\u4F46\u4ECD\u8BB0\u5F55\u4E0D\u786E\u5B9A\u9879;\u4E3B\u4F1A\u8BDD\u9700\u8981\u5224\u65AD\u4E0D\u786E\u5B9A\u9879\u662F\u5426\u5F71\u54CD\u7528\u6237\u76EE\u6807\u3002");
  }
  return {
    ok,
    status,
    agentDeclaredStatus: explicitStatus,
    agentDeclaredStatusRaw: explicitStatusRaw,
    controllerClassifiedStatus: status,
    requiresParentReview: !ok || warnings.length > 0 || effectiveBlockedSignals.length > 0 || uncertaintySectionHasContent,
    failure_type: failureType,
    verdictBasis,
    blockedSignals: effectiveBlockedSignals,
    rescueSignals,
    warnings,
    sections: {
      failureSectionHasContent,
      uncertaintySectionHasContent,
      diagnosticSignals: { rescueSignals, blockedSignals, suppressedBlockedSignals }
    }
  };
}
function applyReviewGate(task, synthesis) {
  if (!synthesis?.applied || !["pass", "fail", "needs_owner"].includes(synthesis.gate)) {
    return task;
  }
  if (synthesis.gate === "pass") {
    return {
      ...task,
      ok: true,
      status: "completed",
      controllerClassifiedStatus: "completed",
      requiresParentReview: false,
      failure_type: "none",
      warnings: [],
      reviewGate: "pass"
    };
  }
  const status = synthesis.gate === "fail" ? "failed" : "partial";
  return {
    ...task,
    ok: true,
    status,
    controllerClassifiedStatus: status,
    requiresParentReview: true,
    failure_type: "none",
    warnings: [],
    reviewGate: synthesis.gate
  };
}
function headingStatus(text3, headings = requiredHeadings, { conclusionStatusRequired = true } = {}) {
  const body = String(text3);
  const lines = body.split(/\r?\n/);
  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  const missing = headings.filter((heading) => !body.includes(heading));
  const conclusionIsFirst = firstNonEmptyLine === headings[0];
  const conclusionFirstLine = sectionLines(body, headings[0])[0]?.trim() ?? "";
  const conclusionStatusOk = matchTaskStatusLine(conclusionFirstLine) !== null;
  const headingPositions = headings.map((heading) => ({
    heading,
    index: body.indexOf(heading)
  }));
  const headingsInOrder = headingPositions.filter((entry) => entry.index >= 0).every((entry, index, entries) => index === 0 || entry.index > entries[index - 1].index);
  const duplicateHeadings = headings.filter((heading) => {
    const matches2 = body.match(new RegExp(escapeRegex(heading), "g")) ?? [];
    return matches2.length > 1;
  });
  const warnings = [];
  if (!conclusionIsFirst) {
    warnings.push(`child-final.md \u9996\u4E2A\u975E\u7A7A\u884C\u5FC5\u987B\u662F ${headings[0]},\u4E0D\u80FD\u6709\u6E38\u79BB\u524D\u8A00\u3002`);
  }
  if (!conclusionStatusOk) {
    warnings.push(`${headings[0]} \u540E\u7B2C\u4E00\u884C\u5FC5\u987B\u662F \u4EFB\u52A1\u72B6\u6001:completed|partial|blocked|failed\u3002`);
  }
  if (!headingsInOrder) {
    warnings.push("\u8F93\u51FA\u6807\u9898\u987A\u5E8F\u5FC5\u987B\u4E0E Output Contract \u4E00\u81F4\u3002");
  }
  if (duplicateHeadings.length > 0) {
    warnings.push(`\u8F93\u51FA\u6807\u9898\u4E0D\u80FD\u91CD\u590D:${duplicateHeadings.join(", ")}`);
  }
  return {
    required: headings,
    missing,
    firstNonEmptyLine,
    conclusionIsFirst,
    conclusionStatusOk,
    headingsInOrder,
    duplicateHeadings,
    warnings,
    ok: missing.length === 0 && conclusionIsFirst && (conclusionStatusOk || !conclusionStatusRequired) && headingsInOrder && duplicateHeadings.length === 0
  };
}
function normalizeFinalText(text3) {
  return redactText(text3).trim();
}
function parseSimulationProfile(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("simProfileJson must encode one structured object");
  }
  return parsed;
}
function simulationProfilePrompt(profile) {
  return [
    "# \u76EE\u6807\u4ED3\u5B50\u4EE3\u7406\u6A21\u62DF",
    `\u4EE5\u76EE\u6807\u4ED3\u5B50\u4EE3\u7406\u753B\u50CF\u8FD0\u884C,\u7528\u4E8E\u8DE8\u4ED3\u6539\u52A8\u9A8C\u6536\u524D\u7684\u6A21\u62DF\u3002\u89D2\u8272:${profile.role || "(\u672A\u547D\u540D)"}\u3002`,
    "\u76EE\u6807\u4ED3\u5B50\u4EE3\u7406\u8BBE\u5B9A\u5982\u4E0B(\u7EA6\u675F\u884C\u4E3A\u98CE\u683C\u4E0E\u64CD\u4F5C\u8FB9\u754C;\u4EFB\u52A1\u76EE\u6807\u4EE5\u4E0B\u65B9\u4EFB\u52A1\u6750\u6599\u4E3A\u51C6):",
    "",
    JSON.stringify(profile.persona, null, 2),
    "",
    "---",
    "\u4EE5\u4E0B\u662F\u672C\u6B21\u4EFB\u52A1\u6750\u6599:"
  ].join("\n");
}
function fillTemplate(template2, taskText2, context = {}) {
  const {
    contextMode: contextMode2 = "isolated",
    childCwd: childCwd2 = "",
    targetCwd: targetCwd2 = "",
    artifactsDir: artifactsDir2 = "",
    outDir: outDir2 = "",
    runtimeName = "",
    taskReminder = ""
  } = context;
  const labels = runtimeLabels(runtimeName);
  const runtimeContext = contextMode2 === "project-aware" ? [
    "- \u4E0A\u4E0B\u6587\u6A21\u5F0F:project-aware\u3002",
    `- ${labels.child} \u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55:${childCwd2}`,
    `- \u4EFB\u52A1\u76EE\u6807\u5DE5\u4F5C\u533A:${targetCwd2}`,
    "- \u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u5C31\u662F\u4EFB\u52A1\u76EE\u6807\u5DE5\u4F5C\u533A\uFF1Brunner \u5173\u95ED\u81EA\u52A8 context-file \u53D1\u73B0\uFF0C\u53EA\u6267\u884C\u542F\u52A8\u6750\u6599\u663E\u5F0F\u6CE8\u5165\u7684\u9879\u76EE\u89C4\u5219\u548C\u4EFB\u52A1\u6750\u6599\u3002",
    "- \u76EE\u6807\u5DE5\u4F5C\u533A\u4E2D\u7684 AGENTS.md \u6216\u9879\u76EE\u914D\u7F6E\u53EA\u6709\u88AB\u4EFB\u52A1\u6750\u6599\u663E\u5F0F\u6CE8\u5165\u6216\u5217\u5165\u6388\u6743\u8BFB\u9762\u65F6\u624D\u4F5C\u4E3A\u53EF\u89C1\u4E8B\u5B9E\u3002",
    `- \u666E\u901A\u4EA7\u7269\u5199\u5165\u4EFB\u52A1\u76EE\u6807\u5DE5\u4F5C\u533A\u6216\u4EA7\u7269\u76EE\u5F55:${artifactsDir2}`
  ] : [
    "- \u4E0A\u4E0B\u6587\u6A21\u5F0F:isolated\u3002",
    `- ${labels.child} \u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55:${childCwd2}`,
    `- \u4EFB\u52A1\u76EE\u6807\u5DE5\u4F5C\u533A:${targetCwd2}`,
    "- \u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u662F\u9694\u79BB\u8FD0\u884C\u76EE\u5F55,\u4E0D\u4EE3\u8868\u4EFB\u52A1\u76EE\u6807\u3002",
    "- \u4E0D\u5E94\u81EA\u52A8\u628A\u76EE\u6807\u5DE5\u4F5C\u533A AGENTS.md \u5F53\u4F5C\u8FD0\u884C\u6307\u4EE4;\u5982\u4EFB\u52A1\u8981\u6C42\u8BFB\u53D6\u76EE\u6807\u89C4\u5219,\u53EA\u80FD\u628A\u5B83\u4F5C\u4E3A\u4E8B\u5B9E\u6750\u6599\u5F15\u7528\u3002",
    `- \u666E\u901A\u4EA7\u7269\u5199\u5165\u4EFB\u52A1\u76EE\u6807\u5DE5\u4F5C\u533A\u6216\u4EA7\u7269\u76EE\u5F55:${artifactsDir2}`
  ];
  return applyTemplateReplacements(template2, {
    "{{GOAL}}": taskText2,
    "{{RUNTIME_CONTEXT}}": runtimeContext.join("\n"),
    "{{EVIDENCE_DIR}}": outDir2,
    "{{ARTIFACTS_DIR}}": artifactsDir2,
    "{{TASK_REMINDER}}": taskReminder
  });
}
function classifyLiveWrite(frame, elapsedMs, intervalMs) {
  const phaseChanged = frame.nextPhase !== frame.prevPhase;
  const isToolCall = frame.nextPhase === "tool_call";
  const status = String(frame.status ?? "");
  const isTerminal = frame.event === "finished" || status === "completed" || status === "failed" || status === "cancelled";
  return {
    phaseChanged,
    isTerminal,
    recordEvent: phaseChanged || isToolCall || isTerminal,
    flushLive: phaseChanged || isTerminal || elapsedMs >= intervalMs
  };
}
function makeLiveWriter({
  outDir: outDir2,
  livePath: livePath2,
  eventsPath,
  initialState: initialState2 = {},
  flushIntervalMs = LIVE_FLUSH_INTERVAL_MS
} = {}) {
  let lastLiveFlushMs = 0;
  let snapshotDeferred = false;
  let liveState = { ...initialState2 };
  return {
    get state() {
      return liveState;
    },
    writeLive(patch = {}) {
      ensureDir(outDir2);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const prevPhase = liveState.phase;
      liveState = {
        ...liveState,
        ...patch,
        rev: Number(liveState.rev ?? 0) + 1,
        updated_at: now,
        last_event_at: patch.last_event_at ?? now
      };
      const decision = classifyLiveWrite(
        { prevPhase, nextPhase: liveState.phase, event: patch.event, status: liveState.status },
        Date.now() - lastLiveFlushMs,
        flushIntervalMs
      );
      const recordEvent2 = patch.force_record_event === true || decision.recordEvent;
      if (recordEvent2) {
        appendFileSync4(
          eventsPath,
          `${JSON.stringify({
            at: now,
            rev: liveState.rev,
            status: liveState.status,
            phase: liveState.phase,
            event: patch.event ?? null,
            last_notification_method: liveState.last_notification_method,
            last_tool_call: liveState.last_tool_call,
            ...patch.event_extra ?? {}
          })}
`,
          "utf8"
        );
      }
      if (decision.flushLive) {
        if (liveState.token_usage === void 0) {
          delete liveState.token_usage;
        }
        const tempPath = `${livePath2}.${process.pid}.${liveState.rev}.tmp`;
        try {
          writeFileSync7(tempPath, JSON.stringify(liveState, null, 2), { encoding: "utf8", flag: "wx" });
          for (let attempt = 0; ; attempt++) {
            try {
              renameSync3(tempPath, livePath2);
              break;
            } catch (error) {
              if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
              if (attempt === 7) {
                if (!snapshotDeferred) {
                  appendFileSync4(eventsPath, `${JSON.stringify({
                    at: (/* @__PURE__ */ new Date()).toISOString(),
                    rev: liveState.rev,
                    event: "live_snapshot_deferred",
                    error_code: error.code,
                    error: error.message
                  })}
`, "utf8");
                }
                snapshotDeferred = true;
                lastLiveFlushMs = Date.now();
                return;
              }
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
            }
          }
        } finally {
          rmSync2(tempPath, { force: true });
        }
        if (snapshotDeferred) {
          appendFileSync4(eventsPath, `${JSON.stringify({
            at: (/* @__PURE__ */ new Date()).toISOString(),
            rev: liveState.rev,
            event: "live_snapshot_resumed"
          })}
`, "utf8");
          snapshotDeferred = false;
        }
        lastLiveFlushMs = Date.now();
      }
    }
  };
}
function writeStdoutSync(text3) {
  const buffer = Buffer.from(text3, "utf8");
  let written = 0;
  while (written < buffer.length) {
    try {
      written += writeSync2(1, buffer, written, buffer.length - written);
    } catch (error) {
      if (error?.code !== "EAGAIN") {
        throw error;
      }
    }
  }
}
function makeFailEarly({ outDir: outDir2, resultPath: resultPath2 = path13.join(outDir2, "child-task-result.json") } = {}) {
  return function failEarly2(result2, failureType, message) {
    result2.ok = false;
    result2.status = "failed";
    result2.failure_type = failureType;
    result2.error = message;
    ensureDir(outDir2);
    result2.outputPath = resultPath2;
    writeFileSync7(resultPath2, JSON.stringify(result2, null, 2), "utf8");
    writeStdoutSync(`${JSON.stringify(result2, null, 2)}
`);
    process.exit(1);
  };
}
function readTaskText({ taskFile: taskFile2 = "", task = "" } = {}) {
  if (taskFile2) {
    return readFileSync9(taskFile2, "utf8").trim();
  }
  return String(task ?? "").trim();
}
function classifyFinalResult(orchestration, task) {
  const orchestrationOk = orchestration?.ok === true;
  const taskOk = task?.ok === true;
  const incomplete = INCOMPLETE_BUSINESS_STATUSES.has(task?.status);
  return {
    ok: orchestrationOk && taskOk,
    status: !orchestrationOk ? "failed" : incomplete ? task.status : taskOk ? "completed" : "blocked",
    failure_type: !orchestrationOk ? orchestration?.failure_type ?? "unknown" : task?.failure_type ?? "unknown"
  };
}
var LIVE_FLUSH_INTERVAL_MS, requiredHeadings, TASK_STATUS_CANON, TASK_STATUS_SYNONYMS, INCOMPLETE_BUSINESS_STATUSES;
var init_child_task_contract = __esm({
  "ops/tools/_child-task-contract.mjs"() {
    init_stdio_jsonrpc();
    LIVE_FLUSH_INTERVAL_MS = 5e3;
    requiredHeadings = [
      "## \u7ED3\u8BBA",
      "## \u4E8B\u5B9E\u4E0E\u8BC1\u636E",
      "## \u5DF2\u68C0\u67E5\u5185\u5BB9",
      "## \u5931\u8D25\u68C0\u67E5",
      "## \u4E0D\u786E\u5B9A\u9879",
      "## \u8FB9\u754C"
    ];
    TASK_STATUS_CANON = ["completed", "partial", "blocked", "failed"];
    TASK_STATUS_SYNONYMS = {
      done: "completed",
      complete: "completed",
      success: "completed",
      succeeded: "completed",
      \u5B8C\u6210: "completed",
      \u6210\u529F: "completed",
      \u5DF2\u5B8C\u6210: "completed",
      partially_completed: "partial",
      partial_success: "partial",
      \u90E8\u5206\u5B8C\u6210: "partial",
      \u90E8\u5206: "partial",
      stuck: "blocked",
      \u53D7\u963B: "blocked",
      \u963B\u585E: "blocked",
      \u88AB\u963B\u585E: "blocked",
      error: "failed",
      failure: "failed",
      \u5931\u8D25: "failed",
      \u51FA\u9519: "failed"
    };
    INCOMPLETE_BUSINESS_STATUSES = /* @__PURE__ */ new Set(["partial", "blocked", "failed"]);
    if (process.argv[1] && path13.basename(process.argv[1]).toLowerCase() === "_child-task-contract.mjs" && process.argv.includes("--self-test")) {
      const selfTestModule = "./_child-task-contract.selftest.mjs";
      import(selfTestModule).then((module) => {
        module.selfTest();
        console.log("CONTRACT_SELF_TEST_OK");
      }).catch((error) => {
        console.error(`CONTRACT_SELF_TEST_FAIL: ${error?.message ?? error}`);
        process.exitCode = 1;
      });
    }
  }
});

// ops/tools/run-pi-task.selftest.mjs
var run_pi_task_selftest_exports = {};
__export(run_pi_task_selftest_exports, {
  PI_STUB_DEFAULT_FINAL_TEXT: () => PI_STUB_DEFAULT_FINAL_TEXT,
  renderPiStubSource: () => renderPiStubSource,
  runSelfTest: () => runSelfTest
});
import { spawn as spawn3 } from "node:child_process";
import { existsSync as existsSync12, mkdtempSync, readFileSync as readFileSync10, rmSync as rmSync3, writeFileSync as writeFileSync8 } from "node:fs";
import { tmpdir } from "node:os";
import path14 from "node:path";
function renderPiStubSource({ finalText = PI_STUB_DEFAULT_FINAL_TEXT } = {}) {
  return [
    "import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    `const finalText = ${JSON.stringify(finalText)};`,
    "const argv = process.argv.slice(2);",
    "const mode = (process.env.PI_STUB_MODE || 'ok').split('-').join('_');",
    "function flagValue(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }",
    "const provider = flagValue('--provider') || 'stub-provider';",
    "const modelId = flagValue('--model') || 'stub-model';",
    "const thinking = flagValue('--thinking') || 'medium';",
    "const sessionDir = flagValue('--session-dir');",
    "const sessionFile = flagValue('--session') || (sessionDir ? path.join(sessionDir, 'stub-session.jsonl') : undefined);",
    "if (process.env.PI_STUB_ARGV_OUT) { writeFileSync(process.env.PI_STUB_ARGV_OUT, JSON.stringify(argv, null, 2), 'utf8'); writeFileSync(process.env.PI_STUB_ARGV_OUT + '.recovery.json', JSON.stringify({ stallTimeoutMs: process.env.PI_RETRY_STALL_TIMEOUT_MS })); }",
    "if (process.env.PI_STUB_WORKER_ENV_OUT) writeFileSync(process.env.PI_STUB_WORKER_ENV_OUT, JSON.stringify({ path: process.env.PI_WORKER_TOOLS_PATH, inherit: process.env.PI_WORKER_INHERIT_TOOLS, identity: process.env.PI_WORKER_TASK_PACKAGE_PATH }));",
    "if (sessionDir) { mkdirSync(sessionDir, { recursive: true }); appendFileSync(sessionFile, JSON.stringify({ role: 'stub', at: Date.now() }) + '\\n', 'utf8'); }",
    "if (process.env.PI_WRITE_DOMAIN) { const spec = JSON.parse(process.env.PI_WRITE_DOMAIN); mkdirSync(path.dirname(spec.log), { recursive: true }); appendFileSync(spec.log, JSON.stringify({ schema_version: 1, kind: 'guard_ready', profile: 'pi-child-write-domain/v1', at: new Date().toISOString(), task_id: spec.taskId || null }) + '\\n', 'utf8'); }",
    // boot_crash:收到第一条命令就退出,runner 的握手 get_state 永远等不到响应。
    "if (mode === 'boot_crash') {",
    "  process.stdin.on('data', () => process.exit(9));",
    "  process.stdin.resume();",
    "  setInterval(() => {}, 1 << 30);",
    "} else {",
    "const mismatch = mode === 'identity_mismatch' || mode === 'catalog_miss_mismatch';",
    "const thinkingClamp = mode === 'thinking_clamp';",
    "const dirty = mode === 'dirty_ok' || mode === 'dirty_provider_error';",
    // turn_timeout 与 no_settle 是同一行为的两个调用方命名:停在 agent_settled 之前。
    "const noSettle = ['turn_timeout', 'no_settle', 'cancel_bash', 'cancel_ignore_eof'].includes(mode);",
    "const stopReason = mode === 'dirty_provider_error' ? 'error' : mode === 'aborted' ? 'aborted' : 'stop';",
    "const compactionMode = mode === 'compaction_midrun' || mode === 'compaction_no_resume';",
    "let streaming = false;",
    "let compacting = false;",
    "let promptCount = 0;",
    "let lastPrompt = '';",
    "let stateProbes = 0;",
    "let currentModel = mismatch ? { id: 'other-model', provider: 'other-provider' } : { id: modelId, provider };",
    "let currentThinking = mismatch ? 'off' : thinkingClamp ? 'high' : thinking;",
    "function modelEntry(p, id) { return { id, provider: p, name: id, api: 'stub-api', reasoning: true, contextWindow: 200000, maxTokens: 64000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }; }",
    "const catalog = mode.startsWith('catalog_miss') ? [modelEntry('other-provider', 'other-model')] : [modelEntry(provider, modelId), modelEntry('other-provider', 'other-model')];",
    "const usage = { input: 123, output: 45, cacheRead: 6, cacheWrite: 7, reasoning: 3, totalTokens: 181, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };",
    "function out(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }",
    "function raw(line) { process.stdout.write(line + '\\n'); }",
    "function ok(id, command, data) { const msg = { id, type: 'response', command, success: true }; if (data !== undefined) { msg.data = data; } out(msg); }",
    "function state() { return { model: currentModel, thinkingLevel: currentThinking, isStreaming: streaming, isCompacting: compacting, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', sessionId: 'stub-session-id', sessionFile, autoCompactionEnabled: true, autoRetryEnabled: true, messageCount: 0, pendingMessageCount: 0 }; }",
    "function persistSetting(section, enabled) {",
    "  if (!process.env.PI_STUB_SETTINGS_PATH) { return; }",
    "  const settings = JSON.parse(readFileSync(process.env.PI_STUB_SETTINGS_PATH, 'utf8'));",
    "  settings[section] = { ...(settings[section] || {}), enabled };",
    "  writeFileSync(process.env.PI_STUB_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\\n', 'utf8');",
    "}",
    "function assistantMessage() { const text = mode === 'assistant_text_rpc_fail' ? '' : mode === 'brief_final' ? '## \u7ED3\u8BBA\\n\u4EFB\u52A1\u72B6\u6001\uFF1Acompleted\\n\\n## \u4E8B\u5B9E\u4E0E\u8BC1\u636E\\n\u5DF2\u901A\u8FC7 submit_task_result \u63D0\u4EA4\u3002' : mode === 'submitted_brief' ? '\u5DF2\u901A\u8FC7 submit_task_result \u4EA4\u4ED8\uFF0C\u62A5\u544A\u89C1 notes/general/report.md\u3002' : mode === 'submitted_failure_words' ? '\u547D\u4EE4\u6267\u884C\u5931\u8D25\uFF0C\u5DF2\u901A\u8FC7 submit_task_result \u4EA4\u5377\u3002' : mode === 'review_submitted_brief' ? '\u5BA1\u67E5\u4EA4\u4ED8\u5B8C\u6210\uFF1Agate pass\uFF0C\u672A\u53D1\u73B0\u95EE\u9898\u3002' : finalText; return { role: 'assistant', content: text ? [{ type: 'text', text }] : [], api: 'stub-api', provider: currentModel.provider, model: currentModel.id, responseModel: currentModel.id + '-2026-08', usage, stopReason, timestamp: Date.now() }; }",
    // 压缩插件 ctx.compact() 先 abort 当前回合:pi 以 stopReason=error + 'This operation was aborted' 收束该回合。
    "function abortedMessage(errorMessage) { return { role: 'assistant', content: [], api: 'stub-api', provider: currentModel.provider, model: currentModel.id, responseModel: currentModel.id + '-2026-08', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: 'error', errorMessage, timestamp: Date.now() }; }",
    "function emitSettled() { streaming = false; out({ type: 'agent_settled' }); }",
    "function emitCompactionCycle(resume) {",
    "  setTimeout(() => { compacting = true; out({ type: 'compaction_start', reason: 'manual' }); }, 40);",
    "  setTimeout(() => { compacting = false; out({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'stub summary', tokensBefore: 180000, estimatedTokensAfter: 2000 } }); }, 90);",
    "  if (resume) { setTimeout(() => { out({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '[pi-midrun-compact/v1] Auto-compaction completed. Continue the interrupted task.' }], timestamp: Date.now() } }); emitRun('normal'); }, 130); }",
    "}",
    // 握手前先吐两条非 JSON 行:真实 pi 在扩展/主题加载期会往 stdout 漏 banner。
    `if (dirty) { raw('pi banner: loading extensions'); raw('{"unterminated": '); }`,
    "function emitRun(kind) {",
    "  streaming = true;",
    "  out({ type: 'agent_start' });",
    "  out({ type: 'turn_start' });",
    "  if (dirty) { raw('<<< stray pi notice >>>'); }",
    "  out({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'stub prompt' }], timestamp: Date.now() } });",
    "  out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'stub prompt' }], timestamp: Date.now() } });",
    "  if (mode === 'cancel_bash') out({ type: 'tool_execution_start', toolCallId: 'tc-cancel', toolName: 'bash', args: { command: 'long-running stub' } });",
    "  const toolCall = (id, toolName, args) => { out({ type: 'tool_execution_start', toolCallId: id, toolName, args }); out({ type: 'tool_execution_end', toolCallId: id, toolName, result: { output: 'ok' }, isError: false }); };",
    "  const echoCalls = (from, count) => { for (let i = from; i < from + count; i += 1) toolCall('tc-echo-' + i, 'bash', { command: 'sleep ' + i }); };",
    "  const sameCalls = (count) => { for (let i = 1; i <= count; i += 1) toolCall('tc-same-' + i, 'bash', { command: 'sleep 5' }); };",
    "  const writeSubmission = () => writeFileSync(process.env.PI_TASK_RESULT_PAYLOAD_PATH, JSON.stringify({ submitted_at: new Date().toISOString(), handoff_check: { checked: false, status: 'not_configured', issues: [] }, scope_validation: { compliant: true, violation_count: 0 }, result: { verdict: process.env.PI_STUB_SUBMIT_VERDICT || 'done' } }), 'utf8');",
    // submitted_brief:像 submit_task_result 扩展一样落交卷记录,最终回复只有一句话。
    "  if (mode === 'submitted_brief' && process.env.PI_TASK_RESULT_PAYLOAD_PATH) { toolCall('tc-submit', 'submit_task_result', { payload_path: 'artifacts/result.json' }); writeSubmission(); }",
    "  if (mode === 'submitted_failure_words' && process.env.PI_TASK_RESULT_PAYLOAD_PATH) { toolCall('tc-submit', 'submit_task_result', { payload_path: 'artifacts/result.json' }); writeSubmission(); if (process.env.PI_STUB_FAILED_TOOL === '1') { out({ type: 'tool_execution_start', toolCallId: 'tc-failed-read', toolName: 'read', args: { path: 'missing.txt' } }); out({ type: 'tool_execution_end', toolCallId: 'tc-failed-read', toolName: 'read', result: { output: 'ENOENT' }, isError: true }); } }",
    // submitted_then_loop:交卷已成功落记录，之后连串空转命令直到熔断。
    "  if (mode === 'submitted_then_loop' && process.env.PI_TASK_RESULT_PAYLOAD_PATH) { toolCall('tc-submit', 'submit_task_result', { payload_path: 'artifacts/result.json' }); writeSubmission(); for (let i = 0; i < 8; i += 1) toolCall('tc-post-submit-' + i, 'bash', { command: 'echo ending-' + i }); return; }",
    // draft_*：从 prompt 里取约定交卷文件路径，像模型用 write 工具那样写交卷文件。
    "  const draftPath = (lastPrompt.match(/`([^`]*task-result-payload\\.json)`/) || [])[1];",
    "  const writeDraft = (verdict) => { mkdirSync(path.dirname(draftPath), { recursive: true }); writeFileSync(draftPath, JSON.stringify({ verdict, summary: 'stub draft', sections: { Evidence: 'stub evidence' }, scope_actual: { read: [], written: [] }, evidence_refs: [] }), 'utf8'); };",
    // draft_then_loop:交卷文件写好后发不出交卷调用，连串空转命令直到熔断。
    "  if (mode === 'draft_then_loop' && draftPath) { writeDraft('done'); for (const word of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) toolCall('tc-draft-noop-' + word, 'bash', { command: 'echo ' + word }); return; }",
    // draft_invalid_then_fix:首轮 verdict 写成聊天词表后正常结束，修正轮改成闭集取值。
    "  if (mode === 'draft_invalid_then_fix' && draftPath) writeDraft(promptCount === 1 ? 'completed' : 'done');",
    "  if (mode === 'draft_written' && draftPath) writeDraft('done');",
    // review_submitted_brief:像 submit_review_result 扩展一样落审查结果,最终回复只有一句话。
    "  if (mode === 'review_submitted_brief' && process.env.PI_REVIEW_RESULT_PATH) { toolCall('tc-review', 'submit_review_result', {}); writeFileSync(process.env.PI_REVIEW_RESULT_PATH, JSON.stringify({ schema_version: 1, gate: 'pass', summary: 'stub review', findings: [], evidence_gaps: [], scope: { reviewed: ['target.py'], not_reviewed: [], actual_reads: ['target.py'] }, output: {} }), 'utf8'); }",
    "  if (mode === 'tool_loop') echoCalls(1, 20);",
    "  if (mode === 'tool_loop_repeat') { for (let i = 1; i <= 20; i += 1) toolCall('tc-poll-' + i, 'read', { path: 'status.json' }); }",
    "  if (mode === 'tool_loop_alternate') { for (let i = 1; i <= 10; i += 1) { toolCall('tc-a-' + i, 'bash', { command: 'git status' }); toolCall('tc-b-' + i, 'read', { path: 'stub.txt' }); } }",
    "  if (mode === 'tool_loop_reset') { sameCalls(19); toolCall('tc-break-1', 'read', { path: 'stub.txt' }); toolCall('tc-break-2', 'read', { path: 'other.txt' }); }",
    // 不在调用后停住：熔断照样由 runner 判定；未熔断的变体（如求值表达式）能正常收尾。
    "  if (mode === 'tool_loop_noop') { for (const word of ['stop', 'final-submit', 'please', 'x1', 'x2', 'x3', 'x4', 'x5']) toolCall('tc-noop-' + word, 'bash', { command: 'echo ' + word }); }",
    "  if (mode === 'tool_loop_ps_read') { for (let i = 1; i <= 8; i += 1) toolCall('tc-ps-' + i, 'powershell', { command: 'Write-Output (Get-Content page-' + i + '.txt)' }); }",
    "  if (mode === 'tool_loop_noop_exit') { for (let i = 0; i < 8; i += 1) toolCall('tc-exit-' + i, 'powershell', { command: 'exit 0' }); return; }",
    "  if (mode === 'tool_loop_noop_short') { for (const word of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) toolCall('tc-noop-' + word, 'bash', { command: 'echo ' + word }); toolCall('tc-real', 'bash', { command: 'git status' }); }",
    "  if (mode === 'tool_loop_numbered_files') { for (let i = 1; i <= 20; i += 1) toolCall('tc-cat-' + i, 'bash', { command: 'cat file' + i + '.txt' }); }",
    "  if (mode === 'tool_loop_read_pages') { for (let i = 0; i < 20; i += 1) toolCall('tc-page-' + i, 'read', { path: 'big.txt', offset: i * 200 + 1, limit: 200 }); }",
    "  if (noSettle) { return; }",
    "  if (mode === 'bash_error') {",
    "    out({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'stub failure' } });",
    "    out({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', result: { output: 'stub bash failed' }, isError: true });",
    "  } else if (mode === 'bash_exit_nonzero') {",
    "    out({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'grep -r nomatch .' } });",
    "    out({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', result: { content: [{ type: 'text', text: '(no output)\\n\\nCommand exited with code 1' }], details: {} }, isError: true });",
    "  } else if (mode === 'write_domain_blocked') {",
    "    const spec = JSON.parse(process.env.PI_WRITE_DOMAIN || '{}');",
    "    const record = { schema_version: 1, kind: 'tool_call', profile: 'pi-child-write-domain/v1', at: new Date().toISOString(), task_id: spec.taskId || null, tool_call_id: 'tc-write', tool: 'write', raw_path: 'README.md', resolved_path: path.join(process.cwd(), 'README.md'), allowed: false, matched: null };",
    "    appendFileSync(spec.log, JSON.stringify(record) + '\\n', 'utf8');",
    "    out({ type: 'tool_execution_start', toolCallId: 'tc-write', toolName: 'write', args: { path: 'README.md', content: 'blocked' } });",
    "    out({ type: 'tool_execution_end', toolCallId: 'tc-write', toolName: 'write', result: { output: 'write domain violation' }, isError: true });",
    "  } else {",
    "    out({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'read', args: { path: 'stub.txt' } });",
    "    out({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'read', result: { output: 'stub' }, isError: false });",
    "  }",
    "  if (kind === 'abort_error' || kind === 'error_empty') {",
    "    const message = abortedMessage(kind === 'abort_error' ? 'This operation was aborted' : 'stub provider error');",
    "    out({ type: 'message_start', message: { role: 'assistant', content: [], api: 'stub-api', provider: currentModel.provider, model: currentModel.id, usage, stopReason: 'pending', timestamp: Date.now() } });",
    "    out({ type: 'message_end', message });",
    "    out({ type: 'turn_end', message, toolResults: [] });",
    "    out({ type: 'agent_end', messages: [message], willRetry: false });",
    "    emitSettled();",
    "    if (kind === 'abort_error') { emitCompactionCycle(mode === 'compaction_midrun'); }",
    "    return;",
    "  }",
    "  out({ type: 'message_start', message: { role: 'assistant', content: [], api: 'stub-api', provider: currentModel.provider, model: currentModel.id, usage, stopReason: 'pending', timestamp: Date.now() } });",
    "  out({ type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'text_delta', delta: 'stub' }, usage });",
    "  out({ type: 'message_end', message: assistantMessage() });",
    "  out({ type: 'turn_end', message: assistantMessage(), toolResults: [] });",
    "  out({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });",
    "  emitSettled();",
    "}",
    "function handle(cmd) {",
    "  const id = cmd.id;",
    "  if (process.env.PI_STUB_COMMANDS_OUT) { appendFileSync(process.env.PI_STUB_COMMANDS_OUT, cmd.type + '\\n', 'utf8'); }",
    "  switch (cmd.type) {",
    "    case 'get_state': {",
    "      if (promptCount === 0) return ok(id, 'get_state', state());",
    "      stateProbes += 1;",
    // 回合后的 get_state 探测:三个竞态/失败场景(sol 审查 F2/F3/F4 的回归)。
    "      if (mode === 'state_probe_fail') return out({ id, type: 'response', command: 'get_state', success: false, error: 'post-settle state failed' });",
    // 将新活动放在探测回复前；反序会把回复后的活动误当作窗口内活动，结果依赖 stdout 分块。
    "      if (mode === 'idle_then_restart' && stateProbes === 1) { emitRun('normal'); return ok(id, 'get_state', state()); }",
    "      if (mode === 'compacting_state_then_end' && stateProbes === 1) { ok(id, 'get_state', { ...state(), isCompacting: true }); out({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'stub', tokensBefore: 10, estimatedTokensAfter: 1 } }); return undefined; }",
    "      return ok(id, 'get_state', state());",
    "    }",
    "    case 'get_available_models': return ok(id, 'get_available_models', { models: catalog });",
    "    case 'get_available_thinking_levels': return ok(id, 'get_available_thinking_levels', { levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] });",
    "    case 'set_auto_compaction': persistSetting('compaction', cmd.enabled); return ok(id, 'set_auto_compaction');",
    "    case 'set_auto_retry': persistSetting('retry', cmd.enabled); return ok(id, 'set_auto_retry');",
    "    case 'set_model': {",
    "      const found = catalog.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);",
    "      if (!found) { return out({ id, type: 'response', command: 'set_model', success: false, error: 'Model not found: ' + cmd.provider + '/' + cmd.modelId }); }",
    // identity_mismatch:set_model 报 success 但状态纹丝不动,回读仍是 other-provider/other-model。
    "      if (!mismatch) { currentModel = { id: found.id, provider: found.provider }; }",
    "      return ok(id, 'set_model', found);",
    "    }",
    // thinking_clamp:set_thinking_level 报 success 但被 pi 按模型能力夹回 high。
    "    case 'set_thinking_level': { if (!mismatch && !thinkingClamp) { currentThinking = cmd.level; } return ok(id, 'set_thinking_level'); }",
    "    case 'prompt': {",
    "      ok(id, 'prompt');",
    "      if (mode === 'crash') { setTimeout(() => process.exit(7), 30); return undefined; }",
    "      promptCount += 1;",
    "      lastPrompt = String(cmd.message || '');",
    "      const kind = compactionMode && promptCount === 1 ? 'abort_error' : mode === 'error_then_idle' && promptCount === 1 ? 'error_empty' : 'normal';",
    "      setTimeout(() => emitRun(kind), 20);",
    "      return undefined;",
    "    }",
    // 首活动超时后才发活动；不提供 usage，验证不能依赖 token 阻止重放。
    "    case 'abort': { if (mode.startsWith('fallback_')) { if (mode === 'fallback_abort_assistant') { out({ type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'text_delta', delta: 'late-before-abort-ack' } }); setTimeout(() => { ok(id, 'abort'); setTimeout(emitSettled, 10); }, 20); return undefined; } ok(id, 'abort'); setTimeout(() => { if (mode === 'fallback_assistant') out({ type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'text_delta', delta: 'late' } }); if (mode === 'fallback_tool') out({ type: 'tool_execution_start', toolCallId: 'late-tool', toolName: 'read', args: { path: 'stub.txt' } }); emitSettled(); }, 10); return undefined; } ok(id, 'abort'); if (streaming) setTimeout(() => { if (mode === 'cancel_bash') { if (process.env.PI_STUB_BASH_CLEANUP_PATH) appendFileSync(process.env.PI_STUB_BASH_CLEANUP_PATH, JSON.stringify({ tool_call_id: 'tc-cancel', confirmed: true, observed: true, tracked_pids: [] }) + '\\n', 'utf8'); out({ type: 'tool_execution_end', toolCallId: 'tc-cancel', toolName: 'bash', result: { output: 'aborted' }, isError: true }); } const message = abortedMessage('This operation was aborted'); out({ type: 'message_end', message }); out({ type: 'turn_end', message, toolResults: [] }); out({ type: 'agent_end', messages: [message], willRetry: false }); emitSettled(); }, 10); return undefined; }",
    "    case 'switch_session': return ok(id, 'switch_session', { cancelled: false });",
    "    case 'get_last_assistant_text': {",
    "      if (mode === 'assistant_text_rpc_fail') return out({ id, type: 'response', command: 'get_last_assistant_text', success: false, error: 'stub rpc fail' });",
    "      if ((mode === 'error_then_idle' || mode === 'compaction_no_resume') && promptCount === 1) return ok(id, 'get_last_assistant_text', { text: '' });",
    "      return ok(id, 'get_last_assistant_text', { text: finalText });",
    "    }",
    "    case 'get_session_stats': { const send = () => ok(id, 'get_session_stats', { sessionId: 'stub-session-id', userMessages: 1, assistantMessages: 1, toolCalls: 1, toolResults: 1, totalMessages: 2, tokens: { input: 123, output: 45, cacheRead: 6, cacheWrite: 7, total: 181 }, cost: 0.3, contextUsage: { tokens: 181, contextWindow: 200000, percent: 0.09 } }); if (mode === 'late_cancel') setTimeout(send, Number(process.env.PI_STUB_STATS_DELAY_MS || 250)); else send(); return undefined; }",
    "    default: return out({ id, type: 'response', command: cmd.type, success: false, error: 'unsupported stub command' });",
    "  }",
    "}",
    "let buf = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  buf += chunk;",
    "  let i;",
    "  while ((i = buf.indexOf('\\n')) >= 0) {",
    "    const line = buf.slice(0, i).replace(/\\r$/, '');",
    "    buf = buf.slice(i + 1);",
    "    if (!line.trim()) { continue; }",
    "    try { handle(JSON.parse(line)); } catch (e) { out({ type: 'response', command: 'parse', success: false, error: String(e && e.message ? e.message : e) }); }",
    "  }",
    "});",
    "process.stdin.on('end', () => { if (mode === 'fallback_shutdown' || mode === 'fallback_shutdown_tool') { out({ type: 'agent_start' }); if (mode === 'fallback_shutdown') out({ type: 'message_end', message: assistantMessage() }); else out({ type: 'tool_execution_start', toolCallId: 'late-tool', toolName: 'read', args: { path: 'stub.txt' } }); setTimeout(() => process.exit(0), 20); return; } if (mode !== 'cancel_ignore_eof') process.exit(0); });",
    "setInterval(() => {}, 1 << 30);",
    "}"
  ].join("\n");
}
function selfTestCheck(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
function runRunnerForSelfTest(scriptPathForSelf, runnerArgs, env) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.PI_WRITE_DOMAIN;
  return new Promise((resolve) => {
    const child = spawn3(process.execPath, [scriptPathForSelf, ...runnerArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: childEnv
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
async function runSelfTest(scriptPathForSelf) {
  const root = mkdtempSync(path14.join(tmpdir(), "pi-runner-selftest-"));
  try {
    const stubPath = path14.join(root, "pi-stub.mjs");
    writeFileSync8(stubPath, renderPiStubSource(), "utf8");
    const targetCwd2 = path14.join(root, "target");
    ensureDir(targetCwd2);
    const taskPath = path14.join(root, "task.md");
    ensureDir(path14.join(targetCwd2, "ops", "agents"));
    writeFileSync8(path14.join(targetCwd2, "ops", "agents", "fixture-agent.toml"), [
      'name = "fixture-agent"',
      "[[picks]]",
      'id = "stub"',
      'model = "stub-provider/stub-model"',
      'effort = "low"',
      'effort_min = "low"',
      'effort_max = "medium"',
      "default = true",
      ""
    ].join("\n"), "utf8");
    writeFileSync8(path14.join(targetCwd2, "ops", "model-notes.toml"), 'version = 1\n[notes."stub-provider/stub-model"]\nefforts = ["low", "medium"]\n', "utf8");
    ensureDir(path14.join(targetCwd2, "ops", "templates"));
    writeFileSync8(path14.join(targetCwd2, "ops", "templates", "worker-system-prompt.md"), "Self-test protocol fixture; no production task execution.\n", "utf8");
    writeFileSync8(path14.join(targetCwd2, "ops", "templates", "handoff-prompt-template.md"), "Protocol fixture prompt. {{RESULT_SUBMISSION}}\n", "utf8");
    writeFileSync8(path14.join(targetCwd2, "ops", "templates", "worker-resources.json"), JSON.stringify({
      version: 2,
      tools: {
        read: { access: "optional" },
        bash: { access: "optional" },
        grep: { access: "default_on" },
        command_job: { access: "default_on" },
        dispatch_prepare: { access: "off" }
      },
      extensions: {},
      skills: {},
      required_tools: ["submit_task_result", "submit_review_result"]
    }), "utf8");
    const fixtureTask = { task_package: { package_id: "fixture-selftest", agent: { role: "fixture-agent" }, expected_output: { mode: "none" } } };
    writeFileSync8(taskPath, "\u8F93\u51FA PI_STUB_OK \u5E76\u6309\u6807\u9898\u5408\u540C\u5199\u7ED3\u8BBA\u3002", "utf8");
    const taskPackagePath = path14.join(root, "task-package.json");
    writeFileSync8(taskPackagePath, JSON.stringify(fixtureTask), "utf8");
    const scenario = async (name, {
      mode,
      extraArgs = [],
      turnTimeoutMs: turnTimeoutMs2 = null,
      commandsOut: commandsOut2 = null,
      cancelRequest = null,
      statsDelayMs = 250
    }) => {
      const outDir2 = path14.join(root, `out-${name}`);
      const argvOut = path14.join(root, `argv-${name}.json`);
      const runnerArgs = [
        "--contextMode",
        "isolated",
        "--targetCwd",
        targetCwd2,
        // Role/model-note fixtures belong to this run, not the production asset root.
        "--runtimeRoot",
        targetCwd2,
        "--childCwd",
        path14.join(root, `child-${name}`),
        "--taskFile",
        taskPath,
        "--taskPackageFile",
        taskPackagePath,
        "--model",
        "stub-provider/stub-model",
        "--effort",
        "low",
        "--outDir",
        outDir2,
        "--artifactsDir",
        path14.join(outDir2, "artifacts"),
        "--controlHome",
        path14.join(root, "control-home"),
        ...turnTimeoutMs2 ? ["--turnTimeoutMs", String(turnTimeoutMs2)] : [],
        ...extraArgs
      ];
      let cancelTimer = null;
      let cancelEligibleAt = null;
      if (cancelRequest) {
        cancelTimer = setInterval(() => {
          const eventsPath = path14.join(outDir2, "child-task-events.jsonl");
          if (cancelRequest.whenCommand) {
            if (!commandsOut2 || !existsSync12(commandsOut2) || !readFileSync10(commandsOut2, "utf8").includes(cancelRequest.whenCommand)) return;
          } else if (!existsSync12(eventsPath) || !readFileSync10(eventsPath, "utf8").includes('"turn_start"')) return;
          if (cancelEligibleAt === null) cancelEligibleAt = Date.now() + Math.max(0, Number(cancelRequest.delayMs) || 0);
          if (Date.now() < cancelEligibleAt) return;
          writeFileSync8(cancelRequest.path, `${JSON.stringify({
            type: "abort",
            attempt_id: cancelRequest.attemptId,
            reason: cancelRequest.reason,
            requested_at: (/* @__PURE__ */ new Date()).toISOString()
          })}
`, "utf8");
          clearInterval(cancelTimer);
        }, 25);
        cancelTimer.unref();
      }
      const run = await runRunnerForSelfTest(scriptPathForSelf, runnerArgs, {
        PI_CONTROL_PI: stubPath,
        SUBAGENT_CONTROL_REPO_ROOT: targetCwd2,
        PI_STUB_MODE: mode,
        PI_STUB_STATS_DELAY_MS: String(statsDelayMs),
        PI_STUB_ARGV_OUT: argvOut,
        ...cancelRequest ? { PI_STUB_BASH_CLEANUP_PATH: path14.join(outDir2, `bash-tree-cleanup.${cancelRequest.attemptId}.jsonl`) } : {},
        ...commandsOut2 ? { PI_STUB_COMMANDS_OUT: commandsOut2 } : {}
      });
      if (cancelTimer !== null) clearInterval(cancelTimer);
      const resultPath2 = path14.join(outDir2, "child-task-result.json");
      selfTestCheck(existsSync12(resultPath2), `${name}: child-task-result.json \u672A\u4EA7\u51FA (stderr: ${run.stderr.slice(0, 400)})`);
      const parsed = JSON.parse(readFileSync10(resultPath2, "utf8"));
      return { name, run, outDir: outDir2, argvOut, result: parsed };
    };
    const okCase = await scenario("ok", { mode: "ok" });
    const okResult = okCase.result;
    selfTestCheck(okCase.run.code === 0, `ok: runner \u9000\u51FA\u7801\u5E94\u4E3A 0,\u5B9E\u5F97 ${okCase.run.code}; failure_type=${okResult.failure_type}; error=${okResult.error || ""}; stderr=${okCase.run.stderr.slice(0, 400)}`);
    selfTestCheck(okResult.ok === true, `ok: result.ok \u5E94\u4E3A true,\u5B9E\u5F97 ${okResult.ok}`);
    selfTestCheck(okResult.session?.resumable === false, "ok: \u6210\u529F\u4EFB\u52A1\u4E0D\u5E94 resumable");
    selfTestCheck(okResult.status === "completed", `ok: status \u5E94\u4E3A completed,\u5B9E\u5F97 ${okResult.status}`);
    selfTestCheck(okResult.failure_type === "none", `ok: failure_type \u5E94\u4E3A none,\u5B9E\u5F97 ${okResult.failure_type}`);
    selfTestCheck(okResult.backend === BACKEND && okResult.runner === RUNNER_NAME, "ok: backend/runner \u6807\u8BC6\u9519\u8BEF");
    selfTestCheck(okResult.orchestration.ok === true && okResult.orchestration.status === "completed", "ok: orchestration \u6BB5\u9519\u8BEF");
    selfTestCheck(okResult.task.ok === true, "ok: task \u6BB5\u9519\u8BEF");
    selfTestCheck(okResult.required_headings.ok === true, "ok: \u516D\u6BB5\u6807\u9898\u5224\u5B9A\u9519\u8BEF");
    selfTestCheck(okResult.selection.appliedModel === "stub-model", `ok: appliedModel \u9519\u8BEF ${okResult.selection.appliedModel}`);
    selfTestCheck(okResult.selection.appliedProvider === "stub-provider", `ok: appliedProvider \u9519\u8BEF ${okResult.selection.appliedProvider}`);
    selfTestCheck(okResult.selection.appliedEffort === "low", `ok: appliedEffort \u9519\u8BEF ${okResult.selection.appliedEffort}`);
    selfTestCheck(okResult.selection.validated === true, "ok: selection.validated \u5E94\u4E3A true");
    selfTestCheck(okResult.identity.verified === true, "ok: identity.verified \u5E94\u4E3A true");
    selfTestCheck(okResult.identity.applied?.model === "stub-model", "ok: identity \u5FEB\u7167\u6A21\u578B\u9519\u8BEF");
    selfTestCheck(Array.isArray(okResult.turns) && okResult.turns.length >= 1, "ok: turns[] \u7F3A\u5931");
    selfTestCheck(okResult.turns[0].model === "stub-model", `ok: turns[0].model \u9519\u8BEF ${okResult.turns[0].model}`);
    selfTestCheck(okResult.turns[0].provider === "stub-provider", "ok: turns[0].provider \u9519\u8BEF");
    selfTestCheck(okResult.permission.tool_allowlist === null, "ok: \u7F3A\u7701\u4EFB\u52A1\u4E0D\u5E94\u88C1\u526A\u5DE5\u5177");
    selfTestCheck(okResult.runtime?.exitCode === 0, `ok: pi \u9000\u51FA\u7801\u5E94\u4E3A 0,\u5B9E\u5F97 ${okResult.runtime?.exitCode}`);
    const finalDoc = readFileSync10(path14.join(okCase.outDir, "child-final.md"), "utf8");
    selfTestCheck(finalDoc.includes("## \u7ED3\u8BBA") && finalDoc.includes("## \u8FB9\u754C"), "ok: child-final.md \u516D\u6BB5\u7F3A\u5931");
    const liveSnapshot = JSON.parse(readFileSync10(path14.join(okCase.outDir, "child-task-live.json"), "utf8"));
    selfTestCheck(liveSnapshot.phase === "finished" && liveSnapshot.status === "completed", "ok: live \u7EC8\u6001\u9519\u8BEF");
    selfTestCheck(liveSnapshot.backend === BACKEND, "ok: live.backend \u9519\u8BEF");
    selfTestCheck(
      existsSync12(path14.join(okCase.outDir, "pi-session", "stub-session.jsonl")),
      "ok: --session-dir \u672A\u751F\u6548,pi-session \u4E0B\u6CA1\u6709\u4F1A\u8BDD jsonl"
    );
    selfTestCheck(existsSync12(path14.join(okCase.outDir, "child-handoff.md")), "ok: child-handoff.md \u672A\u4EA7\u51FA");
    const identityDoc = JSON.parse(readFileSync10(path14.join(okCase.outDir, "child-task-identity.json"), "utf8"));
    selfTestCheck(identityDoc.turn_receipts.length >= 1, "ok: \u8EAB\u4EFD\u5FEB\u7167\u7F3A\u5C11\u9010\u8F6E\u56DE\u6267");
    selfTestCheck(identityDoc.available_models.matched === true, "ok: \u8EAB\u4EFD\u5FEB\u7167\u6A21\u578B\u76EE\u5F55\u547D\u4E2D\u6807\u8BB0\u9519\u8BEF");
    const stubArgv = JSON.parse(readFileSync10(okCase.argvOut, "utf8"));
    const workerPromptFlagIndex = stubArgv.indexOf("--append-system-prompt");
    const workerPromptPath = stubArgv[workerPromptFlagIndex + 1];
    const workerPromptBase = readFileSync10(path14.join(targetCwd2, "ops", "templates", "worker-system-prompt.md"), "utf8").trimEnd();
    selfTestCheck(
      workerPromptFlagIndex >= 0 && path14.resolve(workerPromptPath) === path14.resolve(okCase.outDir, "worker-system.md") && readFileSync10(workerPromptPath, "utf8").startsWith(workerPromptBase),
      `ok: worker system \u8FFD\u52A0\u5C42\u5E94\u4E3A\u4EFB\u52A1\u76EE\u5F55\u7684 worker-system.md \u4E14\u4EE5\u901A\u7528\u89C4\u5219\u5F00\u5934 ${workerPromptPath}`
    );
    selfTestCheck(okResult.context?.globalAppendSystemSuppressed === true, "ok: child \u672A\u56DE\u663E\u5168\u5C40 APPEND \u6291\u5236\u72B6\u6001");
    selfTestCheck(!stubArgv.includes("-t") && !stubArgv.includes("--no-tools"), "ok: \u7F3A\u7701\u4EFB\u52A1\u4E0D\u5E94\u4F20\u5DE5\u5177\u767D\u540D\u5355");
    selfTestCheck(okResult.selection?.effort_check?.source === "model_notes", "ok: \u65E0\u51BB\u7ED3\u9009\u578B\u65F6\u6309\u6A21\u578B\u6863\u4F4D\u6821\u9A8C effort");
    const outsideModel = await scenario("effort-outside-model", { mode: "ok", extraArgs: ["--effort", "high"] });
    selfTestCheck(outsideModel.result.failure_type === "invalid_model_effort", `effort_outside_model: \u5B9E\u5F97 ${outsideModel.result.failure_type}`);
    const frozen = (applied) => {
      const file = path14.join(root, `selection-${applied.length}.json`);
      writeFileSync8(file, JSON.stringify({
        requested: { pick: "stub", model: null, effort: "low" },
        role: "fixture-agent",
        capability: "fixture",
        pick: "stub",
        config_source: {},
        resolved_model: "stub-provider/stub-model",
        resolved_effort: "low",
        effort_source: "explicit",
        efforts: ["low", "medium"],
        effort_range: ["medium", "medium"],
        authorization: applied.length ? { quote: "\u81EA\u6D4B", requested_overrides: applied, applied_overrides: applied.map((kind) => ({ kind, previous_value: ["medium", "medium"] })) } : null
      }), "utf8");
      return file;
    };
    const frozenDenied = await scenario("frozen-range-denied", { mode: "ok", extraArgs: ["--selectionFile", frozen([])] });
    selfTestCheck(frozenDenied.result.failure_type === "invalid_model_effort", `frozen_range_denied: \u5B9E\u5F97 ${frozenDenied.result.failure_type}`);
    const frozenGranted = await scenario("frozen-range-granted", { mode: "ok", extraArgs: ["--selectionFile", frozen(["effort_range"])] });
    selfTestCheck(
      frozenGranted.result.ok === true && frozenGranted.result.selection?.effort_check?.source === "frozen_selection",
      `frozen_range_granted: \u5B9E\u5F97 ${frozenGranted.result.failure_type}`
    );
    const toolTask = (allowed) => {
      const file = path14.join(root, `task-package-tools-${allowed.length}.json`);
      writeFileSync8(file, JSON.stringify({ task_package: { ...fixtureTask.task_package, tool_contract: { allowed } } }), "utf8");
      return file;
    };
    const surfaced = await scenario("tool-surface", { mode: "ok", extraArgs: ["--taskPackageFile", toolTask(["read", "bash", "dispatch_prepare", "web_search"])] });
    const surfacedArgv = JSON.parse(readFileSync10(surfaced.argvOut, "utf8"));
    selfTestCheck(surfacedArgv[surfacedArgv.indexOf("-t") + 1] === "read,bash", `tool_surface: -t \u5B9E\u5F97 ${surfacedArgv[surfacedArgv.indexOf("-t") + 1]}`);
    selfTestCheck(surfacedArgv[surfacedArgv.indexOf("-xt") + 1] === "dispatch_prepare", "tool_surface: off \u5DE5\u5177\u5E94\u8FDB -xt");
    selfTestCheck(
      ["dispatch_prepare", "web_search"].every((name) => surfaced.result.warnings.some((item) => String(item).includes(`\u4EFB\u52A1\u5DE5\u5177 ${name}`))),
      "tool_surface: \u4E0D\u5F00\u653E\u6216\u672A\u8BB0\u5F55\u7684\u767D\u540D\u5355\u5DE5\u5177\u5E94\u544A\u8B66"
    );
    const closed = await scenario("tool-surface-closed", { mode: "ok", extraArgs: ["--taskPackageFile", toolTask([])] });
    const closedArgv = JSON.parse(readFileSync10(closed.argvOut, "utf8"));
    selfTestCheck(closedArgv.includes("--no-tools") && !closedArgv.includes("-t"), "tool_surface_closed: \u7A7A\u5DE5\u5177\u9762\u4FDD\u6301\u5C01\u95ED");
    const briefCommands = path14.join(root, "commands-brief-final.txt");
    const briefFinal = await scenario("brief-final", { mode: "brief_final", commandsOut: briefCommands });
    selfTestCheck(briefFinal.run.code === 0 && briefFinal.result.ok === true, `brief_final: \u5E94\u6309\u5B8C\u6210\u9000\u51FA,\u5B9E\u5F97 code=${briefFinal.run.code} ok=${briefFinal.result.ok}`);
    selfTestCheck(briefFinal.result.status === "completed" && briefFinal.result.failure_type === "none", `brief_final: \u9876\u5C42\u7EC8\u6001\u9519\u8BEF ${briefFinal.result.status}/${briefFinal.result.failure_type}`);
    selfTestCheck(briefFinal.result.orchestration?.ok === true && briefFinal.result.task?.ok === true, "brief_final: \u8FD0\u8F93\u4E0E\u4E1A\u52A1\u6295\u5F71\u90FD\u5E94\u5B8C\u6210");
    selfTestCheck(briefFinal.result.session?.resumable === false, "brief_final: \u5DF2\u5B8C\u6210\u4EFB\u52A1\u4E0D\u5E94\u663E\u793A resumable");
    const writeDomainSpec2 = path14.join(root, "write-domain.json");
    writeFileSync8(writeDomainSpec2, `${JSON.stringify({
      contract_version: "pi-child-write-domain/v1",
      task_id: "runner-self-test",
      paths: [path14.join(targetCwd2, "allowed.txt")],
      delete_paths: [],
      case_insensitive: process.platform === "win32"
    })}
`, "utf8");
    const guarded = await scenario("write-domain", {
      mode: "ok",
      extraArgs: ["--writeDomainSpec", writeDomainSpec2]
    });
    selfTestCheck(guarded.result.ok === true, `write_domain: \u5E94\u5B8C\u6210,\u5B9E\u5F97 ${guarded.result.failure_type}`);
    selfTestCheck(guarded.result.write_domain?.enabled === true, "write_domain: write/edit \u5DE5\u5177\u5B58\u5728\u65F6\u5E94\u542F\u7528\u5B88\u95E8");
    selfTestCheck(guarded.result.write_domain?.audit_complete === true && guarded.result.write_domain?.scope_compliant === true, "write_domain: \u96F6\u5199\u8C03\u7528\u5BA1\u8BA1\u5E94\u5B8C\u6574\u5408\u89C4");
    const loadedWriteDomainExtension = guarded.result.selection?.extensions?.find((item) => /pi_write_domain_extension(?:\.bundle)?\.mjs$/.test(item));
    selfTestCheck(Boolean(loadedWriteDomainExtension) && existsSync12(loadedWriteDomainExtension), "write_domain: \u540C\u76EE\u5F55\u72EC\u7ACB\u6269\u5C55\u7F3A\u5931");
    const guardedArgv = JSON.parse(readFileSync10(guarded.argvOut, "utf8"));
    selfTestCheck(guardedArgv.includes(loadedWriteDomainExtension), "write_domain: \u72EC\u7ACB\u6269\u5C55\u672A\u4F20\u7ED9 pi -e");
    const blockedWrite = await scenario("write-domain-blocked", {
      mode: "write_domain_blocked",
      extraArgs: ["--writeDomainSpec", writeDomainSpec2]
    });
    selfTestCheck(blockedWrite.result.ok === true && blockedWrite.run.code === 0, "write_domain_blocked: \u8DEF\u5F84\u62D2\u7EDD\u662F\u5BA1\u8BA1\u4E8B\u5B9E,\u4E0D\u5E94\u4F2A\u88C5\u6210\u8FD0\u8F93\u5931\u8D25");
    selfTestCheck(blockedWrite.result.write_domain?.scope_compliant === false, "write_domain_blocked: scope_compliant \u5E94\u4E3A false");
    selfTestCheck(blockedWrite.result.write_domain?.violations?.[0]?.raw_path === "README.md", "write_domain_blocked: \u56DE\u6267\u5E94\u70B9\u540D\u8D8A\u754C\u8DEF\u5F84");
    const invalidWriteDomain = await scenario("invalid-write-domain", {
      mode: "ok",
      extraArgs: ["--writeDomainSpec", path14.join(root, "missing-write-domain.json")]
    });
    selfTestCheck(invalidWriteDomain.result.ok === false && invalidWriteDomain.result.failure_type === "invalid_write_domain", `invalid_write_domain: \u5B9E\u5F97 ${invalidWriteDomain.result.failure_type}`);
    const wrongWriteDomainSpec = path14.join(root, "wrong-write-domain.json");
    writeFileSync8(wrongWriteDomainSpec, `${JSON.stringify({
      contract_version: "async-write-claim/v1",
      task_id: "runner-self-test",
      paths: [path14.join(targetCwd2, "allowed.txt")],
      delete_paths: [],
      case_insensitive: process.platform === "win32"
    })}
`, "utf8");
    const wrongWriteDomain = await scenario("wrong-write-domain-contract", {
      mode: "ok",
      extraArgs: ["--writeDomainSpec", wrongWriteDomainSpec]
    });
    selfTestCheck(wrongWriteDomain.result.failure_type === "invalid_write_domain" && wrongWriteDomain.result.error.includes("contract_version"), "invalid_write_domain: \u65E7 claim \u7248\u672C\u4E0D\u5F97\u5192\u5145 direct write domain \u7248\u672C");
    const catalogMiss = await scenario("catalog-miss", { mode: "catalog_miss" });
    selfTestCheck(catalogMiss.result.ok === true && catalogMiss.run.code === 0, "catalog_miss: \u8EAB\u4EFD\u901A\u8FC7\u540E\u5E94\u7EE7\u7EED");
    selfTestCheck(catalogMiss.result.identity.verified === true && catalogMiss.result.selection.validated === false, "catalog_miss: \u4E0D\u5F97\u628A\u76EE\u5F55 miss \u6807\u4E3A\u547D\u4E2D");
    selfTestCheck(catalogMiss.result.warnings.length > 0, "catalog_miss: \u5E94\u8BB0\u5F55\u8BCA\u65AD");
    const catalogMismatch = await scenario("catalog-miss-mismatch", { mode: "catalog_miss_mismatch" });
    selfTestCheck(catalogMismatch.result.failure_type === "identity_mismatch" && catalogMismatch.run.code === 1, "catalog_miss: \u8EAB\u4EFD\u4E0D\u7B26\u4ECD\u62D2\u7EDD");
    const mismatch = await scenario("identity-mismatch", { mode: "identity_mismatch" });
    selfTestCheck(mismatch.result.failure_type === "identity_mismatch", `identity_mismatch: failure_type \u5B9E\u5F97 ${mismatch.result.failure_type}`);
    selfTestCheck(mismatch.result.identity?.verified === false, "identity_mismatch: identity.verified \u5E94\u4E3A false");
    selfTestCheck(mismatch.result.session?.resumable === false, "identity_mismatch: \u4E0D\u5E94 resumable");
    selfTestCheck(existsSync12(path14.join(mismatch.outDir, "child-final.md")), "identity_mismatch: \u515C\u5E95 child-final.md \u7F3A\u5931");
    const timeout = await scenario("turn-timeout", { mode: "turn_timeout", turnTimeoutMs: 1500 });
    selfTestCheck(timeout.result.failure_type === "turn_timeout", `turn_timeout: failure_type \u5B9E\u5F97 ${timeout.result.failure_type}`);
    selfTestCheck(timeout.result.turn?.startAck === true, "turn_timeout: prompt ack \u5E94\u5DF2\u8BB0\u5F55");
    selfTestCheck(existsSync12(path14.join(timeout.outDir, "child-final.md")), "turn_timeout: \u515C\u5E95 child-final.md \u7F3A\u5931");
    const cancelFile = path14.join(root, "cancel-request.json");
    const cancelled = await scenario("external-cancel", {
      mode: "turn_timeout",
      extraArgs: ["--controlFile", cancelFile, "--attemptId", "attempt-1"],
      cancelRequest: { path: cancelFile, attemptId: "attempt-1", reason: "operator observed a stalled tool", delayMs: 300 }
    });
    selfTestCheck(cancelled.run.code === 1 && cancelled.result.status === "cancelled", `external_cancel: \u9876\u5C42\u5E94\u4E3A cancelled,\u5B9E\u5F97 code=${cancelled.run.code} status=${cancelled.result.status}`);
    selfTestCheck(cancelled.result.cancellation?.graceful === true && cancelled.result.cancellation?.attempt_id === "attempt-1", "external_cancel: \u5E94\u8BC1\u660E\u5F53\u524D attempt \u5DF2\u4F18\u96C5\u6536\u5C3E");
    selfTestCheck(cancelled.result.session?.resumable === true && existsSync12(cancelled.result.session.file), "external_cancel: settled/idle \u4E14\u5B58\u6863\u5B58\u5728\u65F6\u5E94\u53EF\u7EED\u8DD1");
    const cancelledBash = await scenario("external-cancel-bash", {
      mode: "cancel_bash",
      extraArgs: ["--controlFile", path14.join(root, "cancel-bash.json"), "--attemptId", "attempt-bash"],
      cancelRequest: { path: path14.join(root, "cancel-bash.json"), attemptId: "attempt-bash", reason: "stop running command", delayMs: 100 }
    });
    selfTestCheck(cancelledBash.result.cancellation?.graceful === true && cancelledBash.result.session?.resumable === true, "cancel_bash: Bash \u4E2D\u6B62\u9519\u8BEF\u4E0D\u5E94\u5728\u6B63\u5E38 EOF \u6536\u5C3E\u524D\u5F3A\u6740 Pi");
    selfTestCheck(cancelledBash.result.cleanup?.steps?.includes("stdin_eof"), "cancel_bash: \u5E94\u8D70 EOF \u6536\u5C3E");
    const forcedShutdown = await scenario("external-cancel-ignore-eof", {
      mode: "cancel_ignore_eof",
      extraArgs: ["--controlFile", path14.join(root, "cancel-ignore-eof.json"), "--attemptId", "attempt-eof"],
      cancelRequest: { path: path14.join(root, "cancel-ignore-eof.json"), attemptId: "attempt-eof", reason: "stop ignored EOF" }
    });
    selfTestCheck(forcedShutdown.result.cancellation?.graceful === false && forcedShutdown.result.session?.resumable === false, "cancel_ignore_eof: \u5DF2 settled \u4F46\u5173\u505C\u5347\u7EA7\u5230 SIGTERM \u65F6\u4E0D\u53EF\u5192\u62A5\u53EF\u7EED\u8DD1");
    const lateCancelPath = path14.join(root, "late-cancel.json");
    const lateCancel = await scenario("late-cancel", {
      mode: "late_cancel",
      statsDelayMs: 33e3,
      commandsOut: path14.join(root, "late-cancel.commands"),
      extraArgs: ["--controlFile", lateCancelPath, "--attemptId", "attempt-late"],
      cancelRequest: { path: lateCancelPath, attemptId: "attempt-late", reason: "late request during stats", whenCommand: "get_session_stats" }
    });
    const lateLive = JSON.parse(readFileSync10(path14.join(lateCancel.outDir, "child-task-live.json"), "utf8"));
    selfTestCheck(lateLive.attempt_id === "attempt-late" && lateLive.turn_completed === true, "late_cancel: \u5B8C\u6210\u8FB9\u754C\u672A\u7ED1\u5B9A\u5F53\u524D attempt");
    selfTestCheck(existsSync12(lateCancelPath), "late_cancel: \u672A\u6CE8\u5165\u7EDF\u8BA1\u7A97\u53E3\u53D6\u6D88\u8BF7\u6C42");
    selfTestCheck(lateCancel.result.ok === true && lateCancel.result.cancellation?.requested !== true, "late_cancel: \u5DF2\u5B8C\u6210\u56DE\u5408\u4E0D\u80FD\u88AB\u6536\u5272\u9636\u6BB5\u8FDF\u5230\u53D6\u6D88\u8986\u76D6");
    const crash = await scenario("crash", { mode: "crash" });
    selfTestCheck(crash.result.failure_type === "transport_failed", `crash: failure_type \u5B9E\u5F97 ${crash.result.failure_type}`);
    selfTestCheck(existsSync12(path14.join(crash.outDir, "child-final.md")), "crash: \u515C\u5E95 child-final.md \u7F3A\u5931");
    const bashError = await scenario("bash-error", { mode: "bash_error" });
    selfTestCheck(bashError.result.mechanical_signals?.failedBashToolCalls === 1, "bash_error: \u672A\u8BB0\u5F55\u5931\u8D25 Bash \u5DE5\u5177");
    if (process.platform === "win32") {
      selfTestCheck(
        bashError.result.cleanup?.steps?.includes("kill"),
        `bash_error: Windows \u672A\u8D70\u540C\u6B65\u6574\u6811\u56DE\u6536 ${JSON.stringify(bashError.result.cleanup)}`
      );
    }
    const bashExit = await scenario("bash-exit-nonzero", { mode: "bash_exit_nonzero" });
    selfTestCheck(bashExit.result.mechanical_signals?.failedBashToolCalls === 1, "bash_exit_nonzero: \u5931\u8D25 Bash \u5DE5\u5177\u8BA1\u6570\u5E94\u4FDD\u7559");
    selfTestCheck(
      !bashExit.result.cleanup?.steps?.includes("kill") && bashExit.result.cleanup?.tree_confirmed === true,
      `bash_exit_nonzero: \u6B63\u5E38\u7ED3\u675F\u7684\u975E\u96F6\u9000\u51FA\u4E0D\u5E94\u6574\u6811\u5F3A\u6740 ${JSON.stringify(bashExit.result.cleanup)}`
    );
    const aborted = await scenario("aborted", { mode: "aborted" });
    selfTestCheck(aborted.result.ok === true, `aborted: \u56DE\u6267 aborted \u4E0D\u5F97\u5224\u6B7B,\u5B9E\u5F97 ok=${aborted.result.ok} failure_type=${aborted.result.failure_type}`);
    selfTestCheck(aborted.result.turns?.[0]?.stopReason === "aborted", "aborted: \u56DE\u6267 stopReason \u5E94\u539F\u6837\u7559\u5728 turns[]");
    selfTestCheck(aborted.result.diagnostics?.stop_reason === "aborted", "aborted: diagnostics.stop_reason \u5E94\u4E3A aborted");
    selfTestCheck(Boolean(aborted.result.session?.file) && existsSync12(aborted.result.session.file), "aborted: \u5E94\u7559\u4E0B session \u6587\u4EF6");
    const midrun = await scenario("compaction-midrun", { mode: "compaction_midrun" });
    selfTestCheck(midrun.result.ok === true, `compaction_midrun: \u5E94\u5B8C\u6210,\u5B9E\u5F97 ok=${midrun.result.ok} failure_type=${midrun.result.failure_type} error=${midrun.result.error}`);
    selfTestCheck(midrun.result.failure_type === "none", `compaction_midrun: failure_type \u5B9E\u5F97 ${midrun.result.failure_type}`);
    selfTestCheck(midrun.result.turn?.compactions?.length === 1 && midrun.result.turn.compactions[0].ended_at, "compaction_midrun: \u5E94\u8BB0\u5F55\u4E00\u6B21\u5B8C\u6574\u538B\u7F29");
    selfTestCheck(midrun.result.turns?.[0]?.stopReason === "error" && /aborted/.test(midrun.result.turns[0].errorMessage || ""), "compaction_midrun: \u9996\u6761\u56DE\u6267\u5E94\u4FDD\u7559 abort \u4E8B\u5B9E");
    selfTestCheck(midrun.result.turns?.[1]?.stopReason === "stop", "compaction_midrun: \u7EED\u8DD1\u56DE\u6267\u5E94\u4E3A stop");
    selfTestCheck(midrun.result.turn?.finalTextSource === "message_end", `compaction_midrun: \u6B63\u6587\u5E94\u6765\u81EA\u7EED\u8DD1 message_end,\u5B9E\u5F97 ${midrun.result.turn?.finalTextSource}`);
    const noResumeCommands = path14.join(root, "commands-no-resume.txt");
    const noResume = await scenario("compaction-no-resume", { mode: "compaction_no_resume", commandsOut: noResumeCommands });
    selfTestCheck(noResume.result.orchestration?.ok === true && noResume.result.turn?.completed === true, `compaction_no_resume: \u8FD0\u8F93\u5E94\u5B8C\u6210,\u5B9E\u5F97 orchestration.ok=${noResume.result.orchestration?.ok}`);
    selfTestCheck(noResume.result.failure_type === "task_status_missing" && noResume.result.ok === false, `compaction_no_resume: \u7A7A\u6B63\u6587\u53EA\u5728\u4E1A\u52A1\u5C42\u8BB0 task_status_missing,\u5B9E\u5F97 ok=${noResume.result.ok} failure_type=${noResume.result.failure_type}`);
    selfTestCheck(noResume.result.turn?.settleCycles === 1, `compaction_no_resume: settleCycles \u5E94\u4E3A 1,\u5B9E\u5F97 ${noResume.result.turn?.settleCycles}`);
    selfTestCheck(noResume.result.turn?.compactions?.length === 1, "compaction_no_resume: \u5E94\u8BB0\u5F55\u4E00\u6B21\u538B\u7F29");
    selfTestCheck(noResume.result.turn?.finalTextSource === "empty", `compaction_no_resume: \u6B63\u6587\u6765\u6E90\u5E94\u4E3A empty,\u5B9E\u5F97 ${noResume.result.turn?.finalTextSource}`);
    selfTestCheck(readFileSync10(noResumeCommands, "utf8").split(/\r?\n/).filter((line) => line === "prompt").length === 1, "compaction_no_resume: \u65E0\u6B63\u6587\u4E0D\u5F97\u8FFD\u52A0\u6536\u53E3\u8F6E prompt");
    selfTestCheck(noResume.result.turn?.finalization === void 0, "compaction_no_resume: result.turn \u4E0D\u518D\u6709 finalization \u6BB5");
    selfTestCheck(noResume.result.warnings.some((line) => line.includes("\u4EC5\u8BB0\u5F55\u89C2\u6D4B")), "compaction_no_resume: \u7F3A\u8282\u5E94\u4EE5 warning \u8BB0\u4E8B\u5B9E");
    selfTestCheck(noResume.result.session?.resumable === true, "compaction_no_resume: \u672A ok \u6536\u5C3E\u4E14\u8EAB\u4EFD\u6838\u8FC7\u5E94\u53EF\u7EED\u8DD1");
    const errorIdleCommands = path14.join(root, "commands-error-idle.txt");
    const errorIdle = await scenario("error-then-idle", { mode: "error_then_idle", commandsOut: errorIdleCommands });
    selfTestCheck(errorIdle.result.orchestration?.ok === true && errorIdle.result.orchestration?.failure_type === "none", `error_then_idle: \u8FD0\u8F93\u4E0D\u5F97\u5224\u6B7B,\u5B9E\u5F97 orchestration=${JSON.stringify(errorIdle.result.orchestration)}`);
    selfTestCheck(errorIdle.result.failure_type !== "schema_missing" && errorIdle.result.failure_type !== "provider_error", `error_then_idle: failure_type \u5B9E\u5F97 ${errorIdle.result.failure_type}`);
    selfTestCheck(errorIdle.result.turns?.[0]?.stopReason === "error", "error_then_idle: \u9996\u6761\u56DE\u6267\u5E94\u4FDD\u7559 error");
    selfTestCheck(errorIdle.result.mechanical_signals?.errorTurns === 1, "error_then_idle: errorTurns \u673A\u68B0\u4FE1\u53F7\u5E94\u4E3A 1");
    selfTestCheck(readFileSync10(errorIdleCommands, "utf8").split(/\r?\n/).filter((line) => line === "prompt").length === 1, "error_then_idle: \u4E0D\u5F97\u8FFD\u52A0\u6536\u53E3\u8F6E prompt");
    const probeFail = await scenario("state-probe-fail", { mode: "state_probe_fail" });
    selfTestCheck(probeFail.result.ok === false && probeFail.result.failure_type === "transport_failed", `state_probe_fail: get_state \u5931\u8D25\u5E94\u6309\u8FD0\u8F93\u5931\u8D25\u4E0A\u629B,\u5B9E\u5F97 ok=${probeFail.result.ok} failure_type=${probeFail.result.failure_type}`);
    selfTestCheck(/get_state/.test(String(probeFail.result.error || "")), "state_probe_fail: error \u5E94\u6307\u5411 get_state");
    const idleRestart = await scenario("idle-then-restart", { mode: "idle_then_restart" });
    selfTestCheck(idleRestart.result.ok === true && idleRestart.result.turn?.settleCycles === 2, `idle_then_restart: \u63A2\u6D4B\u7A97\u53E3\u5185\u7684\u65B0\u6D3B\u52A8\u5E94\u88AB\u7B49\u5230,\u5B9E\u5F97 ok=${idleRestart.result.ok} settleCycles=${idleRestart.result.turn?.settleCycles}`);
    const compactingEnd = await scenario("compacting-state-then-end", { mode: "compacting_state_then_end" });
    selfTestCheck(compactingEnd.result.ok === true && compactingEnd.result.failure_type === "none", `compacting_state_then_end: \u5DF2\u5230\u8FBE\u7684 compaction_end \u4E0D\u5F97\u6B7B\u7B49,\u5B9E\u5F97 ok=${compactingEnd.result.ok} failure_type=${compactingEnd.result.failure_type}`);
    selfTestCheck(compactingEnd.result.turn?.compactions?.length === 0, "compacting_state_then_end: \u65E0 compaction_start \u65F6\u4E0D\u8BB0\u5F55\u538B\u7F29\u6761\u76EE");
    const toolLoop2 = await scenario("tool-loop", { mode: "tool_loop_repeat" });
    selfTestCheck(toolLoop2.result.ok === true && !toolLoop2.result.tool_loop, "tool_loop: \u540C\u53C2\u6570\u8F6E\u8BE2\u4E0D\u5F97\u5F3A\u6740");
    selfTestCheck(toolLoop2.result.tool_progress_warning?.signatures?.[0]?.count === 20, "tool_loop: \u56DE\u6267\u5E94\u8BB0\u5F55\u544A\u8B66");
    const toolLoopLive = JSON.parse(readFileSync10(path14.join(toolLoop2.outDir, "child-task-live.json"), "utf8"));
    selfTestCheck(toolLoopLive.tool_progress_warning?.signatures?.[0]?.count === 20, "tool_loop: live \u5E94\u8BB0\u5F55\u544A\u8B66");
    const toolLoopEvents = readFileSync10(path14.join(toolLoop2.outDir, "child-task-events.jsonl"), "utf8");
    selfTestCheck(toolLoopEvents.includes('"tool_progress_warning"'), "tool_loop: \u4E8B\u4EF6\u5E94\u8BB0\u5F55\u544A\u8B66");
    const toolLoopAlternate = await scenario("tool-loop-alternate", { mode: "tool_loop_alternate" });
    selfTestCheck(toolLoopAlternate.result.ok === true && !toolLoopAlternate.result.tool_loop && toolLoopAlternate.result.tool_progress_warning?.signatures?.length === 2, "tool_loop_alternate: A/B \u4EA4\u66FF\u5E94\u7EE7\u7EED");
    const toolLoopNoop = await scenario("tool-loop-noop", { mode: "tool_loop_noop" });
    selfTestCheck(toolLoopNoop.result.failure_type === "tool_loop" && toolLoopNoop.result.tool_loop?.kind === "noop_commands" && toolLoopNoop.result.tool_loop?.noop_streak === 8 && /连续 8 次空转命令/.test(String(toolLoopNoop.result.error || "")), `tool_loop_noop: \u8FDE\u7EED 8 \u6B21\u5185\u5BB9\u5404\u5F02\u7684\u7A7A\u8F6C\u547D\u4EE4\u5E94\u89E6\u53D1,\u5B9E\u5F97 ${toolLoopNoop.result.failure_type} ${JSON.stringify(toolLoopNoop.result.tool_loop)}`);
    const toolLoopNoopExit = await scenario("tool-loop-noop-exit", { mode: "tool_loop_noop_exit" });
    selfTestCheck(toolLoopNoopExit.result.failure_type === "tool_loop" && toolLoopNoopExit.result.tool_loop?.kind === "noop_commands", `tool_loop_noop_exit: \u8FDE\u7EED 8 \u6B21 PowerShell exit 0 \u5E94\u89E6\u53D1,\u5B9E\u5F97 ${toolLoopNoopExit.result.failure_type}`);
    const toolLoopNoopShort = await scenario("tool-loop-noop-short", { mode: "tool_loop_noop_short" });
    selfTestCheck(toolLoopNoopShort.result.ok === true && toolLoopNoopShort.result.failure_type === "none" && !toolLoopNoopShort.result.tool_loop, `tool_loop_noop_short: 7 \u6B21\u7A7A\u8F6C\u540E\u63A5\u771F\u5B9E\u547D\u4EE4\u4E0D\u5E94\u89E6\u53D1,\u5B9E\u5F97 ${toolLoopNoopShort.result.failure_type}`);
    const toolLoopReset = await scenario("tool-loop-reset", { mode: "tool_loop_reset" });
    selfTestCheck(toolLoopReset.result.ok === true && toolLoopReset.result.failure_type === "none" && !toolLoopReset.result.tool_loop, `tool_loop_reset: 19 \u6B21\u76F8\u540C\u540E\u63A5 2 \u4E2A\u4E0D\u540C\u7B7E\u540D\u4E0D\u5E94\u89E6\u53D1,\u5B9E\u5F97 ${toolLoopReset.result.failure_type}`);
    const toolLoopPages = await scenario("tool-loop-read-pages", { mode: "tool_loop_read_pages" });
    const toolLoopFiles = await scenario("tool-loop-numbered-files", { mode: "tool_loop_numbered_files" });
    selfTestCheck(toolLoopFiles.result.ok === true && toolLoopFiles.result.failure_type === "none" && !toolLoopFiles.result.tool_loop, `tool_loop_numbered_files: \u8DEF\u5F84\u91CC\u7684\u6570\u5B57\u5E94\u4FDD\u7559,\u5B9E\u5F97 ${toolLoopFiles.result.failure_type}`);
    selfTestCheck(toolLoopPages.result.ok === true && toolLoopPages.result.failure_type === "none" && !toolLoopPages.result.tool_loop, `tool_loop_read_pages: \u540C\u4E00\u6587\u4EF6\u4E0D\u540C offset \u7684\u5206\u9875\u8BFB\u4E0D\u5E94\u89E6\u53D1,\u5B9E\u5F97 ${toolLoopPages.result.failure_type}`);
    const toolLoopNumeric = await scenario("tool-loop-numeric-args", { mode: "tool_loop" });
    selfTestCheck(toolLoopNumeric.result.ok === true && toolLoopNumeric.result.failure_type === "none" && !toolLoopNumeric.result.tool_loop, `tool_loop_numeric_args: \u53EA\u6362\u6570\u5B57\u53C2\u6570\u7684 20 \u6B21\u547D\u4EE4\u4E0D\u5E94\u89E6\u53D1,\u5B9E\u5F97 ${toolLoopNumeric.result.failure_type} ${JSON.stringify(toolLoopNumeric.result.tool_loop)}`);
    const toolLoopPsRead = await scenario("tool-loop-ps-read", { mode: "tool_loop_ps_read" });
    selfTestCheck(toolLoopPsRead.result.ok === true && toolLoopPsRead.result.failure_type === "none" && !toolLoopPsRead.result.tool_loop, `tool_loop_ps_read: 8 \u6B21\u5B50\u8868\u8FBE\u5F0F\u8BFB\u53D6\u4E0D\u5E94\u5224\u7A7A\u8F6C,\u5B9E\u5F97 ${toolLoopPsRead.result.failure_type} ${JSON.stringify(toolLoopPsRead.result.tool_loop)}`);
    const budget = await scenario("budget-during-grace", { mode: "ok", turnTimeoutMs: 1200 });
    selfTestCheck(budget.result.failure_type === "turn_timeout", `budget_during_grace: \u9759\u9ED8\u7A97\u8D8A\u8FC7 turn \u9884\u7B97\u5E94\u5224 turn_timeout,\u5B9E\u5F97 ${budget.result.failure_type}`);
    const commandsOut = path14.join(root, "commands-resume.txt");
    const resumed = await scenario("resume", {
      mode: "ok",
      extraArgs: ["--resumeSession", aborted.result.session.file],
      commandsOut
    });
    selfTestCheck(resumed.result.ok === true, `resume: result.ok \u5E94\u4E3A true,\u5B9E\u5F97 ${resumed.result.ok}`);
    const resumeArgv = JSON.parse(readFileSync10(resumed.argvOut, "utf8"));
    selfTestCheck(resumeArgv[resumeArgv.indexOf("--session") + 1] === aborted.result.session.file, "resume: CLI \u672A\u76F4\u63A5\u6253\u5F00\u539F\u4F1A\u8BDD");
    selfTestCheck(resumed.result.session.file === aborted.result.session.file, "resume: \u4F1A\u8BDD\u6587\u4EF6\u4E0D\u4E00\u81F4");
    selfTestCheck(!readFileSync10(commandsOut, "utf8").includes("switch_session"), "resume: \u4E0D\u5E94\u5148\u521B\u5EFA\u4E34\u65F6\u4F1A\u8BDD\u518D\u91CD\u8F7D\u6269\u5C55");
    const textFail = await scenario("assistant-text-rpc-fail", { mode: "assistant_text_rpc_fail" });
    selfTestCheck(textFail.result.ok === false, "assistant_text_rpc_fail: \u4E0D\u5E94\u628A RPC \u5931\u8D25\u6D17\u6210\u6210\u529F\u7A7A\u6587\u672C");
    selfTestCheck(textFail.result.failure_type !== "none", `assistant_text_rpc_fail: failure_type \u5B9E\u5F97 ${textFail.result.failure_type}`);
    writeStdoutSync("PI_RUNNER_SELF_TEST_OK\n");
  } finally {
    rmSync3(root, { recursive: true, force: true });
  }
}
var BACKEND, RUNNER_NAME, PI_STUB_DEFAULT_FINAL_TEXT;
var init_run_pi_task_selftest = __esm({
  "ops/tools/run-pi-task.selftest.mjs"() {
    init_child_task_contract();
    init_stdio_jsonrpc();
    BACKEND = "pi-rpc";
    RUNNER_NAME = "run-pi-task";
    PI_STUB_DEFAULT_FINAL_TEXT = [
      "## \u7ED3\u8BBA",
      "\u4EFB\u52A1\u72B6\u6001:completed",
      "## \u4E8B\u5B9E\u4E0E\u8BC1\u636E",
      "- stub \u56DE\u6267 PI_STUB_OK",
      "## \u5DF2\u68C0\u67E5\u5185\u5BB9",
      "- self-test \u94FE\u8DEF",
      "## \u5931\u8D25\u68C0\u67E5",
      "\u65E0",
      "## \u4E0D\u786E\u5B9A\u9879",
      "\u65E0",
      "## \u8FB9\u754C",
      "- stub \u4E0D\u6267\u884C\u771F\u5B9E\u4EFB\u52A1"
    ].join("\n");
  }
});

// ops/tools/run-pi-task.mjs
import { spawn as spawn4 } from "node:child_process";
import { existsSync as existsSync13, readdirSync as readdirSync2, readFileSync as readFileSync11, rmSync as rmSync4, statSync as statSync5, writeFileSync as writeFileSync9 } from "node:fs";
import path15 from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";

// ops/node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r\n|\n|\r/g);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
};

// ops/node_modules/smol-toml/dist/util.js
function isEscaped(str, ptr) {
  let i = 0;
  while (str[ptr - ++i] === "\\")
    ;
  return --i && i % 2;
}
function indexOfNewline(str, start = 0, end = str.length) {
  let idx = str.indexOf("\n", start);
  if (str[idx - 1] === "\r")
    idx--;
  return idx <= end ? idx : -1;
}
function skipComment(str, ptr) {
  for (let i = ptr; i < str.length; i++) {
    let c = str[i];
    if (c === "\n")
      return i;
    if (c === "\r" && str[i + 1] === "\n")
      return i + 1;
    if (c < " " && c !== "	" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in comments", {
        toml: str,
        ptr
      });
    }
  }
  return str.length;
}
function skipVoid(str, ptr, banNewLines, banComments) {
  let c;
  while ((c = str[ptr]) === " " || c === "	" || !banNewLines && (c === "\n" || c === "\r" && str[ptr + 1] === "\n"))
    ptr++;
  return banComments || c !== "#" ? ptr : skipVoid(str, skipComment(str, ptr), banNewLines);
}
function skipUntil(str, ptr, sep, end, banNewLines = false) {
  if (!end) {
    ptr = indexOfNewline(str, ptr);
    return ptr < 0 ? str.length : ptr;
  }
  for (let i = ptr; i < str.length; i++) {
    let c = str[i];
    if (c === "#") {
      i = indexOfNewline(str, i);
    } else if (c === sep) {
      return i + 1;
    } else if (c === end || banNewLines && (c === "\n" || c === "\r" && str[i + 1] === "\n")) {
      return i;
    }
  }
  throw new TomlError("cannot find end of structure", {
    toml: str,
    ptr
  });
}
function getStringEnd(str, seek) {
  let first = str[seek];
  let target = first === str[seek + 1] && str[seek + 1] === str[seek + 2] ? str.slice(seek, seek + 3) : first;
  seek += target.length - 1;
  do
    seek = str.indexOf(target, ++seek);
  while (seek > -1 && first !== "'" && isEscaped(str, seek));
  if (seek > -1) {
    seek += target.length;
    if (target.length > 1) {
      if (str[seek] === first)
        seek++;
      if (str[seek] === first)
        seek++;
    }
  }
  return seek;
}

// ops/node_modules/smol-toml/dist/date.js
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}:\d{2}(?:\.\d+)?)?(Z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    if (typeof date === "string") {
      let match = date.match(DATE_TIME_RE);
      if (match) {
        if (!match[1]) {
          hasDate = false;
          date = `0000-01-01T${date}`;
        }
        hasTime = !!match[2];
        hasTime && date[10] === " " && (date = date.replace(" ", "T"));
        if (match[2] && +match[2] > 23) {
          date = "";
        } else {
          offset = match[3] || null;
          date = date.toUpperCase();
          if (!offset && hasTime)
            date += "Z";
        }
      } else {
        date = "";
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// ops/node_modules/smol-toml/dist/primitive.js
var INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
var FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
var LEADING_ZERO = /^[+-]?0[0-9_]/;
var ESCAPE_REGEX = /^[0-9a-f]{4,8}$/i;
var ESC_MAP = {
  b: "\b",
  t: "	",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\"
};
function parseString(str, ptr = 0, endPtr = str.length) {
  let isLiteral = str[ptr] === "'";
  let isMultiline = str[ptr++] === str[ptr] && str[ptr] === str[ptr + 1];
  if (isMultiline) {
    endPtr -= 2;
    if (str[ptr += 2] === "\r")
      ptr++;
    if (str[ptr] === "\n")
      ptr++;
  }
  let tmp = 0;
  let isEscape;
  let parsed = "";
  let sliceStart = ptr;
  while (ptr < endPtr - 1) {
    let c = str[ptr++];
    if (c === "\n" || c === "\r" && str[ptr] === "\n") {
      if (!isMultiline) {
        throw new TomlError("newlines are not allowed in strings", {
          toml: str,
          ptr: ptr - 1
        });
      }
    } else if (c < " " && c !== "	" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in strings", {
        toml: str,
        ptr: ptr - 1
      });
    }
    if (isEscape) {
      isEscape = false;
      if (c === "u" || c === "U") {
        let code = str.slice(ptr, ptr += c === "u" ? 4 : 8);
        if (!ESCAPE_REGEX.test(code)) {
          throw new TomlError("invalid unicode escape", {
            toml: str,
            ptr: tmp
          });
        }
        try {
          parsed += String.fromCodePoint(parseInt(code, 16));
        } catch {
          throw new TomlError("invalid unicode escape", {
            toml: str,
            ptr: tmp
          });
        }
      } else if (isMultiline && (c === "\n" || c === " " || c === "	" || c === "\r")) {
        ptr = skipVoid(str, ptr - 1, true);
        if (str[ptr] !== "\n" && str[ptr] !== "\r") {
          throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
            toml: str,
            ptr: tmp
          });
        }
        ptr = skipVoid(str, ptr);
      } else if (c in ESC_MAP) {
        parsed += ESC_MAP[c];
      } else {
        throw new TomlError("unrecognized escape sequence", {
          toml: str,
          ptr: tmp
        });
      }
      sliceStart = ptr;
    } else if (!isLiteral && c === "\\") {
      tmp = ptr - 1;
      isEscape = true;
      parsed += str.slice(sliceStart, tmp);
    }
  }
  return parsed + str.slice(sliceStart, endPtr - 1);
}
function parseValue(value, toml, ptr, integersAsBigInt) {
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  if (value === "-inf")
    return -Infinity;
  if (value === "inf" || value === "+inf")
    return Infinity;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value)) {
      throw new TomlError("leading zeroes are not allowed", {
        toml,
        ptr
      });
    }
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric)) {
      throw new TomlError("invalid number", {
        toml,
        ptr
      });
    }
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
        throw new TomlError("integer value cannot be represented losslessly", {
          toml,
          ptr
        });
      }
      if (isInt || integersAsBigInt === true)
        numeric = BigInt(value);
    }
    return numeric;
  }
  const date = new TomlDate(value);
  if (!date.isValid()) {
    throw new TomlError("invalid value", {
      toml,
      ptr
    });
  }
  return date;
}

// ops/node_modules/smol-toml/dist/extract.js
function sliceAndTrimEndOf(str, startPtr, endPtr, allowNewLines) {
  let value = str.slice(startPtr, endPtr);
  let commentIdx = value.indexOf("#");
  if (commentIdx > -1) {
    skipComment(str, commentIdx);
    value = value.slice(0, commentIdx);
  }
  let trimmed = value.trimEnd();
  if (!allowNewLines) {
    let newlineIdx = value.indexOf("\n", trimmed.length);
    if (newlineIdx > -1) {
      throw new TomlError("newlines are not allowed in inline tables", {
        toml: str,
        ptr: startPtr + newlineIdx
      });
    }
  }
  return [trimmed, commentIdx];
}
function extractValue(str, ptr, end, depth, integersAsBigInt) {
  if (depth === 0) {
    throw new TomlError("document contains excessively nested structures. aborting.", {
      toml: str,
      ptr
    });
  }
  let c = str[ptr];
  if (c === "[" || c === "{") {
    let [value, endPtr2] = c === "[" ? parseArray(str, ptr, depth, integersAsBigInt) : parseInlineTable(str, ptr, depth, integersAsBigInt);
    let newPtr = end ? skipUntil(str, endPtr2, ",", end) : endPtr2;
    if (endPtr2 - newPtr && end === "}") {
      let nextNewLine = indexOfNewline(str, endPtr2, newPtr);
      if (nextNewLine > -1) {
        throw new TomlError("newlines are not allowed in inline tables", {
          toml: str,
          ptr: nextNewLine
        });
      }
    }
    return [value, newPtr];
  }
  let endPtr;
  if (c === '"' || c === "'") {
    endPtr = getStringEnd(str, ptr);
    let parsed = parseString(str, ptr, endPtr);
    if (end) {
      endPtr = skipVoid(str, endPtr, end !== "]");
      if (str[endPtr] && str[endPtr] !== "," && str[endPtr] !== end && str[endPtr] !== "\n" && str[endPtr] !== "\r") {
        throw new TomlError("unexpected character encountered", {
          toml: str,
          ptr: endPtr
        });
      }
      endPtr += +(str[endPtr] === ",");
    }
    return [parsed, endPtr];
  }
  endPtr = skipUntil(str, ptr, ",", end);
  let slice = sliceAndTrimEndOf(str, ptr, endPtr - +(str[endPtr - 1] === ","), end === "]");
  if (!slice[0]) {
    throw new TomlError("incomplete key-value declaration: no value specified", {
      toml: str,
      ptr
    });
  }
  if (end && slice[1] > -1) {
    endPtr = skipVoid(str, ptr + slice[1]);
    endPtr += +(str[endPtr] === ",");
  }
  return [
    parseValue(slice[0], str, ptr, integersAsBigInt),
    endPtr
  ];
}

// ops/node_modules/smol-toml/dist/struct.js
var KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
function parseKey(str, ptr, end = "=") {
  let dot = ptr - 1;
  let parsed = [];
  let endPtr = str.indexOf(end, ptr);
  if (endPtr < 0) {
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: str,
      ptr
    });
  }
  do {
    let c = str[ptr = ++dot];
    if (c !== " " && c !== "	") {
      if (c === '"' || c === "'") {
        if (c === str[ptr + 1] && c === str[ptr + 2]) {
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: str,
            ptr
          });
        }
        let eos = getStringEnd(str, ptr);
        if (eos < 0) {
          throw new TomlError("unfinished string encountered", {
            toml: str,
            ptr
          });
        }
        dot = str.indexOf(".", eos);
        let strEnd = str.slice(eos, dot < 0 || dot > endPtr ? endPtr : dot);
        let newLine = indexOfNewline(strEnd);
        if (newLine > -1) {
          throw new TomlError("newlines are not allowed in keys", {
            toml: str,
            ptr: ptr + dot + newLine
          });
        }
        if (strEnd.trimStart()) {
          throw new TomlError("found extra tokens after the string part", {
            toml: str,
            ptr: eos
          });
        }
        if (endPtr < eos) {
          endPtr = str.indexOf(end, eos);
          if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: str,
              ptr
            });
          }
        }
        parsed.push(parseString(str, ptr, eos));
      } else {
        dot = str.indexOf(".", ptr);
        let part = str.slice(ptr, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part)) {
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: str,
            ptr
          });
        }
        parsed.push(part.trimEnd());
      }
    }
  } while (dot + 1 && dot < endPtr);
  return [parsed, skipVoid(str, endPtr + 1, true, true)];
}
function parseInlineTable(str, ptr, depth, integersAsBigInt) {
  let res = {};
  let seen = /* @__PURE__ */ new Set();
  let c;
  let comma = 0;
  ptr++;
  while ((c = str[ptr++]) !== "}" && c) {
    let err = { toml: str, ptr: ptr - 1 };
    if (c === "\n") {
      throw new TomlError("newlines are not allowed in inline tables", err);
    } else if (c === "#") {
      throw new TomlError("inline tables cannot contain comments", err);
    } else if (c === ",") {
      throw new TomlError("expected key-value, found comma", err);
    } else if (c !== " " && c !== "	") {
      let k;
      let t = res;
      let hasOwn = false;
      let [key, keyEndPtr] = parseKey(str, ptr - 1);
      for (let i = 0; i < key.length; i++) {
        if (i)
          t = hasOwn ? t[k] : t[k] = {};
        k = key[i];
        if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
          throw new TomlError("trying to redefine an already defined value", {
            toml: str,
            ptr
          });
        }
        if (!hasOwn && k === "__proto__") {
          Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        }
      }
      if (hasOwn) {
        throw new TomlError("trying to redefine an already defined value", {
          toml: str,
          ptr
        });
      }
      let [value, valueEndPtr] = extractValue(str, keyEndPtr, "}", depth - 1, integersAsBigInt);
      seen.add(value);
      t[k] = value;
      ptr = valueEndPtr;
      comma = str[ptr - 1] === "," ? ptr - 1 : 0;
    }
  }
  if (comma) {
    throw new TomlError("trailing commas are not allowed in inline tables", {
      toml: str,
      ptr: comma
    });
  }
  if (!c) {
    throw new TomlError("unfinished table encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}
function parseArray(str, ptr, depth, integersAsBigInt) {
  let res = [];
  let c;
  ptr++;
  while ((c = str[ptr++]) !== "]" && c) {
    if (c === ",") {
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    } else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "	" && c !== "\n" && c !== "\r") {
      let e = extractValue(str, ptr - 1, "]", depth - 1, integersAsBigInt);
      res.push(e[0]);
      ptr = e[1];
    }
  }
  if (!c) {
    throw new TomlError("unfinished array encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}

// ops/node_modules/smol-toml/dist/parse.js
function peekTable(key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = {};
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      if (k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = {});
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: {} };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = {};
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function parse(toml, { maxDepth = 1e3, integersAsBigInt } = {}) {
  let res = {};
  let meta = {};
  let tbl = res;
  let m = meta;
  for (let ptr = skipVoid(toml, 0); ptr < toml.length; ) {
    if (toml[ptr] === "[") {
      let isTableArray = toml[++ptr] === "[";
      let k = parseKey(toml, ptr += +isTableArray, "]");
      if (isTableArray) {
        if (toml[k[1] - 1] !== "]") {
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: k[1] - 1
          });
        }
        k[1]++;
      }
      let p = peekTable(
        k[0],
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      m = p[2];
      tbl = p[1];
      ptr = k[1];
    } else {
      let k = parseKey(toml, ptr);
      let p = peekTable(
        k[0],
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      let v = extractValue(toml, k[1], void 0, maxDepth, integersAsBigInt);
      p[1][p[0]] = v[0];
      ptr = v[1];
    }
    ptr = skipVoid(toml, ptr, true);
    if (toml[ptr] && toml[ptr] !== "\n" && toml[ptr] !== "\r") {
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr
      });
    }
    ptr = skipVoid(toml, ptr);
  }
  return res;
}

// ops/tools/dispatch-core/model_selection.mjs
import { existsSync as existsSync3, readdirSync, readFileSync as readFileSync3 } from "node:fs";
import path3 from "node:path";

// ops/tools/_dispatch-prepare-argv.mjs
var DISPATCH_PREPARE_SEED_FIELD_TYPES = Object.freeze({
  route_id: "string",
  goal: "string",
  scope: "object",
  contract: "object",
  slug: "string",
  known_facts: "array",
  delegation_intent: "string",
  extensions: "object",
  read_scope_layers: "object",
  budget: "object",
  slice_id: "string",
  title: "string",
  version: "string",
  package_id: "string",
  agent: "object",
  project_positioning: "object",
  ownership: "object",
  concurrency_contract: "object",
  inputs: "object",
  expected_output: "object",
  runtime_context: "object",
  alignment: "object",
  planning_policy: "object",
  tool_contract: "object",
  stop_conditions: "array",
  handoff_contract: "object"
});
var DISPATCH_PREPARE_SEED_FIELDS = Object.freeze(Object.keys(DISPATCH_PREPARE_SEED_FIELD_TYPES));
var AUTHORIZATION_OVERRIDES = Object.freeze(["effort_range", "outside_pool"]);
var DISPATCH_PREPARE_OVERRIDE_FLAGS = Object.freeze({
  pick: "--async-pick",
  model: "--async-model",
  authorization: "--async-authorization",
  effort: "--async-effort",
  target_cwd: "--async-target-cwd",
  execution_profile: "--async-execution-profile",
  origin_id: "--origin-id"
});

// ops/tools/dispatch-core/_tool_common.mjs
import {
  closeSync,
  existsSync as existsSync2,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync as readFileSync2,
  readSync,
  realpathSync,
  renameSync,
  statSync as statSync2,
  unlinkSync,
  writeSync
} from "node:fs";
import path2 from "node:path";
import process3 from "node:process";
import { fileURLToPath } from "node:url";

// ops/tools/model_config.mjs
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process2 from "node:process";
var MODEL_CONFIG_DECLARATION_SEGMENTS = Object.freeze([".pi", "control-plane-model-config.json"]);
var MODEL_CONFIG_SCHEMA_VERSION = 1;
var MODEL_CONFIG_ASSETS = Object.freeze({
  agents_dir: Object.freeze({ kind: "dir", relative: Object.freeze(["ops", "agents"]) }),
  model_notes: Object.freeze({ kind: "file", relative: Object.freeze(["ops", "model-notes.toml"]) })
});
var MODEL_CONFIG_ASSET_KEYS = Object.freeze(Object.keys(MODEL_CONFIG_ASSETS));
var MODEL_CONFIG_REQUIRED_KEYS = Object.freeze(["agents_dir", "model_notes"]);
var ModelConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelConfigError";
    this.code = "MODEL_CONFIG_INVALID";
  }
};
function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function samePath(left, right) {
  const normalizedLeft = path.resolve(String(left));
  const normalizedRight = path.resolve(String(right));
  return process2.platform === "win32" ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US") : normalizedLeft === normalizedRight;
}
function isInsideProject(target, projectRoot2) {
  const normalizedTarget = process2.platform === "win32" ? path.resolve(target).toLocaleLowerCase("en-US") : path.resolve(target);
  const normalizedRoot = process2.platform === "win32" ? path.resolve(projectRoot2).toLocaleLowerCase("en-US") : path.resolve(projectRoot2);
  if (normalizedTarget === normalizedRoot) return true;
  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}
function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}
function assetExists(target, key) {
  return MODEL_CONFIG_ASSETS[key].kind === "dir" ? isDirectory(target) : isFile(target);
}
function globalModelConfigAssetPath(root, key) {
  if (!MODEL_CONFIG_ASSETS[key]) throw new ModelConfigError(`\u672A\u77E5\u7684\u6A21\u578B\u914D\u7F6E\u8D44\u4EA7\uFF1A${key}`);
  return path.join(path.resolve(String(root)), ...MODEL_CONFIG_ASSETS[key].relative);
}
function inspectGlobalModelConfig(root) {
  const resolved = path.resolve(String(root));
  const missing = MODEL_CONFIG_REQUIRED_KEYS.filter((key) => !assetExists(globalModelConfigAssetPath(resolved, key), key));
  return { root: resolved, complete: missing.length === 0, missing };
}
function resolveGlobalModelConfigRoot({ roots = [] } = {}) {
  const inspected = [];
  for (const entry of roots) {
    const raw = typeof entry === "string" ? entry : entry?.root;
    if (!text(raw)) continue;
    const source = typeof entry === "string" ? "runtime_root" : String(entry?.source || "runtime_root");
    const inspection = inspectGlobalModelConfig(raw);
    if (inspection.complete) return { root: inspection.root, source };
    if (inspected.some((item) => samePath(item.root, inspection.root))) continue;
    inspected.push({ root: inspection.root, source, missing: inspection.missing });
  }
  const detail = inspected.length ? inspected.map((item) => `${item.root}\uFF08${item.source}\uFF09\u7F3A\u5C11 ${item.missing.join(", ")}`).join("\uFF1B") : "\u6CA1\u6709\u53EF\u7528\u7684\u5019\u9009\u8FD0\u884C\u6839";
  throw new ModelConfigError(
    `\u5168\u5C40\u89D2\u8272/\u6A21\u578B\u914D\u7F6E\u4E0D\u5B8C\u6574\uFF1A${detail}\u3002\u8BF7\u90E8\u7F72\u5E26 ops/agents \u4E0E ops/model-notes.toml \u7684\u8FD0\u884C\u5305\u3002`
  );
}
function modelConfigDeclarationPath(projectRoot2) {
  return path.join(path.resolve(String(projectRoot2)), ...MODEL_CONFIG_DECLARATION_SEGMENTS);
}
function declarationPathValue(declaration, key, declarationPath) {
  const value = declaration[key];
  if (!text(value)) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32\uFF1A${declarationPath}`);
  }
  const raw = value.trim();
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith("\\\\")) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u5FC5\u987B\u662F\u9879\u76EE\u5185\u76F8\u5BF9\u8DEF\u5F84\uFF1A${declarationPath}\uFF1A${raw}`);
  }
  const segments = raw.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u4E0D\u5F97\u8D8A\u51FA\u9879\u76EE\u6839\uFF1A${declarationPath}\uFF1A${raw}`);
  }
  return segments.join("/");
}
function readModelConfigDeclaration(projectRoot2) {
  const declarationPath = modelConfigDeclarationPath(projectRoot2);
  if (!existsSync(declarationPath)) {
    return { path: declarationPath, exists: false, overrides: {}, declared_keys: [] };
  }
  if (!isFile(declarationPath)) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u5FC5\u987B\u662F\u666E\u901A\u6587\u4EF6\uFF1A${declarationPath}`);
  }
  let raw;
  try {
    raw = readFileSync(declarationPath, "utf8");
  } catch (error) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u4E0D\u53EF\u8BFB\uFF1A${declarationPath}\uFF1A${error?.message ?? error}`);
  }
  let declaration;
  try {
    declaration = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u4E0D\u662F\u6709\u6548 JSON\uFF1A${declarationPath}\uFF1A${error?.message ?? error}`);
  }
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u5FC5\u987B\u662F JSON \u5BF9\u8C61\uFF1A${declarationPath}`);
  }
  if (declaration.schema_version !== MODEL_CONFIG_SCHEMA_VERSION) {
    throw new ModelConfigError(
      `\u6A21\u578B\u914D\u7F6E\u58F0\u660E schema_version \u5FC5\u987B\u4E3A ${MODEL_CONFIG_SCHEMA_VERSION}\uFF1A${declarationPath}`
    );
  }
  const unknown = Object.keys(declaration).filter((key) => key !== "schema_version" && !MODEL_CONFIG_ASSETS[key]);
  if (unknown.length > 0) {
    throw new ModelConfigError(
      `\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u542B\u672A\u77E5\u5B57\u6BB5 ${unknown.join(", ")}\uFF1A${declarationPath}\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${MODEL_CONFIG_ASSET_KEYS.join(", ")}`
    );
  }
  const declaredKeys = MODEL_CONFIG_ASSET_KEYS.filter((key) => declaration[key] !== void 0);
  if (declaredKeys.length === 0) {
    throw new ModelConfigError(
      `\u6A21\u578B\u914D\u7F6E\u58F0\u660E\u672A\u9009\u62E9\u4EFB\u4F55\u8D44\u4EA7\uFF1A${declarationPath}\uFF1B\u81F3\u5C11\u58F0\u660E ${MODEL_CONFIG_ASSET_KEYS.join(" / ")} \u4E4B\u4E00`
    );
  }
  const project = path.resolve(String(projectRoot2));
  const overrides = {};
  for (const key of declaredKeys) {
    const relative = declarationPathValue(declaration, key, declarationPath);
    const resolved = path.resolve(project, ...relative.split("/"));
    if (!isInsideProject(resolved, project)) {
      throw new ModelConfigError(`\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u8D8A\u51FA\u9879\u76EE\u6839\uFF1A${declarationPath}\uFF1A${relative}`);
    }
    if (!assetExists(resolved, key)) {
      throw new ModelConfigError(
        `\u6A21\u578B\u914D\u7F6E\u58F0\u660E ${key} \u6307\u5411\u7684${MODEL_CONFIG_ASSETS[key].kind === "dir" ? "\u76EE\u5F55" : "\u6587\u4EF6"}\u4E0D\u5B58\u5728\uFF1A${declarationPath}\uFF1A${relative}`
      );
    }
    overrides[key] = resolved;
  }
  return { path: declarationPath, exists: true, overrides, declared_keys: declaredKeys };
}
function resolveModelConfigSources({ roots = [], projectRoot: projectRoot2 } = {}) {
  if (!text(projectRoot2)) {
    throw new ModelConfigError("\u89E3\u6790\u6A21\u578B\u914D\u7F6E\u6765\u6E90\u9700\u8981\u9879\u76EE\u6839");
  }
  const global = resolveGlobalModelConfigRoot({ roots });
  const declaration = readModelConfigDeclaration(projectRoot2);
  const assets = {};
  const sources = {};
  for (const key of MODEL_CONFIG_ASSET_KEYS) {
    const declared = declaration.overrides[key];
    assets[key] = declared ?? globalModelConfigAssetPath(global.root, key);
    sources[key] = declared ? "project_declaration" : "global_default";
  }
  return {
    global_root: global.root,
    global_source: global.source,
    declaration_path: declaration.path,
    project_override: Object.keys(declaration.overrides).length > 0,
    declared_keys: declaration.declared_keys,
    agents_dir: assets.agents_dir,
    model_notes: assets.model_notes,
    sources,
    /** 角色 TOML 路径；角色名只做路径拼接，合法性由调用方既有的角色名校验负责。 */
    roleConfigPath(role) {
      const name = `${String(role ?? "").trim()}.toml`;
      const selected = path.join(assets.agents_dir, name);
      return declaration.overrides.agents_dir && !existsSync(selected) ? path.join(global.root, "ops", "agents", name) : selected;
    },
    /** 来源诊断：父进程选型与 runner 验收共用同一份字段。 */
    describe() {
      return {
        global_root: global.root,
        global_source: global.source,
        declaration_path: declaration.path,
        project_override: Object.keys(declaration.overrides).length > 0,
        declared_keys: [...declaration.declared_keys],
        agents_dir: assets.agents_dir,
        model_notes: assets.model_notes,
        sources: { ...sources }
      };
    }
  };
}

// ops/tools/dispatch-core/_tool_common.mjs
var ToolError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
};
function isAbsoluteLikePython(value) {
  const text3 = String(value ?? "");
  if (process3.platform !== "win32") return text3.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(text3) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(text3);
}
function resolveLikePython(value) {
  const absolute = path2.resolve(String(value));
  let current = absolute;
  const tail = [];
  while (true) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? path2.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path2.dirname(current);
      if (parent === current) return absolute;
      tail.push(path2.basename(current));
      current = parent;
    }
  }
}
function repoRoot() {
  const explicit = String(process3.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
  if (explicit) {
    if (!isAbsoluteLikePython(explicit)) throw new ToolError("SUBAGENT_CONTROL_REPO_ROOT must be an absolute path");
    const resolved = resolveLikePython(explicit);
    let info = null;
    try {
      info = statSync2(resolved);
    } catch {
      info = null;
    }
    if (!info || !info.isDirectory()) throw new ToolError(`SUBAGENT_CONTROL_REPO_ROOT is not a directory: ${explicit}`);
    return resolved;
  }
  const scriptRoot = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync2(path2.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  let cur = resolveLikePython(process3.cwd());
  while (true) {
    if (existsSync2(path2.join(cur, ".git")) || existsSync2(path2.join(cur, "AGENTS.md")) && existsSync2(path2.join(cur, "ops"))) {
      return cur;
    }
    const parent = path2.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new ToolError(`cannot locate cockpit repository root from ${resolveLikePython(process3.cwd())}`);
}
function declaredDirectory(envKey) {
  const explicit = String(process3.env[envKey] || "").trim();
  if (!explicit) return null;
  if (!isAbsoluteLikePython(explicit)) throw new ToolError(`${envKey} must be an absolute path`);
  const resolved = resolveLikePython(explicit);
  let info = null;
  try {
    info = statSync2(resolved);
  } catch {
    info = null;
  }
  if (!info || !info.isDirectory()) throw new ToolError(`${envKey} is not a directory: ${explicit}`);
  return resolved;
}
function projectRoot() {
  const explicit = declaredDirectory("SUBAGENT_PROJECT_ROOT");
  if (explicit) return explicit;
  if (String(process3.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const cwd2 = resolveLikePython(process3.cwd());
  let cur = cwd2;
  while (true) {
    if (existsSync2(path2.join(cur, ".git")) || existsSync2(path2.join(cur, "AGENTS.md")) && existsSync2(path2.join(cur, "ops"))) {
      return cur;
    }
    const parent = path2.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return repoRoot();
}
function runtimeRoot() {
  const explicit = declaredDirectory("SUBAGENT_RUNTIME_ROOT");
  if (explicit) return explicit;
  if (String(process3.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim()) return repoRoot();
  const scriptRoot = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (existsSync2(path2.join(scriptRoot, "ops"))) return resolveLikePython(scriptRoot);
  return repoRoot();
}
var ROOT = projectRoot();
var RUNTIME_ROOT = runtimeRoot();

// ops/tools/dispatch-core/model_selection.mjs
var EFFORT_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
var ID_RE = /^[a-z0-9_]+$/;
var ROLE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/;
var PICK_KEYS = Object.freeze(["id", "when", "capability", "model", "effort", "effort_min", "effort_max", "default"]);
var NOTE_KEYS = Object.freeze(["tag", "supports_vision", "description", "efforts", "effort_note"]);
var REMOVED_ROLE_KEYS = Object.freeze({
  pi_model: "\u6539\u5199 [[picks]]",
  pi_model_reasoning_effort: "\u6539\u5199 [[picks]]",
  pi_candidates: "\u6539\u5199 [[picks]]",
  owner_note: "\u6539\u5199 [[picks]]",
  pi_effort_limits: "\u6863\u4F4D\u8303\u56F4\u6539\u5199\u5728\u5404\u63A8\u8350\u884C\u7684 effort_min / effort_max"
});
var REMOVED_NOTE_KEYS = Object.freeze({
  max_effort: "\u53EF\u9009\u6863\u4F4D\u6539\u5199 efforts",
  effort_levels: "\u53EF\u9009\u6863\u4F4D\u6539\u5199 efforts\uFF0C\u5B9E\u6D4B\u8BF4\u660E\u5199 effort_note",
  status: "\u6A21\u578B\u662F\u5426\u53EF\u7528\u4EE5 Pi \u6A21\u578B\u6E05\u5355\u4E3A\u51C6"
});
var WORKER_RESOURCE_LISTS = Object.freeze(["tools", "extensions", "skills"]);
var PROJECT_SKILL_MODES = Object.freeze(["none", "all"]);
var AGENT_BLOCK_RE = /```yaml\s+task_package_agent\s*\n([\s\S]*?)\n```/;
var CARD_RE = /```json\s+route_card\s*\n([\s\S]*?)\n```/;
function fail(code, file, field, message, where = {}) {
  const error = new ToolError(`${field ? `${file} ${field}` : file}\uFF1A${message}`);
  Object.assign(error, { code, file: String(file), field: field || null, ...where });
  throw error;
}
function text2(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function asText(value) {
  return text2(value) ? value.trim() : "";
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
var rank = (level) => EFFORT_LEVELS.indexOf(level);
function readToml(file) {
  if (!text2(file) || !existsSync3(file)) fail("file_invalid", file || "(missing)", "", "\u6587\u4EF6\u4E0D\u5B58\u5728");
  try {
    return parse(readFileSync3(file, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    fail("file_invalid", file, "", `\u4E0D\u662F\u6709\u6548 TOML\uFF1A${error?.message ?? error}`);
  }
}
function optionalText(value, file, field, where) {
  if (value === void 0) return "";
  if (typeof value !== "string") fail("value_invalid", file, field, "\u5FC5\u987B\u662F\u5B57\u7B26\u4E32", where);
  return value.trim();
}
function loadNotes(file) {
  const data = readToml(file);
  const notes = /* @__PURE__ */ new Map();
  if (data.notes !== void 0 && !record(data.notes)) fail("value_invalid", file, "notes", '\u5FC5\u987B\u662F\u8868\uFF0C\u6BCF\u4E2A\u6A21\u578B\u5199\u4E00\u5F20 [notes."<\u6A21\u578B>"]');
  for (const [model2, value] of Object.entries(data.notes ?? {})) {
    const at = `notes."${model2}"`;
    if (!record(value)) fail("value_invalid", file, at, "\u5FC5\u987B\u662F\u8868");
    for (const key of Object.keys(value)) {
      if (REMOVED_NOTE_KEYS[key]) fail("field_removed", file, `${at}.${key}`, `\u5DF2\u5220\u9664\uFF0C${REMOVED_NOTE_KEYS[key]}`);
      if (!NOTE_KEYS.includes(key)) fail("field_unknown", file, `${at}.${key}`, `\u672A\u77E5\u5B57\u6BB5\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${NOTE_KEYS.join("\u3001")}`);
    }
    if (value.supports_vision !== void 0 && typeof value.supports_vision !== "boolean") {
      fail("value_invalid", file, `${at}.supports_vision`, "\u5FC5\u987B\u662F true \u6216 false");
    }
    const efforts = value.efforts ?? EFFORT_LEVELS;
    const ordered = Array.isArray(efforts) && efforts.length > 0 && efforts.every((item, index) => rank(item) >= 0 && (index === 0 || rank(item) > rank(efforts[index - 1])));
    if (!ordered) fail("value_invalid", file, `${at}.efforts`, `\u5FC5\u987B\u662F ${EFFORT_LEVELS.join(" < ")} \u7684\u975E\u7A7A\u5B50\u96C6\uFF0C\u6309\u6863\u4F4D\u987A\u5E8F\u6392\u5217\u4E14\u4E0D\u91CD\u590D`);
    notes.set(model2, {
      tag: optionalText(value.tag, file, `${at}.tag`),
      supports_vision: value.supports_vision ?? null,
      description: optionalText(value.description, file, `${at}.description`),
      efforts: [...efforts],
      effort_note: optionalText(value.effort_note, file, `${at}.effort_note`)
    });
  }
  return notes;
}
function loadRoutes(root) {
  const dir = root ? path3.join(root, "ops", "protocols", "task-package-routes") : "";
  if (!dir || !existsSync3(dir)) return [];
  const routes = [];
  for (const name of readdirSync(dir).filter((item) => item.endsWith(".md")).sort()) {
    const file = path3.join(dir, name);
    const body = readFileSync3(file, "utf8");
    const agent = AGENT_BLOCK_RE.exec(body);
    if (!agent) continue;
    const role = /(?:^|\n)\s*role:\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(agent[1])?.[1] || "";
    const capability = /capability:\s*\n(?:[^\n]*\n){0,4}?\s*name:\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(agent[1])?.[1] || "";
    if (!role || !capability) continue;
    let card = {};
    let phaseError = null;
    try {
      card = JSON.parse(CARD_RE.exec(body)?.[1] ?? "{}");
    } catch (error) {
      phaseError = `route_card \u4E0D\u662F\u6709\u6548 JSON\uFF1A${error?.message ?? error}`;
    }
    const phase = card.dispatch_phase;
    phaseError ??= phase === void 0 ? "\u5C1A\u672A\u5199\u5165 dispatch_phase" : !record(phase) || !["direct", "workflow"].includes(phase.kind) ? "dispatch_phase.kind \u5FC5\u987B\u662F direct \u6216 workflow" : phase.kind === "workflow" && !text2(phase.step) ? "dispatch_phase.step \u7F3A\u5C11\u771F\u5B9E\u6B65\u9AA4" : null;
    routes.push({
      role,
      capability,
      route_id: `${role}__${capability}`,
      description: asText(card.applies_to),
      dispatch_phase: phaseError ? null : { kind: phase.kind, step: text2(phase.step) ? phase.step.trim() : null },
      phase_error: phaseError,
      file
    });
  }
  return routes;
}
function nameList(value, file, field) {
  if (!Array.isArray(value) || value.some((item) => !text2(item))) fail("value_invalid", file, field, "\u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32\u6570\u7EC4");
  return [...new Set(value.map((item) => item.trim()))];
}
function projectSkillsValue(value, file, field) {
  if (PROJECT_SKILL_MODES.includes(value)) return value;
  if (Array.isArray(value)) return nameList(value, file, field);
  fail("value_invalid", file, field, '\u5FC5\u987B\u662F "none"\u3001"all" \u6216 skill \u540D\u5355');
}
function roleWorkerResources(data, file) {
  if (![...WORKER_RESOURCE_LISTS, "project_skills"].some((key) => data[key] !== void 0)) return null;
  return {
    ...Object.fromEntries(WORKER_RESOURCE_LISTS.map((key) => [key, data[key] === void 0 ? [] : nameList(data[key], file, key)])),
    project_skills: data.project_skills === void 0 ? "none" : projectSkillsValue(data.project_skills, file, "project_skills")
  };
}
function capabilityWorkerResources(role, value, file, field) {
  const base = role ?? { tools: [], extensions: [], skills: [], project_skills: "none" };
  const out = { ...base };
  for (const key of WORKER_RESOURCE_LISTS) {
    if (value[key] === void 0) continue;
    const list = nameList(value[key], file, `${field}.${key}`);
    const extra = list.filter((name) => !base[key].includes(name));
    if (extra.length) fail("value_invalid", file, `${field}.${key}`, `\u53EA\u80FD\u6536\u7A84\u89D2\u8272\u6E05\u5355\uFF0C\u591A\u51FA ${extra.join(", ")}`);
    out[key] = list;
  }
  if (value.project_skills !== void 0) {
    const narrowed = projectSkillsValue(value.project_skills, file, `${field}.project_skills`);
    const allowed = base.project_skills === "all" || narrowed === "none" || Array.isArray(base.project_skills) && Array.isArray(narrowed) && narrowed.every((name) => base.project_skills.includes(name));
    if (!allowed) fail("value_invalid", file, `${field}.project_skills`, `\u53EA\u80FD\u6536\u7A84\u89D2\u8272\u7684 project_skills\uFF08\u89D2\u8272\u503C ${JSON.stringify(base.project_skills)}\uFF09`);
    out.project_skills = narrowed;
  }
  return role || [...WORKER_RESOURCE_LISTS, "project_skills"].some((key) => value[key] !== void 0) ? out : null;
}
function effortsOf(notes, model2) {
  return notes.get(model2)?.efforts ?? EFFORT_LEVELS;
}
function loadPick(item, index, file, role, notes, known, ids) {
  const field = `picks[${index}]`;
  const where = { role, pick_id: record(item) && text2(item.id) ? item.id.trim() : null };
  const bad = (code, key, message) => fail(code, file, key ? `${field}.${key}` : field, message, where);
  if (!record(item)) bad("value_invalid", "", "\u5FC5\u987B\u662F\u8868");
  if (item.slot !== void 0) bad("field_removed", "slot", "\u5DF2\u5220\u9664\uFF0C\u6539\u5199 model\uFF08Pi \u6A21\u578B\u5168\u540D\uFF09\u4E0E effort / effort_min / effort_max");
  const unknown = Object.keys(item).find((key) => !PICK_KEYS.includes(key));
  if (unknown) bad("field_unknown", unknown, `\u672A\u77E5\u5B57\u6BB5\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${PICK_KEYS.join("\u3001")}\u3002\u89D2\u8272\u9876\u5C42\u952E\u987B\u5199\u5728\u7B2C\u4E00\u4E2A [[picks]] \u4E4B\u524D`);
  const id = asText(item.id);
  if (!ID_RE.test(id)) bad("value_invalid", "id", `\u5FC5\u987B\u662F ASCII \u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u4E0E\u4E0B\u5212\u7EBF\uFF0C\u5B9E\u5F97 ${JSON.stringify(item.id)}`);
  if (ids.has(id)) bad("pick_duplicate", "id", `${id} \u5728\u89D2\u8272\u5185\u91CD\u590D`);
  ids.add(id);
  if (item.capability !== void 0 && !text2(item.capability)) bad("value_invalid", "capability", "\u4E0D\u80FD\u4E3A\u7A7A\uFF1B\u9002\u7528\u5168\u90E8\u4EFB\u52A1\u65F6\u5220\u9664\u8BE5\u5B57\u6BB5");
  const capability = item.capability === void 0 ? null : item.capability.trim();
  if (capability && !known.has(capability)) bad("capability_unknown", "capability", `${capability} \u4E0D\u662F\u8BE5\u89D2\u8272\u5DF2\u6709\u4EFB\u52A1\u7C7B\u578B`);
  if (!text2(item.model) || !item.model.includes("/")) bad("value_invalid", "model", "\u5FC5\u987B\u662F Pi \u6A21\u578B\u5168\u540D\uFF0C\u4F8B\u5982 openai-codex/gpt-6-sol");
  const model2 = item.model.trim();
  const levels = {};
  for (const key of ["effort", "effort_min", "effort_max"]) {
    if (rank(item[key]) < 0) bad("value_invalid", key, `\u5FC5\u987B\u662F ${EFFORT_LEVELS.join("/")} \u4E4B\u4E00\uFF0C\u5B9E\u5F97 ${JSON.stringify(item[key])}`);
    levels[key] = item[key];
  }
  if (rank(levels.effort_min) > rank(levels.effort_max)) bad("effort_order", "effort_min", `${levels.effort_min} \u9AD8\u4E8E effort_max ${levels.effort_max}`);
  if (rank(levels.effort) < rank(levels.effort_min) || rank(levels.effort) > rank(levels.effort_max)) {
    bad("effort_order", "effort", `${levels.effort} \u4E0D\u5728 effort_min\u2013effort_max\uFF08${levels.effort_min}\u2013${levels.effort_max}\uFF09\u5185`);
  }
  const allowed = effortsOf(notes, model2);
  for (const key of ["effort", "effort_min", "effort_max"]) {
    if (!allowed.includes(levels[key])) {
      bad("effort_not_supported", key, `${levels[key]} \u4E0D\u5728 ${model2} \u7684\u53EF\u9009\u6863\u4F4D\uFF08${allowed.join("/")}\uFF09\u5185\uFF1B\u6539\u9009\u6863\u4F4D\u6216\u5230\u6A21\u578B\u6863\u4F4D\u9875\u8C03\u6574`);
    }
  }
  if (item.default !== void 0 && typeof item.default !== "boolean") bad("value_invalid", "default", "\u5FC5\u987B\u662F true \u6216 false");
  return { id, when: optionalText(item.when, file, `${field}.when`, where), capability, model: model2, ...levels, default: item.default === true };
}
function checkDefaults(picks, known, capabilities, file, role) {
  const seen = /* @__PURE__ */ new Map();
  picks.forEach((pick, index) => {
    if (!pick.default) return;
    const key = pick.capability ?? "";
    if (seen.has(key)) {
      fail("default_duplicate", file, `picks[${index}].default`, pick.capability ? `\u4EFB\u52A1\u7C7B\u578B ${pick.capability} \u7684\u9ED8\u8BA4\u884C\u53EA\u80FD\u6709\u4E00\u884C\uFF08\u5DF2\u6709 ${seen.get(key)}\uFF09` : `\u4E0D\u5E26 capability \u7684\u9ED8\u8BA4\u884C\u53EA\u80FD\u6709\u4E00\u884C\uFF08\u5DF2\u6709 ${seen.get(key)}\uFF09`, { role, pick_id: pick.id });
    }
    seen.set(key, pick.id);
  });
  const lacking = [...known].filter((capability) => !seen.has(capability));
  const sealed = lacking.find((capability) => capabilities.get(capability)?.inherit_role_picks === false);
  if (sealed) {
    fail("default_missing", file, `capabilities.${sealed}`, "\u4E0D\u7EE7\u627F\u89D2\u8272\u63A8\u8350\uFF0C\u5FC5\u987B\u6709\u4E00\u884C capability \u6307\u5411\u5B83\u7684 default \u63A8\u8350\u884C", { role });
  }
  if ((known.size === 0 || lacking.length) && !seen.has("")) {
    fail("default_missing", file, "picks", known.size === 0 ? "\u89D2\u8272\u6CA1\u6709\u4EFB\u52A1\u7C7B\u578B\uFF0C\u5FC5\u987B\u628A\u4E00\u884C\u4E0D\u5E26 capability \u7684\u63A8\u8350\u8BBE\u4E3A default" : `\u4EFB\u52A1\u7C7B\u578B ${lacking.join("\u3001")} \u6CA1\u6709\u4E13\u5C5E\u9ED8\u8BA4\uFF0C\u5FC5\u987B\u628A\u4E00\u884C\u4E0D\u5E26 capability \u7684\u63A8\u8350\u8BBE\u4E3A default`, { role });
  }
}
function loadRoleFile(file, routes, notes) {
  const data = readToml(file);
  const role = asText(data.name);
  if (!role) fail("value_invalid", file, "name", "\u89D2\u8272\u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (`${role}.toml` !== path3.basename(file)) fail("value_invalid", file, "name", `\u4E0E\u6587\u4EF6\u540D\u4E0D\u4E00\u81F4\uFF1A${role}`);
  for (const [key, hint] of Object.entries(REMOVED_ROLE_KEYS)) {
    if (data[key] !== void 0) fail("field_removed", file, key, `\u5DF2\u5220\u9664\uFF0C${hint}`, { role });
  }
  const workerResources2 = roleWorkerResources(data, file);
  const roleRoutes = routes.filter((item) => item.role === role);
  const known = new Set(roleRoutes.map((item) => item.capability));
  const capabilities = /* @__PURE__ */ new Map();
  if (data.capabilities !== void 0 && !record(data.capabilities)) {
    fail("value_invalid", file, "capabilities", "\u5FC5\u987B\u662F\u8868\uFF0C\u6BCF\u4E2A\u4EFB\u52A1\u7C7B\u578B\u5199\u4E00\u5F20 [capabilities.<id>]", { role });
  }
  for (const [capability, value] of Object.entries(data.capabilities ?? {})) {
    const field = `capabilities.${capability}`;
    if (roleRoutes.length && !known.has(capability)) fail("capability_unknown", file, field, "\u4E0D\u662F\u8BE5\u89D2\u8272\u5DF2\u6709\u4EFB\u52A1\u7C7B\u578B", { role });
    if (!record(value)) fail("value_invalid", file, field, "\u5FC5\u987B\u662F\u8868", { role });
    if (value.inherit_role_picks !== void 0 && typeof value.inherit_role_picks !== "boolean") {
      fail("value_invalid", file, `${field}.inherit_role_picks`, "\u5FC5\u987B\u662F true \u6216 false", { role });
    }
    capabilities.set(capability, {
      inherit_role_picks: value.inherit_role_picks !== false,
      worker_resources: capabilityWorkerResources(workerResources2, value, file, field)
    });
    known.add(capability);
  }
  if (!roleRoutes.length && Array.isArray(data.picks)) {
    for (const item of data.picks) if (record(item) && text2(item.capability)) known.add(item.capability.trim());
  }
  if (!Array.isArray(data.picks) || !data.picks.length) fail("value_invalid", file, "picks", "\u81F3\u5C11\u8981\u6709\u4E00\u884C\u63A8\u8350", { role });
  const ids = /* @__PURE__ */ new Set();
  const picks = data.picks.map((item, index) => loadPick(item, index, file, role, notes, known, ids));
  checkDefaults(picks, known, capabilities, file, role);
  return {
    role,
    description: asText(data.description),
    file,
    picks,
    capabilities,
    routes: roleRoutes,
    known_capabilities: known,
    worker_resources: workerResources2
  };
}
function roleNames(sources) {
  const names = /* @__PURE__ */ new Set();
  for (const dir of [sources.agents_dir, text2(sources.global_root) ? path3.join(sources.global_root, "ops", "agents") : ""]) {
    if (!text2(dir) || !existsSync3(dir)) continue;
    for (const name of readdirSync(dir)) if (ROLE_FILE_RE.test(name)) names.add(name.slice(0, -".toml".length));
  }
  return [...names].sort();
}
function loadSelectionConfig(sources) {
  if (!record(sources) || typeof sources.roleConfigPath !== "function") {
    throw new ToolError("loadSelectionConfig \u9700\u8981 resolveModelConfigSources \u7684\u8FD4\u56DE\u5BF9\u8C61");
  }
  const notes = loadNotes(sources.model_notes);
  const routes = loadRoutes(sources.global_root);
  const roles = /* @__PURE__ */ new Map();
  for (const name of roleNames(sources)) {
    const file = sources.roleConfigPath(name);
    if (existsSync3(file)) roles.set(name, loadRoleFile(file, routes, notes));
  }
  return {
    sources,
    config_source: sources.describe(),
    notes,
    routes,
    roles,
    warnings: routes.filter((route) => route.phase_error).map((route) => ({ code: "dispatch_phase_invalid", file: route.file, field: "dispatch_phase", role: route.role, message: route.phase_error }))
  };
}
function modelEfforts(config, model2) {
  return [...effortsOf(config.notes, model2)];
}
function roleRecord(config, role) {
  const found = config.roles.get(role);
  if (!found) throw new ToolError(`\u672A\u77E5\u89D2\u8272\uFF1A${role || "(\u7A7A)"}`);
  return found;
}
function requireCapability(role, capability) {
  if (!text2(capability)) throw new ToolError(`\u89E3\u6790 ${role.role} \u5FC5\u987B\u7ED9\u51FA\u4EFB\u52A1\u7C7B\u578B`);
  if (role.known_capabilities.size && !role.known_capabilities.has(capability)) {
    throw new ToolError(`${role.file}\uFF1A${capability} \u4E0D\u662F\u8BE5\u89D2\u8272\u5DF2\u6709\u4EFB\u52A1\u7C7B\u578B`);
  }
}
function resolveWorkerResources(config, roleName, capability) {
  const role = roleRecord(config, roleName);
  requireCapability(role, capability);
  const effective = role.capabilities.has(capability) ? role.capabilities.get(capability).worker_resources : role.worker_resources;
  return effective ? structuredClone(effective) : null;
}

// ops/tools/pi_model_extension_profile.mjs
import { existsSync as existsSync4 } from "node:fs";
import { homedir } from "node:os";
import path4 from "node:path";
var PI_CHILD_MODEL_EXTENSION_PROFILE = "pi-child-model-extensions/v1";
var RELATIVE_EXTENSION_PATHS = Object.freeze([
  "extensions/openai-codex-sol-context-alias.ts",
  "npm/node_modules/pi-claude-code-provider/extensions/pi-claude-code-provider.ts",
  "npm/node_modules/@tian.zuo/pi-antigravity/index.ts"
]);
function resolvePiAgentDir(env = process.env) {
  const configured = String(env.PI_CODING_AGENT_DIR || "").trim();
  return path4.resolve(configured || path4.join(homedir(), ".pi", "agent"));
}
function resolvePiChildModelExtensions(options = {}) {
  const env = options.env || process.env;
  if (String(env.PI_CONTROL_PI || "").trim()) return [];
  const exists = options.exists || existsSync4;
  const agentDir = path4.resolve(options.agentDir || resolvePiAgentDir(env));
  return RELATIVE_EXTENSION_PATHS.map((relativePath) => path4.join(agentDir, ...relativePath.split("/"))).filter((candidate) => exists(candidate));
}
function isPiModelExtensionProfileCli(argv1 = process.argv[1]) {
  return path4.basename(String(argv1 || "")).toLowerCase() === "pi_model_extension_profile.mjs";
}
if (isPiModelExtensionProfileCli()) {
  if (process.argv.slice(2).some((arg) => arg !== "--json")) {
    process.stderr.write("Usage: node ops/tools/pi_model_extension_profile.mjs [--json]\n");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify({
    profile: PI_CHILD_MODEL_EXTENSION_PROFILE,
    extensions: resolvePiChildModelExtensions()
  })}
`);
}

// ops/tools/pi_compaction_extension_profile.mjs
import { existsSync as existsSync5 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import path5 from "node:path";
var PI_CHILD_COMPACTION_EXTENSION_PROFILE = "pi-child-compaction-extensions/v1";
var RELATIVE_EXTENSION_PATHS2 = Object.freeze([
  "npm/node_modules/pi-compaction-model/src/index.ts",
  "npm/node_modules/pi-midrun-compact/index.ts"
]);
function resolvePiAgentDir2(env = process.env) {
  const configured = String(env.PI_CODING_AGENT_DIR || "").trim();
  return path5.resolve(configured || path5.join(homedir2(), ".pi", "agent"));
}
function resolvePiChildCompactionExtensions(options = {}) {
  const env = options.env || process.env;
  if (String(env.PI_CONTROL_PI || "").trim()) return [];
  const exists = options.exists || existsSync5;
  const agentDir = path5.resolve(options.agentDir || resolvePiAgentDir2(env));
  return RELATIVE_EXTENSION_PATHS2.map((relativePath) => path5.join(agentDir, ...relativePath.split("/"))).filter((candidate) => exists(candidate));
}
function isPiCompactionExtensionProfileCli(argv1 = process.argv[1]) {
  return path5.basename(String(argv1 || "")).toLowerCase() === "pi_compaction_extension_profile.mjs";
}
if (isPiCompactionExtensionProfileCli()) {
  if (process.argv.slice(2).some((arg) => arg !== "--json")) {
    process.stderr.write("Usage: node ops/tools/pi_compaction_extension_profile.mjs [--json]\n");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify({
    profile: PI_CHILD_COMPACTION_EXTENSION_PROFILE,
    extensions: resolvePiChildCompactionExtensions()
  })}
`);
}

// ops/tools/pi_worker_resources.mjs
import { spawn } from "node:child_process";
import { existsSync as existsSync6, mkdirSync as mkdirSync2, readFileSync as readFileSync4, statSync as statSync3, writeFileSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import path6 from "node:path";
import { fileURLToPath as fileURLToPath2, pathToFileURL } from "node:url";
var WORKER_RESOURCES_CONFIG = path6.resolve(path6.dirname(fileURLToPath2(import.meta.url)), "../templates/worker-resources.json");
var IMPORT_ACCESS = Object.freeze(["off", "optional", "default_on"]);
var BUILTIN_TOOLS = Object.freeze(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
var RUNNER_TOOLS = Object.freeze(["research_search", "research_fetch", "command_job"]);
var PI_CLI = path6.join(process.env.APPDATA || path6.join(homedir3(), "AppData", "Roaming"), "npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
var PROBE_TIMEOUT_MS = 6e4;
var PROBE_SCRIPT = `import { pathToFileURL } from "node:url";
const { loadExtensions } = await import(pathToFileURL(process.env.PI_TOOL_PROBE_LOADER).href);
const { extensions, errors } = await loadExtensions(JSON.parse(process.env.PI_TOOL_PROBE_EXTENSIONS), process.cwd());
if (errors.length) throw new Error(errors.map(({ path, error }) => path + ": " + error).join("; "));
console.log(JSON.stringify([...new Set(extensions.flatMap((extension) => [...extension.tools.keys()]))]));
`;
var probes = /* @__PURE__ */ new Map();
var SECTIONS = Object.freeze(["tools", "extensions", "skills"]);
var ENTRY_KEYS = Object.freeze({ tools: ["access", "label", "group"], extensions: ["access", "label"], skills: ["access", "label"] });
var REMOVED_KEYS = Object.freeze({
  base_extensions: '\u6539\u5199\u4E3A extensions \u4E2D access = "default_on" \u7684\u6761\u76EE',
  main_only_extensions: '\u6539\u5199\u4E3A extensions \u4E2D access = "off" \u7684\u6761\u76EE',
  main_only_skills: '\u6539\u5199\u4E3A skills \u4E2D access = "off" \u7684\u6761\u76EE',
  force_excluded_tools: '\u6539\u5199\u4E3A tools \u4E2D access = "off" \u7684\u6761\u76EE'
});
function configError(code, file, field, message) {
  return Object.assign(new Error(`${file} ${field}\uFF1A${message}`), { code, file, field });
}
function literalLength(key) {
  return key.replaceAll("*", "").length;
}
function matches(value, pattern) {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}
function packageJsonName(dir) {
  const file = path6.join(dir, "package.json");
  if (!existsSync6(file)) return null;
  const name = JSON.parse(readFileSync4(file, "utf8")).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
function resourceName(file) {
  const parts = String(file).replaceAll("\\", "/").split("/").filter(Boolean);
  const last = parts.length - 1;
  if (parts[last] === "SKILL.md") return parts[last - 1];
  const modules = parts.lastIndexOf("node_modules");
  if (modules >= 0 && modules < last) {
    return parts[modules + 1].startsWith("@") ? `${parts[modules + 1]}/${parts[modules + 2]}` : parts[modules + 1];
  }
  const local = parts.lastIndexOf("local-packages");
  if (local >= 0 && local < last) {
    const dir = parts.slice(0, local + 2).join("/");
    return packageJsonName(/^[A-Za-z]:$/.test(parts[0]) ? dir : `/${dir}`) ?? parts[local + 1];
  }
  const extensions = parts.lastIndexOf("extensions");
  if (extensions >= 0 && extensions === last - 1) return parts[last].replace(/\.[^.]+$/, "");
  if (extensions >= 0 && extensions < last) return parts[extensions + 1];
  return parts[last].replace(/\.[^.]+$/, "");
}
function loadWorkerResourcesConfig(configPath = WORKER_RESOURCES_CONFIG) {
  const raw = JSON.parse(readFileSync4(configPath, "utf8"));
  for (const [key, hint] of Object.entries(REMOVED_KEYS)) {
    if (raw[key] !== void 0) throw configError("field_removed", configPath, key, `\u5DF2\u5220\u9664\uFF0C${hint}`);
  }
  if (raw.version !== 2) throw configError("value_invalid", configPath, "version", "\u5FC5\u987B\u4E3A 2");
  const config = { configPath };
  for (const section of SECTIONS) {
    const entries = raw[section];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw configError("value_invalid", configPath, section, "\u5FC5\u987B\u5B58\u5728\u4E14\u662F\u5BF9\u8C61\uFF1B\u6CA1\u6709\u6761\u76EE\u65F6\u5199 {}");
    }
    for (const [key, entry] of Object.entries(entries)) {
      const field = `${section}.${key}`;
      if (section === "tools" && key.includes("*")) throw configError("value_invalid", configPath, field, "\u5DE5\u5177\u53EA\u5199\u5177\u4F53\u540D\u5B57\uFF0C\u4E0D\u652F\u6301 *");
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw configError("value_invalid", configPath, field, "\u5FC5\u987B\u662F\u5BF9\u8C61");
      const unknown = Object.keys(entry).find((item) => !ENTRY_KEYS[section].includes(item));
      if (unknown) throw configError("field_unknown", configPath, `${field}.${unknown}`, `\u672A\u77E5\u5B57\u6BB5\uFF1B\u53EF\u7528\u5B57\u6BB5\uFF1A${ENTRY_KEYS[section].join("\u3001")}`);
      if (!IMPORT_ACCESS.includes(entry.access)) throw configError("value_invalid", configPath, `${field}.access`, `\u5FC5\u987B\u662F ${IMPORT_ACCESS.join(" / ")} \u4E4B\u4E00`);
      for (const text3 of ["label", "group"]) {
        if (entry[text3] !== void 0 && typeof entry[text3] !== "string") throw configError("value_invalid", configPath, `${field}.${text3}`, "\u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
      }
    }
    config[section] = entries;
  }
  const required = raw.required_tools;
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !name.trim())) {
    throw configError("value_invalid", configPath, "required_tools", "\u5FC5\u987B\u662F\u5DE5\u5177\u540D\u6570\u7EC4");
  }
  for (const name of required) {
    if (config.tools[name]?.access === "off") throw configError("value_invalid", configPath, `tools.${name}.access`, "\u8FD0\u884C\u5FC5\u9700\u5DE5\u5177\u4E0D\u80FD\u8BBE\u4E3A off");
  }
  config.required_tools = [...required];
  return config;
}
function importEntry(config, section, name) {
  const hits = Object.keys(config[section]).filter((key) => matches(name, key));
  if (!hits.length) return null;
  const rank2 = (key) => key.includes("*") ? literalLength(key) : Number.POSITIVE_INFINITY;
  const best = Math.max(...hits.map(rank2));
  const top = hits.filter((key) => rank2(key) === best);
  if (top.length > 1) {
    throw configError("value_invalid", config.configPath, section, `${name} \u540C\u65F6\u5339\u914D ${top.join("\u3001")}\uFF1B\u5220\u53BB\u91CD\u590D\u6216\u5199\u51FA\u66F4\u5177\u4F53\u7684\u952E`);
  }
  return { key: top[0], ...config[section][top[0]] };
}
function accessOf(config, section, name) {
  if (section === "tools" && config.required_tools.includes(name)) return "default_on";
  return importEntry(config, section, name)?.access ?? "off";
}
async function discoverWorkerResources({
  cwd: cwd2 = process.cwd(),
  agentDir = process.env.PI_CODING_AGENT_DIR || path6.join(homedir3(), ".pi", "agent"),
  piCli: piCli2 = PI_CLI
} = {}) {
  const { DefaultPackageManager, SettingsManager } = await import(pathToFileURL(path6.join(path6.dirname(piCli2), "index.js")).href);
  const settingsPath = path6.join(agentDir, "settings.json");
  const settings = existsSync6(settingsPath) ? JSON.parse(readFileSync4(settingsPath, "utf8")) : {};
  const manager = new DefaultPackageManager({ cwd: cwd2, agentDir, settingsManager: SettingsManager.inMemory(settings) });
  const missing = [];
  const resolved = await manager.resolve(async (source) => {
    missing.push(source);
    return "skip";
  });
  const enabled = (type) => (resolved[type] || []).filter((item) => item.enabled && ["user", "project"].includes(item.metadata?.scope)).map((item) => ({ name: resourceName(item.path), path: item.path, scope: item.metadata.scope }));
  return { settingsPath, extensions: enabled("extensions"), skills: enabled("skills"), missing };
}
function probeRegisteredTools({ extensions, piCli: piCli2 = PI_CLI, cacheFile, cwd: cwd2 = process.cwd() }) {
  const key = JSON.stringify(["registration-only/v1", path6.resolve(cwd2), ...[piCli2, ...extensions.map((item) => item.path)].map((file) => [file, existsSync6(file) ? statSync3(file).mtimeMs : 0])]);
  const cached = existsSync6(cacheFile) ? JSON.parse(readFileSync4(cacheFile, "utf8")) : null;
  if (cached?.key === key) return Promise.resolve(cached.tools);
  const id = `${cacheFile}
${key}`;
  if (!probes.has(id)) {
    probes.set(id, runToolProbe(extensions, piCli2, cwd2).then((tools) => {
      mkdirSync2(path6.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ key, tools }));
      return tools;
    }).finally(() => probes.delete(id)));
  }
  return probes.get(id);
}
function runToolProbe(extensions, piCli2, cwd2) {
  const loader = path6.join(path6.dirname(piCli2), "core", "extensions", "loader.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", PROBE_SCRIPT], {
      cwd: cwd2,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PI_TOOL_PROBE_LOADER: loader, PI_TOOL_PROBE_EXTENSIONS: JSON.stringify(extensions.map((item) => item.path)) }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Pi \u6269\u5C55\u6CE8\u518C\u63A2\u6D4B\u5931\u8D25\uFF08exit ${code}\uFF09${stderr.trim() ? `\uFF1A${stderr.trim().slice(-400)}` : ""}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`Pi \u5DE5\u5177\u6CE8\u518C\u8868\u65E0\u6CD5\u89E3\u6790\uFF1A${error.message}`));
      }
    });
  });
}
function catalogEntries(config, section, installed) {
  const rows = installed.map(({ name, scope }) => {
    const entry = importEntry(config, section, name);
    return { key: entry?.key ?? null, name, access: entry?.access ?? "off", label: entry?.label ?? "", installed: true, scope };
  });
  for (const [key, entry] of Object.entries(config[section])) {
    if (!installed.some(({ name }) => matches(name, key))) {
      rows.push({ key, name: key, access: entry.access, label: entry.label ?? "", installed: false, scope: null });
    }
  }
  return rows;
}
async function resolveWorkerResourceCatalog({
  cwd: cwd2 = process.cwd(),
  agentDir,
  configPath = WORKER_RESOURCES_CONFIG,
  piCli: piCli2 = PI_CLI,
  toolCache = path6.join(cwd2, ".runtime", "cockpit", "worker-tool-probe.json"),
  probeTools = probeRegisteredTools
} = {}) {
  const config = loadWorkerResourcesConfig(configPath);
  const found = await discoverWorkerResources({ cwd: cwd2, agentDir, piCli: piCli2 });
  const diagnostics = found.missing.map((source) => ({ code: "not_installed", file: found.settingsPath, field: "packages", message: `\u5DF2\u914D\u7F6E\u7684 Pi \u8D44\u6E90\u672A\u5B89\u88C5\uFF1A${source}` }));
  const known = /* @__PURE__ */ new Set([...BUILTIN_TOOLS, ...RUNNER_TOOLS]);
  try {
    for (const name of await probeTools({ extensions: found.extensions, piCli: piCli2, cacheFile: toolCache, cwd: cwd2 })) known.add(name);
  } catch (error) {
    diagnostics.push({ code: "tool_probe_failed", file: found.settingsPath, field: "extensions", message: `\u8BFB\u53D6\u5DF2\u88C5\u63D2\u4EF6\u6CE8\u518C\u7684\u5DE5\u5177\u5931\u8D25\uFF0C\u5DE5\u5177\u8868\u53EA\u542B\u5185\u7F6E\u5DE5\u5177\uFF1A${error.message}` });
  }
  const toolNames = [.../* @__PURE__ */ new Set([...known, ...Object.keys(config.tools), ...config.required_tools])].sort();
  return {
    configPath,
    settingsPath: found.settingsPath,
    tools: toolNames.map((name) => {
      const entry = config.tools[name];
      return {
        key: entry ? name : null,
        name,
        access: accessOf(config, "tools", name),
        label: entry?.label ?? "",
        group: entry?.group ?? "",
        installed: known.has(name) || config.required_tools.includes(name)
      };
    }),
    extensions: catalogEntries(config, "extensions", found.extensions),
    skills: catalogEntries(config, "skills", found.skills.filter((item) => item.scope === "user")),
    project_skills: found.skills.filter((item) => item.scope === "project").map(({ name, scope }) => ({ name, scope })),
    required_tools: config.required_tools,
    diagnostics
  };
}
function selectTaskResources(config, installed, spec) {
  const warnings = [];
  const pick = (section, type, entries, names, { first = false } = {}) => {
    const chosen = entries.filter((item) => accessOf(config, section, item.name) === "default_on");
    for (const name of names) {
      const found = entries.filter((item) => item.name === name);
      const access = accessOf(config, section, name);
      if (access === "off") warnings.push({ type, name, reason: "off" });
      else if (!found.length) warnings.push({ type, name, reason: "not_installed" });
      else if (access === "optional") chosen.push(...found);
    }
    const seen = /* @__PURE__ */ new Set();
    return chosen.filter((item) => {
      const key = first ? `${item.scope}:${item.name}` : item.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const userSkills = pick("skills", "skill", installed.skills.filter((item) => item.scope === "user"), spec.skills, { first: true });
  const projectSkills = installed.skills.filter((item) => item.scope === "project");
  const projectNames = spec.project_skills === "all" ? [...new Set(projectSkills.map((item) => item.name))] : Array.isArray(spec.project_skills) ? spec.project_skills : [];
  const chosenProject = [];
  for (const name of projectNames) {
    const found = projectSkills.find((item) => item.name === name);
    if (userSkills.some((item) => item.name === name)) warnings.push({ type: "project_skill", name, reason: "shadowed_by_user_skill" });
    else if (!found) warnings.push({ type: "project_skill", name, reason: "not_installed" });
    else chosenProject.push(found);
  }
  return {
    extensions: pick("extensions", "extension", installed.extensions, spec.extensions),
    skills: [...userSkills, ...chosenProject],
    warnings
  };
}
function workerSpawnTools(allowed, config, submitTool2 = null) {
  if (allowed === null) return { tools: null, dropped: [] };
  const required = config.required_tools;
  const surface = allowed.filter((name) => !required.includes(name) && accessOf(config, "tools", name) !== "off");
  const tools = surface.includes("bash") ? surface : surface.filter((name) => name !== "command_job");
  return {
    tools: [...tools, ...submitTool2 ? [submitTool2] : []],
    dropped: allowed.filter((name) => !required.includes(name) && !surface.includes(name))
  };
}
function excludedTools(config) {
  return Object.keys(config.tools).filter((name) => config.tools[name].access === "off");
}
if (path6.basename(process.argv[1] || "") === "pi_worker_resources.mjs") {
  if (process.argv.slice(2).some((arg) => arg !== "--json")) {
    console.error("Usage: node ops/tools/pi_worker_resources.mjs --json");
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await resolveWorkerResourceCatalog(), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

// ops/tools/pi_child_command_jobs.mjs
import * as fs from "node:fs";
import path7 from "node:path";

// ops/tools/pi_child_bash_process_tree.mjs
import * as piChildBashFs from "node:fs";
import * as piChildBashProcess from "node:child_process";
import piChildBashPath from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";
var PI_CHILD_BASH_PROCESS_TREE_PROFILE = "pi-child-bash-process-tree/v1";
var PI_CHILD_BASH_DEFAULT_TIMEOUT_SECONDS = 120;
var PI_CHILD_BASH_MAX_TIMEOUT_SECONDS = 600;
var PI_CHILD_BASH_DEFAULT_SCRATCH = "C:\\tmp\\agent-scratch";
function childBashSpawnEnv(baseEnv, platform = process.platform) {
  const env = { ...baseEnv || {} };
  if (platform !== "win32") return env;
  const scratch = String(env.PI_CONTROL_BASH_SCRATCH || "").trim() || PI_CHILD_BASH_DEFAULT_SCRATCH;
  env.TMP = scratch;
  env.TEMP = scratch;
  env.TMPDIR = scratch;
  return env;
}
function resolveChildBashTimeout(value) {
  const seconds = value ?? PI_CHILD_BASH_DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > PI_CHILD_BASH_MAX_TIMEOUT_SECONDS) {
    throw new Error(`Invalid timeout: \u5B50\u4EE3\u7406Bash\u524D\u53F0timeout\u5355\u4F4D\u4E3A\u79D2\uFF0C\u987B\u5927\u4E8E0\u4E14\u4E0D\u8D85\u8FC7${PI_CHILD_BASH_MAX_TIMEOUT_SECONDS}\uFF1B\u68C0\u67E5\u79D2/\u6BEB\u79D2\uFF0C\u957F\u4EFB\u52A1\u6539\u8D70\u540E\u53F0\u3002\u547D\u4EE4\u672A\u542F\u52A8\u3002`);
  }
  return seconds;
}
function resolveChildBash(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const exists = options.exists || piChildBashFs.existsSync;
  const spawnSyncFn = options.spawnSyncFn || piChildBashProcess.spawnSync;
  const configured = String(env.PI_CONTROL_BASH_PATH || "").trim();
  if (configured) {
    if (!exists(configured)) throw new Error(`PI_CONTROL_BASH_PATH does not exist: ${configured}`);
    return configured;
  }
  if (platform !== "win32") {
    if (exists("/bin/bash")) return "/bin/bash";
    const found2 = spawnSyncFn("which", ["bash"], { encoding: "utf8", timeout: 5e3, env });
    const candidate2 = String(found2.stdout || "").trim().split(/\r?\n/)[0];
    return candidate2 || "sh";
  }
  const pathApi = piChildBashPath.win32;
  const candidates = [
    env.ProgramFiles ? pathApi.join(env.ProgramFiles, "Git", "bin", "bash.exe") : "",
    env["ProgramFiles(x86)"] ? pathApi.join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe") : ""
  ].filter(Boolean);
  for (const candidate2 of candidates) {
    if (exists(candidate2)) return candidate2;
  }
  const found = spawnSyncFn("where.exe", ["bash.exe"], {
    encoding: "utf8",
    timeout: 5e3,
    windowsHide: true,
    env
  });
  const candidate = String(found.stdout || "").trim().split(/\r?\n/)[0];
  if (candidate && exists(candidate)) return candidate;
  const gitFound = spawnSyncFn("where.exe", ["git.exe"], {
    encoding: "utf8",
    timeout: 5e3,
    windowsHide: true,
    env
  });
  const gitExecutables = String(gitFound.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  for (const gitExecutable of gitExecutables) {
    let ancestor = pathApi.dirname(gitExecutable);
    for (let depth = 0; depth < 4; depth += 1) {
      for (const relative of [["bin", "bash.exe"], ["usr", "bin", "bash.exe"]]) {
        const bashCandidate = pathApi.join(ancestor, ...relative);
        if (exists(bashCandidate)) return bashCandidate;
      }
      const parent = pathApi.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  throw new Error("No Bash executable found for Pi child task");
}
function snapshotChildProcessTree(roots, options = {}) {
  const platform = options.platform || process.platform;
  const run = options.spawnSyncFn || piChildBashProcess.spawnSync;
  const result2 = platform === "win32" ? run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 5e3, windowsHide: true }) : run("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 5e3 });
  if (result2.status !== 0 || result2.error) return null;
  let entries;
  try {
    if (platform === "win32") {
      const data = JSON.parse(String(result2.stdout));
      entries = (Array.isArray(data) ? data : [data]).map((item) => [Number(item.ProcessId), Number(item.ParentProcessId)]);
    } else {
      entries = String(result2.stdout).trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
    }
  } catch {
    return null;
  }
  const selected = new Set(roots.map(Number));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of entries) {
      if (selected.has(parent) && !selected.has(pid)) {
        selected.add(pid);
        changed = true;
      }
    }
  }
  return entries.filter(([pid]) => selected.has(pid)).map(([pid]) => pid);
}
function terminateChildProcessTree(pid, options = {}) {
  const platform = options.platform || process.platform;
  const spawnSyncFn = options.spawnSyncFn || piChildBashProcess.spawnSync;
  if (!pid) return { requested: false, reason: "missing_pid" };
  const tracked = snapshotChildProcessTree([pid], { platform, spawnSyncFn });
  const observed = Array.isArray(tracked) && tracked.includes(Number(pid));
  options.onCaptured?.({ pid, tracked_pids: tracked, observed, confirmed: false });
  const proof = (exitCode) => {
    const remaining = observed ? snapshotChildProcessTree(tracked, { platform, spawnSyncFn }) : null;
    return { tracked_pids: tracked, observed, remaining_pids: remaining, confirmed: exitCode === 0 && observed && remaining?.length === 0 };
  };
  if (platform === "win32") {
    const result2 = spawnSyncFn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      timeout: 15e3,
      windowsHide: true
    });
    return {
      requested: true,
      exitCode: result2.status ?? null,
      error: result2.error?.message || null,
      ...proof(result2.status)
    };
  }
  try {
    process.kill(-Number(pid), "SIGKILL");
    return { requested: true, exitCode: 0, error: null, ...proof(0) };
  } catch {
    try {
      process.kill(Number(pid), "SIGKILL");
      return { requested: true, exitCode: 0, error: null, ...proof(0) };
    } catch (error) {
      return { requested: false, reason: "kill_failed", error: error?.message || String(error), ...proof(null) };
    }
  }
}
function waitForChildProcess(child) {
  const EXIT_STDIO_GRACE_MS = 100;
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode = null;
    let postExitTimer;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = void 0;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };
    const finalize = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onExit = (code) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code) => {
      finalize(code);
    };
    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}
function createTreeSafeBashOperations(options = {}) {
  const platform = options.platform || process.platform;
  const spawnFn = options.spawnFn || piChildBashProcess.spawn;
  const terminateTree = options.terminateTree || ((pid, onCaptured) => terminateChildProcessTree(pid, { platform, onCaptured }));
  const shell = options.shell || resolveChildBash({ ...options, platform });
  const normalizedShell = shell.replace(/\//g, "\\").toLowerCase();
  const commandFromStdin = platform === "win32" && /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalizedShell);
  return {
    async exec(command, cwd2, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");
      timeout = resolveChildBashTimeout(timeout);
      const spawnEnv = childBashSpawnEnv(env, platform);
      if (platform === "win32" && spawnEnv.TEMP) piChildBashFs.mkdirSync(spawnEnv.TEMP, { recursive: true });
      const child = spawnFn(shell, commandFromStdin ? ["-s"] : ["-c", command], {
        cwd: cwd2,
        detached: platform !== "win32",
        env: spawnEnv,
        stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true
      });
      if (commandFromStdin) {
        child.stdin?.on("error", () => {
        });
        child.stdin?.end(command);
      }
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const exitPromise = waitForChildProcess(child).then((code) => ({ type: "exit", exitCode: code }));
      let timeoutHandle;
      let abortHandler;
      const timeoutPromise = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ type: "timeout" }), timeout * 1e3);
      });
      const abortPromise = !signal ? new Promise(() => {
      }) : new Promise((resolve) => {
        abortHandler = () => resolve({ type: "abort" });
        signal.addEventListener("abort", abortHandler, { once: true });
      });
      try {
        const outcome = await Promise.race([exitPromise, timeoutPromise, abortPromise]);
        if (outcome.type === "exit") return { exitCode: outcome.exitCode };
        const termination = terminateTree(child.pid, (record2) => options.onCleanup?.(record2));
        const stopped = await Promise.race([
          exitPromise.catch(() => ({ type: "exit", exitCode: null })),
          new Promise((resolve) => setTimeout(resolve, 2e3))
        ]);
        const remaining = termination?.observed && !termination.confirmed && stopped?.type === "exit" ? snapshotChildProcessTree(termination.tracked_pids, { platform }) : termination?.remaining_pids;
        options.onCleanup?.({
          ...termination,
          pid: child.pid,
          remaining_pids: remaining,
          confirmed: termination?.exitCode === 0 && termination?.observed === true && remaining?.length === 0 && stopped?.type === "exit"
        });
        const detail = termination?.error || termination?.exitCode && `taskkill exit ${termination.exitCode}` || "";
        throw new Error(`${outcome.type === "abort" ? "aborted" : `timeout:${timeout}`}${detail ? ` (${detail})` : ""}`);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      }
    }
  };
}
function resolvePiChildBashToolModule(piCli2, options = {}) {
  const exists = options.exists || piChildBashFs.existsSync;
  const modulePath = piChildBashPath.join(piChildBashPath.dirname(piChildBashPath.resolve(String(piCli2 || ""))), "core", "tools", "bash.js");
  if (!exists(modulePath)) {
    throw new Error(`Pi Bash tool module does not exist beside CLI: ${modulePath}`);
  }
  return pathToFileURL2(modulePath).href;
}
async function installPiChildBashProcessTreeWithModule(pi, moduleSpecifier, shell, cleanupPath) {
  const { createBashTool } = await import(moduleSpecifier);
  pi.on("session_start", (_event, ctx) => {
    const original = createBashTool(ctx.cwd);
    pi.registerTool({
      ...original,
      parameters: {
        ...original.parameters,
        properties: {
          ...original.parameters.properties,
          timeout: {
            ...original.parameters.properties.timeout,
            description: `\u524D\u53F0\u8D85\u65F6\uFF0C\u5355\u4F4D\u79D2\uFF08\u4F8B\u598260\u4E3A1\u5206\u949F\u3001120\u4E3A2\u5206\u949F\uFF09\uFF1B\u7701\u7565\u4E3A${PI_CHILD_BASH_DEFAULT_TIMEOUT_SECONDS}\u79D2\uFF0C\u6700\u957F${PI_CHILD_BASH_MAX_TIMEOUT_SECONDS}\u79D2\u3002\u957F\u4EFB\u52A1\u6539\u8D70\u540E\u53F0\u3002`,
            exclusiveMinimum: 0,
            maximum: PI_CHILD_BASH_MAX_TIMEOUT_SECONDS
          }
        }
      },
      execute(toolCallId, ...args2) {
        const tool = createBashTool(ctx.cwd, { operations: createTreeSafeBashOperations({
          ...shell ? { shell } : {},
          onCleanup: cleanupPath ? (record2) => piChildBashFs.appendFileSync(cleanupPath, JSON.stringify({ ...record2, tool_call_id: toolCallId }) + "\n", "utf8") : void 0
        }) });
        return tool.execute(toolCallId, ...args2);
      }
    });
  });
}
function renderPiChildBashProcessTreeSource({ bashToolModuleUrl, bashExecutable, cleanupPath = null } = {}) {
  const moduleSpecifier = String(bashToolModuleUrl || "").trim();
  const shell = String(bashExecutable || "").trim();
  if (!moduleSpecifier.startsWith("file:")) {
    throw new Error("Pi child Bash extension requires an absolute Bash tool module file URL");
  }
  if (!shell) {
    throw new Error("Pi child Bash extension requires a runner-resolved Bash executable");
  }
  return [
    'import * as piChildBashFs from "node:fs";',
    'import * as piChildBashProcess from "node:child_process";',
    'import piChildBashPath from "node:path";',
    `const PI_CHILD_BASH_DEFAULT_TIMEOUT_SECONDS = ${PI_CHILD_BASH_DEFAULT_TIMEOUT_SECONDS};`,
    `const PI_CHILD_BASH_MAX_TIMEOUT_SECONDS = ${PI_CHILD_BASH_MAX_TIMEOUT_SECONDS};`,
    `const PI_CHILD_BASH_DEFAULT_SCRATCH = ${JSON.stringify(PI_CHILD_BASH_DEFAULT_SCRATCH)};`,
    `const childBashSpawnEnv = ${childBashSpawnEnv.toString()};`,
    `const resolveChildBashTimeout = ${resolveChildBashTimeout.toString()};`,
    `const resolveChildBash = ${resolveChildBash.toString()};`,
    `const snapshotChildProcessTree = ${snapshotChildProcessTree.toString()};`,
    `const terminateChildProcessTree = ${terminateChildProcessTree.toString()};`,
    `const waitForChildProcess = ${waitForChildProcess.toString()};`,
    `const createTreeSafeBashOperations = ${createTreeSafeBashOperations.toString()};`,
    `const installPiChildBashProcessTreeWithModule = ${installPiChildBashProcessTreeWithModule.toString()};`,
    `const installPiChildBashProcessTree = (pi) => installPiChildBashProcessTreeWithModule(pi, ${JSON.stringify(moduleSpecifier)}, ${JSON.stringify(shell)}, ${JSON.stringify(cleanupPath)});`,
    "export default installPiChildBashProcessTree;"
  ].join("\n");
}

// ops/tools/pi_child_command_jobs.mjs
var COMMAND_JOBS_VERSION = "pi-command-jobs/v1";
function readCommandJobsState(root) {
  if (!fs.existsSync(root)) return { version: COMMAND_JOBS_VERSION, jobs: [], active_commands: 0, active_services: 0, unsafe_jobs: 0 };
  const state = JSON.parse(fs.readFileSync(path7.join(root, "state.json"), "utf8"));
  if (state.version !== COMMAND_JOBS_VERSION || !Array.isArray(state.jobs)) throw new Error("command jobs state unavailable");
  return state;
}

// ops/tools/pi_write_domain_extension.mjs
import { appendFileSync as appendFileSync3, existsSync as existsSync9, mkdirSync as mkdirSync5, readFileSync as readFileSync6, realpathSync as realpathSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import path8 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var PI_CHILD_WRITE_DOMAIN_PROFILE = "pi-child-write-domain/v1";
var WRITE_DOMAIN_ENV = "PI_WRITE_DOMAIN";
var WRITE_DOMAIN_TOOL_NAMES = Object.freeze(["write", "edit"]);
var UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
function normalizeWindowsShellPath(value, platform = process.platform) {
  if (platform !== "win32" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return value;
  }
  const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return value;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}
function normalizeToolPathInput(value, platform = process.platform, homeDir = homedir4()) {
  let normalized = String(value ?? "").replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  normalized = normalizeWindowsShellPath(normalized, platform);
  if (normalized === "~") return homeDir;
  if (normalized.startsWith("~/") || platform === "win32" && normalized.startsWith("~\\")) {
    return path8.join(homeDir, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath3(normalized);
  return normalized;
}
function normalizeDomainPath(value, baseDir, caseInsensitive = false, options = {}) {
  if (value === null || value === void 0 || String(value) === "") return null;
  try {
    const platform = options.platform || process.platform;
    const input = normalizeToolPathInput(value, platform, options.homeDir || homedir4());
    let normalized = path8.normalize(path8.isAbsolute(input) ? input : path8.resolve(baseDir, input));
    try {
      const literalTail = [];
      let existingAncestor = normalized;
      while (!existsSync9(existingAncestor)) {
        const parent = path8.dirname(existingAncestor);
        if (parent === existingAncestor) {
          existingAncestor = null;
          break;
        }
        literalTail.unshift(path8.basename(existingAncestor));
        existingAncestor = parent;
      }
      if (existingAncestor) {
        normalized = path8.join(realpathSync2.native(existingAncestor), ...literalTail);
      }
    } catch {
    }
    normalized = path8.normalize(path8.resolve(normalized));
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  } catch {
    return null;
  }
}
function isInsidePath(base, candidate) {
  const relative = path8.relative(path8.resolve(base), path8.resolve(candidate));
  return relative === "" || !relative.startsWith(`..${path8.sep}`) && relative !== ".." && !path8.isAbsolute(relative);
}
function parseWriteDomainSpec(raw, { baseDir = process.cwd() } = {}) {
  const text3 = String(raw ?? "").trim();
  if (!text3) return null;
  const parsed = JSON.parse(text3);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${WRITE_DOMAIN_ENV} must encode one JSON object`);
  }
  const version = String(parsed.version || "");
  if (version !== PI_CHILD_WRITE_DOMAIN_PROFILE) {
    throw new Error(`${WRITE_DOMAIN_ENV}.version must be ${PI_CHILD_WRITE_DOMAIN_PROFILE}`);
  }
  const caseInsensitive = parsed.caseInsensitive === true;
  const list = (value, label) => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
      throw new Error(`${WRITE_DOMAIN_ENV}.${label} must be a list of non-empty strings`);
    }
    const normalized = value.map((item) => normalizeDomainPath(item, baseDir, caseInsensitive));
    if (normalized.some((item) => !item)) throw new Error(`${WRITE_DOMAIN_ENV}.${label} contains an invalid path`);
    return [...new Set(normalized)];
  };
  const logRaw = String(parsed.log ?? "");
  if (!logRaw) throw new Error(`${WRITE_DOMAIN_ENV}.log is required`);
  const log = normalizeDomainPath(logRaw, baseDir, false);
  if (!log) throw new Error(`${WRITE_DOMAIN_ENV}.log is invalid`);
  const allowed = list(parsed.allowed ?? [], "allowed");
  const roots = list(parsed.roots ?? [], "roots");
  const deleteAllowed = list(parsed.deleteAllowed ?? [], "deleteAllowed");
  const runtimeRoot3 = parsed.runtimeRoot ? normalizeDomainPath(parsed.runtimeRoot, baseDir, caseInsensitive) : null;
  return {
    version,
    taskId: String(parsed.taskId || "") || null,
    allowed,
    roots,
    deleteAllowed,
    runtimeRoot: runtimeRoot3,
    log,
    caseInsensitive
  };
}
function evaluatePathSet(resolvedPath2, entries) {
  if (!resolvedPath2) return { allowed: false, matched: null };
  for (const entry of entries) {
    if (resolvedPath2 === entry || isInsidePath(entry, resolvedPath2)) return { allowed: true, matched: entry };
  }
  return { allowed: false, matched: null };
}
function evaluateWriteDomain(resolvedPath2, spec) {
  if (resolvedPath2 && spec.runtimeRoot && isInsidePath(spec.runtimeRoot, resolvedPath2)) {
    return { allowed: false, matched: null, reason: "runtime_package_read_only" };
  }
  return evaluatePathSet(resolvedPath2, [...spec.allowed, ...spec.roots]);
}
function evaluateDeleteDomain(resolvedPath2, spec) {
  return evaluatePathSet(resolvedPath2, spec.deleteAllowed || []);
}
function readWriteDomainAudit(logPath) {
  if (!logPath || !existsSync9(logPath)) return { ready: [], records: [], errors: [] };
  const ready = [];
  const records = [];
  const errors = [];
  const lines = readFileSync6(logPath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const record2 = JSON.parse(lines[index]);
      if (record2?.kind === "guard_ready" && record2.profile === PI_CHILD_WRITE_DOMAIN_PROFILE) {
        ready.push(record2);
      } else if (record2?.kind === "tool_call" && WRITE_DOMAIN_TOOL_NAMES.includes(record2.tool) && typeof record2.allowed === "boolean" && typeof record2.tool_call_id === "string" && record2.tool_call_id.length > 0) {
        records.push(record2);
      } else {
        throw new Error("invalid record shape");
      }
    } catch (error) {
      errors.push(`line ${index + 1}: ${error?.message || error}`);
    }
  }
  return { ready, records, errors };
}
function summarizeWriteDomainAudit({ logPath, observedToolCalls = null, requireReady = true } = {}) {
  const audit = readWriteDomainAudit(logPath);
  const observed = Array.isArray(observedToolCalls) ? observedToolCalls.filter((item) => WRITE_DOMAIN_TOOL_NAMES.includes(String(item?.name ?? item?.toolName ?? ""))) : null;
  const expectedIds = observed ? observed.map((item) => String(item?.id ?? item?.toolCallId ?? "")).filter(Boolean).sort() : [];
  const recordedIds = audit.records.map((item) => String(item.tool_call_id)).sort();
  const recordedIdSet = new Set(recordedIds);
  const structuralErrors = [...audit.errors];
  if (requireReady && audit.ready.length !== 1) structuralErrors.push(`guard_ready count: ${audit.ready.length}`);
  if (recordedIdSet.size !== recordedIds.length) structuralErrors.push("duplicate tool_call_id in audit");
  const missingObserved = expectedIds.filter((id) => !recordedIdSet.has(id));
  if (observed && expectedIds.length !== observed.length) structuralErrors.push("observed write/edit call missing tool_call_id");
  if (missingObserved.length) structuralErrors.push(`unrecorded observed tool calls: ${missingObserved.join(", ")}`);
  const auditComplete = structuralErrors.length === 0;
  const violations = audit.records.filter((item) => item.allowed === false);
  return {
    ready_count: audit.ready.length,
    request_count: audit.records.length,
    allowed_count: audit.records.length - violations.length,
    blocked_count: violations.length,
    audit_complete: auditComplete,
    scope_compliant: auditComplete && violations.length === 0,
    audit_errors: structuralErrors,
    violations: violations.slice(0, 50)
  };
}
function mergeWriteDomainEvidence(audit, submission = {}) {
  const reportedViolationCount = submission?.submitted ? Math.max(0, Number(submission.write_domain_reported_violation_count) || 0) : 0;
  return {
    ...audit,
    scope_compliant: audit?.scope_compliant === true && submission?.scope_compliant !== false,
    reported_scope_checked: submission?.submitted === true,
    reported_violation_count: reportedViolationCount,
    violation_count: Math.max(0, Number(audit?.blocked_count) || 0) + reportedViolationCount,
    reported_violations: Array.isArray(submission?.write_domain_reported_violations) ? submission.write_domain_reported_violations.slice(0, 50) : []
  };
}
function evaluateReportedWriteScope(scopeActual, spec, baseDirs = []) {
  const roots = [...new Set(baseDirs.map((item) => String(item || "")).filter(Boolean))];
  const violations = [];
  for (const field of ["written", "deleted"]) {
    const values = Array.isArray(scopeActual?.[field]) ? scopeActual[field] : [];
    const evaluate = field === "deleted" ? evaluateDeleteDomain : evaluateWriteDomain;
    for (const rawPath of values) {
      const candidates = roots.map((root) => normalizeDomainPath(rawPath, root, spec.caseInsensitive)).filter(Boolean);
      const matched = candidates.some((candidate) => evaluate(candidate, spec).allowed);
      if (!matched) violations.push({ field, raw_path: String(rawPath), resolved_candidates: candidates });
    }
  }
  return violations;
}

// ops/tools/run-pi-task.mjs
init_stdio_jsonrpc();

// ops/tools/review_result_synthesis.mjs
import { existsSync as existsSync10, mkdirSync as mkdirSync7, readFileSync as readFileSync7, statSync as statSync4, writeFileSync as writeFileSync4 } from "node:fs";
import path10 from "node:path";
var REVIEW_PROFILE = "evidence_only_v1";
var ASSISTED_REVIEW_PROFILE = "evidence_assisted_v1";
var SEMANTIC_REVIEW_PROFILE = "semantic_review_v2";
var ACCEPTANCE_SYNTHESIS_PROFILE = "acceptance_synthesis_v1";
var TARGET_FILES_COVERAGE_MARKER = "$target_files";
var SCOPE_READ_COVERAGE_MARKER = "$scope_read";
var REVIEW_RESULT_V1_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "gate", "summary", "findings", "evidence_gaps", "scope"],
  properties: {
    schema_version: { const: 1 },
    gate: { enum: ["pass", "fail", "needs_owner"], description: "pass \u8981\u6C42 findings \u4E0E evidence_gaps \u7686\u7A7A\uFF1Bfail \u81F3\u5C11\u4E00\u6761 finding\uFF1Bneeds_owner \u8981\u6C42 evidence_gaps \u6216 scope.not_reviewed \u975E\u7A7A" },
    summary: { type: "string", minLength: 1, description: "\u4E00\u53E5\u8BDD\u5BA1\u67E5\u7ED3\u8BBA" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["issue", "impact", "repair", "criteria", "location", "evidence_refs"],
        properties: {
          title: { type: "string", description: "\u95EE\u9898\u77ED\u6807\u9898\uFF1B\u7F3A\u7701\u81EA\u52A8\u53D6 issue \u9996\u53E5" },
          issue: { type: "string", minLength: 1, description: "\u5177\u4F53\u95EE\u9898\u63CF\u8FF0" },
          impact: { type: "string", minLength: 1, description: "\u5B9E\u9645\u5F71\u54CD" },
          repair: { type: "string", minLength: 1, description: "\u4FEE\u590D\u65B9\u5411" },
          criteria: {
            anyOf: [
              { type: "string", minLength: 1 },
              { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }
            ],
            description: "\u547D\u4E2D\u7684\u5224\u636E\u6761\u76EE\u6807\u8BC6"
          },
          location: {
            anyOf: [
              { type: "string", minLength: 1 },
              { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }
            ],
            description: "\u95EE\u9898\u5B9A\u4F4D\uFF08file \u6216 file:line\uFF09\uFF0C\u53EF\u591A\u5904"
          },
          evidence_refs: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            description: "\u8BC1\u636E\u5F15\u7528\uFF08\u8DEF\u5F84\u6216 path:line\uFF09"
          }
        }
      }
    },
    evidence_gaps: { type: "array", description: "\u8BC1\u636E\u7F3A\u53E3\u6E05\u5355\uFF1Bgate=pass \u65F6\u5FC5\u987B\u4E3A\u7A7A" },
    scope: {
      type: "object",
      required: ["reviewed", "not_reviewed"],
      properties: {
        reviewed: { type: "array", items: { type: "string" } },
        not_reviewed: { type: "array", items: { type: "string" }, description: "\u672A\u8986\u76D6\u7684\u76EE\u6807\u6587\u4EF6\u7EAF\u8DEF\u5F84\uFF1B\u539F\u56E0\u5199evidence_gaps\uFF0C\u4E0D\u628A\u8DEF\u5F84\u4E0E\u89E3\u91CA\u6DF7\u5199\u3002" },
        actual_reads: { type: "array", items: { type: "string" }, description: "\u5B9E\u9645\u6D88\u8D39\u7684\u6388\u6743\u8DEF\u5F84\uFF0C\u53EF\u4E3Ascope.read\u5B50\u96C6\uFF1B\u6388\u6743\u76EE\u5F55\u4E0D\u7B49\u4E8E\u5FC5\u8BFB\u5168\u6587\u3002" }
      }
    },
    output: { type: "object" }
  }
});
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function normalizedLineEndings(value) {
  return String(value || "").replace(/\r\n?/g, "\n");
}
function requiredMaterialBlocks(taskText2, root) {
  const pattern = /<!-- subagent-required-material:start ([^\n]*?) -->\n([\s\S]*?)\n<!-- subagent-required-material:end -->/g;
  const blocks = /* @__PURE__ */ new Map();
  for (const match of normalizedLineEndings(taskText2).matchAll(pattern)) {
    let metadata;
    try {
      metadata = JSON.parse(match[1]);
    } catch {
      return null;
    }
    const key = pathKey(object(metadata).path, root);
    if (!key || blocks.has(key)) return null;
    blocks.set(key, normalizedLineEndings(match[2]));
  }
  return blocks;
}
function jsonBlocks(text3) {
  return [...String(text3 || "").matchAll(/```json(?:\s+review_result(?:_v1)?)?\s*\n([\s\S]*?)```/gi)].map((match) => match[1]);
}
function evidenceOnlyPackage(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  return object(extensions.review_execution).profile === REVIEW_PROFILE;
}
function semanticReviewPackage(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  return object(extensions.review_execution).profile === SEMANTIC_REVIEW_PROFILE;
}
function acceptanceSynthesisPackage(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  return object(extensions.review_execution).profile === ACCEPTANCE_SYNTHESIS_PROFILE;
}
function structuredReviewPackage(taskPackage) {
  return evidenceOnlyPackage(taskPackage) || semanticReviewPackage(taskPackage) || acceptanceSynthesisPackage(taskPackage);
}
function reviewProfile(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  return String(object(extensions.review_execution).profile || "");
}
function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function yamlScalarValue(value) {
  const raw = String(value || "").trim();
  if (raw.startsWith('"') && raw.endsWith('"') || raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}
function handoffOutputScalar(text3, key) {
  let inOutput = false;
  const field = new RegExp(`^    ${regexEscape(key)}:\\s*(.*?)\\s*$`);
  for (const line of String(text3 || "").split(/\r?\n/)) {
    if (/^  output:\s*$/.test(line)) {
      inOutput = true;
      continue;
    }
    if (!inOutput) continue;
    if (/^  [A-Za-z_][A-Za-z0-9_]*:\s*/.test(line)) break;
    const match = field.exec(line);
    if (match) return yamlScalarValue(match[1]);
  }
  return "";
}
function readAssistedReviewGate({ taskPackage, fallbackRoot }) {
  if (!taskPackage || reviewProfile(taskPackage) !== ASSISTED_REVIEW_PROFILE) return { applied: false };
  const expected = object(taskPackage.expected_output);
  const handoff = object(taskPackage.handoff_contract);
  const businessGate2 = String(expected.business_gate || "").replace(/^FINAL_HANDOFF\.output\./, "").trim();
  const handoffPath = resolvedPath(taskPackage, handoff.resolved_handoff_file || handoff.handoff_file, fallbackRoot);
  const unreadable = (gateError) => ({
    applied: true,
    profile: ASSISTED_REVIEW_PROFILE,
    gate: "needs_owner",
    gate_error: gateError,
    handoff_path: handoffPath || null
  });
  if (!businessGate2) return unreadable("task package declares no expected_output.business_gate");
  if (!handoffPath || !existsSync10(handoffPath)) return unreadable(`handoff not found: ${handoffPath || "(no handoff path)"}`);
  const text3 = readFileSync7(handoffPath, "utf8");
  const gate = handoffOutputScalar(text3, businessGate2);
  if (!["pass", "fail", "needs_owner"].includes(gate)) {
    return unreadable(`FINAL_HANDOFF.output.${businessGate2}=${JSON.stringify(gate)} is not pass | fail | needs_owner`);
  }
  return {
    applied: true,
    profile: ASSISTED_REVIEW_PROFILE,
    gate,
    handoff_path: handoffPath
  };
}
function capabilityName(taskPackage) {
  const agent = object(taskPackage?.agent);
  return String(object(agent.capability).name || "").trim();
}
function activeCapabilityContract(taskPackage) {
  const extensions = object(taskPackage?.extensions);
  const contracts = object(extensions.capability_contract);
  const contractSlot = String(object(extensions.review_execution).contract_slot || "").trim();
  const direct = contracts[contractSlot || capabilityName(taskPackage).replace(/-/g, "_")];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  if (contractSlot) return {};
  const candidates = Object.values(contracts).filter((value) => value && typeof value === "object" && !Array.isArray(value));
  return candidates.length === 1 ? candidates[0] : {};
}
function identifierArray(output, field) {
  const value = output[field];
  if (!Array.isArray(value)) {
    throw new Error(`review_result_v1 output.${field} must be a string array`);
  }
  const normalized = value.map((item) => String(item || "").trim());
  if (normalized.some((item) => !item)) {
    throw new Error(`review_result_v1 output.${field} must not contain empty identifiers`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`review_result_v1 output.${field} must contain unique identifiers`);
  }
  return normalized;
}
function validateContractDriftResult(result2) {
  const output = object(result2.output);
  const enumerated = identifierArray(output, "identifiers_enumerated");
  const checked = identifierArray(output, "identifiers_checked");
  const enumeratedSet = new Set(enumerated);
  const unknownChecked = checked.filter((item) => !enumeratedSet.has(item));
  if (unknownChecked.length) {
    throw new Error(`contract-drift identifiers_checked were not enumerated: ${unknownChecked.join(", ")}`);
  }
  if (result2.gate !== "needs_owner") {
    if (!enumerated.length) {
      throw new Error("contract-drift pass/fail requires at least one enumerated identifier");
    }
    const checkedSet = new Set(checked);
    const unchecked = enumerated.filter((item) => !checkedSet.has(item));
    if (unchecked.length) {
      throw new Error(`contract-drift pass/fail left identifiers unchecked: ${unchecked.join(", ")}`);
    }
  }
}
function normalizeTargetFilesCoverage(taskPackage, result2) {
  const reviewed = result2.scope.reviewed;
  const notReviewed = result2.scope.not_reviewed;
  const markerInReviewed = reviewed.includes(TARGET_FILES_COVERAGE_MARKER);
  const markerInNotReviewed = notReviewed.includes(TARGET_FILES_COVERAGE_MARKER);
  if (!markerInReviewed && !markerInNotReviewed) return;
  if (markerInNotReviewed || reviewed.length !== 1 || notReviewed.length !== 0) {
    throw new Error("$target_files must be the sole scope.reviewed item for full coverage");
  }
  const targetFiles = contractTargetFiles(taskPackage);
  if (!targetFiles.length) {
    throw new Error("$target_files requires a non-empty capability coverage file set");
  }
  result2.scope.reviewed = [...targetFiles];
}
function normalizeScopeReadCoverage(taskPackage, result2) {
  const actualReads = result2.scope.actual_reads;
  if (!Array.isArray(actualReads) || !actualReads.includes(SCOPE_READ_COVERAGE_MARKER)) return;
  if (actualReads.length !== 1) {
    throw new Error("$scope_read must be the sole scope.actual_reads item for full input coverage");
  }
  const declared = object(taskPackage.scope).read;
  if (!Array.isArray(declared) || !declared.length) {
    throw new Error("$scope_read requires non-empty task_package.scope.read");
  }
  result2.scope.actual_reads = [...declared];
}
function validateAcceptanceSynthesisResult(taskPackage, result2) {
  const extensions = object(taskPackage?.extensions);
  const contracts = object(object(extensions.capability_contract).acceptance_synthesis);
  const expected = Array.isArray(contracts.acceptance_ids) ? contracts.acceptance_ids.map((item) => String(item || "").trim()) : [];
  if (!expected.length || expected.some((item) => !item) || new Set(expected).size !== expected.length) {
    throw new Error("acceptance-synthesis task contract requires unique acceptance_ids");
  }
  const expectedSet = new Set(expected);
  const output = object(result2.output);
  const disposition = String(output.disposition || "");
  const mechanicalSchema = object(contracts.mechanical_schema);
  const dispositionValues = Array.isArray(mechanicalSchema.disposition_values) ? mechanicalSchema.disposition_values.map((item) => String(item || "").trim()).filter(Boolean) : [];
  if (!dispositionValues.length || new Set(dispositionValues).size !== dispositionValues.length) {
    throw new Error("acceptance-synthesis task contract requires mechanical_schema.disposition_values");
  }
  if (!dispositionValues.includes(disposition)) {
    throw new Error(`acceptance-synthesis output.disposition must be one of ${dispositionValues.join(", ")}`);
  }
  const considered = identifierArray(output, "acceptance_ids_considered");
  const failed = identifierArray(output, "failed_acceptance_ids");
  const confirmation = identifierArray(output, "confirmation_acceptance_ids");
  const regression = identifierArray(output, "regression_acceptance_ids");
  const uncertainty = object(output.uncertainty);
  const environmentUncertain = identifierArray(uncertainty, "environment");
  const evidenceUncertain = identifierArray(uncertainty, "evidence");
  if (considered.length !== expected.length || considered.some((item) => !expectedSet.has(item))) {
    throw new Error("acceptance-synthesis acceptance_ids_considered must equal task acceptance_ids");
  }
  for (const [label, values] of [["failed", failed], ["confirmation", confirmation], ["regression", regression]]) {
    const unknown = values.filter((item) => !expectedSet.has(item));
    if (unknown.length) throw new Error(`acceptance-synthesis ${label} ids are unknown: ${unknown.join(", ")}`);
  }
  const coverage = object(output.coverage);
  const coverageGroups = ["passed", "failed", "uncertain", "missing"].map((field) => [field, identifierArray(coverage, field)]);
  const coverageIds = coverageGroups.flatMap(([, values]) => values);
  const uncertaintyIds = [...environmentUncertain, ...evidenceUncertain];
  if (coverageIds.length !== expected.length || new Set(coverageIds).size !== expected.length || coverageIds.some((item) => !expectedSet.has(item))) {
    throw new Error("acceptance-synthesis coverage must partition all task acceptance_ids exactly once");
  }
  if (uncertaintyIds.length !== coverage.uncertain.length || new Set(uncertaintyIds).size !== uncertaintyIds.length || uncertaintyIds.some((item) => !coverage.uncertain.includes(item))) {
    throw new Error("acceptance-synthesis uncertainty groups must partition coverage.uncertain");
  }
  if (result2.gate === "pass" && (disposition !== "pass" || failed.length || confirmation.length || regression.length || coverage.failed.length || coverage.uncertain.length || coverage.missing.length)) {
    throw new Error("acceptance-synthesis pass gate is inconsistent with disposition or coverage");
  }
  if (result2.gate === "fail") {
    if (disposition !== "rework" || !failed.length && !environmentUncertain.length) {
      throw new Error("acceptance-synthesis fail gate requires disposition=rework and failed or environment-uncertain ids");
    }
    if (evidenceUncertain.length || coverage.missing.length) {
      throw new Error("acceptance-synthesis rework cannot contain evidence uncertainty or missing ids");
    }
    const confirmationSet = new Set(confirmation);
    const confirmationRequired = [...failed, ...environmentUncertain];
    if (confirmationRequired.some((item) => !confirmationSet.has(item))) {
      throw new Error("acceptance-synthesis confirmation_acceptance_ids must include every failed and environment-uncertain id");
    }
  }
  if (result2.gate === "needs_owner" && disposition !== "needs_owner") {
    throw new Error("acceptance-synthesis needs_owner gate requires disposition=needs_owner");
  }
  for (const [index, finding] of result2.findings.entries()) {
    for (const field of ["acceptance_refs", "requirement_refs"]) {
      const values = Array.isArray(finding?.[field]) ? finding[field] : [];
      if (!values.length || values.some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`acceptance-synthesis findings[${index}].${field} is required`);
      }
    }
    if (finding.acceptance_refs.some((item) => !expectedSet.has(String(item)))) {
      throw new Error(`acceptance-synthesis findings[${index}] references unknown acceptance id`);
    }
  }
}
function validateCapabilityResult(taskPackage, result2) {
  const capability = capabilityName(taskPackage);
  if (capability === "contract-drift-inspection") validateContractDriftResult(result2);
  if (capability === "acceptance-synthesis") validateAcceptanceSynthesisResult(taskPackage, result2);
}
function validateFinding(finding, index) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    throw new Error(`review_result_v1 findings[${index}] must be an object`);
  }
  for (const field of ["title", "issue", "impact", "repair"]) {
    if (typeof finding[field] !== "string" || !finding[field].trim()) {
      throw new Error(`review_result_v1 findings[${index}].${field} is required`);
    }
  }
  const criteriaItems = Array.isArray(finding.criteria) ? finding.criteria : [finding.criteria];
  if (!criteriaItems.length || criteriaItems.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`review_result_v1 findings[${index}].criteria must be a non-empty string or string array`);
  }
  finding.criteria = criteriaItems.join(", ");
  const locations = Array.isArray(finding.location) ? finding.location : [finding.location];
  if (!locations.length || locations.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`review_result_v1 findings[${index}].location must be a non-empty string or string array`);
  }
  if (!Array.isArray(finding.evidence_refs) || !finding.evidence_refs.length || finding.evidence_refs.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`review_result_v1 findings[${index}].evidence_refs must be a non-empty string array`);
  }
}
function backfillFindingTitles(findings) {
  for (const finding of findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) continue;
    const hasTitle = typeof finding.title === "string" && finding.title.trim();
    const issue = typeof finding.issue === "string" ? finding.issue.trim() : "";
    if (!hasTitle && issue) {
      finding.title = issue.split(/[。.!！?？;；\n]/)[0].trim().slice(0, 80);
    }
  }
}
function validateReviewResultSemantics(result2, taskPackage = null) {
  backfillFindingTitles(result2.findings);
  result2.findings.forEach(validateFinding);
  if (result2.gate === "pass" && (result2.findings.length || result2.evidence_gaps.length)) {
    throw new Error("review_result_v1 pass requires empty findings and evidence_gaps");
  }
  if (result2.gate === "fail" && !result2.findings.length) {
    const environmentUncertain = object(object(result2.output).uncertainty).environment;
    const acceptanceEnvironmentRework = capabilityName(taskPackage) === "acceptance-synthesis" && Array.isArray(environmentUncertain) && environmentUncertain.length > 0;
    if (!acceptanceEnvironmentRework) {
      throw new Error("review_result_v1 fail requires at least one finding");
    }
  }
  const notReviewed = Array.isArray(result2.scope?.not_reviewed) ? result2.scope.not_reviewed : [];
  if (result2.gate === "needs_owner" && !result2.evidence_gaps.length && !notReviewed.length) {
    throw new Error("review_result_v1 needs_owner requires evidence_gaps or scope.not_reviewed");
  }
}
function validateReviewResultPayload(result2, taskPackage = null) {
  if (result2?.schema_version !== 1) throw new Error("review_result_v1 schema_version must be 1");
  if (!["pass", "fail", "needs_owner"].includes(result2?.gate)) {
    throw new Error("review_result_v1 gate must be pass, fail or needs_owner");
  }
  if (typeof result2?.summary !== "string" || !result2.summary.trim()) {
    throw new Error("review_result_v1 summary is required");
  }
  for (const field of ["findings", "evidence_gaps"]) {
    if (!Array.isArray(result2[field])) throw new Error(`review_result_v1 ${field} must be an array`);
  }
  if (!result2.scope || typeof result2.scope !== "object" || Array.isArray(result2.scope)) {
    throw new Error("review_result_v1 scope must be an object");
  }
  for (const field of ["reviewed", "not_reviewed"]) {
    if (!Array.isArray(result2.scope[field]) || result2.scope[field].some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`review_result_v1 scope.${field} must be a string array`);
    }
  }
  if (result2.scope.actual_reads !== void 0 && (!Array.isArray(result2.scope.actual_reads) || result2.scope.actual_reads.some((item) => typeof item !== "string" || !item.trim()))) {
    throw new Error("review_result_v1 scope.actual_reads must be a string array when present");
  }
  if (result2.output !== void 0 && (typeof result2.output !== "object" || Array.isArray(result2.output) || result2.output === null)) {
    throw new Error("review_result_v1 output must be an object when present");
  }
  if (taskPackage) {
    normalizeTargetFilesCoverage(taskPackage, result2);
    normalizeScopeReadCoverage(taskPackage, result2);
  }
  validateReviewResultSemantics(result2, taskPackage);
  if (taskPackage) validateCapabilityResult(taskPackage, result2);
  return result2;
}
function parseReviewResult(finalText, taskPackage = null) {
  const text3 = String(finalText || "");
  const facts = /## 事实与证据\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(text3)?.[1] ?? text3;
  const trimmedFacts = facts.trim();
  const [fencedBlock] = jsonBlocks(facts);
  const block = fencedBlock || (trimmedFacts.startsWith("{") && trimmedFacts.endsWith("}") ? trimmedFacts : "");
  if (!block) throw new Error("review_result_v1 JSON block missing");
  let result2;
  try {
    result2 = JSON.parse(block);
  } catch (error) {
    throw new Error(`review_result_v1 is invalid JSON: ${error.message}`);
  }
  return validateReviewResultPayload(result2, taskPackage);
}
function resolvedPath(taskPackage, value, fallbackRoot) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (path10.isAbsolute(raw)) return path10.resolve(raw);
  const runtime = object(taskPackage.runtime_context);
  return path10.resolve(String(runtime.output_root || fallbackRoot), raw);
}
function yamlScalar(value) {
  if (value === null || value === void 0) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}
function pathKey(value, root) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const absolute = path10.resolve(root, raw);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function scopeAllows(taskPackage, reviewedPath, root) {
  const candidate = pathKey(reviewedPath, root);
  if (!candidate) return false;
  const declared = object(taskPackage.scope).read;
  if (!Array.isArray(declared)) return false;
  return declared.some((entry) => {
    const key = pathKey(entry, root);
    if (!key) return false;
    if (/^https?:\/\//i.test(key)) return candidate === key;
    if (candidate === key) return true;
    const raw = String(entry || "").trim();
    const absolute = path10.resolve(root, raw);
    return existsSync10(absolute) && statSync4(absolute).isDirectory() && candidate.startsWith(`${key}${path10.sep}`);
  });
}
function requiredMaterialDeclaration(taskPackage, root) {
  const agent = object(taskPackage.agent);
  const capability = object(agent.capability);
  const required = agent.required_files;
  if (!String(agent.role || "").trim() || !String(agent.runtime_role || "").trim() || !String(capability.name || "").trim() || !String(capability.file || "").trim() || !Array.isArray(required) || !required.length || required.some((entry) => typeof entry !== "string" || !entry.trim())) return null;
  const runtime = object(taskPackage.runtime_context);
  const binding = object(object(taskPackage.extensions).model_config);
  const materialRoot = String(binding.global_root || runtime.output_root || "").trim() || root;
  const keys = required.map((entry) => pathKey(entry, materialRoot));
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) return null;
  return { required, materialRoot, keys };
}
function requiredMaterialLoaded(taskPackage, taskText2, root) {
  const declaration = requiredMaterialDeclaration(taskPackage, root);
  if (!declaration) return false;
  const { required, materialRoot, keys } = declaration;
  const blocks = requiredMaterialBlocks(taskText2, materialRoot);
  if (!blocks || blocks.size !== keys.length || keys.some((key) => !blocks.has(key))) return false;
  return required.every((entry) => {
    const pathname = path10.resolve(materialRoot, String(entry || ""));
    if (!existsSync10(pathname) || !statSync4(pathname).isFile()) return false;
    const content = normalizedLineEndings(readFileSync7(pathname, "utf8"));
    return Boolean(content) && blocks.get(pathKey(entry, materialRoot)) === content;
  });
}
function contractTargetFiles(taskPackage) {
  const contract = activeCapabilityContract(taskPackage);
  const values = Array.isArray(contract.target_files) ? contract.target_files : Array.isArray(contract.affected_files) ? contract.affected_files : [];
  return values.map(String);
}
function loadReviewEvidence(taskPackage, root) {
  const extensions = object(taskPackage.extensions);
  const reference = object(extensions.review_evidence);
  const rawPath = String(reference.path || "").trim();
  if (!rawPath) throw new Error("review evidence path is missing");
  const runtime = object(taskPackage.runtime_context);
  const rootPath = path10.resolve(String(runtime.output_root || root));
  const evidencePath = path10.resolve(rootPath, rawPath);
  const relative = path10.relative(rootPath, evidencePath);
  if (relative.startsWith("..") || path10.isAbsolute(relative)) {
    throw new Error(`review evidence path escapes resolved root: ${rawPath}`);
  }
  if (!existsSync10(evidencePath)) {
    throw new Error(`review evidence file is missing: ${evidencePath}`);
  }
  if (!statSync4(evidencePath).isFile()) {
    throw new Error(`review evidence path is not a file: ${evidencePath}`);
  }
  const content = readFileSync7(evidencePath, "utf8").replace(/\r\n?/g, "\n");
  let evidence;
  try {
    evidence = JSON.parse(content);
  } catch (error) {
    throw new Error(`review evidence JSON is invalid: ${evidencePath}: ${error.message}`);
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error(`review evidence JSON root must be an object: ${evidencePath}`);
  }
  return evidence;
}
function evidenceContractTargetFiles(evidence) {
  const contract = object(evidence?.contract);
  return Array.isArray(contract.target_files) ? contract.target_files.map(String) : [];
}
function evidenceSourcePathSet(evidence, root) {
  const sources = evidence?.sources;
  if (!Array.isArray(sources) || !sources.length) return null;
  const keys = sources.map((source) => pathKey(object(source).path, root));
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) return null;
  return new Set(keys);
}
function evidenceMetadataMatchesExecution(evidence, taskPackage) {
  const extensions = object(taskPackage.extensions);
  const execution = object(extensions.review_execution);
  const materialMode = String(execution.material_mode || "").trim();
  if (evidence?.profile !== SEMANTIC_REVIEW_PROFILE || evidence?.complete !== true || !["full", "index"].includes(materialMode) || evidence?.material_mode !== materialMode) return false;
  const sources = evidence.sources;
  return materialMode !== "full" || Array.isArray(sources) && sources.every((source) => typeof object(source).content === "string");
}
function samePathSet(left, right, root) {
  const leftKeys = left.map((entry) => pathKey(entry, root));
  const rightKeys = right.map((entry) => pathKey(entry, root));
  if (leftKeys.some((key) => !key) || rightKeys.some((key) => !key) || new Set(leftKeys).size !== leftKeys.length || new Set(rightKeys).size !== rightKeys.length) return false;
  const rightSet = new Set(rightKeys);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => rightSet.has(key));
}
function validateAcceptanceInputCoverage(taskPackage, result2, root) {
  const declared = object(taskPackage.scope).read;
  if (!Array.isArray(declared) || !declared.length || declared.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("acceptance-synthesis scope.read must contain exact input paths");
  }
  const reviewed = Array.isArray(result2.scope.reviewed) ? result2.scope.reviewed : [];
  const notReviewed = Array.isArray(result2.scope.not_reviewed) ? result2.scope.not_reviewed : [];
  const combined = [...reviewed, ...notReviewed];
  if (!samePathSet(combined, declared, root)) {
    throw new Error("acceptance-synthesis reviewed/not_reviewed must exactly partition scope.read");
  }
  if (notReviewed.length && result2.gate !== "needs_owner") {
    throw new Error("partial acceptance-synthesis input coverage requires needs_owner");
  }
}
function validateTargetFilesCoverage(taskPackage, result2, root, targetFiles, evidenceSourceKeys = null) {
  const reviewed = Array.isArray(result2.scope.reviewed) ? result2.scope.reviewed : [];
  if (!reviewed.length || reviewed.some((item) => typeof item !== "string" || !scopeAllows(taskPackage, item, root))) {
    throw new Error("structured review scope.reviewed must contain exact paths within scope.read");
  }
  if (evidenceSourceKeys) {
    const missingReviewedSources = reviewed.filter((item) => !evidenceSourceKeys.has(pathKey(item, root)));
    if (missingReviewedSources.length) {
      throw new Error(`structured review scope.reviewed files are missing from evidence sources: ${missingReviewedSources.join(", ")}`);
    }
  }
  const notReviewed = Array.isArray(result2.scope.not_reviewed) ? result2.scope.not_reviewed : [];
  if (notReviewed.some((item) => !scopeAllows(taskPackage, item, root))) {
    throw new Error("structured review scope.not_reviewed must contain exact paths within scope.read");
  }
  const targetKeys = new Set(targetFiles.map((item) => pathKey(item, root)));
  const reviewedKeys = new Set(reviewed.map((item) => pathKey(item, root)));
  const notReviewedKeys = new Set(notReviewed.map((item) => pathKey(item, root)));
  const unknownNotReviewed = notReviewed.filter((item) => !targetKeys.has(pathKey(item, root)));
  if (unknownNotReviewed.length || [...notReviewedKeys].some((key) => reviewedKeys.has(key))) {
    throw new Error("structured review scope.not_reviewed must be a disjoint subset of the coverage file set");
  }
  const missingTargets = targetFiles.filter((item) => !reviewedKeys.has(pathKey(item, root)));
  if (notReviewed.length) {
    if (result2.gate !== "needs_owner" || !samePathSet(missingTargets, notReviewed, root)) {
      throw new Error("partial structured review must exactly list reviewed/not_reviewed coverage files and use needs_owner");
    }
  } else if (missingTargets.length) {
    throw new Error(`structured review pass/fail did not review all coverage files: ${missingTargets.join(", ")}`);
  }
}
var ReviewPackageDefectError = class extends Error {
};
function validateReviewResultScope(taskPackage, result2, root) {
  if (!requiredMaterialDeclaration(taskPackage, root)) {
    throw new ReviewPackageDefectError("task package required material declaration is incomplete (agent.role, agent.runtime_role, agent.capability.name/file, unique agent.required_files)");
  }
  let actualReads = Array.isArray(result2.scope.reviewed) ? [...result2.scope.reviewed] : [];
  if (acceptanceSynthesisPackage(taskPackage)) {
    validateAcceptanceInputCoverage(taskPackage, result2, root);
  }
  if (evidenceOnlyPackage(taskPackage)) {
    const targetFiles = contractTargetFiles(taskPackage);
    if (!targetFiles.length) {
      throw new ReviewPackageDefectError("evidence-only capability contract coverage files must be non-empty");
    }
    validateTargetFilesCoverage(taskPackage, result2, root, targetFiles);
  }
  if (semanticReviewPackage(taskPackage)) {
    const targetFiles = contractTargetFiles(taskPackage);
    if (!targetFiles.length) {
      throw new ReviewPackageDefectError("semantic review capability contract target_files must be non-empty");
    }
    const evidence = loadReviewEvidence(taskPackage, root);
    const evidenceTargetFiles = evidenceContractTargetFiles(evidence);
    if (!evidenceTargetFiles.length || !samePathSet(targetFiles, evidenceTargetFiles, root)) {
      throw new ReviewPackageDefectError("semantic review capability contract and evidence target_files must match");
    }
    if (!evidenceMetadataMatchesExecution(evidence, taskPackage)) {
      throw new ReviewPackageDefectError("semantic review evidence metadata does not match the execution contract");
    }
    const evidenceSourceKeys = evidenceSourcePathSet(evidence, root);
    if (!evidenceSourceKeys) {
      throw new ReviewPackageDefectError("semantic review evidence sources must be a non-empty unique path set");
    }
    const missingTargetSources = targetFiles.filter((item) => !evidenceSourceKeys.has(pathKey(item, root)));
    if (missingTargetSources.length) {
      throw new ReviewPackageDefectError(`semantic review target_files are missing from evidence sources: ${missingTargetSources.join(", ")}`);
    }
    validateTargetFilesCoverage(taskPackage, result2, root, targetFiles, evidenceSourceKeys);
    const reportedReads = result2.scope.actual_reads;
    if (!Array.isArray(reportedReads) || !reportedReads.length && result2.gate !== "needs_owner") {
      throw new Error("semantic review scope.actual_reads must record consumed scope.read inputs");
    }
    if (reportedReads.some((item) => !scopeAllows(taskPackage, item, root))) {
      throw new Error("semantic review scope.actual_reads must contain paths within scope.read");
    }
    actualReads = [...reportedReads];
  }
  return actualReads;
}
function structuredValidation({ taskPackage, taskText: taskText2, result: result2, fallbackRoot, reportPath, handoffPath, runnerObservations }) {
  if (object(runnerObservations).turn_completed !== true) {
    throw new Error("structured review synthesis requires a completed model turn");
  }
  if (evidenceOnlyPackage(taskPackage) && object(runnerObservations).evidence_tool_guard_passed !== true) {
    throw new Error("evidence-only review synthesis requires the tool guard to pass");
  }
  if (!requiredMaterialLoaded(taskPackage, taskText2, fallbackRoot)) {
    throw new Error("structured review required files were not present in task material");
  }
  if (!reportPath || !handoffPath) {
    throw new Error("structured review output paths are incomplete");
  }
  const actualReads = validateReviewResultScope(taskPackage, result2, fallbackRoot);
  return {
    required_files_loaded: true,
    expected_output_satisfied: true,
    scope_compliant: true,
    mechanical_check: "pass",
    actual_reads: actualReads
  };
}
function markdownFinding(finding, index) {
  const item = object(finding);
  const title = String(item.title).trim();
  const lines = [`### F${index + 1} - ${title}`];
  for (const [key, value] of [
    ["location", item.location],
    ["criteria", item.criteria],
    ["issue", item.issue],
    ["impact", item.impact],
    ["repair", item.repair],
    ["acceptance_refs", item.acceptance_refs],
    ["requirement_refs", item.requirement_refs]
  ]) {
    const rendered = Array.isArray(value) ? value.map(String).join(", ") : String(value ?? "");
    if (rendered.trim()) lines.push(`- ${key}: ${rendered.trim()}`);
  }
  const refs = Array.isArray(item.evidence_refs) ? item.evidence_refs : [];
  if (refs.length) lines.push(`- evidence_refs: ${refs.map(String).join(", ")}`);
  return lines.join("\n");
}
function reportText(result2, taskPackage) {
  const findings = result2.findings.length ? result2.findings.map(markdownFinding).join("\n\n") : "(none)";
  const gaps = result2.evidence_gaps.length ? result2.evidence_gaps.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n") : "(none)";
  const machineDecision = capabilityName(taskPackage) === "acceptance-synthesis" ? ["", "```json review_result", JSON.stringify(result2, null, 2), "```"] : [];
  return [
    "# Review Report",
    "",
    "## Verdict",
    result2.gate,
    "",
    result2.summary.trim(),
    ...machineDecision,
    "",
    "## Findings",
    findings,
    "",
    "## Evidence Gaps",
    gaps,
    "",
    "## Capability Output",
    "```json",
    JSON.stringify(object(result2.output), null, 2),
    "```",
    "",
    "## Scope",
    "```json",
    JSON.stringify(result2.scope, null, 2),
    "```",
    ""
  ].join("\n");
}
function handoffText(taskPackage, result2, reportPath, handoffPath, validation) {
  const expected = object(taskPackage.expected_output);
  const handoff = object(taskPackage.handoff_contract);
  const runtime = object(taskPackage.runtime_context);
  const extensions = object(taskPackage.extensions);
  const evidence = object(extensions.review_evidence);
  const businessGate2 = String(expected.business_gate || "verdict").replace(/^FINAL_HANDOFF\.output\./, "");
  const verdict = result2.gate === "needs_owner" ? "needs_owner" : "done";
  const actualReads = Array.isArray(validation.actual_reads) ? validation.actual_reads : [];
  const evidenceRefs = [expected.file_path || reportPath, evidence.path].filter(Boolean);
  const capabilityOutput = object(result2.output);
  const capabilityLines = Object.entries(capabilityOutput).filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== void 0).map(([key, value]) => `    ${key}: ${Array.isArray(value) || value && typeof value === "object" ? JSON.stringify(value) : yamlScalar(value)}`);
  const lines = [
    "FINAL_HANDOFF:",
    `  package_id: ${yamlScalar(taskPackage.package_id)}`,
    `  verdict: ${verdict}`,
    `  summary: ${yamlScalar(result2.summary.trim())}`,
    "  output:",
    `    target_repo: ${yamlScalar(runtime.target_repo || null)}`,
    `    file_path: ${yamlScalar(expected.file_path || reportPath)}`,
    `    resolved_file_path: ${yamlScalar(expected.resolved_file_path || reportPath)}`,
    `    handoff_file: ${yamlScalar(handoff.handoff_file || handoffPath)}`,
    `    resolved_handoff_file: ${yamlScalar(handoff.resolved_handoff_file || handoffPath)}`,
    `    ${businessGate2}: ${result2.gate}`,
    `    findings_count: ${result2.findings.length}`,
    `    evidence_gaps_count: ${result2.evidence_gaps.length}`,
    ...capabilityLines,
    "  scope_actual:",
    "    read:",
    ...actualReads.length ? actualReads.map((item) => `      - ${yamlScalar(item)}`) : ["      - null"],
    "    written:",
    `      - ${yamlScalar(expected.file_path || reportPath)}`,
    `      - ${yamlScalar(handoff.handoff_file || handoffPath)}`,
    "    deleted: []",
    "  validation:",
    `    required_files_loaded: ${validation.required_files_loaded}`,
    "    required_files_loaded_detail: provided",
    `    expected_output_satisfied: ${validation.expected_output_satisfied}`,
    `    scope_compliant: ${validation.scope_compliant}`,
    `    mechanical_check: ${validation.mechanical_check}`,
    "  evidence_refs:",
    ...evidenceRefs.length ? evidenceRefs.map((item) => `    - ${yamlScalar(item)}`) : ["    - null"],
    ""
  ];
  return lines.join("\n");
}
function write(pathname, content) {
  mkdirSync7(path10.dirname(pathname), { recursive: true });
  writeFileSync4(pathname, content, "utf8");
}
function obtainReviewResult({ finalText, taskPackage, reviewResultPath: reviewResultPath2 }) {
  if (reviewResultPath2 && existsSync10(reviewResultPath2)) {
    const raw = readFileSync7(reviewResultPath2, "utf8");
    let submitted;
    try {
      submitted = JSON.parse(raw);
    } catch (error) {
      throw new Error(`submitted review-result.json is invalid JSON: ${error.message}`);
    }
    return { result: validateReviewResultPayload(submitted, taskPackage), source: "submit_tool" };
  }
  return { result: parseReviewResult(finalText, taskPackage), source: "final_response" };
}
function salvageReviewResult(parseError) {
  return {
    schema_version: 1,
    gate: "needs_owner",
    summary: `\u7ED3\u6784\u5316\u5BA1\u67E5\u7ED3\u679C\u65E0\u6548\uFF0C\u4FDD\u7559\u539F\u59CB\u56DE\u590D\u5F85 owner \u6536\u5272:${parseError}`,
    findings: [],
    evidence_gaps: [`review_result_v1 \u89E3\u6790\u5931\u8D25:${parseError};\u539F\u59CB\u6700\u7EC8\u56DE\u590D\u89C1 run \u76EE\u5F55 child-final.md`],
    scope: { reviewed: [], not_reviewed: [] },
    output: {}
  };
}
var ReviewContractError = class extends Error {
};
function synthesizeReviewResult({ taskPackage, taskText: taskText2, finalText, outDir: outDir2, fallbackRoot, reviewResultPath: reviewResultPath2 = null, runnerObservations = {} }) {
  if (!taskPackage || !structuredReviewPackage(taskPackage)) return { applied: false };
  const expected = object(taskPackage.expected_output);
  const handoff = object(taskPackage.handoff_contract);
  const reportPath = resolvedPath(taskPackage, expected.resolved_file_path || expected.file_path, fallbackRoot);
  const handoffPath = resolvedPath(taskPackage, handoff.resolved_handoff_file || handoff.handoff_file, fallbackRoot);
  if (!reportPath || !handoffPath) throw new Error("evidence review requires resolved report and handoff paths");
  let result2;
  let resultSource;
  let parseError = null;
  try {
    ({ result: result2, source: resultSource } = obtainReviewResult({ finalText, taskPackage, reviewResultPath: reviewResultPath2 }));
  } catch (error) {
    parseError = String(error?.message ?? error);
    result2 = salvageReviewResult(parseError);
    resultSource = "salvage";
  }
  if (resultSource === "salvage") {
    const report2 = reportText(result2, taskPackage);
    const handoffBody2 = handoffText(taskPackage, result2, reportPath, handoffPath, {
      actual_reads: [],
      required_files_loaded: false,
      expected_output_satisfied: false,
      scope_compliant: false,
      mechanical_check: "fail"
    });
    write(reportPath, report2);
    write(handoffPath, handoffBody2);
    write(path10.join(outDir2, "report.md"), report2);
    write(path10.join(outDir2, "handoff.md"), handoffBody2);
    return {
      applied: true,
      profile: reviewProfile(taskPackage),
      gate: result2.gate,
      result_source: resultSource,
      review_result_path: null,
      parse_error: parseError,
      findings_count: 0,
      evidence_gaps_count: result2.evidence_gaps.length,
      report_path: reportPath,
      handoff_path: handoffPath
    };
  }
  let validation;
  try {
    validation = structuredValidation({
      taskPackage,
      taskText: taskText2,
      result: result2,
      fallbackRoot,
      reportPath,
      handoffPath,
      runnerObservations
    });
  } catch (error) {
    throw new ReviewContractError(String(error?.message ?? error));
  }
  const report = reportText(result2, taskPackage);
  const handoffBody = handoffText(taskPackage, result2, reportPath, handoffPath, validation);
  write(reportPath, report);
  write(handoffPath, handoffBody);
  write(path10.join(outDir2, "report.md"), report);
  write(path10.join(outDir2, "handoff.md"), handoffBody);
  return {
    applied: true,
    profile: reviewProfile(taskPackage),
    gate: result2.gate,
    result_source: resultSource,
    review_result_path: resultSource === "submit_tool" ? reviewResultPath2 : null,
    findings_count: result2.findings.length,
    evidence_gaps_count: result2.evidence_gaps.length,
    report_path: reportPath,
    handoff_path: handoffPath
  };
}
if (process.argv[1] && path10.basename(process.argv[1]).toLowerCase() === "review_result_synthesis.mjs") {
  if (process.argv[2] !== "self-test") {
    console.error("usage: node ops/tools/review_result_synthesis.mjs self-test");
    process.exit(2);
  }
  const selfTestModule = "./review_result_synthesis.selftest.mjs";
  import(selfTestModule).then((module) => {
    module.selfTest();
    console.log("review_result_synthesis self-test: pass");
  }).catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}

// ops/tools/task_result_synthesis.mjs
import { existsSync as existsSync11, mkdirSync as mkdirSync8, writeFileSync as writeFileSync5 } from "node:fs";
import { spawnSync as spawnSync2 } from "node:child_process";
import path11 from "node:path";
var TASK_RESULT_TOOL_NAME = "submit_task_result";
var TASK_RESULT_SCHEMA_VERSION = 1;
var INCOMPLETE_VERDICTS = /* @__PURE__ */ new Set(["needs_owner", "partial", "needs_split"]);
var RESERVED_OUTPUT_KEYS = ["target_repo", "file_path", "resolved_file_path", "handoff_file", "resolved_handoff_file"];
var YAML_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
var NON_PATH_PREFIXES = ["http://", "https://", "command:", "cmd:", "shell:", "powershell:", "bash:"];
var PATH_SUFFIXES = [".md", ".json", ".yaml", ".yml", ".txt", ".csv"];
var TASK_RESULT_V1_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: true,
  required: ["verdict", "summary", "sections"],
  properties: {
    // 输入层不写 const：模型可省略固定版本（工具补数字 1），显式写出的非 1 值由
    // validateTaskResultPayload 明确拒绝；落盘记录的 schema_version 始终是数字 1。
    schema_version: { type: "number", description: '\u53EF\u7701\u7565\uFF1A\u56FA\u5B9A\u534F\u8BAE\u7248\u672C\uFF0C\u5DE5\u5177\u4F1A\u8865\u6210\u6570\u5B57 1\uFF1B\u663E\u5F0F\u5199\u51FA\u65F6\u53EA\u63A5\u53D7 1\uFF08"1" \u4F1A\u88AB\u65E0\u635F\u5F52\u4E00\u4E3A 1\uFF09' },
    verdict: { type: "string", minLength: 1, description: "\u5FC5\u586B\uFF1B\u53EA\u53D6 task_package.handoff_contract.accept_verdicts \u4E4B\u4E00" },
    summary: { type: "string", minLength: 1, description: "\u5FC5\u586B\uFF1B\u4E00\u884C\u7ED3\u8BBA\uFF0C\u4E0D\u542B\u6362\u884C" },
    title: { type: "string", description: "\u62A5\u544A\u6807\u9898\uFF1B\u7F3A\u7701\u53D6\u4EFB\u52A1\u5305 title \u6216 package_id" },
    sections: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "\u5FC5\u586B\uFF1B\u62A5\u544A\u7AE0\u8282\uFF1A\u952E\u4E3A task_package.expected_output.required_sections \u91CC\u7684\u7AE0\u8282\u540D\uFF0C\u503C\u4E3A\u8BE5\u8282 Markdown \u6B63\u6587\uFF1B\u6BCF\u4E2A\u5FC5\u9700\u7AE0\u8282\u90FD\u8981\u975E\u7A7A\uFF0C\u53EF\u8FFD\u52A0\u989D\u5916\u7AE0\u8282\uFF1B\u6574\u4F53\u5199\u6210 JSON \u5B57\u7B26\u4E32\u4F1A\u88AB\u65E0\u635F\u8FD8\u539F"
    },
    output: {
      type: "object",
      description: "FINAL_HANDOFF.output \u7684\u4E1A\u52A1\u5B57\u6BB5\uFF1Aexpected_output.business_gate \u6307\u5B9A\u7684\u95E8\u5B57\u6BB5\u4E0E\u80FD\u529B\u63D0\u793A\u8BCD\u8981\u6C42\u7684\u5B57\u6BB5\uFF1B\u8DEF\u5F84\u7C7B\u4E94\u4E2A\u4FDD\u7559\u952E\u7531\u6E32\u67D3\u5668\u586B\u5199"
    },
    scope_actual: {
      type: "object",
      properties: {
        read: { type: "array", items: { type: "string" } },
        written: { type: "array", items: { type: "string" } },
        deleted: { type: "array", items: { type: "string" } }
      },
      description: "\u5B9E\u9645\u8BFB\u3001\u5199\u3001\u5220\u7684\u8DEF\u5F84\uFF1B\u62A5\u544A\u4E0E handoff \u8DEF\u5F84\u7531\u6E32\u67D3\u5668\u8865\u5165 written"
    },
    evidence_refs: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "\u652F\u6491\u7ED3\u8BBA\u7684\u5F15\u7528\uFF08\u8DEF\u5F84\u3001path:line\u3001URL \u6216 command: \u524D\u7F00\u7684\u547D\u4EE4\uFF09\uFF1B\u8DEF\u5F84\u7C7B\u5F15\u7528\u5FC5\u987B\u771F\u5B9E\u5B58\u5728"
    }
  }
});
function object2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringArray(value, label) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`task_result_v1 ${label} must be a string array`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`task_result_v1 ${label} must not contain empty items`);
    return item.trim();
  });
}
var INPUT_ERROR_PREFIX = "submit_task_result input error:";
var ERROR_LIST_LIMIT = 8;
var JSON_WRAPPED_OBJECT_FIELDS = ["sections", "output", "scope_actual"];
var SCOPE_ACTUAL_KEYS = ["read", "written", "deleted"];
function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length} items)`;
  if (typeof value === "string") return `string(${value.length} chars)`;
  if (typeof value === "number" || typeof value === "boolean") return `${typeof value}(${String(value)})`;
  return typeof value;
}
function boundedList(items, limit = ERROR_LIST_LIMIT) {
  const list = [...items].map(String);
  if (list.length <= limit) return list.join(", ");
  return `${list.slice(0, limit).join(", ")} (+${list.length - limit} more)`;
}
function inputError(message) {
  return new Error(`${INPUT_ERROR_PREFIX} ${message}`);
}
function jsonWrapped(value, field, expected) {
  try {
    return JSON.parse(value);
  } catch {
    throw inputError(`${field} is a JSON string that does not parse (${describeValue(value)}); pass ${expected}.`);
  }
}
function objectField(value, field) {
  if (value === void 0 || value === null) return value;
  const parsed = typeof value === "string" ? jsonWrapped(value, field, "an object") : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw inputError(`${field} must be an object; received ${describeValue(parsed)}.`);
  }
  return parsed;
}
function stringArrayField(value, field) {
  if (value === void 0 || value === null) return value;
  const parsed = typeof value === "string" ? jsonWrapped(value, field, "a string array") : value;
  if (!Array.isArray(parsed)) throw inputError(`${field} must be a string array; received ${describeValue(parsed)}.`);
  parsed.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw inputError(`${field}[${index}] must be a non-empty string; received ${describeValue(item)}.`);
    }
  });
  return parsed;
}
function normalizeTaskResultArguments(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw inputError(`arguments must be a JSON object with verdict, summary and sections; received ${describeValue(raw)}.`);
  }
  const args2 = { ...raw };
  const version = args2.schema_version;
  if (version === void 0 || version === null) {
    args2.schema_version = TASK_RESULT_SCHEMA_VERSION;
  } else if (typeof version === "number" && Number.isInteger(version)) {
  } else if (typeof version === "string" && /^\d+$/.test(version.trim())) {
    args2.schema_version = Number(version.trim());
  } else {
    throw inputError(`schema_version must be the number ${TASK_RESULT_SCHEMA_VERSION} or omitted; received ${describeValue(version)}.`);
  }
  for (const field of JSON_WRAPPED_OBJECT_FIELDS) args2[field] = objectField(args2[field], field);
  args2.evidence_refs = stringArrayField(args2.evidence_refs, "evidence_refs");
  for (const field of ["verdict", "summary"]) {
    if (args2[field] === void 0 || args2[field] === null) throw inputError(`${field} is required; received ${describeValue(args2[field])}.`);
    if (typeof args2[field] !== "string" || !args2[field].trim()) {
      throw inputError(`${field} must be a non-empty string; received ${describeValue(args2[field])}.`);
    }
  }
  if (args2.title !== void 0 && args2.title !== null && typeof args2.title !== "string") {
    throw inputError(`title must be a string; received ${describeValue(args2.title)}.`);
  }
  if (args2.sections === void 0 || args2.sections === null) {
    throw inputError("sections is required; pass an object of section name -> markdown body (keys are task_package.expected_output.required_sections).");
  }
  for (const [name, body] of Object.entries(args2.sections)) {
    if (typeof body !== "string") {
      throw inputError(`sections["${String(name).slice(0, 60)}"] must be a markdown string; received ${describeValue(body)}.`);
    }
  }
  const scopeActual = args2.scope_actual;
  if (scopeActual !== void 0 && scopeActual !== null) {
    const normalized = {};
    for (const key of SCOPE_ACTUAL_KEYS) {
      const list = stringArrayField(scopeActual[key], `scope_actual.${key}`);
      if (list !== void 0 && list !== null) normalized[key] = list;
    }
    args2.scope_actual = normalized;
  }
  return args2;
}
function normalizeSectionName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
function resolvedOutputPath(taskPackage, value, fallbackRoot) {
  const raw = String(value || "").trim();
  if (!raw || raw === "null") return null;
  if (path11.isAbsolute(raw)) return path11.resolve(raw);
  const runtime = object2(taskPackage.runtime_context);
  return path11.resolve(String(runtime.output_root || fallbackRoot), raw);
}
function taskResultOutputPaths(taskPackage, fallbackRoot) {
  const expected = object2(taskPackage?.expected_output);
  const handoff = object2(taskPackage?.handoff_contract);
  return {
    reportPath: resolvedOutputPath(taskPackage, expected.resolved_file_path || expected.file_path, fallbackRoot),
    handoffPath: resolvedOutputPath(taskPackage, handoff.resolved_handoff_file || handoff.handoff_file, fallbackRoot)
  };
}
function requiredSections(taskPackage) {
  const sections = object2(taskPackage?.expected_output).required_sections;
  if (!Array.isArray(sections)) return [];
  return sections.map((item) => String(item || "").trim()).filter(Boolean);
}
function acceptVerdicts(taskPackage) {
  const values = object2(taskPackage?.handoff_contract).accept_verdicts;
  if (!Array.isArray(values)) return [];
  return values.map((item) => String(item || "").trim()).filter(Boolean);
}
function businessGate(taskPackage) {
  return String(object2(taskPackage?.expected_output).business_gate || "").replace(/^FINAL_HANDOFF\.output\./, "").trim();
}
function gateValues(taskPackage) {
  const contracts = object2(object2(taskPackage?.extensions).capability_contract);
  for (const slot of Object.values(contracts)) {
    const raw = String(object2(slot).gate_values || "");
    if (raw) return raw.split("|").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}
function referencePath(value) {
  let text3 = String(value || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!text3 || text3 === "FINAL_HANDOFF" || text3 === "-") return null;
  const lowered = text3.toLowerCase();
  if (NON_PATH_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return null;
  if (text3.startsWith("`") || text3.startsWith("$")) return null;
  if (/^[A-Za-z][A-Za-z0-9_-]*\|/.test(text3)) return null;
  if (!(text3.includes("/") || text3.includes("\\") || PATH_SUFFIXES.some((suffix) => text3.endsWith(suffix)))) return null;
  const label = /^[A-Za-z][\w-]*:\s+(\S.*)$/.exec(text3);
  if (label) text3 = label[1].trim().replace(/^["'`]+|["'`]+$/g, "");
  const line = /^(.*):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/.exec(text3);
  if (line) text3 = line[1];
  return text3;
}
function referenceRoots(taskPackage, fallbackRoot) {
  const runtime = object2(taskPackage?.runtime_context);
  return [...new Set([runtime.output_root, runtime.target_repo, fallbackRoot].map((item) => String(item || "").trim()).filter(Boolean))];
}
function referenceExists(candidate, roots) {
  if (path11.isAbsolute(candidate)) return existsSync11(candidate);
  return roots.some((root) => existsSync11(path11.resolve(root, candidate)));
}
function validateTaskResultPayload(payload, taskPackage, { fallbackRoot = process.cwd() } = {}) {
  const raw = object2(payload);
  if (raw.schema_version !== TASK_RESULT_SCHEMA_VERSION) {
    throw new Error(`task_result_v1 schema_version must be the number ${TASK_RESULT_SCHEMA_VERSION} (omit the field to let the tool fill it in); got ${describeValue(raw.schema_version)}`);
  }
  const accepted = acceptVerdicts(taskPackage);
  const verdict = String(raw.verdict || "").trim();
  if (!verdict) throw new Error("task_result_v1 verdict is required");
  if (accepted.length && !accepted.includes(verdict)) {
    throw new Error(`task_result_v1 verdict must be one of ${accepted.join(" | ")}; got ${verdict}`);
  }
  const summary = String(raw.summary ?? "").trim();
  if (!summary) throw new Error("task_result_v1 summary is required");
  if (/[\r\n]/.test(summary)) throw new Error("task_result_v1 summary must be a single line");
  const title = String(raw.title ?? "").trim();
  const sectionsInput = raw.sections;
  if (!sectionsInput || typeof sectionsInput !== "object" || Array.isArray(sectionsInput)) {
    throw new Error("task_result_v1 sections must be an object of section name -> markdown body");
  }
  const sections = /* @__PURE__ */ new Map();
  for (const [name, body] of Object.entries(sectionsInput)) {
    const key = normalizeSectionName(name);
    if (!key) throw new Error("task_result_v1 sections contain an empty section name");
    if (typeof body !== "string") throw new Error(`task_result_v1 sections[${name}] must be a markdown string`);
    if (sections.has(key)) throw new Error(`task_result_v1 sections contain duplicate section ${name}`);
    sections.set(key, { name: String(name).trim(), body: body.replace(/\r\n?/g, "\n").trim() });
  }
  const required = requiredSections(taskPackage);
  const missing = required.filter((name) => !sections.get(normalizeSectionName(name))?.body);
  if (missing.length && !INCOMPLETE_VERDICTS.has(verdict)) {
    throw new Error(`task_result_v1 sections are missing or empty for required_sections: ${boundedList(missing)}`);
  }
  const output = object2(raw.output);
  for (const [key, value] of Object.entries(output)) {
    if (!YAML_KEY.test(key)) throw new Error(`task_result_v1 output key is not a plain identifier: ${key}`);
    if (typeof value === "function" || typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`task_result_v1 output.${key} is not JSON-serializable`);
    }
  }
  const gate = businessGate(taskPackage);
  if (gate && !INCOMPLETE_VERDICTS.has(verdict)) {
    const value = output[gate];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`task_result_v1 output.${gate} is required by expected_output.business_gate`);
    }
    const allowed = gateValues(taskPackage);
    if (allowed.length && !allowed.includes(value.trim())) {
      throw new Error(`task_result_v1 output.${gate} must be one of ${allowed.join(" | ")}; got ${value}`);
    }
  }
  const scopeInput = object2(raw.scope_actual);
  const scopeActual = {
    read: stringArray(scopeInput.read, "scope_actual.read"),
    written: stringArray(scopeInput.written, "scope_actual.written"),
    deleted: stringArray(scopeInput.deleted, "scope_actual.deleted")
  };
  const evidenceRefs = stringArray(raw.evidence_refs, "evidence_refs");
  const roots = referenceRoots(taskPackage, fallbackRoot);
  const missingRefs = [];
  for (const ref of evidenceRefs) {
    const candidate = referencePath(ref);
    if (candidate && !referenceExists(candidate, roots) && !missingRefs.includes(candidate)) missingRefs.push(candidate);
  }
  if (missingRefs.length) {
    throw new Error(`task_result_v1 evidence_refs reference missing paths: ${boundedList(missingRefs)}`);
  }
  return {
    schema_version: TASK_RESULT_SCHEMA_VERSION,
    verdict,
    summary,
    title,
    sections: [...sections.values()],
    output: JSON.parse(JSON.stringify(output)),
    scope_actual: scopeActual,
    evidence_refs: evidenceRefs
  };
}
var YAML_SPECIAL_WORDS = /* @__PURE__ */ new Set(["", "~", "null", "true", "false", "yes", "no", "on", "off", "y", "n"]);
function yamlQuote(text3) {
  return `'${text3.replace(/'/g, "''")}'`;
}
function yamlScalar2(value) {
  if (value === null || value === void 0) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  const text3 = String(value);
  if (YAML_SPECIAL_WORDS.has(text3.trim().toLowerCase())) return yamlQuote(text3);
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text3) || /\s$/.test(text3) || /^\s/.test(text3)) return yamlQuote(text3);
  if (text3.includes(": ") || text3.includes(" #") || text3.endsWith(":")) return yamlQuote(text3);
  if (/^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(text3) || /^0x[0-9a-fA-F]+$/.test(text3)) return yamlQuote(text3);
  return text3;
}
function yamlLines(value, indent) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}[]`];
    return value.flatMap((item) => {
      if (item && typeof item === "object") {
        const nested = yamlLines(item, indent + 2);
        return [`${pad}- ${nested[0].trimStart()}`, ...nested.slice(1)];
      }
      return [`${pad}- ${yamlScalar2(item)}`];
    });
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([key]) => YAML_KEY.test(key));
    if (!entries.length) return [`${pad}{}`];
    return entries.flatMap(([key, item]) => yamlEntry(key, item, indent));
  }
  return [`${pad}${yamlScalar2(value)}`];
}
function yamlEntry(key, value, indent) {
  const pad = " ".repeat(indent);
  if (typeof value === "string" && value.includes("\n")) {
    const body = value.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    return [`${pad}${key}: |-`, ...body.split("\n").map((line) => line ? `${pad}  ${line}` : "")];
  }
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}${key}: []`];
    return [`${pad}${key}:`, ...yamlLines(value, indent + 2)];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([item]) => YAML_KEY.test(item));
    if (!entries.length) return [`${pad}${key}: {}`];
    return [`${pad}${key}:`, ...yamlLines(value, indent + 2)];
  }
  return [`${pad}${key}: ${yamlScalar2(value)}`];
}
function reportTitle(result2, taskPackage) {
  const title = String(result2.title || "").trim();
  if (title) return title;
  const packageTitle = String(taskPackage?.title || "").trim();
  if (packageTitle) return packageTitle;
  return String(taskPackage?.package_id || "Task Report").trim();
}
function renderTaskReport(result2, taskPackage) {
  const ordered = [];
  const seen = /* @__PURE__ */ new Set();
  for (const name of requiredSections(taskPackage)) {
    const key = normalizeSectionName(name);
    const section = result2.sections.find((item) => normalizeSectionName(item.name) === key);
    if (!section || seen.has(key)) continue;
    seen.add(key);
    ordered.push({ name, body: section.body });
  }
  for (const section of result2.sections) {
    const key = normalizeSectionName(section.name);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(section);
  }
  const lines = [`# ${reportTitle(result2, taskPackage)}`, "", `- verdict: ${result2.verdict}`, `- summary: ${result2.summary}`, ""];
  for (const section of ordered) {
    lines.push(`## ${section.name}`, "", section.body || "\u65E0", "");
  }
  return lines.join("\n");
}
function renderTaskHandoff(result2, taskPackage, { reportPath, handoffPath, scopeValidation: scopeValidation2 = null }) {
  const expected = object2(taskPackage.expected_output);
  const handoff = object2(taskPackage.handoff_contract);
  const runtime = object2(taskPackage.runtime_context);
  const declaredReport = expected.file_path || reportPath;
  const declaredHandoff = handoff.handoff_file || handoffPath;
  const written = [...result2.scope_actual.written];
  for (const item of [declaredReport, declaredHandoff]) {
    if (item && !written.includes(item)) written.push(item);
  }
  const gate = businessGate(taskPackage);
  const rank2 = (key, value) => {
    if (key === gate) return 0;
    if (typeof value === "string" && value.includes("\n")) return 3;
    if (value && typeof value === "object") return 2;
    return 1;
  };
  const customOutput = Object.entries(result2.output).filter(([key]) => !RESERVED_OUTPUT_KEYS.includes(key)).map(([key, value], index) => ({ key, value, index, rank: rank2(key, value) })).sort((left, right) => left.rank - right.rank || left.index - right.index);
  const output = {
    target_repo: runtime.target_repo || null,
    file_path: declaredReport,
    resolved_file_path: expected.resolved_file_path || reportPath,
    handoff_file: declaredHandoff,
    resolved_handoff_file: handoff.resolved_handoff_file || handoffPath,
    ...Object.fromEntries(customOutput.map(({ key, value }) => [key, value]))
  };
  const evidenceRefs = [...result2.evidence_refs];
  for (const item of [expected.resolved_file_path || reportPath, handoff.resolved_handoff_file || handoffPath]) {
    if (item && !evidenceRefs.includes(item)) evidenceRefs.push(item);
  }
  const scopeCompliant = scopeValidation2?.compliant === true;
  const scopeComplianceSource = String(scopeValidation2?.source || "write_domain_unavailable");
  const writeDomainViolationCount = Math.max(0, Number(scopeValidation2?.violation_count) || 0);
  const writeDomainAuditComplete = scopeValidation2?.audit_complete === true;
  const lines = [
    "FINAL_HANDOFF:",
    ...yamlEntry("package_id", taskPackage.package_id ?? null, 2),
    ...yamlEntry("verdict", result2.verdict, 2),
    ...yamlEntry("summary", result2.summary, 2),
    ...yamlEntry("output", output, 2),
    ...yamlEntry("scope_actual", { read: result2.scope_actual.read, written, deleted: result2.scope_actual.deleted }, 2),
    "  validation:",
    "    required_files_loaded: true",
    "    required_files_loaded_detail: provided",
    "    expected_output_satisfied: true",
    `    scope_compliant: ${scopeCompliant}`,
    `    scope_compliance_source: ${yamlScalar2(scopeComplianceSource)}`,
    `    write_domain_audit_complete: ${writeDomainAuditComplete}`,
    `    write_domain_violation_count: ${writeDomainViolationCount}`,
    "    mechanical_check: pass",
    ...yamlEntry("evidence_refs", evidenceRefs, 2),
    ""
  ];
  return lines.join("\n");
}
function write2(pathname, content) {
  mkdirSync8(path11.dirname(pathname), { recursive: true });
  writeFileSync5(pathname, content, "utf8");
}
function writeTaskResultOutputs({ payload, taskPackage, reportPath, handoffPath, fallbackRoot, scopeValidation: scopeValidation2 = null }) {
  const result2 = validateTaskResultPayload(payload, taskPackage, { fallbackRoot });
  const report = renderTaskReport(result2, taskPackage);
  const handoff = renderTaskHandoff(result2, taskPackage, { reportPath, handoffPath, scopeValidation: scopeValidation2 });
  write2(reportPath, report);
  write2(handoffPath, handoff);
  return { result: result2, report, handoff };
}
function parseHandoffCheckSpec(raw) {
  const text3 = String(raw || "").trim();
  if (!text3) return null;
  const parsed = JSON.parse(text3);
  const spec = object2(parsed);
  if (!Array.isArray(spec.argv) || spec.argv.length < 2 || spec.argv.some((item) => typeof item !== "string" || !item)) {
    throw new Error("handoff check spec is present but not a usable {argv, cwd, env} object");
  }
  return {
    argv: [...spec.argv],
    cwd: String(spec.cwd || "") || null,
    env: Object.fromEntries(Object.entries(object2(spec.env)).map(([key, value]) => [key, String(value)]))
  };
}
function runHandoffCheck(spec, { spawn: spawn5 = spawnSync2, baseEnv = process.env } = {}) {
  if (!spec) return { checked: false, status: "not_configured", issues: [] };
  const run = spawn5(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd || void 0,
    env: { ...baseEnv, ...spec.env },
    encoding: "utf8",
    windowsHide: true
  });
  const stdout = String(run.stdout || "").trim();
  if (run.error || !stdout) {
    return {
      checked: true,
      status: "error",
      exit_code: run.status ?? null,
      issues: [run.error ? `handoff_check_spawn_failed=${run.error.message}` : "handoff_check_no_output"],
      stderr: String(run.stderr || "").trim().slice(0, 2e3)
    };
  }
  try {
    const parsed = JSON.parse(stdout);
    return {
      checked: true,
      status: String(parsed.status || (run.status === 0 ? "pass" : "fail")),
      exit_code: run.status ?? null,
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : []
    };
  } catch {
    return {
      checked: true,
      status: "error",
      exit_code: run.status ?? null,
      issues: ["handoff_check_output_parse_failed"],
      stdout: stdout.slice(0, 2e3)
    };
  }
}
if (process.argv[1] && path11.basename(process.argv[1]).toLowerCase() === "task_result_synthesis.mjs") {
  if (process.argv[2] !== "self-test") {
    console.error("usage: node ops/tools/task_result_synthesis.mjs self-test");
    process.exit(2);
  }
  const selfTestModule = "./task_result_synthesis.selftest.mjs";
  import(selfTestModule).then((module) => {
    module.selfTest();
    console.log("task_result_synthesis self-test: pass");
  }).catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}

// ops/tools/pi_transient_retry.mjs
var TRANSIENT_RETRY_EXTENSION_NAMES = Object.freeze([
  "pi_transient_retry.mjs",
  "pi_transient_retry.bundle.mjs"
]);

// ops/tools/pi_task_result_extension.mjs
import { mkdirSync as mkdirSync9, readFileSync as readFileSync8, writeFileSync as writeFileSync6 } from "node:fs";
import path12 from "node:path";
function taskPackageFromFile(taskPackagePath) {
  const parsed = JSON.parse(readFileSync8(taskPackagePath, "utf8"));
  const body = parsed && typeof parsed === "object" && parsed.task_package && typeof parsed.task_package === "object" ? parsed.task_package : parsed;
  if (!body || typeof body !== "object" || !body.package_id) throw new Error("task package JSON has no task package body");
  return body;
}
function prepareTaskResultArguments(raw, taskPackage = null, cwd2 = process.cwd()) {
  let input = raw;
  if (input && typeof input === "object" && !Array.isArray(input) && input.payload_path !== void 0) {
    const { payload_path: payloadFile, schema_version: _version, ...inline } = input;
    if (typeof payloadFile !== "string" || !payloadFile.trim()) {
      throw new Error("submit_task_result input error: payload_path must be a non-empty file path string.");
    }
    if (Object.keys(inline).length) {
      throw new Error(`submit_task_result input error: pass payload_path alone; also received ${Object.keys(inline).slice(0, 8).join(", ")}.`);
    }
    const file = path12.resolve(cwd2, payloadFile.trim());
    let text3;
    try {
      text3 = readFileSync8(file, "utf8");
    } catch (error) {
      throw new Error(`submit_task_result input error: payload_path cannot be read: ${file} (${error?.code || error?.message || error}).`);
    }
    try {
      input = JSON.parse(text3.replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`submit_task_result input error: payload_path is not valid JSON: ${file} (${String(error?.message || error).slice(0, 160)}).`);
    }
  }
  const normalized = normalizeTaskResultArguments(input);
  const verdicts = taskPackage ? acceptVerdicts(taskPackage) : [];
  const verdict = String(normalized.verdict || "").trim();
  if (verdicts.length && !verdicts.includes(verdict)) {
    throw new Error(`submit_task_result input error: verdict must be one of ${verdicts.join(" | ")}; received ${JSON.stringify(verdict).slice(0, 40)}.`);
  }
  return normalized;
}
function scopeValidation(taskPackage, candidate, reportPath, handoffPath, spec, cwd2) {
  if (!spec) {
    return {
      compliant: null,
      source: "not_configured",
      audit_complete: null,
      violation_count: 0,
      blocked_count: 0,
      reported_violation_count: 0,
      reported_violations: [],
      audit_errors: [],
      audit_path: null
    };
  }
  const runtime = taskPackage?.runtime_context && typeof taskPackage.runtime_context === "object" ? taskPackage.runtime_context : {};
  const baseDirs = [...new Set([
    cwd2,
    runtime.target_repo,
    runtime.output_root,
    runtime.cwd
  ].map((item) => String(item || "")).filter(Boolean))];
  const trustedOutputViolations = [reportPath, handoffPath].filter((outputPath) => {
    const resolved = normalizeDomainPath(outputPath, cwd2, spec.caseInsensitive);
    return !evaluateWriteDomain(resolved, spec).allowed;
  });
  if (trustedOutputViolations.length) {
    throw new Error(`submit_task_result output is outside the Core direct write domain: ${trustedOutputViolations.join(", ")}`);
  }
  const audit = summarizeWriteDomainAudit({ logPath: spec.log });
  const reportedViolations = evaluateReportedWriteScope(candidate?.scope_actual, spec, baseDirs);
  return {
    compliant: audit.scope_compliant && reportedViolations.length === 0,
    source: PI_CHILD_WRITE_DOMAIN_PROFILE,
    audit_complete: audit.audit_complete,
    violation_count: audit.blocked_count + reportedViolations.length,
    blocked_count: audit.blocked_count,
    reported_violation_count: reportedViolations.length,
    reported_violations: reportedViolations,
    audit_errors: audit.audit_errors,
    audit_path: spec.log
  };
}
function submitTaskResult({ raw, taskPackagePath, reportPath, handoffPath, payloadPath, checkSpec, writeDomainSpec: writeDomainSpec2, cwd: cwd2 = process.cwd() }) {
  const candidate = JSON.parse(JSON.stringify(raw ?? {}));
  let taskPackage;
  try {
    taskPackage = taskPackageFromFile(taskPackagePath);
  } catch (error) {
    return { ok: false, saved: false, errors: [`task package unavailable: ${error?.message || error}`] };
  }
  let written;
  let writeScopeValidation;
  try {
    const normalized = prepareTaskResultArguments(candidate, taskPackage, cwd2);
    writeScopeValidation = scopeValidation(taskPackage, normalized, reportPath, handoffPath, writeDomainSpec2, cwd2);
    written = writeTaskResultOutputs({
      payload: normalized,
      taskPackage,
      reportPath,
      handoffPath,
      fallbackRoot: cwd2,
      scopeValidation: writeScopeValidation
    });
  } catch (error) {
    return {
      ok: false,
      saved: false,
      errors: [String(error?.message || error)],
      hint: "\u7ED3\u679C\u672A\u4FDD\u5B58\u3002\u4FEE\u6B63\u4E0A\u8FF0\u5B57\u6BB5\u540E\u518D\u63D0\u4EA4\u4E00\u6B21\u3002"
    };
  }
  const handoffCheck = runHandoffCheck(checkSpec);
  const record2 = {
    submitted_at: (/* @__PURE__ */ new Date()).toISOString(),
    report_path: reportPath,
    handoff_path: handoffPath,
    handoff_check: handoffCheck,
    scope_validation: writeScopeValidation,
    result: written.result
  };
  mkdirSync9(path12.dirname(payloadPath), { recursive: true });
  writeFileSync6(payloadPath, `${JSON.stringify(record2, null, 2)}
`, "utf8");
  if (handoffCheck.checked && !["pass", "error"].includes(handoffCheck.status)) {
    return {
      ok: false,
      saved: true,
      report_path: reportPath,
      handoff_path: handoffPath,
      handoff_check: handoffCheck,
      hint: "\u62A5\u544A\u4E0E handoff \u5DF2\u5199\u51FA\u4F46\u673A\u68B0\u81EA\u68C0\u672A\u901A\u8FC7\u3002\u6309 issues \u4FEE\u6B63\u540E\u518D\u63D0\u4EA4\u4E00\u6B21\u3002"
    };
  }
  const scopeViolation = writeScopeValidation?.compliant === false;
  const checkNote = {
    pass: "\u4EA4\u4ED8\u5B8C\u6210",
    not_configured: "\u4EA4\u4ED8\u5B8C\u6210\uFF1B\u672C\u4EFB\u52A1\u672A\u914D\u7F6E handoff \u81EA\u68C0\uFF0C\u7ED3\u679C\u5DF2\u4FDD\u5B58\u4F46\u672A\u7ECF\u673A\u68B0\u6821\u9A8C",
    error: "\u7ED3\u679C\u5DF2\u4FDD\u5B58\uFF1Bhandoff \u81EA\u68C0\u5668\u672C\u8EAB\u8FD0\u884C\u5931\u8D25\uFF0C\u4E0E\u7ED3\u679C\u5185\u5BB9\u65E0\u5173\uFF0C\u7236\u7EA7\u4F1A\u91CD\u65B0\u6821\u9A8C\uFF0C\u65E0\u9700\u518D\u63D0\u4EA4"
  }[handoffCheck.status];
  return {
    ok: true,
    saved: true,
    report_path: reportPath,
    handoff_path: handoffPath,
    verdict: written.result.verdict,
    handoff_check: handoffCheck,
    handoff_check_status: handoffCheck.status,
    scope_compliant: writeScopeValidation?.compliant ?? null,
    write_domain_violation_count: writeScopeValidation?.violation_count ?? 0,
    requires_parent_review: scopeViolation || handoffCheck.status === "error",
    note: scopeViolation ? `${checkNote}\uFF1B\u5199\u57DF\u8BC1\u636E\u4E0D\u5408\u89C4\uFF0C\u7236\u7EA7\u5FC5\u987B\u590D\u6838\u3002\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E\u4EFB\u52A1\u72B6\u6001\u3001\u62A5\u544A\u8DEF\u5F84\u548C\u8D8A\u754C\u4E8B\u5B9E\u3002` : `${checkNote}\u3002\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E\u4EFB\u52A1\u72B6\u6001\u4E0E\u62A5\u544A\u8DEF\u5F84\u5373\u53EF\uFF0C\u4E0D\u518D\u91CD\u5199\u62A5\u544A\u6B63\u6587\u3002`
  };
}

// ops/tools/run-pi-task.mjs
init_child_task_contract();
var rawArgv = process.argv.slice(2);
var args = parseArgs(rawArgv);
var selfTestRequested = rawArgv.includes("--self-test") || boolArg(args, "self-test", false);
var RUNTIME_NAME = "pi";
var BACKEND2 = "pi-rpc";
var RUNNER_NAME2 = "run-pi-task";
var PI_CHILD_SYSTEM_PROMPT_PROFILE = "pi-child-worker-system/v1";
var DEFAULT_PI_CLI = path15.join(
  process.env.APPDATA || path15.join(process.env.USERPROFILE || "", "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js"
);
var NO_TIMEOUT_MS = 24 * 60 * 60 * 1e3;
var COMMAND_TIMEOUT_MS = 6e4;
var ABORT_SETTLE_WINDOW_MS = 12e3;
var SETTLE_GRACE_MS = 3e3;
var ACTIVITY_EVENT_TYPES = /* @__PURE__ */ new Set(["agent_start", "turn_start", "message_start", "tool_execution_start", "compaction_start"]);
var SHUTDOWN_TERM_MS = 5e3;
var SHUTDOWN_KILL_MS = 5e3;
var STDERR_CAP_BYTES = 262144;
var STDOUT_FRAME_CAP_BYTES = 16 * 1024 * 1024;
var MALFORMED_LINES_FUSE = 100;
var TOOL_LOOP_WINDOW = 20;
var TOOL_LOOP_MAX_DISTINCT = 2;
var TOOL_LOOP_COMMAND_TOOLS = /* @__PURE__ */ new Set(["bash", "powershell"]);
var TOOL_LOOP_NOOP_STREAK = 8;
var TOOL_LOOP_NOOP_COMMAND = /^\s*(echo|printf|write-host|write-output|true|exit|:)\b[^|;&><`$(\n]*$/i;
var CONTINUE_INTERRUPTED_PROMPT = "Continue the interrupted task from the last complete tool boundary. Do not redo completed work.";
var NON_RESUMABLE_FAILURE_TYPES = /* @__PURE__ */ new Set([
  "identity_mismatch",
  "invalid_model_effort",
  "invalid_model",
  "auth_or_preflight_failed"
]);
function taskToolSelection(taskPackage) {
  const allowed = taskPackage?.tool_contract?.allowed;
  if (allowed == null) return { tools: null, source: "pi_configured_tools", error: null };
  if (!Array.isArray(allowed) || allowed.some((name) => typeof name !== "string" || !name.trim())) {
    return { tools: null, source: "task_package.tool_contract.allowed", error: "tool_contract.allowed must be null or an array of non-empty Pi tool names" };
  }
  return { tools: [...new Set(allowed.map((name) => name.trim()))], source: "task_package.tool_contract.allowed", error: null };
}
function collectRepeated(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      const next = argv[i + 1];
      if (next !== void 0 && !next.startsWith("--")) {
        values.push(next);
        i += 1;
      }
    }
  }
  return values;
}
function parseModelRef(raw) {
  const text3 = String(raw ?? "").trim();
  if (!text3) {
    return { provider: "", modelId: "", ok: false, reason: "missing" };
  }
  const index = text3.indexOf("/");
  if (index <= 0 || index === text3.length - 1) {
    return { provider: "", modelId: text3, ok: false, reason: "malformed" };
  }
  return { provider: text3.slice(0, index), modelId: text3.slice(index + 1), ok: true, reason: "ok" };
}
var ROLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function runtimeRoleFromTask(taskPackage) {
  const agent = taskPackage?.agent;
  if (!agent || typeof agent !== "object") {
    return { role: "", status: "missing_role" };
  }
  const runtimeRole = String(agent.runtime_role || "").trim();
  const role = String(agent.role || "").trim();
  const candidate = runtimeRole || role;
  if (!candidate) return { role: "", status: "missing_role" };
  if (!ROLE_NAME_RE.test(candidate)) return { role: candidate, status: "invalid_role" };
  return { role: candidate, status: "ok" };
}
function resolveModelConfigForEffort({ explicitRuntimeRoot = null, opsRoot = null, projectRoot: projectRoot2 = null } = {}) {
  const candidates = [];
  if (explicitRuntimeRoot) candidates.push({ root: explicitRuntimeRoot, source: "runtime_root" });
  const envRoot = String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
  if (envRoot) candidates.push({ root: envRoot, source: "SUBAGENT_CONTROL_REPO_ROOT" });
  if (!envRoot && opsRoot) candidates.push({ root: path15.dirname(opsRoot), source: "script_root" });
  return resolveModelConfigSources({ roots: candidates, projectRoot: projectRoot2 });
}
function checkFrozenEffort(frozen, model2, effort2) {
  if (!Array.isArray(frozen.efforts)) throw new Error("\u51BB\u7ED3\u9009\u578B\u7F3A\u5C11 efforts\uFF0C\u662F\u65E7\u7248\u672C\u51C6\u5907\u7684\u4EFB\u52A1\uFF1B\u91CD\u65B0\u51C6\u5907\u5E76\u6D3E\u53D1\u3002");
  if (frozen.resolved_model !== model2 || frozen.resolved_effort !== effort2) {
    throw new Error(`\u8BF7\u6C42 ${model2}@${effort2} \u4E0E\u51BB\u7ED3\u9009\u578B ${frozen.resolved_model}@${frozen.resolved_effort} \u4E0D\u4E00\u81F4\uFF1B\u91CD\u65B0\u51C6\u5907\u4EFB\u52A1\u3002`);
  }
  if (!frozen.efforts.includes(effort2)) {
    throw new Error(`${effort2} \u4E0D\u5728 ${model2} \u7684\u53EF\u9009\u6863\u4F4D\uFF08${frozen.efforts.join("/")}\uFF09\u5185\u3002`);
  }
  const range = frozen.effort_range;
  const applied = (frozen.authorization?.applied_overrides ?? []).map((item) => item.kind);
  const rank2 = (level) => EFFORT_LEVELS.indexOf(level);
  if (range && (rank2(effort2) < rank2(range[0]) || rank2(effort2) > rank2(range[1])) && !applied.includes("effort_range")) {
    throw new Error(`${effort2} \u8D85\u51FA\u63A8\u8350\u884C ${frozen.pick} \u7684\u6863\u4F4D\u8303\u56F4 ${range[0]}\u2013${range[1]}\uFF0C\u51BB\u7ED3\u9009\u578B\u6CA1\u6709 effort_range \u6388\u6743\u3002`);
  }
  return { source: "frozen_selection", model: model2, effort: effort2, efforts: frozen.efforts, effort_range: range, applied_overrides: applied };
}
function phaseFromPiEvent(type) {
  switch (type) {
    case "agent_start":
    case "turn_start":
      return "turn_wait";
    case "message_start":
    case "message_update":
    case "message_end":
      return "response_item";
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return "tool_call";
    case "auto_retry_start":
    case "auto_retry_end":
      return "auto_retry";
    case "compaction_start":
    case "compaction_end":
      return "compaction";
    case "agent_settled":
      return "turn_completed";
    default:
      return null;
  }
}
function compactPiToolCall(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  return {
    id: event.toolCallId ?? null,
    type: event.type ?? null,
    name: event.toolName ?? null,
    status: event.type === "tool_execution_end" ? event.isError ? "error" : "completed" : "running",
    command_preview: typeof event.args?.command === "string" ? redactText(event.args.command).slice(0, 500) : null,
    full_output_path: event.partialResult?.details?.fullOutputPath ?? event.result?.details?.fullOutputPath ?? event.result?.details?.stdout_path ?? null
  };
}
function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costTotal: 0 };
}
function compactUsage(usage) {
  const source = usage && typeof usage === "object" ? usage : {};
  return {
    input: Number(source.input ?? 0) || 0,
    output: Number(source.output ?? 0) || 0,
    cacheRead: Number(source.cacheRead ?? 0) || 0,
    cacheWrite: Number(source.cacheWrite ?? 0) || 0,
    reasoning: Number(source.reasoning ?? 0) || 0,
    totalTokens: Number(source.totalTokens ?? 0) || 0,
    costTotal: Number(source.cost?.total ?? 0) || 0
  };
}
function addUsage(target, addend) {
  for (const key of Object.keys(target)) {
    target[key] += Number(addend?.[key] ?? 0) || 0;
  }
  return target;
}
function compactSessionStats(stats) {
  if (!stats || typeof stats !== "object") {
    return null;
  }
  return {
    sessionId: stats.sessionId ?? null,
    userMessages: stats.userMessages ?? null,
    assistantMessages: stats.assistantMessages ?? null,
    toolCalls: stats.toolCalls ?? null,
    toolResults: stats.toolResults ?? null,
    totalMessages: stats.totalMessages ?? null,
    tokens: stats.tokens && typeof stats.tokens === "object" ? { ...stats.tokens } : null,
    cost: stats.cost ?? null,
    contextUsage: stats.contextUsage && typeof stats.contextUsage === "object" ? { ...stats.contextUsage } : null
  };
}
function assistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}
var PiRpcClient = class {
  constructor(options = {}) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? {};
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {
    };
    this.onUiRequest = typeof options.onUiRequest === "function" ? options.onUiRequest : () => null;
    this.recordRaw = options.recordRaw === true;
    this.child = null;
    this.nextId = 1;
    this.pending = /* @__PURE__ */ new Map();
    this.stdoutBuffer = "";
    this.stderrText = "";
    this.stderrBytes = 0;
    this.rawRecords = [];
    this.malformedLines = 0;
    this.eventCounts = /* @__PURE__ */ new Map();
    this.startedAt = null;
    this.exitInfo = null;
    this.transportError = null;
    this.shuttingDown = false;
    this.failWaiter = null;
    this.failed = new Promise((_, reject) => {
      this.failWaiter = reject;
    });
    this.failed.catch(() => {
    });
  }
  start() {
    this.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.child = spawn4(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // PI_SKIP_VERSION_CHECK:headless 下禁止启动期版本检查交互面(调试仓 live_pi_rpc_probe.py 同款姿势)。
      env: { ...process.env, ...this.env, NO_COLOR: "1", PI_SKIP_VERSION_CHECK: "1" }
    });
    this.child.on("error", (error) => {
      this.failTransport(new Error(`pi spawn failed: ${error.message}`));
    });
    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal: signal ?? null, at: (/* @__PURE__ */ new Date()).toISOString() };
      if (!this.shuttingDown) {
        this.failTransport(new Error(`pi process exited before completion: code=${code} signal=${signal}`));
      }
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (this.stderrText.length < STDERR_CAP_BYTES) {
        this.stderrText += chunk;
      }
    });
    return this;
  }
  failTransport(error) {
    if (!this.transportError) {
      this.transportError = error instanceof Error ? error : new Error(String(error));
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(this.transportError);
    }
    this.pending.clear();
    this.failWaiter(this.transportError);
  }
  consume(chunk) {
    if (this.transportError || this.shuttingDown) {
      this.stdoutBuffer = "";
      return;
    }
    this.stdoutBuffer += chunk;
    let index;
    while ((index = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line.trim()) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.malformedLines += 1;
        if (this.recordRaw) {
          this.rawRecords.push({ at: (/* @__PURE__ */ new Date()).toISOString(), dir: "recv-bad", line: redactText(line).slice(0, 2e3) });
        }
        if (this.malformedLines >= MALFORMED_LINES_FUSE) {
          this.failTransport(new Error(`pi protocol stream unreliable: ${this.malformedLines} malformed stdout lines`));
          this.stdoutBuffer = "";
          return;
        }
        continue;
      }
      if (this.recordRaw) {
        this.rawRecords.push({ at: (/* @__PURE__ */ new Date()).toISOString(), dir: "recv", msg: redactAuth(message) });
      }
      this.dispatch(message);
      if (this.transportError || this.shuttingDown) {
        this.stdoutBuffer = "";
        return;
      }
    }
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > STDOUT_FRAME_CAP_BYTES) {
      this.failTransport(new Error(`pi stdout frame exceeded ${STDOUT_FRAME_CAP_BYTES} bytes without newline`));
      this.stdoutBuffer = "";
    }
  }
  dispatch(message) {
    if (message?.type === "response") {
      const key = message.id === void 0 || message.id === null ? "" : String(message.id);
      const entry = this.pending.get(key);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(key);
        entry.resolve(message);
      }
      return;
    }
    if (message?.type === "extension_ui_request") {
      if (this.shuttingDown) return;
      const reply = this.onUiRequest(message);
      if (reply) {
        this.writeRaw(reply);
      }
      return;
    }
    const type = String(message?.type ?? "unknown");
    this.eventCounts.set(type, (this.eventCounts.get(type) ?? 0) + 1);
    this.onEvent(message);
  }
  writeRaw(payload) {
    if (!this.child?.stdin?.writable) {
      return false;
    }
    if (this.recordRaw) {
      this.rawRecords.push({ at: (/* @__PURE__ */ new Date()).toISOString(), dir: "send", msg: redactAuth(payload) });
    }
    this.child.stdin.write(`${JSON.stringify(payload)}
`);
    return true;
  }
  send(type, payload = {}, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    if (this.transportError) {
      return Promise.reject(this.transportError);
    }
    if (this.shuttingDown) {
      return Promise.reject(new Error(`pi client is shutting down (command ${type})`));
    }
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error(`pi stdin is not writable (command ${type})`));
    }
    const id = String(this.nextId);
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for pi response: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.writeRaw({ ...payload, type, id });
    return promise;
  }
  // 命令的成功响应;success=false 时抛出带 command/error 的错误,由调用点归类。
  async call(type, payload = {}, options = {}) {
    const response = await this.send(type, payload, options);
    if (response?.success !== true) {
      const detail = typeof response?.error === "string" ? response.error : JSON.stringify(redactAuth(response ?? null));
      const error = new Error(`pi command ${type} failed: ${detail}`);
      error.piCommand = type;
      error.piError = detail;
      throw error;
    }
    return response.data ?? null;
  }
  eventCountList() {
    return [...this.eventCounts.entries()].map(([key, count]) => ({ key, count }));
  }
  exited() {
    return this.child ? this.child.exitCode !== null || this.child.signalCode !== null : true;
  }
  // EOF 优雅关停；超时后 Windows 整树回收，POSIX 先 TERM 再 KILL。
  async shutdown(options = {}) {
    if (!this.child) {
      return { requested: false, reason: "not_started", exitInfo: null };
    }
    this.shuttingDown = true;
    const shutdownError = new Error("pi client shutting down");
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(shutdownError);
    }
    this.pending.clear();
    const steps = [];
    if (options.forceTreeCleanup === true && process.platform === "win32" && !this.exited()) {
      const treeKill = terminateChildProcessTree(this.child.pid);
      steps.push("kill");
      await this.waitForExit(2e3);
      return { requested: true, steps, treeKill, exitInfo: this.exitInfo };
    }
    try {
      this.child.stdin.end();
      steps.push("stdin_eof");
    } catch {
      steps.push("stdin_eof_failed");
    }
    if (!await this.waitForExit(SHUTDOWN_TERM_MS)) {
      while (options.cooperativeOnly?.() && !this.exited()) {
        options.onUnconfirmed?.();
        await this.waitForExit(250);
      }
      if (this.exited()) return { requested: true, steps, treeKill: null, exitInfo: this.exitInfo };
      if (process.platform === "win32") {
        const treeKill = terminateChildProcessTree(this.child.pid);
        steps.push("kill");
        await this.waitForExit(2e3);
        return { requested: true, steps, treeKill, exitInfo: this.exitInfo };
      }
      try {
        this.child.kill("SIGTERM");
        steps.push("sigterm");
      } catch {
        steps.push("sigterm_failed");
      }
      if (!await this.waitForExit(SHUTDOWN_KILL_MS)) {
        const treeKill = terminateChildProcessTree(this.child.pid);
        try {
          this.child.kill("SIGKILL");
        } catch {
        }
        steps.push("kill");
        await this.waitForExit(2e3);
        return { requested: true, steps, treeKill, exitInfo: this.exitInfo };
      }
    }
    return { requested: true, steps, treeKill: null, exitInfo: this.exitInfo };
  }
  waitForExit(ms) {
    if (this.exited()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.exited()), ms);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
};
var scriptPath = fileURLToPath4(import.meta.url);
if (selfTestRequested) {
  try {
    const { runSelfTest: runSelfTest2 } = await Promise.resolve().then(() => (init_run_pi_task_selftest(), run_pi_task_selftest_exports));
    await runSelfTest2(scriptPath);
    process.exit(0);
  } catch (error) {
    console.error(`PI_RUNNER_SELF_TEST_FAIL: ${error?.message ?? error}`);
    process.exit(1);
  }
}
var skillRoot = path15.dirname(path15.dirname(scriptPath));
var runtimeRoot2 = path15.resolve(
  stringArg(args, "runtimeRoot", process.env.SUBAGENT_RUNTIME_ROOT || path15.dirname(skillRoot))
);
var runStamp = stampForPath();
var runId = `pi-child-task-${runStamp}`;
var controlHome = path15.resolve(
  stringArg(args, "controlHome", process.env.PI_CONTROL_HOME || defaultControlHome())
);
var contextMode = stringArg(args, "contextMode", "isolated");
var legacyCwdArg = stringArg(args, "cwd", "");
var targetCwdSource = args.targetCwd !== void 0 ? "targetCwd" : legacyCwdArg ? "legacy-cwd" : "process-cwd";
var targetCwd = path15.resolve(stringArg(args, "targetCwd", legacyCwdArg || process.cwd()));
var childCwdArg = stringArg(args, "childCwd", "");
var childCwdDefault = contextMode === "project-aware" ? targetCwd : path15.join(controlHome, "workspaces", runId);
var childCwdSource = childCwdArg ? "childCwd" : contextMode === "project-aware" ? "targetCwd-project-aware" : "controlHome-isolated-workspace";
var childCwd = path15.resolve(childCwdArg || childCwdDefault);
var cwd = childCwd;
var outDir = path15.resolve(stringArg(args, "outDir", path15.join(controlHome, "runs", runId)));
var artifactsDir = path15.resolve(stringArg(args, "artifactsDir", path15.join(controlHome, "artifacts", runId)));
var livePath = path15.join(outDir, "child-task-live.json");
var liveEventsPath = path15.join(outDir, "child-task-events.jsonl");
var reviewResultPath = path15.join(outDir, "review-result.json");
var reviewTaskPackagePath = path15.join(outDir, "review-task-package.json");
var taskResultPayloadPath = path15.join(outDir, "task-result.json");
var taskResultDraftPath = path15.join(artifactsDir, "task-result-payload.json");
var writeDomainAuditPath = path15.join(outDir, "write-domain-events.jsonl");
var identityPath = path15.join(outDir, "child-task-identity.json");
var sessionDir = path15.join(outDir, "pi-session");
var stderrPath = path15.join(outDir, "pi-stderr.log");
var targetAgentsPath = path15.join(targetCwd, "AGENTS.md");
var workerSystemPromptPath = path15.join(runtimeRoot2, "ops", "templates", "worker-system-prompt.md");
var modelFromArg = stringArg(args, "model", "");
var effortFromArg = stringArg(args, "effort", "");
var selectionFileArg = stringArg(args, "selectionFile", "");
var selectionFile = selectionFileArg ? path15.resolve(selectionFileArg) : null;
var frozenSelection = null;
if (selectionFile) {
  if (!existsSync13(selectionFile)) {
    throw new Error(`selection file does not exist: ${selectionFile}`);
  }
  frozenSelection = JSON.parse(readFileSync11(selectionFile, "utf8"));
  if (!frozenSelection || typeof frozenSelection !== "object" || Array.isArray(frozenSelection)) {
    throw new Error("selection file must contain an object");
  }
}
var modelFromEnv = process.env.PI_CONTROL_MODEL || "";
var effortFromEnv = process.env.PI_CONTROL_EFFORT || "";
var model = modelFromArg || modelFromEnv;
var effort = effortFromArg || effortFromEnv;
var modelSource = modelFromArg ? "argument" : modelFromEnv ? "env" : "missing";
var effortSource = effortFromArg ? "argument" : effortFromEnv ? "env" : "missing";
var modelRef = parseModelRef(model);
var explicitExtensionPaths = collectRepeated(rawArgv, "--ext");
var bashProcessTreeExtensionPath = path15.join(outDir, "pi-child-bash-process-tree.mjs");
var workerToolsSnapshotPath = path15.join(outDir, "worker-tools.json");
var toolRuntimeExtensionPaths = String(process.env.PI_CONTROL_PI || "").trim() ? [] : [bashProcessTreeExtensionPath];
var extensionPaths = [.../* @__PURE__ */ new Set([
  ...toolRuntimeExtensionPaths,
  ...explicitExtensionPaths
])];
var PI_CHILD_RUNNER_EXTENSION_PROFILE = "pi-child-runner-extensions/v1";
var RUNNER_FIXED_EXTENSIONS = Object.freeze({
  worker_tools: Object.freeze(["pi_worker_tools_extension.mjs", "pi_worker_tools_extension.bundle.mjs"]),
  // grep / find 以同名注册覆盖 Pi 内置实现；缺失即运行包不完整，不回落到内置版。
  search: Object.freeze(["pi_search_extension.mjs", "pi_search_extension.bundle.mjs"]),
  // 只给原生分类漏掉的临时服务错误追加原生可识别提示；不新增重试循环，不改 retry 次数和间隔。
  transient_retry: TRANSIENT_RETRY_EXTENSION_NAMES
});
var simProfileJson = stringArg(args, "simProfileJson", "");
var turnTimeoutMs = numberArg(args, "turnTimeoutMs", 0);
var effectiveTurnTimeoutMs = turnTimeoutMs > 0 ? turnTimeoutMs : NO_TIMEOUT_MS;
var globalTimeoutMs = numberArg(args, "timeoutMs", 0);
var effectiveGlobalTimeoutMs = globalTimeoutMs > 0 ? globalTimeoutMs : NO_TIMEOUT_MS;
var saveRawEvidence = boolArg(args, "saveRawEvidence", false);
var taskFile = stringArg(args, "taskFile", "");
var taskArg = stringArg(args, "task", "");
var taskPackageFile = stringArg(args, "taskPackageFile", "");
var resumeSession = stringArg(args, "resumeSession", "");
var controlFileArg = stringArg(args, "controlFile", "");
var controlFile = controlFileArg ? path15.resolve(controlFileArg) : null;
var attemptId = stringArg(args, "attemptId", "");
var bashCleanupPath = path15.join(outDir, `bash-tree-cleanup.${path15.basename(attemptId || runId)}.jsonl`);
var commandJobsRoot = path15.join(outDir, `command-jobs.${path15.basename(attemptId || runId)}`);
var writeDomainSpecArg = stringArg(args, "writeDomainSpec", "");
var writeDomainSpecPath = writeDomainSpecArg ? path15.resolve(writeDomainSpecArg) : null;
var piCli = process.env.PI_CONTROL_PI?.trim() || DEFAULT_PI_CLI;
var toolAllowlist = null;
var startedAtMs = Date.now();
var globalDeadlineMs = startedAtMs + effectiveGlobalTimeoutMs;
var promptStarted = false;
var settledIdleConfirmed = false;
var cancellationPoll = null;
var externalCancellation = {
  requested: false,
  reason: null,
  attempt_id: null,
  requested_at: null,
  detected_at: null,
  abort_sent: false,
  abort_acknowledged: false,
  abort_error: null,
  deadline_ms: null,
  graceful: false
};
var ExternalCancellationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ExternalCancellationError";
  }
};
function remainingGlobalMs() {
  return Math.max(0, globalDeadlineMs - Date.now());
}
var live = makeLiveWriter({
  outDir,
  livePath,
  eventsPath: liveEventsPath,
  initialState: {
    rev: 0,
    run_id: runId,
    attempt_id: attemptId || null,
    turn_completed: false,
    backend: BACKEND2,
    status: "starting",
    phase: "bootstrap",
    model,
    effort,
    context_mode: contextMode,
    cwd,
    child_cwd: childCwd,
    target_cwd: targetCwd,
    pid: process.pid,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    updated_at: null,
    last_event_at: null,
    last_notification_method: null,
    last_tool_call: null,
    event_counts: [],
    tool_call_counts: []
  }
});
var writeLive = (patch) => live.writeLive(patch);
function failureFinalDoc(failureType, message) {
  return [
    "## \u7ED3\u8BBA",
    "\u4EFB\u52A1\u72B6\u6001:failed",
    "",
    "## \u4E8B\u5B9E\u4E0E\u8BC1\u636E",
    `- runner failure_type: ${failureType}`,
    "",
    "## \u5DF2\u68C0\u67E5\u5185\u5BB9",
    "- pi RPC \u8FD0\u8F93\u4E0E\u5F53\u524D\u4EFB\u52A1\u9636\u6BB5\u3002",
    "",
    "## \u5931\u8D25\u68C0\u67E5",
    `- ${message}`,
    "",
    "## \u4E0D\u786E\u5B9A\u9879",
    "\u65E0",
    "",
    "## \u8FB9\u754C",
    "- runner \u5728\u5931\u8D25\u70B9\u505C\u6B62,\u672A\u7EE7\u7EED\u6267\u884C\u540E\u7EED\u4EFB\u52A1\u6B65\u9AA4\u3002"
  ].join("\n");
}
function ensureFailureFinal(target, failureType, message) {
  const finalPath = path15.join(outDir, "child-final.md");
  if (existsSync13(finalPath)) {
    return finalPath;
  }
  ensureDir(outDir);
  const doc = failureFinalDoc(failureType, message);
  writeFileSync9(finalPath, doc, "utf8");
  target.turn = { ...target.turn, finalTextPath: finalPath, finalTextSource: "runner_failure_summary" };
  target.required_headings = headingStatus(doc);
  return finalPath;
}
var failEarlyBase = makeFailEarly({ outDir });
function failEarly(target, failureType, message) {
  ensureFailureFinal(target, failureType, message);
  writeLive({
    status: "failed",
    phase: "finished",
    event: "finished",
    final_status: "failed",
    failure_type: failureType
  });
  failEarlyBase(target, failureType, message);
}
var simProfile = null;
var simProfileError = (() => {
  try {
    simProfile = parseSimulationProfile(simProfileJson);
    return null;
  } catch (error) {
    return error;
  }
})();
var result = {
  ok: false,
  status: "pending",
  failure_type: "unknown",
  backend: BACKEND2,
  runner: RUNNER_NAME2,
  outputPath: null,
  cwd,
  childCwd,
  targetCwd,
  run: {
    runId,
    controlHome,
    outDir,
    artifactsDir
  },
  context: {
    mode: contextMode,
    childCwd,
    targetCwd,
    legacyCwdArg: legacyCwdArg || null,
    childCwdSource,
    targetCwdSource,
    targetAgentsPath,
    targetAgentsLoaded: false,
    workerSystemPromptProfile: PI_CHILD_SYSTEM_PROMPT_PROFILE,
    workerSystemPromptPath,
    globalAppendSystemSuppressed: true,
    isolationOk: null,
    note: "pi \u4EE5 -nc \u5173\u95ED\u4E0A\u4E0B\u6587\u6587\u4EF6\u53D1\u73B0\uFF0C\u5E76\u7528\u663E\u5F0F --append-system-prompt \u9009\u62E9 worker system\u3001\u66FF\u4EE3\u5168\u5C40 APPEND_SYSTEM \u81EA\u52A8\u53D1\u73B0\uFF1Bisolated \u6A21\u5F0F\u518D\u7528\u72EC\u7ACB\u7A7A\u5DE5\u4F5C\u533A\u7269\u7406\u9694\u79BB\uFF0Cproject-aware \u6A21\u5F0F cwd=targetCwd\u3002"
  },
  orchestration: {
    ok: false,
    status: "pending",
    failure_type: "unknown"
  },
  task: {
    ok: false,
    status: "pending",
    failure_type: "unknown",
    blockedSignals: []
  },
  selection: {
    model: model || null,
    effort: effort || null,
    frozen: frozenSelection,
    modelSource,
    effortSource,
    requestedProvider: modelRef.ok ? modelRef.provider : null,
    requestedModelId: modelRef.ok ? modelRef.modelId : null,
    appliedProvider: null,
    appliedModel: null,
    appliedEffort: null,
    availableModels: [],
    availableModelCount: 0,
    availableThinking: [],
    extensions: extensionPaths,
    extensionProfile: PI_CHILD_MODEL_EXTENSION_PROFILE,
    runnerExtensionProfile: PI_CHILD_RUNNER_EXTENSION_PROFILE,
    // 固定清单逐项的解析结果：路径为本次加载的文件，null 为运行目录缺失或尚未解析。
    runnerExtensions: Object.fromEntries(Object.keys(RUNNER_FIXED_EXTENSIONS).map((id) => [id, null])),
    compactionExtensionProfile: PI_CHILD_COMPACTION_EXTENSION_PROFILE,
    toolRuntimeProfile: PI_CHILD_BASH_PROCESS_TREE_PROFILE,
    writeDomainExtensionProfile: PI_CHILD_WRITE_DOMAIN_PROFILE,
    workerResources: null,
    effort_check: null,
    validated: false,
    note: null
  },
  identity: {
    requested: {
      provider: modelRef.ok ? modelRef.provider : null,
      modelId: modelRef.ok ? modelRef.modelId : null,
      thinkingLevel: effort || null
    },
    applied: null,
    corrections: [],
    verified: false,
    evidencePath: identityPath
  },
  turns: [],
  usage: emptyUsage(),
  permission: {
    evidenceDir: outDir,
    answer_mode: "tool_allowlist",
    tool_allowlist: toolAllowlist,
    decisions: [],
    note: "pi \u65E0 OS sandbox \u5F3A\u5236\u3001\u65E0\u53CD\u5411\u6743\u9650\u8BE2\u95EE;\u5DE5\u5177\u9ED8\u8BA4\u7EE7\u627F\u914D\u7F6E\uFF0C\u663E\u5F0F\u6570\u7EC4\u624D\u5728 spawn \u671F\u9650\u5236(-t)\u3002Core \u4E0B\u53D1\u5199\u57DF\u65F6,write/edit \u5728\u6267\u884C\u524D\u673A\u68B0\u5B88\u95E8;bash/powershell \u7684\u547D\u4EE4\u5199\u5165\u4ECD\u7531\u4EFB\u52A1\u5408\u540C\u4E0E\u4E8B\u540E diff \u5BA1\u8BA1\u3002"
  },
  write_domain: {
    profile: PI_CHILD_WRITE_DOMAIN_PROFILE,
    enabled: false,
    scope_compliant: null,
    audit_complete: null,
    request_count: 0,
    allowed_count: 0,
    blocked_count: 0,
    violations: [],
    audit_errors: [],
    audit_path: null,
    covered_tools: ["write", "edit"],
    command_write_enforced: false
  },
  rawEvidenceSaved: saveRawEvidence,
  runtime: null,
  diagnostics: {},
  session: null,
  turn: {
    requestedModel: model || null,
    requestedEffort: effort || null,
    requestedModelSource: modelSource,
    requestedEffortSource: effortSource
  },
  required_headings: {
    required: requiredHeadings,
    missing: requiredHeadings,
    ok: false
  },
  warnings: [],
  evidence: null,
  cleanup: null
};
if (!["isolated", "project-aware"].includes(contextMode)) {
  failEarly(result, "invalid_context_mode", "\u65E0\u6548 contextMode\u3002\u53EF\u7528\u503C\u4E3A isolated \u6216 project-aware\u3002");
}
if (!existsSync13(targetCwd)) {
  failEarly(result, "target_cwd_missing", `\u4EFB\u52A1\u76EE\u6807\u5DE5\u4F5C\u533A\u4E0D\u5B58\u5728:${targetCwd}`);
}
if (!existsSync13(workerSystemPromptPath)) {
  failEarly(
    result,
    "transport_failed",
    `\u7F3A\u5C11 worker system prompt:${workerSystemPromptPath}\u3002\u8BF7\u91CD\u65B0\u6784\u5EFA\u5E76\u90E8\u7F72 child runner\u3002`
  );
}
if (simProfileError) {
  failEarly(result, "invalid_sim_profile", `simProfileJson \u89E3\u6790\u5931\u8D25:${simProfileError?.message ?? simProfileError}`);
}
if (model && !modelRef.ok) {
  failEarly(result, "invalid_model", `--model \u9700\u8981 provider/model-id \u5F62\u5F0F,\u5B9E\u5F97:${model}`);
}
var taskText = readTaskText({ taskFile, task: taskArg });
if (!taskText) {
  failEarly(result, "child_task_failed", "\u7F3A\u5C11\u4EFB\u52A1\u6587\u672C\u3002\u8BF7\u63D0\u4F9B --task \u6216 --taskFile\u3002");
}
if (resumeSession && !existsSync13(resumeSession)) {
  failEarly(result, "session_missing", `resumeSession \u4E0D\u5B58\u5728:${resumeSession}`);
}
ensureDir(outDir);
if (toolRuntimeExtensionPaths.length > 0) {
  try {
    const bashToolModuleUrl = resolvePiChildBashToolModule(piCli);
    const bashExecutable = resolveChildBash();
    const bashProcessTreeSource = renderPiChildBashProcessTreeSource({ bashToolModuleUrl, bashExecutable, cleanupPath: bashCleanupPath });
    writeFileSync9(bashProcessTreeExtensionPath, `${bashProcessTreeSource}
`, "utf8");
  } catch (error) {
    failEarly(result, "transport_failed", `Pi Bash extension preparation failed: ${error?.message || error}`);
  }
}
ensureDir(childCwd);
ensureDir(artifactsDir);
ensureDir(sessionDir);
writeLive({ status: "starting", phase: "workspace_prepared", event: "workspace_prepared" });
function readTaskPackageFile(file) {
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync11(file, "utf8"));
    return parsed?.task_package && typeof parsed.task_package === "object" ? parsed.task_package : parsed;
  } catch (error) {
    failEarly(result, "child_task_failed", `\u4EFB\u52A1\u5305\u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6:${file}:${error?.message || error}`);
  }
}
var reviewTaskPackage = readTaskPackageFile(taskPackageFile);
var evidenceOnlyTask = evidenceOnlyPackage(reviewTaskPackage);
var structuredReviewTask = structuredReviewPackage(reviewTaskPackage);
var declaredToolSelection = taskToolSelection(reviewTaskPackage);
if (declaredToolSelection.error) {
  failEarly(result, "invalid_tool_contract", declaredToolSelection.error);
}
var roleResolution = runtimeRoleFromTask(reviewTaskPackage);
if (roleResolution.status !== "ok") {
  const detail = roleResolution.status === "invalid_role" ? `runtime role \u975E\u6CD5:${roleResolution.role}\u3002\u8BF7\u5728\u4EFB\u52A1\u5305 agent.runtime_role \u6216 agent.role \u4E2D\u63D0\u4F9B\u5408\u6CD5\u89D2\u8272\u540D\u3002` : "\u7F3A\u5C11 runtime role\u3002\u8BF7\u5728\u4EFB\u52A1\u5305 agent.runtime_role \u6216 agent.role \u4E2D\u63D0\u4F9B\u5DF2\u914D\u7F6E\u89D2\u8272\uFF1B\u65E0\u6CD5\u5728\u8EAB\u4EFD\u4E0D\u660E\u65F6\u6821\u9A8C\u5DF2\u4FDD\u5B58\u6863\u4F4D\u8303\u56F4\u3002";
  failEarly(result, "invalid_model_effort", detail);
}
var envControlRoot = String(process.env.SUBAGENT_CONTROL_REPO_ROOT || "").trim();
var modelConfigSources = null;
try {
  const binding = reviewTaskPackage?.extensions?.model_config;
  modelConfigSources = binding ? resolveModelConfigSources({ roots: [{ root: binding.global_root, source: "runtime_root" }], projectRoot: binding.project_root }) : resolveModelConfigForEffort({
    explicitRuntimeRoot: args.runtimeRoot !== void 0 || process.env.SUBAGENT_RUNTIME_ROOT ? runtimeRoot2 : null,
    opsRoot: skillRoot,
    projectRoot: targetCwd
  });
  result.selection.model_config = modelConfigSources.describe();
} catch (error) {
  const message = error instanceof ModelConfigError || error?.name === "ModelConfigError" ? error.message : String(error?.message || error);
  result.selection.model_config = {
    status: "unavailable",
    runtime_root: runtimeRoot2,
    project_root: targetCwd,
    legacy_env_root: envControlRoot || null,
    error: message
  };
  failEarly(result, "invalid_model_effort", message);
}
var roleConfigFile = modelConfigSources.roleConfigPath(roleResolution.role);
result.selection.model_config.role_file = roleConfigFile;
if (!existsSync13(roleConfigFile)) failEarly(result, "invalid_model_effort", `\u7F3A\u5C11\u89D2\u8272\u914D\u7F6E:${roleConfigFile}\u3002`);
if (!model || !effort) {
  failEarly(result, "invalid_model_effort", "\u5FC5\u987B\u540C\u65F6\u63D0\u4F9B --model \u4E0E --effort\uFF1A\u6863\u4F4D\u6309\u6A21\u578B\u53EF\u9009\u6863\u4F4D\u6821\u9A8C\uFF0C\u4E0D\u4EA4\u7ED9 Pi \u81EA\u9009\u9ED8\u8BA4\u3002");
}
try {
  result.selection.effort_check = frozenSelection ? checkFrozenEffort(frozenSelection, model, effort) : (() => {
    const efforts = modelEfforts(loadSelectionConfig(modelConfigSources), model);
    if (!efforts.includes(effort)) throw new Error(`${effort} \u4E0D\u5728 ${model} \u7684\u53EF\u9009\u6863\u4F4D\uFF08${efforts.join("/")}\uFF09\u5185\u3002`);
    return { source: "model_notes", model, effort, efforts };
  })();
} catch (error) {
  failEarly(result, "invalid_model_effort", String(error?.message || error));
}
var workerResourceSpec = reviewTaskPackage?.worker_resources;
var recoveredTools = null;
if (!workerResourceSpec) {
  const role = roleResolution.role;
  try {
    const capability = String(reviewTaskPackage?.agent?.capability?.name || "").trim();
    const recovered = resolveWorkerResources(loadSelectionConfig(modelConfigSources), role, capability);
    if (recovered) {
      recoveredTools = recovered.tools;
      workerResourceSpec = {
        extensions: recovered.extensions,
        skills: recovered.skills,
        project_skills: recovered.project_skills,
        source: { role, capability, recovered_from: "legacy_role_resources" }
      };
      result.warnings.push(`\u65E7\u4EFB\u52A1\u5305\u7F3A\u5C11 worker_resources\uFF1B\u6309\u5F53\u524D\u89D2\u8272 ${role} \u7684\u8D44\u6E90\u914D\u7F6E\u6062\u590D\u3002`);
    }
  } catch (error) {
    failEarly(result, "worker_resources_unavailable", `\u65E0\u6CD5\u6062\u590D\u65E7\u4EFB\u52A1\u5305\u7684\u89D2\u8272\u8D44\u6E90\uFF1A${error.message}`);
  }
}
workerResourceSpec ??= { extensions: [], skills: [], project_skills: "none" };
var effectiveToolAllowlist = evidenceOnlyTask ? [] : declaredToolSelection.tools ?? recoveredTools;
var workerResourcesConfigPath = path15.join(runtimeRoot2, "ops", "templates", "worker-resources.json");
var workerImports;
try {
  workerImports = loadWorkerResourcesConfig(workerResourcesConfigPath);
} catch (error) {
  failEarly(result, "worker_resources_unavailable", error.message);
}
var toolSurface = workerSpawnTools(effectiveToolAllowlist, workerImports);
for (const name of toolSurface.dropped) result.warnings.push(`\u4EFB\u52A1\u5DE5\u5177 ${name} \u5728\u5BFC\u5165\u8303\u56F4\u91CC\u4E0D\u5F00\u653E\u6216\u672A\u8BB0\u5F55\uFF0C\u672C\u6B21\u4E0D\u542F\u7528\u3002`);
var toolEnabled = (name) => toolSurface.tools === null ? workerImports.tools[name]?.access === "default_on" : toolSurface.tools.includes(name);
var commandJobsEnabled = toolRuntimeExtensionPaths.length > 0 && !evidenceOnlyTask && toolEnabled("command_job");
var commandJobsConfig = null;
if (commandJobsEnabled) {
  const jobsExtensionPath = resolveSiblingExtension(["pi_child_command_jobs.mjs", "pi_child_command_jobs.bundle.mjs"]);
  if (!jobsExtensionPath) failEarly(result, "transport_failed", "Command jobs runtime is missing; rebuild/deploy the runner.");
  commandJobsConfig = {
    root: commandJobsRoot,
    cwd: childCwd,
    owner: attemptId || runId,
    shell: resolveChildBash(),
    controlFile,
    attemptId
  };
  extensionPaths.push(jobsExtensionPath);
}
var structuredReviewWriteTool = structuredReviewTask && (effectiveToolAllowlist === null || effectiveToolAllowlist.includes("write"));
var guardedDirectTools = (effectiveToolAllowlist || ["write", "edit"]).filter((name) => ["write", "edit"].includes(name));
var forceExcludedTools = excludedTools(workerImports);
var workerResources = { spec: workerResourceSpec, extensions: [], skills: [], warnings: [] };
try {
  if (evidenceOnlyTask || process.env.PI_CONTROL_PI?.trim()) {
    extensionPaths.push(...resolvePiChildModelExtensions(), ...resolvePiChildCompactionExtensions());
  } else {
    const installed = await discoverWorkerResources({ cwd: targetCwd, piCli });
    workerResources = { spec: workerResourceSpec, ...selectTaskResources(workerImports, installed, workerResourceSpec) };
    for (const resource of workerResources.extensions) if (!extensionPaths.includes(resource.path)) extensionPaths.push(resource.path);
    for (const source of installed.missing) result.warnings.push(`Configured Pi resource is not installed: ${source}`);
    for (const item of workerResources.warnings) {
      result.warnings.push({
        off: `\u4EFB\u52A1\u6E05\u5355\u7684 ${item.type} ${item.name} \u5728\u5BFC\u5165\u8303\u56F4\u91CC\u4E0D\u5F00\u653E\u6216\u672A\u8BB0\u5F55\uFF0C\u672C\u6B21\u4E0D\u52A0\u8F7D\u3002`,
        not_installed: `\u4EFB\u52A1\u6E05\u5355\u7684 ${item.type} ${item.name} \u672C\u673A\u672A\u5B89\u88C5\uFF0C\u672C\u6B21\u4E0D\u52A0\u8F7D\u3002`,
        shadowed_by_user_skill: `\u9879\u76EE\u7EA7 skill ${item.name} \u4E0E\u5DF2\u9009\u7528\u6237\u7EA7 skill \u540C\u540D\uFF0C\u672C\u6B21\u8DF3\u8FC7\u3002`
      }[item.reason]);
    }
  }
} catch (error) {
  failEarly(result, "worker_resources_unavailable", error.message);
}
result.selection.workerResources = workerResources;
if (toolEnabled("grep") || toolEnabled("find")) {
  const searchExtensionPath = resolveSiblingExtension(RUNNER_FIXED_EXTENSIONS.search);
  if (!searchExtensionPath) failEarly(result, "transport_failed", "Search tools extension (pi_search_extension) is missing beside runner; rebuild/deploy the runner.");
  result.selection.runnerExtensions.search = searchExtensionPath;
  extensionPaths.push(searchExtensionPath);
}
var workerToolsExtensionPath = resolveSiblingExtension(RUNNER_FIXED_EXTENSIONS.worker_tools);
if (!workerToolsExtensionPath) failEarly(result, "worker_resources_unavailable", "Missing pi_worker_tools_extension beside runner; rebuild/deploy the runner.");
result.selection.runnerExtensions.worker_tools = workerToolsExtensionPath;
extensionPaths.push(workerToolsExtensionPath);
var transientRetryPath = resolveSiblingExtension(RUNNER_FIXED_EXTENSIONS.transient_retry);
result.selection.runnerExtensions.transient_retry = transientRetryPath;
if (transientRetryPath && !extensionPaths.includes(transientRetryPath)) extensionPaths.push(transientRetryPath);
else if (!transientRetryPath) {
  result.warnings.push("\u77AC\u65F6\u670D\u52A1\u9519\u8BEF\u5206\u7C7B\u6269\u5C55\u4E0D\u5728\u8FD0\u884C\u76EE\u5F55\uFF1B\u672C\u6B21\u4E0D\u8FFD\u52A0\u539F\u751F\u91CD\u8BD5\u63D0\u793A\u3002");
}
var writeDomainSpec = null;
if (writeDomainSpecPath) {
  try {
    const input = JSON.parse(readFileSync11(writeDomainSpecPath, "utf8"));
    if (!input || typeof input !== "object" || !Array.isArray(input.paths)) {
      throw new Error("write-domain spec must contain paths[]");
    }
    if (input.contract_version !== PI_CHILD_WRITE_DOMAIN_PROFILE) {
      throw new Error(`write-domain spec contract_version must be ${PI_CHILD_WRITE_DOMAIN_PROFILE}`);
    }
    writeDomainSpec = parseWriteDomainSpec(JSON.stringify({
      version: PI_CHILD_WRITE_DOMAIN_PROFILE,
      taskId: input.task_id || null,
      allowed: input.paths,
      deleteAllowed: Array.isArray(input.delete_paths) ? input.delete_paths : [],
      // 与提示词口径一致:产物目录与本次证据目录都可写；运行包只读，任何任务都不因 marker/链接自动扩权。
      roots: [artifactsDir, outDir],
      runtimeRoot: existsSync13(path15.join(runtimeRoot2, "consumer-release-manifest.json")) ? runtimeRoot2 : null,
      log: writeDomainAuditPath,
      caseInsensitive: input.case_insensitive === true
    }), { baseDir: targetCwd });
  } catch (error) {
    failEarly(result, "invalid_write_domain", `\u5199\u57DF\u89C4\u683C\u4E0D\u53EF\u7528:${writeDomainSpecPath}: ${error?.message || error}`);
  }
}
var writeDomainExtensionPath = writeDomainSpec ? resolveSiblingExtension(["pi_write_domain_extension.mjs", "pi_write_domain_extension.bundle.mjs"]) : null;
if (writeDomainSpec) {
  if (!writeDomainExtensionPath) {
    failEarly(result, "invalid_write_domain", "pi write-domain extension is missing beside the runner");
  }
  rmSync4(writeDomainAuditPath, { force: true });
  extensionPaths.push(writeDomainExtensionPath);
}
result.write_domain = {
  ...result.write_domain,
  enabled: Boolean(writeDomainSpec),
  scope_compliant: null,
  audit_complete: null,
  audit_path: writeDomainSpec ? writeDomainAuditPath : null,
  claim_path_count: writeDomainSpec?.allowed?.length ?? 0,
  delete_path_count: writeDomainSpec?.deleteAllowed?.length ?? 0,
  artifact_root_count: writeDomainSpec?.roots?.length ?? 0,
  guarded_tools: guardedDirectTools,
  command_tools_present: (effectiveToolAllowlist || ["bash", "powershell"]).filter((name) => ["bash", "powershell"].includes(name))
};
result.permission.write_domain_guard = writeDomainSpec ? { profile: PI_CHILD_WRITE_DOMAIN_PROFILE, guarded_tools: guardedDirectTools, command_write_enforced: false } : null;
function resolveSiblingExtension(names) {
  const selfDir = path15.dirname(fileURLToPath4(import.meta.url));
  for (const name of names) {
    const candidate = path15.join(selfDir, name);
    if (existsSync13(candidate)) return candidate;
  }
  return null;
}
var reviewResultExtensionPath = structuredReviewTask ? resolveSiblingExtension(["pi_review_result_extension.mjs", "pi_review_result_extension.bundle.mjs"]) : null;
var reviewResultToolEnabled = Boolean(reviewResultExtensionPath);
if (structuredReviewTask && !reviewResultToolEnabled) {
  result.warnings.push(
    "submit_review_result \u6269\u5C55\u4E0D\u53EF\u7528(\u8FD0\u884C\u76EE\u5F55\u7F3A pi_review_result_extension.mjs);\u7ED3\u6784\u5316\u7ED3\u679C\u9000\u56DE\u6700\u7EC8\u56DE\u590D\u5185\u8054 JSON \u94FE\u8DEF\u3002"
  );
}
if (reviewResultToolEnabled) {
  extensionPaths.push(reviewResultExtensionPath);
}
var handoffCheckSpec = parseHandoffCheckSpec(stringArg(args, "handoffCheck", ""));
var taskResultPaths = !structuredReviewTask && reviewTaskPackage ? taskResultOutputPaths(reviewTaskPackage, targetCwd) : { reportPath: null, handoffPath: null };
var taskResultExtensionPath = taskResultPaths.reportPath && taskResultPaths.handoffPath ? resolveSiblingExtension(["pi_task_result_extension.mjs", "pi_task_result_extension.bundle.mjs"]) : null;
if (taskResultPaths.reportPath && taskResultPaths.handoffPath && !taskResultExtensionPath) {
  failEarly(result, "transport_failed", "Task result extension (pi_task_result_extension) is missing beside runner; rebuild/deploy the runner.");
}
var taskResultToolEnabled = Boolean(taskResultExtensionPath);
if (taskResultToolEnabled) {
  extensionPaths.push(taskResultExtensionPath);
}
var submitTool = reviewResultToolEnabled ? "submit_review_result" : taskResultToolEnabled ? TASK_RESULT_TOOL_NAME : null;
var spawnToolAllowlist = toolSurface.tools === null ? null : [...toolSurface.tools.filter((name) => name !== "command_job" || commandJobsEnabled), ...submitTool ? [submitTool] : []];
workerResources.tools = spawnToolAllowlist;
result.permission.force_excluded_tools = forceExcludedTools;
result.permission.answer_mode = spawnToolAllowlist === null ? "configured_tools" : "tool_allowlist";
result.permission.tool_allowlist = spawnToolAllowlist;
result.permission.tool_inventory_path = workerToolsSnapshotPath;
result.permission.tool_allowlist_source = declaredToolSelection.source;
result.permission.structured_review_write_tool = structuredReviewWriteTool;
result.permission.evidence_only_no_tools = evidenceOnlyTask && !reviewResultToolEnabled;
result.permission.review_result_tool = reviewResultToolEnabled;
result.permission.task_result_tool = taskResultToolEnabled;
var templatePath = path15.join(
  runtimeRoot2,
  "ops",
  "templates",
  structuredReviewTask ? "review-evidence-prompt-template.md" : "handoff-prompt-template.md"
);
var inlineSubmission = Array.isArray(spawnToolAllowlist) && !spawnToolAllowlist.includes("write");
var resultSubmissionText = taskResultToolEnabled && inlineSubmission ? [
  "\u505A\u5B8C\u540E\u76F4\u63A5\u8C03\u7528 `submit_task_result`\uFF0C\u5185\u8054\u4F20 verdict\u3001summary\u3001sections\uFF08\u6309\u4EFB\u52A1\u5361\u7684\u62A5\u544A\u7AE0\u8282\u9010\u8282\u5199 Markdown\uFF09\u3001",
  "output\uFF08\u4E1A\u52A1\u95E8\u4E0E\u80FD\u529B\u5408\u540C\u8981\u6C42\u7684\u5B57\u6BB5\uFF09\u3001scope_actual\u3001evidence_refs\uFF1B\u53D6\u503C\u4E0E\u5FC5\u9700\u7AE0\u8282\u89C1\u5176\u53C2\u6570\u8BF4\u660E\u3002",
  "\u8FD4\u56DE ok:false \u65F6\u6309 errors / issues \u4FEE\u6B63\u540E\u518D\u63D0\u4EA4\uFF1B\u8FD4\u56DE ok:true \u5373\u4EA4\u4ED8\u5B8C\u6210\uFF0C\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E\u4EFB\u52A1\u72B6\u6001\u4E0E\u62A5\u544A\u8DEF\u5F84\u3002"
].join("") : taskResultToolEnabled ? [
  `\u505A\u5B8C\u540E\u5148\u7528\u5199\u6587\u4EF6\u5DE5\u5177\u628A\u4EA4\u5377\u5B57\u6BB5\u5199\u6210 JSON \u6587\u4EF6 \`${taskResultDraftPath}\`\uFF1Averdict\u3001summary\u3001sections\uFF08\u6309\u4EFB\u52A1\u5361\u7684\u62A5\u544A\u7AE0\u8282`,
  "\u9010\u8282\u5199 Markdown\uFF09\u3001output\uFF08\u4E1A\u52A1\u95E8\u4E0E\u80FD\u529B\u5408\u540C\u8981\u6C42\u7684\u5B57\u6BB5\uFF09\u3001scope_actual\u3001evidence_refs\uFF1Bverdict \u53D6\u503C\u4E0E\u5FC5\u9700\u7AE0\u8282\u89C1 ",
  "`submit_task_result` \u7684\u53C2\u6570\u8BF4\u660E\u3002\u518D\u8C03\u7528 `submit_task_result`\uFF0C\u53EA\u4F20 payload_path\u3002\u8FD4\u56DE ok:false \u65F6\u6309 errors / issues ",
  "\u4FEE\u6B63\u6587\u4EF6\u540E\u518D\u63D0\u4EA4\uFF1B\u8FD4\u56DE ok:true \u5373\u4EA4\u4ED8\u5B8C\u6210\uFF0C\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E\u4EFB\u52A1\u72B6\u6001\u4E0E\u62A5\u544A\u8DEF\u5F84\u3002\u5DE5\u5177\u8C03\u7528\u53D1\u4E0D\u51FA\u65F6\uFF0C\u6587\u4EF6\u5199\u597D\u540E\u76F4\u63A5\u7ED3\u675F\u56DE\u590D\uFF0C",
  "runner \u4F1A\u8BFB\u53D6\u8BE5\u6587\u4EF6\u6309\u540C\u4E00\u5957\u6821\u9A8C\u4EE3\u4E3A\u63D0\u4EA4\uFF0C\u6709\u7F3A\u53E3\u4F1A\u53D1\u56DE\u7ED9\u4F60\u4FEE\u6B63\u3002"
].join("") : "\u672C\u4EFB\u52A1\u6CA1\u6709\u58F0\u660E\u62A5\u544A\u4E0E handoff \u6587\u4EF6\uFF0C\u6700\u7EC8\u56DE\u590D\u6309\u4E0B\u9762\u516D\u8282\u5199\u5373\u4E3A\u4EA4\u4ED8\u3002";
var FINAL_REPLY_SECTIONS_BLOCK = /<!-- final-reply-sections -->\n?([\s\S]*?)<!-- \/final-reply-sections -->\n?/;
var REVIEW_TOOL_DELIVERY = "\u7ED3\u6784\u5316\u7ED3\u679C\u7528 `submit_review_result` \u63D0\u4EA4\uFF1B\u8FD4\u56DE ok:true \u5373\u4EA4\u4ED8\u5B8C\u6210\uFF0C\u6700\u7EC8\u56DE\u590D\u4E00\u53E5\u8BDD\u5199\u660E gate \u4E0E\u7ED3\u8BBA\u3002\n";
var template = readFileSync11(templatePath, "utf8").replace(FINAL_REPLY_SECTIONS_BLOCK, structuredReviewTask ? reviewResultToolEnabled ? REVIEW_TOOL_DELIVERY : "$1" : taskResultToolEnabled ? "" : "$1").replace("{{RESULT_SUBMISSION}}", resultSubmissionText);
var taskHeadline = String(reviewTaskPackage?.goal || "").trim().split("\n")[0];
var handoffPrompt = fillTemplate(template, taskText, {
  contextMode,
  childCwd,
  targetCwd,
  artifactsDir,
  outDir,
  runtimeName: RUNTIME_NAME,
  taskReminder: taskHeadline ? `\u518D\u6B21\u786E\u8BA4\uFF1A\u672C\u6B21\u4EFB\u52A1\u662F\u300C${taskHeadline}\u300D\u3002\u6309\u4EFB\u52A1\u5361\u7684\u5B8C\u6210\u6761\u4EF6\u5168\u90E8\u505A\u5B8C\u518D\u4EA4\u4ED8\u3002` : ""
});
writeFileSync9(path15.join(outDir, "child-handoff.md"), handoffPrompt, "utf8");
writeLive({ status: "starting", phase: "handoff_prompt_prepared", event: "handoff_prompt_prepared" });
var promptMessage = resumeSession ? CONTINUE_INTERRUPTED_PROMPT : simProfile ? `${simulationProfilePrompt(simProfile)}

${handoffPrompt}` : handoffPrompt;
var roleInstructions = String(
  parse(readFileSync11(modelConfigSources.roleConfigPath(roleResolution.role), "utf8")).developer_instructions || ""
).trim();
var taskSystemPromptPath = path15.join(outDir, "worker-system.md");
writeFileSync9(
  taskSystemPromptPath,
  `${readFileSync11(workerSystemPromptPath, "utf8").trimEnd()}
${roleInstructions ? `
<role name="${roleResolution.role}">
${roleInstructions}
</role>
` : ""}`,
  "utf8"
);
var piArgs = [
  piCli,
  "--mode",
  "rpc",
  "-ne",
  "-ns",
  "-np",
  "--no-themes",
  "-nc",
  "--no-approve",
  "--append-system-prompt",
  taskSystemPromptPath,
  "--session-dir",
  sessionDir,
  ...resumeSession ? ["--session", resumeSession] : []
];
if (modelRef.ok) {
  piArgs.push("--provider", modelRef.provider, "--model", modelRef.modelId);
}
if (effort) {
  piArgs.push("--thinking", effort);
}
for (const extPath of extensionPaths) {
  piArgs.push("-e", extPath);
}
for (const skill of workerResources.skills) piArgs.push("--skill", skill.path);
if (Array.isArray(spawnToolAllowlist)) {
  if (spawnToolAllowlist.length > 0) {
    piArgs.push("-t", spawnToolAllowlist.join(","));
  } else {
    piArgs.push("--no-tools");
  }
}
if (forceExcludedTools.length) piArgs.push("-xt", forceExcludedTools.join(","));
if (reviewResultToolEnabled || taskResultToolEnabled) {
  rmSync4(reviewResultPath, { force: true });
  rmSync4(taskResultPayloadPath, { force: true });
}
if (reviewTaskPackage) writeFileSync9(reviewTaskPackagePath, `${JSON.stringify(reviewTaskPackage, null, 2)}
`, "utf8");
if (taskResultToolEnabled && !resumeSession) rmSync4(taskResultDraftPath, { force: true });
var SUBMITTED_VERDICT_STATUS = /* @__PURE__ */ new Map([
  ["done", "completed"],
  ["completed", "completed"],
  ["pass", "completed"],
  ["partial", "partial"],
  ["needs_owner", "blocked"],
  ["needs_split", "blocked"],
  ["blocked", "blocked"],
  ["failed", "failed"],
  ["fail", "failed"]
]);
function submittedTaskStatus(taskResult) {
  if (!taskResult?.submitted || !["pass", "not_configured", "error"].includes(taskResult.handoff_check_status)) return null;
  return SUBMITTED_VERDICT_STATUS.get(String(taskResult.verdict || "").trim().toLowerCase()) ?? null;
}
function readTaskResultSubmission() {
  if (!taskResultToolEnabled) return { enabled: false, submitted: false };
  if (!existsSync13(taskResultPayloadPath)) {
    return { enabled: true, submitted: false, payload_path: taskResultPayloadPath };
  }
  try {
    const record2 = JSON.parse(readFileSync11(taskResultPayloadPath, "utf8"));
    return {
      enabled: true,
      submitted: true,
      payload_path: taskResultPayloadPath,
      submitted_at: record2.submitted_at ?? null,
      verdict: record2.result?.verdict ?? null,
      handoff_check_status: record2.handoff_check?.status ?? null,
      handoff_check_issues: Array.isArray(record2.handoff_check?.issues) ? record2.handoff_check.issues : [],
      scope_compliant: record2.scope_validation?.compliant ?? null,
      write_domain_audit_complete: record2.scope_validation?.audit_complete ?? null,
      write_domain_violation_count: record2.scope_validation?.violation_count ?? 0,
      write_domain_blocked_count: record2.scope_validation?.blocked_count ?? 0,
      write_domain_reported_violation_count: record2.scope_validation?.reported_violation_count ?? 0,
      write_domain_reported_violations: Array.isArray(record2.scope_validation?.reported_violations) ? record2.scope_validation.reported_violations.slice(0, 50) : []
    };
  } catch (error) {
    return { enabled: true, submitted: false, payload_path: taskResultPayloadPath, error: String(error?.message || error) };
  }
}
var TASK_RESULT_DRAFT_FIX_ROUNDS = 2;
function ingestTaskResultDraft(trigger) {
  if (!taskResultToolEnabled || !existsSync13(taskResultDraftPath)) return null;
  if (submittedTaskStatus(readTaskResultSubmission())) return null;
  const outcome = submitTaskResult({
    raw: { payload_path: taskResultDraftPath },
    taskPackagePath: reviewTaskPackagePath,
    reportPath: taskResultPaths.reportPath,
    handoffPath: taskResultPaths.handoffPath,
    payloadPath: taskResultPayloadPath,
    checkSpec: handoffCheckSpec,
    writeDomainSpec,
    cwd: childCwd
  });
  const gaps = [...outcome.errors ?? [], ...(outcome.handoff_check?.issues ?? []).map(String)];
  const ok = outcome.ok === true || Boolean(submittedTaskStatus(readTaskResultSubmission()));
  result.task_result_ingestions = [...result.task_result_ingestions ?? [], {
    trigger,
    ok,
    gaps: gaps.slice(0, 20),
    at: (/* @__PURE__ */ new Date()).toISOString()
  }];
  writeLive({
    status: "running",
    phase: "result_collection",
    event: "task_result_draft_ingested",
    force_record_event: true,
    event_extra: { task_result_ingestion: { trigger, ok } }
  });
  return { ok, gaps };
}
function taskResultDraftFixPrompt(gaps) {
  return [
    `\u4EA4\u5377\u6587\u4EF6 \`${taskResultDraftPath}\` \u672A\u901A\u8FC7\u6821\u9A8C\uFF1A`,
    ...gaps.slice(0, 20).map((gap) => `- ${gap}`),
    "",
    "\u4FEE\u6B63\u8BE5\u6587\u4EF6\u540E\u8C03\u7528 `submit_task_result`\uFF08\u53EA\u4F20 payload_path\uFF09\uFF0C\u6216\u5199\u597D\u540E\u76F4\u63A5\u7ED3\u675F\u56DE\u590D\u3002"
  ].join("\n");
}
var eventLog = [];
var toolCallIndex = /* @__PURE__ */ new Map();
var turnReceipts = [];
var turnTexts = [];
var uiRequests = [];
var failedToolCallCount = 0;
var failedBashToolCount = 0;
var interruptedBashToolIds = /* @__PURE__ */ new Set();
var BASH_EXITED_NONZERO = /Command exited with code \d+\s*$/;
function bashExitedNormally(event) {
  const content = Array.isArray(event?.result?.content) ? event.result.content : [];
  return BASH_EXITED_NONZERO.test(content.filter((part) => part?.type === "text").map((part) => part.text).join("\n"));
}
var messageUpdateCount = 0;
var settledCount = 0;
var activityGeneration = 0;
var modelActivityObserved = false;
var compactionsStarted = 0;
var compactionsEnded = 0;
var toolLoop = { window: [], noopStreak: 0, tripped: null, warned: false };
var compactionLog = [];
var eventWaiters = /* @__PURE__ */ new Set();
function waitForEvent(match, ms) {
  return new Promise((resolve) => {
    const waiter = { match, resolve: null };
    const timer = setTimeout(() => {
      eventWaiters.delete(waiter);
      resolve(null);
    }, Math.max(1, ms));
    timer.unref();
    waiter.resolve = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    eventWaiters.add(waiter);
  });
}
function notifyEventWaiters(type, message) {
  for (const waiter of [...eventWaiters]) {
    if (waiter.match(type, message)) {
      eventWaiters.delete(waiter);
      waiter.resolve({ type, message });
    }
  }
}
function recordEvent(entry) {
  eventLog.push({ at: (/* @__PURE__ */ new Date()).toISOString(), ...entry });
  if (eventLog.length > 4e3) {
    eventLog.splice(0, eventLog.length - 4e3);
  }
}
function toolCallCounts() {
  return countBy([...toolCallIndex.values()], (item) => item.name ?? item.type ?? "unknown");
}
function stableToolArgs(value) {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(stableToolArgs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableToolArgs(value[key])]));
}
function toolCallSignature(message) {
  const name = String(message?.toolName ?? "unknown");
  const args2 = stableToolArgs(message?.args ?? null);
  let argsText;
  try {
    argsText = JSON.stringify(args2) ?? "null";
  } catch {
    argsText = String(args2);
  }
  return `${name} ${argsText}`;
}
function tripToolLoop(tripped) {
  toolLoop.tripped = tripped;
  result.tool_loop = tripped;
  writeLive({
    status: "running",
    phase: "tool_call",
    event: "tool_loop_detected",
    force_record_event: true,
    tool_loop: tripped,
    event_extra: { tool_loop: tripped }
  });
}
function observeToolCallStart(message) {
  const command = TOOL_LOOP_COMMAND_TOOLS.has(String(message?.toolName)) ? message?.args?.command : null;
  toolLoop.noopStreak = typeof command === "string" && TOOL_LOOP_NOOP_COMMAND.test(command.trim()) ? toolLoop.noopStreak + 1 : 0;
  if (!toolLoop.tripped && toolLoop.noopStreak >= TOOL_LOOP_NOOP_STREAK) {
    tripToolLoop({
      kind: "noop_commands",
      noop_streak: toolLoop.noopStreak,
      signatures: [{ preview: redactText(toolCallSignature(message)).slice(0, 300), count: toolLoop.noopStreak }],
      detected_at: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  toolLoop.window.push(toolCallSignature(message));
  if (toolLoop.window.length > TOOL_LOOP_WINDOW) toolLoop.window.shift();
  if (toolLoop.tripped || toolLoop.warned || toolLoop.window.length < TOOL_LOOP_WINDOW) return;
  const counts = /* @__PURE__ */ new Map();
  for (const signature of toolLoop.window) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  if (counts.size > TOOL_LOOP_MAX_DISTINCT || [...counts.values()].some((count) => count < 2)) return;
  toolLoop.warned = true;
  const warning = {
    kind: "signature_window",
    window: TOOL_LOOP_WINDOW,
    max_distinct: TOOL_LOOP_MAX_DISTINCT,
    signatures: [...counts].map(([signature, count]) => ({ preview: redactText(signature).slice(0, 300), count })),
    detected_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  result.tool_progress_warning = warning;
  writeLive({
    status: "running",
    phase: "tool_call",
    event: "tool_progress_warning",
    force_record_event: true,
    tool_progress_warning: warning,
    event_extra: { tool_progress_warning: warning }
  });
}
function isModelActivity(type, message) {
  if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(type)) return true;
  if (type === "message_update" && message?.message?.role === "assistant") return true;
  return type === "message_end" && message?.message?.role === "assistant";
}
function handlePiEvent(message) {
  const type = String(message?.type ?? "unknown");
  if (isModelActivity(type, message)) modelActivityObserved = true;
  if (ACTIVITY_EVENT_TYPES.has(type)) {
    activityGeneration += 1;
  }
  if (type === "agent_settled") {
    settledCount += 1;
  } else if (type === "compaction_start") {
    compactionsStarted += 1;
    compactionLog.push({ reason: message?.reason ?? null, started_at: (/* @__PURE__ */ new Date()).toISOString(), ended_at: null, aborted: null, error: null });
  } else if (type === "compaction_end") {
    compactionsEnded += 1;
    const entry = compactionLog.find((item) => item.ended_at === null);
    if (entry) {
      entry.ended_at = (/* @__PURE__ */ new Date()).toISOString();
      entry.aborted = message?.aborted === true;
      entry.error = message?.errorMessage ? redactText(String(message.errorMessage)).slice(0, 500) : null;
    }
  }
  notifyEventWaiters(type, message);
  if (type === "message_update") {
    messageUpdateCount += 1;
    writeLive({
      status: "running",
      phase: "response_item",
      event: "message_update",
      last_notification_method: "message_update"
    });
    return;
  }
  if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
    if (type === "tool_execution_start") observeToolCallStart(message);
    const compact = compactPiToolCall(message);
    if (compact?.id) {
      const previous = toolCallIndex.get(String(compact.id)) ?? {};
      toolCallIndex.set(String(compact.id), {
        id: compact.id,
        type: previous.type ?? compact.type ?? null,
        name: previous.name ?? compact.name ?? null,
        status: compact.status ?? previous.status ?? null,
        command_preview: compact.command_preview ?? previous.command_preview ?? null,
        full_output_path: compact.full_output_path ?? previous.full_output_path ?? null
      });
    }
    if (type !== "tool_execution_update") {
      recordEvent({ type, toolCallId: compact?.id ?? null, toolName: compact?.name ?? null, isError: message?.isError === true });
      if (type === "tool_execution_end" && message?.isError === true) {
        failedToolCallCount += 1;
        if (compact?.name === "bash") {
          failedBashToolCount += 1;
          if (!bashExitedNormally(message)) interruptedBashToolIds.add(compact.id);
        }
      }
    }
    writeLive({
      status: "running",
      phase: "tool_call",
      event: type,
      last_notification_method: type,
      last_tool_call: compact?.id ? toolCallIndex.get(String(compact.id)) : live.state.last_tool_call,
      tool_call_counts: toolCallCounts()
    });
    return;
  }
  if (type === "message_end" && message?.message?.role === "assistant") {
    const assistant = message.message;
    const usage = compactUsage(assistant.usage);
    const text3 = assistantText(assistant);
    const receipt = {
      index: turnReceipts.length,
      phase: currentTurnPhase,
      model: assistant.model ?? null,
      provider: assistant.provider ?? null,
      responseModel: assistant.responseModel ?? null,
      api: assistant.api ?? null,
      stopReason: assistant.stopReason ?? null,
      errorMessage: assistant.errorMessage ? redactText(String(assistant.errorMessage)).slice(0, 2e3) : null,
      usage,
      textLength: text3.length,
      at: (/* @__PURE__ */ new Date()).toISOString()
    };
    turnReceipts.push(receipt);
    turnTexts.push(text3);
    const applied = result.identity?.applied;
    if (applied?.model && (receipt.provider !== applied.provider || receipt.model !== applied.model)) {
      result.identity.turnReceiptMismatch = true;
      result.warnings.push(
        `\u7B2C ${turnReceipts.length} \u6761 assistant \u56DE\u6267 ${receipt.provider ?? "?"}/${receipt.model ?? "?"} \u4E0E\u5B9E\u6536\u8EAB\u4EFD ${applied.provider ?? "?"}/${applied.model ?? "?"} \u4E0D\u7B26\u3002`
      );
    }
    addUsage(result.usage, usage);
    live.state.token_usage = { ...result.usage };
    recordEvent({ type, model: receipt.model, provider: receipt.provider, stopReason: receipt.stopReason });
    writeLive({
      status: "running",
      phase: "response_item",
      event: "message_end",
      last_notification_method: "message_end",
      last_turn_receipt: {
        model: receipt.model,
        provider: receipt.provider,
        responseModel: receipt.responseModel,
        stopReason: receipt.stopReason
      }
    });
    return;
  }
  if (type === "auto_retry_start" || type === "auto_retry_end" || type === "compaction_start" || type === "compaction_end") {
    const detail = redactAuth({
      attempt: message?.attempt ?? null,
      maxAttempts: message?.maxAttempts ?? null,
      reason: message?.reason ?? null,
      success: message?.success ?? null,
      errorMessage: message?.errorMessage ?? message?.finalError ?? null
    });
    result.warnings.push(`pi \u4E8B\u4EF6 ${type}:${JSON.stringify(detail)}`);
    recordEvent({ type, detail });
    writeLive({
      status: "running",
      phase: phaseFromPiEvent(type) ?? live.state.phase,
      event: type,
      force_record_event: true,
      event_extra: { detail },
      last_notification_method: type
    });
    return;
  }
  if (type === "agent_settled") {
    recordEvent({ type });
    writeLive({ status: "running", phase: "turn_completed", event: "agent_settled", last_notification_method: type });
    return;
  }
  recordEvent({ type });
  const nextPhase = phaseFromPiEvent(type) ?? live.state.phase;
  writeLive({ status: "running", phase: nextPhase, event: type, last_notification_method: type });
}
function handleUiRequest(message) {
  const method = String(message?.method ?? "unknown");
  uiRequests.push({ method, at: (/* @__PURE__ */ new Date()).toISOString() });
  result.warnings.push(`Pi \u540E\u53F0\u6269\u5C55\u53D1\u51FA UI \u8BF7\u6C42(method=${method});\u5DF2\u8BB0\u5F55\uFF0C\u4E0D\u8FDB\u884C\u7528\u6237\u4EA4\u4E92\u3002`);
  let reply = null;
  if (method === "confirm") {
    reply = { type: "extension_ui_response", id: message.id, confirmed: false };
  } else if (["select", "input", "editor"].includes(method)) {
    reply = { type: "extension_ui_response", id: message.id, cancelled: true };
  }
  result.permission.decisions.push({
    source: "extension_ui_request",
    method,
    effective: reply ? method === "confirm" ? "deny" : "cancelled" : "ignored",
    at: (/* @__PURE__ */ new Date()).toISOString()
  });
  writeLive({
    status: "running",
    phase: live.state.phase,
    event: "extension_ui_request",
    force_record_event: true,
    event_extra: { ui_request: { method, answered: Boolean(reply) } }
  });
  return reply;
}
var currentTurnPhase = "bootstrap";
var childExtensionEnv = {
  // 插件无法区分watchdog中止与用户取消；默认只保留错误分类，显式配置可覆盖。
  PI_RETRY_STALL_TIMEOUT_MS: process.env.PI_RETRY_STALL_TIMEOUT_MS?.trim() || "0",
  PI_COMMAND_JOBS_CONFIG: commandJobsConfig ? JSON.stringify(commandJobsConfig) : "",
  PI_WORKER_TOOLS_PATH: workerToolsSnapshotPath,
  PI_WORKER_INHERIT_TOOLS: spawnToolAllowlist === null ? "1" : "0",
  PI_WORKER_TOOL_SURFACE: spawnToolAllowlist === null ? "" : JSON.stringify(spawnToolAllowlist),
  // 双根显式下传：worker 侧项目面一律以 targetCwd 为本，运行面只读资产以 runtimeRoot 为本。
  SUBAGENT_PROJECT_ROOT: targetCwd,
  SUBAGENT_RUNTIME_ROOT: runtimeRoot2,
  PI_WORKER_TASK_PACKAGE_PATH: reviewTaskPackage ? reviewTaskPackagePath : "",
  // runner 自有的结果与审计通道先置空，本次启用时再覆盖。子进程环境是 {...process.env, ...本对象}：
  // 子代理在任务里跑测试、测试再拉起 runner 时，不置空就会继承外层任务的通道，把假数据写进外层的
  // 写域审计（09-24 d4b74295：guard_ready 13 条判不合规）或报告路径。各扩展把空值视为未配置。
  PI_REVIEW_RESULT_PATH: "",
  PI_REVIEW_TASK_PACKAGE_PATH: "",
  PI_TASK_RESULT_TASK_PACKAGE_PATH: "",
  PI_TASK_RESULT_REPORT_PATH: "",
  PI_TASK_RESULT_HANDOFF_PATH: "",
  PI_TASK_RESULT_PAYLOAD_PATH: "",
  PI_TASK_RESULT_HANDOFF_CHECK: "",
  [WRITE_DOMAIN_ENV]: ""
};
if (reviewResultToolEnabled) {
  Object.assign(childExtensionEnv, {
    PI_REVIEW_RESULT_PATH: reviewResultPath,
    PI_REVIEW_TASK_PACKAGE_PATH: reviewTaskPackagePath
  });
} else if (taskResultToolEnabled) {
  Object.assign(childExtensionEnv, {
    PI_TASK_RESULT_TASK_PACKAGE_PATH: reviewTaskPackagePath,
    PI_TASK_RESULT_REPORT_PATH: taskResultPaths.reportPath,
    PI_TASK_RESULT_HANDOFF_PATH: taskResultPaths.handoffPath,
    PI_TASK_RESULT_PAYLOAD_PATH: taskResultPayloadPath,
    ...handoffCheckSpec ? { PI_TASK_RESULT_HANDOFF_CHECK: JSON.stringify(handoffCheckSpec) } : {}
  });
}
if (writeDomainSpec) childExtensionEnv[WRITE_DOMAIN_ENV] = JSON.stringify(writeDomainSpec);
var client = new PiRpcClient({
  command: process.execPath,
  args: piArgs,
  cwd,
  env: childExtensionEnv,
  recordRaw: saveRawEvidence,
  onEvent: handlePiEvent,
  onUiRequest: handleUiRequest
});
function sendExternalAbort() {
  if (!externalCancellation.requested || externalCancellation.abort_sent || !promptStarted) return;
  externalCancellation.abort_sent = true;
  externalCancellation.deadline_ms = Date.now() + ABORT_SETTLE_WINDOW_MS;
  void client.call("abort", {}, { timeoutMs: 5e3 }).then(() => {
    externalCancellation.abort_acknowledged = true;
  }).catch((error) => {
    externalCancellation.abort_error = String(error?.message ?? error);
  });
}
var cancellationReadErrors = /* @__PURE__ */ new Set();
function inspectCancellationRequest() {
  if (!controlFile || !attemptId || externalCancellation.requested && externalCancellation.type !== "pause" || settledIdleConfirmed && !promptStarted || !existsSync13(controlFile)) return false;
  let request;
  try {
    request = JSON.parse(readFileSync11(controlFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    const message = String(error?.message ?? error);
    externalCancellation.read_error = message;
    result.cancellation = { ...result.cancellation ?? {}, read_error: message };
    if (!cancellationReadErrors.has(message)) {
      cancellationReadErrors.add(message);
      result.warnings.push(`\u53D6\u6D88\u8BF7\u6C42\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25(${controlFile}): ${message};\u7EE7\u7EED\u8F6E\u8BE2\u3002`);
    }
    return false;
  }
  if (!["abort", "pause"].includes(request?.type) || String(request?.attempt_id || "") !== attemptId) return false;
  if (externalCancellation.requested && request.type === "pause") return false;
  const reason = String(request?.reason ?? "").trim();
  if (!reason) return false;
  Object.assign(externalCancellation, {
    requested: true,
    type: request.type,
    reason,
    attempt_id: attemptId,
    requested_at: request.requested_at ?? null,
    detected_at: (/* @__PURE__ */ new Date()).toISOString(),
    deadline_ms: Date.now() + ABORT_SETTLE_WINDOW_MS
  });
  writeLive({
    status: "running",
    phase: live.state.phase,
    event: request.type === "pause" ? "pause_request" : "cancel_request",
    force_record_event: true,
    event_extra: { cancellation: { attempt_id: attemptId, reason } }
  });
  sendExternalAbort();
  return true;
}
function startCancellationMonitor() {
  if (!controlFile || !attemptId || cancellationPoll !== null) return;
  inspectCancellationRequest();
  cancellationPoll = setInterval(inspectCancellationRequest, 100);
  cancellationPoll.unref?.();
}
function stopCancellationMonitor() {
  if (cancellationPoll !== null) clearInterval(cancellationPoll);
  cancellationPoll = null;
}
function deadlineBounded(turnDeadlineMs) {
  const now = Date.now();
  if (externalCancellation.type === "pause") {
    if (now >= externalCancellation.deadline_ms && !externalCancellation.unconfirmed_reported) {
      externalCancellation.unconfirmed_reported = true;
      writeLive({
        status: "running",
        phase: "pause_unconfirmed",
        event: "pause_unconfirmed",
        error: "Pi has not confirmed idle after pause; ownership remains active. Inspect get or explicitly cancel if forced termination is intended."
      });
    }
    return { ms: COMMAND_TIMEOUT_MS, boundedBy: "pause", exhausted: false };
  }
  const globalLeft = remainingGlobalMs();
  const turnLeft = Math.max(0, turnDeadlineMs - now);
  const cancelLeft = externalCancellation.deadline_ms == null ? Number.POSITIVE_INFINITY : Math.max(0, externalCancellation.deadline_ms - now);
  const candidates = [
    { kind: "global", ms: globalLeft },
    { kind: "turn", ms: turnLeft },
    { kind: "cancel", ms: cancelLeft },
    { kind: "tool_loop", ms: toolLoop.tripped ? 0 : Number.POSITIVE_INFINITY }
  ].sort((left, right) => left.ms - right.ms);
  return {
    ms: Math.max(1, candidates[0].ms),
    boundedBy: candidates[0].kind,
    exhausted: candidates[0].ms <= 0
  };
}
async function waitForSettled(baseline, turnDeadlineMs) {
  while (settledCount <= baseline) {
    const bound = deadlineBounded(turnDeadlineMs);
    if (bound.exhausted) return { timedOut: true, boundedBy: bound.boundedBy };
    const hit = await Promise.race([
      waitForEvent((type) => type === "agent_settled", Math.min(bound.ms, 100)),
      client.failed
    ]);
    if (hit) return { timedOut: false };
  }
  return { timedOut: false };
}
async function waitForCompactionEnd(endedBaseline, turnDeadlineMs) {
  while (compactionsEnded <= endedBaseline) {
    const bound = deadlineBounded(turnDeadlineMs);
    if (bound.exhausted) return { timedOut: true, boundedBy: bound.boundedBy };
    const ended = await Promise.race([
      waitForEvent((type) => type === "compaction_end", Math.min(bound.ms, 100)),
      client.failed
    ]);
    if (ended) return { timedOut: false };
  }
  return { timedOut: false };
}
async function waitForTurnEnd(baseline, turnDeadlineMs) {
  let settleCycles = 0;
  let commandJobsProjectionKey = null;
  let settledBaseline = baseline;
  for (; ; ) {
    const settled = await waitForSettled(settledBaseline, turnDeadlineMs);
    if (settled.timedOut) return { ...settled, settleCycles };
    settleCycles += 1;
    settledBaseline = settledCount;
    let agentRestarted = false;
    while (!agentRestarted) {
      if (compactionsStarted > compactionsEnded) {
        const ended = await waitForCompactionEnd(compactionsEnded, turnDeadlineMs);
        if (ended.timedOut) return { ...ended, settleCycles };
        writeLive({ status: "running", phase: "turn_wait", event: "compaction_settled" });
        continue;
      }
      const grace = deadlineBounded(turnDeadlineMs);
      if (grace.exhausted) return { timedOut: true, boundedBy: grace.boundedBy, settleCycles };
      const activityBaseline = activityGeneration;
      const activity = await Promise.race([
        waitForEvent((type) => ACTIVITY_EVENT_TYPES.has(type), Math.min(SETTLE_GRACE_MS, grace.ms)),
        client.failed
      ]);
      if (activity) {
        if (activity.type === "compaction_start") continue;
        agentRestarted = true;
        break;
      }
      const probe = deadlineBounded(turnDeadlineMs);
      if (probe.exhausted) return { timedOut: true, boundedBy: probe.boundedBy, settleCycles };
      const endedBaseline = compactionsEnded;
      const state = await client.call("get_state", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, probe.ms)) });
      if (activityGeneration !== activityBaseline) {
        agentRestarted = true;
        break;
      }
      if (compactionsStarted > compactionsEnded) continue;
      if (state?.isCompacting === true) {
        if (compactionsEnded > endedBaseline) continue;
        const ended = await waitForCompactionEnd(endedBaseline, turnDeadlineMs);
        if (ended.timedOut) return { ...ended, settleCycles };
        continue;
      }
      if (state?.isStreaming === true) {
        agentRestarted = true;
        break;
      }
      const finalBound = deadlineBounded(turnDeadlineMs);
      if (finalBound.exhausted) return { timedOut: true, boundedBy: finalBound.boundedBy, settleCycles };
      if (commandJobsEnabled && (!externalCancellation.requested || externalCancellation.type === "pause")) {
        const jobs = readCommandJobsState(commandJobsRoot);
        if (jobs.active_commands > 0) {
          const observed = jobs.jobs.filter((job) => ["starting", "running", "stopping"].includes(job.status)).map(({ job_id, status, last_output_at, stdout_path, stderr_path }) => ({ job_id, status, last_output_at, stdout_path, stderr_path }));
          const key = JSON.stringify(observed);
          if (key !== commandJobsProjectionKey) {
            commandJobsProjectionKey = key;
            writeLive({
              status: "running",
              phase: "command_job_wait",
              event: "command_job_progress",
              event_extra: { command_jobs: observed }
            });
          }
          continue;
        }
      }
      return { timedOut: false, settleCycles };
    }
  }
}
async function runPromptTurn(messageText) {
  currentTurnPhase = "main";
  const receiptCursor = turnReceipts.length;
  const eventCursor = eventLog.length;
  const compactionCursor = compactionLog.length;
  const settledBaseline = settledCount;
  const turnDeadlineMs = Date.now() + effectiveTurnTimeoutMs;
  writeLive({ status: "running", phase: "turn_start", event: "turn_start" });
  try {
    await client.call("prompt", { message: messageText }, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) });
  } catch (error) {
    if (client.transportError) {
      result.failure_type = "transport_failed";
      result.orchestration.failure_type = "transport_failed";
      throw client.transportError;
    }
    result.failure_type = "auth_or_preflight_failed";
    result.orchestration.failure_type = "auth_or_preflight_failed";
    throw error;
  }
  result.turn = { ...result.turn, startAck: true };
  promptStarted = true;
  inspectCancellationRequest();
  sendExternalAbort();
  writeLive({ status: "running", phase: "turn_wait", event: "turn_wait" });
  const ended = await waitForTurnEnd(settledBaseline, turnDeadlineMs);
  if (ended.timedOut) {
    if (ended.boundedBy === "cancel") {
      externalCancellation.graceful = false;
      throw new ExternalCancellationError("\u53D6\u6D88\u8BF7\u6C42\u5DF2\u53D1\u51FA\uFF0C\u4F46 Pi \u672A\u5728\u4F18\u96C5\u6536\u5C3E\u7A97\u53E3\u5185\u8BC1\u660E settled/idle\u3002");
    }
    const failureType = ended.boundedBy === "global" ? "global_timeout" : ended.boundedBy === "tool_loop" ? "tool_loop" : "turn_timeout";
    try {
      await client.call("abort", {}, { timeoutMs: 5e3 });
    } catch {
    }
    await Promise.race([
      waitForEvent((type) => type === "agent_settled", ABORT_SETTLE_WINDOW_MS),
      client.failed.catch(() => {
      })
    ]);
    const salvagedBy = failureType !== "tool_loop" ? null : submittedTaskStatus(readTaskResultSubmission()) ? "task_result_submitted" : ingestTaskResultDraft("tool_loop")?.ok === true ? "task_result_draft" : null;
    if (salvagedBy) {
      toolLoop.tripped.salvaged_by = salvagedBy;
    } else {
      result.failure_type = failureType;
      result.orchestration.failure_type = failureType;
      throw new Error(
        failureType === "global_timeout" ? `\u5168\u7A0B\u9884\u7B97\u7528\u5C3D(timeoutMs=${globalTimeoutMs || 0});\u5DF2\u53D1 abort \u5E76\u8FDB\u5165\u5173\u505C\u3002` : failureType === "tool_loop" ? `\u5DE5\u5177\u8C03\u7528\u5FAA\u73AF:\u8FDE\u7EED ${toolLoop.tripped.noop_streak} \u6B21\u7A7A\u8F6C\u547D\u4EE4(\u6700\u8FD1\u4E00\u6B21 ${toolLoop.tripped.signatures[0].preview});\u5DF2\u53D1 abort \u5E76\u8FDB\u5165\u5173\u505C\u3002` : `\u5355\u8F6E\u7B49\u5F85\u8D85\u65F6(turnTimeoutMs=${turnTimeoutMs || 0});\u5DF2\u53D1 abort \u5E76\u8FDB\u5165\u5173\u505C\u3002`
      );
    }
  }
  settledIdleConfirmed = true;
  if (externalCancellation.requested) {
    externalCancellation.graceful = true;
    writeLive({
      status: "running",
      phase: "cancel_settled",
      event: "cancel_abort_settled",
      force_record_event: true,
      cancel_abort_settled: true
    });
    throw new ExternalCancellationError(externalCancellation.type === "pause" ? "\u6682\u505C\u8BF7\u6C42\u5DF2\u7531 Pi abort\uFF0C\u5DF2\u8BC1\u660E settled/idle\uFF1B\u6B63\u5728\u4FDD\u5B58\u4F1A\u8BDD\u5E76\u7B49\u5F85\u8FDB\u7A0B\u9000\u51FA\u3002" : "\u53D6\u6D88\u8BF7\u6C42\u5DF2\u7531 Pi abort\uFF0C\u5E76\u5DF2\u8BC1\u660E settled/idle\u3002");
  }
  promptStarted = false;
  stopCancellationMonitor();
  const receipts = turnReceipts.slice(receiptCursor);
  const last = receipts.length > 0 ? receipts[receipts.length - 1] : null;
  const turnText = turnTexts.slice(receiptCursor).filter((text3) => text3.trim().length > 0).pop() ?? "";
  const events = eventLog.slice(eventCursor);
  const compactions = compactionLog.slice(compactionCursor);
  writeLive({
    status: "running",
    phase: "result_collection",
    event: "turn_completed",
    turn_completed: true,
    stop_reason: last?.stopReason ?? null,
    settle_cycles: ended.settleCycles,
    compactions: compactions.length,
    tool_call_counts: toolCallCounts()
  });
  return {
    receipts,
    lastReceipt: last,
    text: turnText,
    stopReason: last?.stopReason ?? null,
    settleCycles: ended.settleCycles,
    compactions,
    eventCounts: countBy(events, (entry) => entry.type ?? "unknown")
  };
}
async function readAssistantText() {
  const data = await client.call("get_last_assistant_text", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) });
  return typeof data?.text === "string" ? data.text : "";
}
function resolveSessionFile(preferred) {
  if (preferred && existsSync13(preferred)) return { file: preferred, readError: null };
  if (!existsSync13(sessionDir)) return { file: null, readError: null };
  try {
    const names = readdirSync2(sessionDir).filter((name) => name.endsWith(".jsonl"));
    if (names.length === 0) return { file: null, readError: null };
    names.sort();
    return { file: path15.join(sessionDir, names[names.length - 1]), readError: null };
  } catch (error) {
    return { file: null, readError: String(error?.message ?? error) };
  }
}
function attachSessionResume() {
  const { file, readError } = resolveSessionFile(result.session?.file);
  const failureType = String(result.failure_type || "");
  result.session = {
    ...result.session || {},
    sessionDir,
    file: file || null,
    ...readError ? { read_error: readError } : {},
    resumable: Boolean(file) && result.ok !== true && result.identity?.verified === true && result.cleanup?.tree_confirmed !== false && (!externalCancellation.requested || externalCancellation.graceful) && !NON_RESUMABLE_FAILURE_TYPES.has(failureType)
  };
  const lastReceipt = turnReceipts.length ? turnReceipts[turnReceipts.length - 1] : null;
  result.diagnostics = {
    ...result.diagnostics || {},
    stop_reason: lastReceipt?.stopReason ?? null,
    last_error_message: lastReceipt?.errorMessage ?? null,
    compaction_seen: compactionsStarted > 0,
    compactions: compactionLog
  };
}
function modelCardOf(state) {
  const card = state?.model;
  if (!card || typeof card !== "object") {
    return null;
  }
  return {
    id: card.id ?? null,
    name: card.name ?? null,
    provider: card.provider ?? null,
    api: card.api ?? null,
    reasoning: card.reasoning ?? null,
    contextWindow: card.contextWindow ?? null,
    maxTokens: card.maxTokens ?? null,
    thinkingLevelMap: card.thinkingLevelMap ?? null
  };
}
function writeIdentitySnapshot(extra = {}) {
  const snapshot = {
    requested: result.identity.requested,
    applied: result.identity.applied,
    verified: result.identity.verified,
    corrections: result.identity.corrections,
    initial_state: result.diagnostics.initial_state ?? null,
    final_state: result.diagnostics.final_state ?? null,
    model_card: modelCardOf(finalState ?? initialState),
    available_models: {
      count: result.selection.availableModelCount,
      matched: result.selection.validated,
      sample: result.selection.availableModels.slice(0, 40)
    },
    available_thinking_levels: result.selection.availableThinking,
    turn_receipts: turnReceipts,
    runnerExtensionProfile: result.selection.runnerExtensionProfile,
    runnerExtensions: result.selection.runnerExtensions,
    ...extra
  };
  ensureDir(outDir);
  writeFileSync9(identityPath, JSON.stringify(snapshot, null, 2), "utf8");
  return snapshot;
}
var initialState = null;
var finalState = null;
client.start();
startCancellationMonitor();
result.runtime = {
  backend: BACKEND2,
  piCli,
  spawnArgs: piArgs.slice(1),
  pid: client.child?.pid ?? null,
  startedAt: client.startedAt,
  exitCode: null,
  exitSignal: null,
  stderrBytes: 0,
  stderrPath: null,
  malformedLines: 0
};
result.failure_type = "transport_failed";
result.orchestration.failure_type = "transport_failed";
try {
  writeLive({ status: "running", phase: "handshake", event: "handshake_start" });
  initialState = await client.call("get_state", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) });
  result.diagnostics.initial_state = redactAuth(initialState);
  result.session = {
    id: initialState?.sessionId ?? null,
    file: initialState?.sessionFile ?? null,
    sessionDir,
    stats: null
  };
  writeLive({ status: "running", phase: "model_catalog", event: "model_catalog_start" });
  const catalog = await client.call("get_available_models", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) });
  const catalogModels = Array.isArray(catalog?.models) ? catalog.models : [];
  result.selection.availableModelCount = catalogModels.length;
  result.selection.availableModels = catalogModels.map((entry) => `${entry?.provider ?? "?"}/${entry?.id ?? "?"}`).filter((entry) => entry !== "?/?");
  const thinkingLevels = await client.call("get_available_thinking_levels", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) }).catch(() => null);
  result.selection.availableThinking = Array.isArray(thinkingLevels?.levels) ? thinkingLevels.levels : [];
  if (effort && result.selection.availableThinking.length > 0 && !result.selection.availableThinking.includes(effort)) {
    result.warnings.push(
      `--effort ${effort} \u4E0D\u5728 pi thinkingLevel \u503C\u57DF(${result.selection.availableThinking.join(", ")})\u5185;\u4EE5\u8EAB\u4EFD\u56DE\u8BFB\u7ED3\u679C\u4E3A\u51C6\u3002`
    );
  }
  if (modelRef.ok) {
    let matched = catalogModels.some((entry) => entry?.provider === modelRef.provider && entry?.id === modelRef.modelId);
    if (!matched) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const refreshed = await client.call("get_available_models", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) }).catch(() => null);
      const refreshedModels = Array.isArray(refreshed?.models) ? refreshed.models : [];
      if (refreshedModels.length > 0) {
        result.selection.availableModelCount = refreshedModels.length;
        result.selection.availableModels = refreshedModels.map((entry) => `${entry?.provider ?? "?"}/${entry?.id ?? "?"}`).filter((entry) => entry !== "?/?");
        matched = refreshedModels.some((entry) => entry?.provider === modelRef.provider && entry?.id === modelRef.modelId);
      }
    }
    if (!matched) {
      result.warnings.push(
        `\u6240\u9009\u6A21\u578B\u4E0D\u5728 pi \u53EF\u7528\u6A21\u578B\u76EE\u5F55\u5185:${modelRef.provider}/${modelRef.modelId}\u3002\u76EE\u5F55\u5171 ${result.selection.availableModelCount} \u9879\uFF1B\u7EE7\u7EED\u8EAB\u4EFD\u6838\u5BF9\u3002`
      );
    }
    result.selection.validated = matched;
  } else {
    result.selection.note = "--model \u7F3A\u5931,\u4F7F\u7528 pi \u542F\u52A8\u65F6\u9009\u5B9A\u7684\u9ED8\u8BA4\u6A21\u578B\u3002";
  }
  writeLive({ status: "running", phase: "identity_check", event: "identity_check_start" });
  const stateModel = (state) => ({
    provider: state?.model?.provider ?? null,
    model: state?.model?.id ?? null,
    thinkingLevel: state?.thinkingLevel ?? null
  });
  let current = stateModel(initialState);
  const modelMismatch = () => modelRef.ok && (current.provider !== modelRef.provider || current.model !== modelRef.modelId);
  const thinkingMismatch = () => Boolean(effort) && current.thinkingLevel !== effort;
  if (modelMismatch()) {
    try {
      await client.call("set_model", { provider: modelRef.provider, modelId: modelRef.modelId }, {
        timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs()))
      });
      result.identity.corrections.push({ command: "set_model", ok: true, error: null });
    } catch (error) {
      result.identity.corrections.push({ command: "set_model", ok: false, error: String(error?.piError ?? error?.message ?? error) });
    }
  }
  if (thinkingMismatch()) {
    try {
      await client.call("set_thinking_level", { level: effort }, {
        timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs()))
      });
      result.identity.corrections.push({ command: "set_thinking_level", ok: true, error: null });
    } catch (error) {
      result.identity.corrections.push({
        command: "set_thinking_level",
        ok: false,
        error: String(error?.piError ?? error?.message ?? error)
      });
    }
  }
  if (result.identity.corrections.length > 0) {
    finalState = await client.call("get_state", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) });
    current = stateModel(finalState);
  } else {
    finalState = initialState;
  }
  result.diagnostics.final_state = redactAuth(finalState);
  result.identity.applied = current;
  result.selection.appliedProvider = current.provider;
  result.selection.appliedModel = current.model;
  result.selection.appliedEffort = current.thinkingLevel;
  result.identity.verified = !modelMismatch() && !thinkingMismatch();
  writeIdentitySnapshot();
  if (!result.identity.verified) {
    const identityFailure = modelMismatch() ? "identity_mismatch" : "invalid_model_effort";
    result.failure_type = identityFailure;
    result.orchestration.failure_type = identityFailure;
    throw new Error(
      `\u8EAB\u4EFD\u6838\u5BF9\u5931\u8D25:\u8BF7\u6C42 ${modelRef.ok ? `${modelRef.provider}/${modelRef.modelId}` : "(\u9ED8\u8BA4\u6A21\u578B)"}/thinking=${effort || "(\u9ED8\u8BA4)"};\u5B9E\u6536 ${current.provider ?? "?"}/${current.model ?? "?"}/thinking=${current.thinkingLevel ?? "?"}\u3002`
    );
  }
  result.failure_type = "transport_failed";
  result.orchestration.failure_type = "transport_failed";
  inspectCancellationRequest();
  if (externalCancellation.requested) {
    const state = await client.call("get_state", {}, { timeoutMs: 5e3 });
    settledIdleConfirmed = state?.isStreaming !== true && state?.isCompacting !== true;
    externalCancellation.graceful = settledIdleConfirmed;
    if (settledIdleConfirmed) {
      writeLive({
        status: "running",
        phase: "cancel_settled",
        event: "cancel_abort_settled",
        force_record_event: true,
        cancel_abort_settled: true
      });
    }
    throw new ExternalCancellationError("\u4EFB\u52A1\u5728 prompt \u524D\u6536\u5230\u5F53\u524D attempt \u7684\u53D6\u6D88\u8BF7\u6C42\u3002");
  }
  let mainTurn = await runPromptTurn(promptMessage);
  for (let round = 0; ; round += 1) {
    const ingested = ingestTaskResultDraft(round === 0 ? "turn_end" : "fix_round");
    if (!ingested || ingested.ok || round >= TASK_RESULT_DRAFT_FIX_ROUNDS) break;
    startCancellationMonitor();
    mainTurn = await runPromptTurn(taskResultDraftFixPrompt(ingested.gaps));
  }
  result.turn = {
    ...result.turn,
    id: "pi-turn-1",
    startAck: true,
    modelActivityObserved
  };
  let finalText = normalizeFinalText(mainTurn.text);
  let finalTextSource = "message_end";
  if (!finalText) {
    finalText = normalizeFinalText(await readAssistantText());
    finalTextSource = finalText ? "get_last_assistant_text" : "empty";
  }
  const headingOptions = { conclusionStatusRequired: !structuredReviewTask };
  const finalPath = path15.join(outDir, "child-final.md");
  writeFileSync9(finalPath, finalText, "utf8");
  const stats = await client.call("get_session_stats", {}, { timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, remainingGlobalMs())) }).catch(() => null);
  result.session = { ...result.session ?? {}, stats: compactSessionStats(stats) };
  result.turns = turnReceipts;
  const nonSubmitToolCalls = [...toolCallIndex.values()].filter((item) => item.name !== "submit_review_result").length;
  if (evidenceOnlyTask && nonSubmitToolCalls > 0) {
    result.warnings.push(
      `evidence_only \u4EFB\u52A1\u5305\u5185\u53D1\u751F ${nonSubmitToolCalls} \u6B21\u5DE5\u5177\u6267\u884C;pi \u8F68\u4E0D\u4E2D\u65AD\u8FD0\u884C,\u8BC1\u636E\u7559\u5728 child-task-events.jsonl \u4F9B\u5BA1\u8BA1\u3002`
    );
  }
  result.review_synthesis = synthesizeReviewResult({
    taskPackage: reviewTaskPackage,
    taskText,
    finalText,
    outDir,
    fallbackRoot: targetCwd,
    reviewResultPath: reviewResultToolEnabled ? reviewResultPath : null,
    runnerObservations: {
      // 回合按 pi 事实结束即视为完成;回执 stopReason 是事实,不再作为合成前置条件。
      turn_completed: true,
      // 额外工具调用只记 warning，不把已完成回合打成 transport_failed。
      evidence_tool_guard_passed: true
    }
  });
  if (!result.review_synthesis.applied) {
    result.review_synthesis = readAssistedReviewGate({ taskPackage: reviewTaskPackage, fallbackRoot: targetCwd });
  }
  result.task_result = readTaskResultSubmission();
  result.turn = {
    ...result.turn,
    completed: true,
    stopReason: mainTurn.stopReason,
    settleCycles: mainTurn.settleCycles,
    compactions: mainTurn.compactions,
    finalTextPath: finalPath,
    finalTextSource,
    eventCounts: mainTurn.eventCounts,
    messageUpdateCount,
    toolCalls: [...toolCallIndex.values()],
    modelActivityObserved
  };
  result.required_headings = headingStatus(finalText, void 0, headingOptions);
  const submittedStatus = submittedTaskStatus(result.task_result);
  const reviewSubmitted = result.review_synthesis?.applied === true && result.review_synthesis?.result_source === "submit_tool";
  result.task_status_source = submittedStatus ? "submit_task_result" : reviewSubmitted ? "submit_review_result" : "final_text";
  if (!result.required_headings.ok && !submittedStatus && !reviewSubmitted) {
    const detail = [
      result.required_headings.missing.length ? `\u7F3A ${result.required_headings.missing.length} \u8282` : "",
      ...result.required_headings.warnings
    ].filter(Boolean).join(";");
    result.warnings.push(`\u6700\u7EC8\u56DE\u590D\u6B63\u6587\u672A\u5305\u542B\u5B8C\u6574\u516D\u8282(${detail});\u4EC5\u8BB0\u5F55\u89C2\u6D4B,\u4E0D\u5224\u5931\u8D25\u3001\u4E0D\u8FFD\u52A0\u6536\u53E3\u8F6E\u3002`);
  }
  result.orchestration.ok = true;
  result.orchestration.status = "completed";
  result.orchestration.failure_type = "none";
  const mechanicalSignals = {
    deniedPermissions: uiRequests.length,
    failedToolCalls: failedToolCallCount,
    failedBashToolCalls: failedBashToolCount,
    errorTurns: turnReceipts.filter((receipt) => receipt.stopReason === "error").length
  };
  result.mechanical_signals = mechanicalSignals;
  const submittedStatusLine = `## \u7ED3\u8BBA
\u4EFB\u52A1\u72B6\u6001\uFF1A${submittedStatus}`;
  const textAnalysis = analyzeTaskResult(submittedStatus ? `${submittedStatusLine}

${finalText}` : finalText, {
    mechanicalSignals
  });
  const verdictTask = submittedStatus ? analyzeTaskResult(submittedStatusLine) : null;
  const taskAnalysis = verdictTask ? {
    ...textAnalysis,
    ok: verdictTask.ok,
    status: verdictTask.status,
    controllerClassifiedStatus: verdictTask.controllerClassifiedStatus,
    failure_type: verdictTask.failure_type
  } : textAnalysis;
  const suppressedHits = taskAnalysis.sections?.diagnosticSignals?.suppressedBlockedSignals ?? [];
  if (suppressedHits.length > 0) {
    result.warnings.push(
      `\u6B63\u6587\u542B\u5931\u8D25\u53D9\u8FF0(${suppressedHits.length} \u4E2A\u6B63\u5219\u547D\u4E2D)\u4F46\u8FD0\u8F93\u5C42\u65E0\u5931\u8D25\u8BC1\u636E(\u673A\u68B0\u4FE1\u53F7\u5E72\u51C0);\u6309\u4E1A\u52A1\u8BA8\u8BBA\u5904\u7406,\u672A\u964D\u7EA7\u3002`
    );
  }
  result.task = applyReviewGate(taskAnalysis, result.review_synthesis);
  if (submittedStatus && result.task_result.handoff_check_status === "error") {
    result.task = { ...result.task, requiresParentReview: true };
    result.warnings.push(
      `handoff checker \u81EA\u8EAB\u6545\u969C(status=error: ${result.task_result.handoff_check_issues.join("; ") || "\u65E0\u8BE6\u60C5"});\u4EA4\u5377\u6309\u63D0\u4EA4 verdict \u6295\u5F71,handoff \u672A\u7ECF\u673A\u68B0\u81EA\u68C0,\u987B\u7236\u7EA7\u590D\u6838\u3002`
    );
  }
  const classified = classifyFinalResult(result.orchestration, result.task);
  result.ok = classified.ok;
  result.status = classified.status;
  result.failure_type = classified.failure_type;
} catch (error) {
  const message = String(error?.message ?? error);
  if (error instanceof ExternalCancellationError) {
    result.status = "cancelled";
    result.ok = false;
    result.failure_type = "cancelled";
    result.orchestration.ok = false;
    result.orchestration.status = "cancelled";
    result.orchestration.failure_type = "cancelled";
    result.task = { ok: false, status: "cancelled", failure_type: "cancelled", blockedSignals: [] };
    result.cancellation = { ...externalCancellation, graceful: externalCancellation.graceful && settledIdleConfirmed };
  } else {
    if (error instanceof ReviewContractError) result.failure_type = "handoff_check_failed";
    else if (result.failure_type === "unknown") result.failure_type = "transport_failed";
    result.status = "failed";
    result.ok = false;
    result.orchestration.ok = false;
    result.orchestration.status = "failed";
    result.orchestration.failure_type = result.failure_type;
  }
  if (client.malformedLines > 0) {
    result.warnings.push(`\u534F\u8BAE\u6D41\u542B ${client.malformedLines} \u6761\u65E0\u6CD5\u89E3\u6790\u7684 stdout \u884C;\u5931\u8D25\u4ECD\u6309\u4E0A\u6E38\u5177\u4F53\u5206\u7C7B\u5F52\u56E0\u3002`);
  }
  result.error = redactText(message);
  result.turns = turnReceipts;
  if (externalCancellation.type !== "pause") ensureFailureFinal(result, result.failure_type, result.error);
} finally {
  const bashCleanup = /* @__PURE__ */ new Map();
  let cleanupLogValid = true;
  try {
    if (existsSync13(bashCleanupPath)) {
      for (const line of readFileSync11(bashCleanupPath, "utf8").split("\n").filter(Boolean)) {
        const record2 = JSON.parse(line);
        bashCleanup.set(record2.tool_call_id, record2);
      }
    }
  } catch {
    cleanupLogValid = false;
  }
  const bashStopsProven = cleanupLogValid && [...interruptedBashToolIds].every((id) => bashCleanup.get(id)?.confirmed === true) && [...bashCleanup.values()].every((record2) => record2.confirmed === true);
  result.cleanup = await client.shutdown({
    cooperativeOnly: () => externalCancellation.type === "pause",
    onUnconfirmed: () => {
      if (externalCancellation.shutdown_unconfirmed) return;
      externalCancellation.shutdown_unconfirmed = true;
      writeLive({
        status: "running",
        phase: "pause_unconfirmed",
        event: "pause_shutdown_unconfirmed",
        error: "Pi has not exited after cooperative pause; no force kill was sent. Inspect get or explicitly cancel to authorize termination."
      });
    },
    forceTreeCleanup: externalCancellation.type !== "pause" && (externalCancellation.requested && !settledIdleConfirmed || interruptedBashToolIds.size > 0 && !(externalCancellation.requested && settledIdleConfirmed && bashStopsProven))
  });
  stopCancellationMonitor();
  if (result.turn) {
    result.turn = { ...result.turn, modelActivityObserved, toolCalls: [...toolCallIndex.values()] };
  }
  const unconfirmed = [...bashCleanup.values()].filter((record2) => !record2.confirmed);
  let treeConfirmed = cleanupLogValid && (interruptedBashToolIds.size === 0 || bashStopsProven || result.cleanup.treeKill?.confirmed === true);
  const remainingPids = /* @__PURE__ */ new Set();
  for (const record2 of unconfirmed) {
    const remaining = record2.observed && Array.isArray(record2.tracked_pids) ? snapshotChildProcessTree(record2.tracked_pids) : null;
    if (remaining === null || remaining.length > 0) treeConfirmed = false;
    for (const pid of remaining || []) remainingPids.add(pid);
  }
  if (result.cleanup.treeKill && result.cleanup.treeKill.confirmed !== true) treeConfirmed = false;
  if (commandJobsEnabled) {
    try {
      const jobs = readCommandJobsState(commandJobsRoot);
      result.cleanup.command_jobs = jobs;
      if (jobs.active_commands > 0 || jobs.active_services > 0 || jobs.unsafe_jobs > 0) {
        treeConfirmed = false;
        for (const job of jobs.jobs) if (job.cleanup_confirmed !== true) {
          for (const pid of job.cleanup?.remaining_pids || [job.pid]) if (pid) remainingPids.add(pid);
        }
      }
    } catch (error) {
      treeConfirmed = false;
      result.cleanup.command_jobs_error = String(error.message || error);
    }
  }
  result.cleanup.tree_confirmed = treeConfirmed;
  result.cleanup.remaining_pids = [...remainingPids];
  result.cleanup.bash_evidence_path = existsSync13(bashCleanupPath) ? bashCleanupPath : null;
  if (externalCancellation.requested) {
    externalCancellation.graceful = settledIdleConfirmed && treeConfirmed && bashStopsProven && result.cleanup.exitInfo?.code === 0 && !result.cleanup.exitInfo?.signal && !(result.cleanup.steps ?? []).some((step) => ["sigterm", "kill"].includes(step));
  }
  if (writeDomainSpec) {
    const submitted = readTaskResultSubmission();
    if (submitted.enabled) result.task_result = submitted;
    const audit = summarizeWriteDomainAudit({
      logPath: writeDomainAuditPath,
      observedToolCalls: [...toolCallIndex.values()]
    });
    const mergedEvidence = mergeWriteDomainEvidence(audit, submitted);
    result.write_domain = {
      ...result.write_domain,
      ...mergedEvidence,
      audit_path: writeDomainAuditPath
    };
    if (!mergedEvidence.scope_compliant) {
      result.warnings.push(
        `\u5199\u57DF\u5B88\u95E8\u53D1\u73B0 ${result.write_domain.violation_count} \u6B21\u8D8A\u754C\u8BF7\u6C42/\u62A5\u544A\u6216\u5BA1\u8BA1\u4E0D\u5B8C\u6574;\u8BE6\u89C1 ${writeDomainAuditPath},\u4EFB\u52A1\u4EA4 Core \u7236\u7EA7\u590D\u6838\u3002`
      );
    }
  }
  result.runtime = {
    ...result.runtime,
    exitCode: client.exitInfo?.code ?? null,
    exitSignal: client.exitInfo?.signal ?? null,
    exitAt: client.exitInfo?.at ?? null,
    stderrBytes: client.stderrBytes,
    malformedLines: client.malformedLines,
    eventCounts: client.eventCountList(),
    uiRequests,
    durationMs: Date.now() - startedAtMs
  };
  if (client.stderrText.trim()) {
    writeFileSync9(stderrPath, redactText(client.stderrText), "utf8");
    result.runtime.stderrPath = stderrPath;
  }
  if (result.ok) {
    const info = client.exitInfo;
    if (!info) {
      result.warnings.push("pi \u8FDB\u7A0B\u5173\u505C\u540E\u672A\u89C2\u6D4B\u5230\u9000\u51FA\u4E8B\u4EF6(exitInfo \u7F3A\u5931);\u4EFB\u52A1\u7ED3\u8BBA\u5728\u5173\u505C\u524D\u5DF2\u6536\u5272,verdict \u4E0D\u53D8\u3002");
    } else if (info.signal) {
      result.warnings.push(`pi \u8FDB\u7A0B\u5728\u5173\u505C\u9636\u6BB5\u88AB\u4FE1\u53F7\u7EC8\u6B62(signal=${info.signal});\u4EFB\u52A1\u7ED3\u8BBA\u5728\u9000\u51FA\u524D\u5DF2\u6536\u5272,verdict \u4E0D\u53D8\u3002`);
    } else if (info.code !== 0 && info.code !== null) {
      result.warnings.push(`pi \u8FDB\u7A0B\u5728\u5173\u505C\u9636\u6BB5\u4EE5\u975E\u96F6\u7801\u9000\u51FA(code=${info.code});\u4EFB\u52A1\u7ED3\u8BBA\u5728\u9000\u51FA\u524D\u5DF2\u6536\u5272,verdict \u4E0D\u53D8\u3002`);
    }
  }
  if (saveRawEvidence) {
    const rawPath = path15.join(outDir, "pi-rpc-raw.jsonl");
    writeFileSync9(rawPath, `${client.rawRecords.map((record2) => JSON.stringify(record2)).join("\n")}
`, "utf8");
    result.evidence = { rawJsonl: rawPath, records: client.rawRecords.length };
  }
  try {
    const sessionFiles = existsSync13(sessionDir) ? statSync5(sessionDir).isDirectory() : false;
    result.session = { ...result.session ?? {}, sessionDir, sessionDirExists: sessionFiles };
  } catch {
    result.session = { ...result.session ?? {}, sessionDir, sessionDirExists: false };
  }
  attachSessionResume();
  if (externalCancellation.requested) {
    result.cancellation = {
      ...externalCancellation,
      graceful: externalCancellation.graceful && settledIdleConfirmed
    };
  }
  if (externalCancellation.type === "pause") {
    result.pause = { ...externalCancellation, graceful: externalCancellation.graceful && settledIdleConfirmed };
    delete result.cancellation;
    if (result.pause.graceful && result.cleanup?.tree_confirmed === true && !result.session?.file && !result.session?.read_error) {
      result.session = { ...result.session, resumable: true, resume_mode: "start" };
    }
    result.status = result.pause.graceful && result.session?.resumable ? "paused" : "pause_unconfirmed";
    result.failure_type = result.status === "paused" ? "none" : "pause_unconfirmed";
    result.orchestration.status = result.status;
    result.orchestration.failure_type = result.failure_type;
    result.task = null;
  }
  writeIdentitySnapshot();
}
var resultPath = path15.join(outDir, "child-task-result.json");
result.outputPath = resultPath;
writeFileSync9(resultPath, JSON.stringify(result, null, 2), "utf8");
writeLive({
  status: result.status === "paused" ? "paused" : result.orchestration?.ok === true ? "completed" : "failed",
  phase: "finished",
  event: "finished",
  final_status: result.status,
  business_status: result.task?.status ?? null,
  failure_type: result.failure_type,
  event_counts: client.eventCountList(),
  tool_call_counts: toolCallCounts(),
  output_path: resultPath
});
console.log(JSON.stringify(result, null, 2));
if (!result.ok && result.status !== "paused") {
  process.exitCode = 1;
}
