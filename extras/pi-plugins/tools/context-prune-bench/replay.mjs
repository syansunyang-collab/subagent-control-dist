#!/usr/bin/env node
/**
 * Offline replay of pi-context-prune (agent-message trigger, agent-message batching)
 * against real Pi session JSONL files.
 *
 * For every assistant call on the session's active branch the script computes the
 * characters that would have been sent with (B) and without (A) pruning, calibrates
 * chars -> tokens against the call's recorded usage, and models the prefix-cache
 * invalidation that each prune causes on the next call. Summaries are produced by the
 * same summarizer model, prompt, serialization (2000-char truncation per result) and
 * skip rule (summary longer than raw -> skip) as pi-context-prune 1.4.0.
 *
 * Usage:
 *   node tools/context-prune-bench/replay.mjs --out <dir> [--sessions a.jsonl,b.jsonl]
 *        [--top N --days D --min-calls C] [--dry] [--model opencode-go/deepseek-v4.1-flash]
 *        [--thinking low] [--concurrency 2]
 *        [--mid-run high,keepTokens,keepCalls,gap[,start] [--mid-run-src <mid-run.ts>]]
 *        [--mid-run-policy watermark|astra-codex --calibration <economic-calibration.json> --dry]
 *
 * --dry skips summarizer calls and assumes summary = 0.40 x serialized batch chars.
 * --mid-run layers the watermark trigger on top of the agent-message trigger, using the
 * extension's own decision module (src/mid-run.ts) so the replay and the extension cannot
 * drift apart. Without the flag the mechanism behaves exactly as before.
 * Never writes to settings.json, source sessions or live Pi state.
 */
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { existsSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(HERE));
const PI_ROOT = join(homedir(), "AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent");
const AGENT_DIR = join(homedir(), ".pi/agent");

// --- pi-context-prune 1.4.0 constants (dist/index.js) -------------------------------
const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Be concise.`;
let RESULT_MAX_CHARS = 2000; // per-result cap shown to the summarizer; --result-cap overrides (0 = no cap)
const SUMMARY_OPEN = "<context-prune-summary>";
const SUMMARY_CLOSE = "</context-prune-summary>";
// --- SoL-Pi ObservationPack constants (src/sol-pi/extensions/observation-pack/observation.ts) ---
// Pure-text tool results above THRESHOLD_BYTES are sent in full for FULL_SENDS provider requests, then
// projected as a ~1 KB head/tail excerpt plus a 7-line header. Bytes are approximated by chars here.
const OBS_THRESHOLD = 10 * 1024;
const OBS_FULL_SENDS = 2;
const OBS_PLACEHOLDER_CHARS = 1024 + 360;

function serializeBatch(batch) {
  const parts = [];
  if (batch.assistantText) parts.push(`Assistant said: ${batch.assistantText}\n`);
  const toolParts = batch.toolCalls.map((tc) => {
    const status = tc.isError ? "ERROR" : "OK";
    const argsJson = JSON.stringify(tc.args, null, 2);
    let resultText = tc.resultText;
    if (RESULT_MAX_CHARS > 0 && resultText.length > RESULT_MAX_CHARS) {
      const remaining = resultText.length - RESULT_MAX_CHARS;
      resultText = resultText.slice(0, RESULT_MAX_CHARS) + ` ...[${remaining} chars truncated]`;
    }
    return `Tool: ${tc.toolName}(${argsJson})\nResult (${status}): ${resultText}`;
  });
  parts.push(toolParts.join("\n---\n"));
  return parts.join("\n");
}
function summaryContextChars(summaryText, n, startIndex = 1) {
  const refs = Array.from({ length: n }, (_, i) => `\`t${i + startIndex}\``).join(", ");
  const footer = `\n\n---\n**Summarized tool refs**: ${refs}\nUse \`context_tree_query\` with these refs to retrieve the original full outputs.`;
  return `${SUMMARY_OPEN}\n${summaryText}${footer}\n${SUMMARY_CLOSE}`.length;
}

// --- args -----------------------------------------------------------------------------
/** "high,keepTokens,keepCalls,gap[,start]" -> MidRunConfig; start defaults to 0.75 x high. */
function parseMidRun(spec) {
  const parts = String(spec ?? "").split(",").map((s) => Number(s.trim()));
  if (parts.length < 4 || parts.length > 5 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error("--mid-run expects high,keepTokens,keepCalls,gap[,start] as non-negative integers");
  }
  const [highTokens, keepTailTokens, keepTailCalls, minRequestsBetween, start] = parts;
  return { enabled: true, highTokens, keepTailTokens, keepTailCalls, minRequestsBetween,
    startTokens: start ?? Math.round(highTokens * 0.75) };
}

function parseArgs(argv) {
  const a = { out: null, sessions: [], top: 0, days: 7, minCalls: 100, dry: false, mechanism: "prune",
    model: "opencode-go/deepseek-v4.1-flash", thinking: "low", concurrency: 2, dryRatio: 0.4,
    midRun: null, midRunPolicy: "watermark", calibration: null, midRunSrc: join(REPO, "tmp/context-prune-bench/pi-context-prune-fork/src/mid-run.ts") };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--out") a.out = v, i++;
    else if (k === "--mid-run") a.midRun = parseMidRun(v), i++;
    else if (k === "--mid-run-src") a.midRunSrc = v, i++;
    else if (k === "--mid-run-policy") a.midRunPolicy = v, i++;
    else if (k === "--calibration") a.calibration = v, i++;
    else if (k === "--sessions") a.sessions = v.split(",").map((s) => s.trim()).filter(Boolean), i++;
    else if (k === "--top") a.top = Number(v), i++;
    else if (k === "--days") a.days = Number(v), i++;
    else if (k === "--min-calls") a.minCalls = Number(v), i++;
    else if (k === "--dry") a.dry = true;
    else if (k === "--dry-ratio") a.dryRatio = Number(v), i++;
    else if (k === "--model") a.model = v, i++;
    else if (k === "--thinking") a.thinking = v, i++;
    else if (k === "--concurrency") a.concurrency = Number(v), i++;
    else if (k === "--mechanism") a.mechanism = v, i++;
    else if (k === "--result-cap") a.resultCap = Number(v), i++;
    else throw new Error(`unknown arg ${k}`);
  }
  if (!["prune", "obspack", "both"].includes(a.mechanism)) throw new Error("--mechanism prune|obspack|both");
  if (a.midRun && a.mechanism === "obspack") throw new Error("--mid-run applies to the prune mechanism");
  if (a.resultCap !== undefined) { if (!Number.isInteger(a.resultCap) || a.resultCap < 0) throw new Error("--result-cap must be a non-negative integer"); RESULT_MAX_CHARS = a.resultCap; }
  if (a.mechanism === "obspack") a.dry = true; // ObservationPack makes no model calls
  if (!["watermark", "astra-codex"].includes(a.midRunPolicy)) throw new Error("unknown --mid-run-policy");
  if (a.midRunPolicy === "astra-codex" && (!a.midRun || !a.calibration || !a.dry)) throw new Error("economic replay requires --mid-run, --calibration and --dry");
  if (a.calibration && (!a.midRun || !a.dry)) throw new Error("--calibration requires --mid-run and --dry");
  if (a.midRun && a.midRunPolicy === "astra-codex") a.midRun.policy = "astra-codex";
  if (!a.out) throw new Error("--out is required");
  if (!a.sessions.length && !a.top) throw new Error("--sessions or --top required");
  return a;
}

// --- session loading ------------------------------------------------------------------
async function loadPi() {
  const s = await import(pathToFileURL(join(PI_ROOT, "dist/core/session-manager.js")).href);
  const r = await import(pathToFileURL(join(PI_ROOT, "dist/core/model-runtime.js")).href);
  const g = await import(pathToFileURL(join(PI_ROOT, "dist/core/model-registry.js")).href);
  return { loadEntriesFromFile: s.loadEntriesFromFile, ModelRuntime: r.ModelRuntime, ModelRegistry: g.ModelRegistry };
}
function activeBranch(entries) {
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const parents = new Set(entries.map((e) => e.parentId).filter(Boolean));
  const leaves = entries.filter((e) => e.id && !parents.has(e.id));
  const pathFrom = (leaf) => {
    const p = []; let cur = leaf; const seen = new Set();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); p.push(cur); cur = cur.parentId ? byId.get(cur.parentId) : null; }
    return p.reverse();
  };
  let best = null;
  for (const leaf of leaves) {
    const p = pathFrom(leaf);
    const calls = p.filter((e) => e.type === "message" && e.message?.role === "assistant").length;
    if (!best || calls > best.calls) best = { calls, path: p };
  }
  return best ? best.path : [];
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && c.type === "text").map((c) => c.text ?? "").join("\n");
}
function assistantChars(message) {
  let n = 0;
  for (const c of message.content ?? []) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text") n += (c.text ?? "").length;
    else if (c.type === "toolCall") n += JSON.stringify(c.arguments ?? c.input ?? c.args ?? {}).length + (c.name ?? "").length;
  }
  return n;
}
function pickSessions(args) {
  if (args.sessions.length) return args.sessions;
  const cutoff = Date.now() - args.days * 86400e3;
  const found = [];
  for (const dir of ["sessions", "pi-web-sessions"]) {
    const base = join(AGENT_DIR, dir);
    if (!existsSync(base)) continue;
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name); const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (name.endsWith(".jsonl") && st.mtimeMs >= cutoff) found.push({ p, size: st.size });
      }
    };
    walk(base);
  }
  found.sort((x, y) => y.size - x.size);
  return found.slice(0, args.top * 3).map((f) => f.p); // over-select; filtered by minCalls later
}

// --- summarizer -----------------------------------------------------------------------
async function makeSummarizer(pi, args) {
  const [provider, ...rest] = args.model.split("/"); const modelId = rest.join("/");
  const runtime = await pi.ModelRuntime.create({ authPath: join(AGENT_DIR, "auth.json"),
    modelsStorePath: join(AGENT_DIR, "models-store.json"), refreshOnCreate: true, allowModelNetwork: false });
  const registry = new pi.ModelRegistry(runtime);
  const model = registry.find(provider, modelId);
  if (!model) throw new Error(`model not found: ${args.model}`);
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`auth failed: ${auth.error}`);
  const prov = registry.getProvider(model.provider);
  const sessionId = randomUUID();
  return async function summarize(userMessage, signal) {
    const headers = { ...(auth.headers ?? {}) };
    if (model.provider === "opencode" || model.provider === "opencode-go") {
      headers["x-opencode-session"] = sessionId; headers["x-opencode-client"] = "pi";
    }
    const opts = { apiKey: auth.apiKey, headers, env: auth.env, signal };
    if (args.thinking !== "default") opts.reasoningEffort = args.thinking === "off" ? undefined : args.thinking;
    const stream = prov.stream(auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
      { messages: [{ role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() }] }, opts);
    for await (const _ of stream) { /* drain */ }
    const res = await stream.result();
    if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage ?? `stop=${res.stopReason}`);
    return { text: res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), usage: res.usage ?? null };
  };
}
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 600e3);
    try { return await fn(ctrl.signal); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
    finally { clearTimeout(t); }
  }
  throw last;
}

// --- simulation -----------------------------------------------------------------------
function linearFit(xs, ys) {
  const n = xs.length; if (n < 2) return { a: 0, b: 0.25, r2: 0 };
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  const b = sxx ? sxy / sxx : 0, a = my - b * mx;
  let ssr = 0; for (let i = 0; i < n; i++) ssr += (ys[i] - (a + b * xs[i])) ** 2;
  return { a, b, r2: syy ? 1 - ssr / syy : 0 };
}

/** Loads the extension's own mid-run decision module, so replay and extension share one algorithm. */
async function loadMidRun(args) {
  if (!args.midRun) return null;
  if (!existsSync(args.midRunSrc)) throw new Error(`--mid-run-src not found: ${args.midRunSrc}`);
  const m = await import(pathToFileURL(args.midRunSrc).href);
  const capture = args.calibration ? await import(pathToFileURL(join(dirname(args.midRunSrc), "batch-capture.ts")).href) : null;
  const economic = args.calibration ? await import(pathToFileURL(join(dirname(args.midRunSrc), "economic-policy.ts")).href) : null;
  const calibration = args.calibration ? JSON.parse(await readFile(args.calibration, "utf8")) : null;
  const stub = args.calibration ? await import(pathToFileURL(join(dirname(args.midRunSrc), "result-stub.ts")).href) : null;
  const horizon = args.calibration ? JSON.parse(await readFile(join(dirname(args.midRunSrc), "economic-horizon.json"), "utf8")) : null;
  if (calibration && (RESULT_MAX_CHARS !== calibration.training.resultCap || args.model !== "opencode-go/deepseek-v4.1-flash" || args.thinking !== "low")) {
    throw new Error("calibrated replay requires the fitted summarizer opencode-go/deepseek-v4.1-flash, low thinking and matching result cap");
  }
  return { MidRunController: m.MidRunController, estimateTokens: m.estimateTokens,
    selectMidRunBatch: m.selectMidRunBatch, serializeBatch: capture?.serializeBatchForSummarizer,
    economic, calibration, stub, horizon };
}

async function replaySession(file, pi, summarize, args, midRunModule, outDir) {
  const entries = pi.loadEntriesFromFile(file);
  const path = activeBranch(entries);
  // A session recorded while the pruner was active already carries pruned contexts: its real token
  // counts are no unpruned baseline and the chars->tokens fit breaks (seen: R2 0.16, savings
  // understated several times over). Replay such a session only for mechanics, never for savings.
  const livePruned = path.filter((e) => e.customType === "context-prune-summary").length;
  if (livePruned) process.stderr.write(`  WARNING ${file}: recorded with the pruner active (${livePruned} live summaries); A is not an unpruned baseline, savings are understated\n`);
  const tag = basename(file).slice(0, 19) + "_" + basename(dirname(file)).replace(/^--|--$/g, "").slice(0, 30);
  const summariesPath = join(outDir, `${tag}.summaries.jsonl`);
  await writeFile(summariesPath, "");

  // context items: {id, kind, chars, toolCallId, pruned}
  let ctx = [];
  const tcById = new Map(); // toolCallId -> {toolName,args,resultText,isError}
  let pending = new Map(); // userTurnGroup -> {assistantTexts:[], toolCallIds:[]}
  let group = 0;
  const calls = []; // per assistant call
  let bustPos = null; // ctx index where prefix got invalidated for B since last call
  let compBust = false;
  const sumStats = { calls: 0, input: 0, output: 0, cost: 0, skipped: 0, summarized: 0, ratios: [], failed: 0 };
  let model = null;
  let provider = null;
  let economicRequest = [];
  let economicModelKey = "";
  let toolAge = 0;
  let nextShortRef = 1;
  const capturedBatches = [];
  const batchForPlan = (plan) => midRunModule.selectMidRunBatch(capturedBatches, plan);
  const decisions = [];
  const prior = midRunModule?.calibration;
  const policy = midRunModule?.economic;
  const stubChars = (id) => midRunModule?.stub?.prunedResultText(tcById.get(id)?.toolName ?? "tool", id).length ?? 0;
  const drySummary = (serializedChars, tools) => {
    const size = prior ? policy.predict(prior.summaryChars, serializedChars, tools) : serializedChars * args.dryRatio;
    const cost = 0; // Owner's marginal summary-cost assumption; no provider call in calibrated dry mode.
    return { text: "x".repeat(Math.round(size)), usage: { input:0, output:0, cost:{total:cost} } };
  };

  const chunksOf = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

  // --- mid-run watermark state ---------------------------------------------------------
  // `steps` mirrors MidRunStep[] from the extension: one entry per assistant message, with
  // each tool call's result size and whether it has been summarized already.
  const midCtl = midRunModule ? new midRunModule.MidRunController() : null;
  const steps = [];
  const stepByCallId = new Map(); // toolCallId -> the MidRunToolCallInfo object inside steps
  const summarizedIds = new Set();
  let midPrunes = 0;
  const midStats = { calls: 0, skipped: 0, prunedTokens: 0, toolChainCuts: 0, regularFlushReuses: 0 };

  const markSummarized = (ids) => {
    for (const id of ids) {
      summarizedIds.add(id);
      const info = stepByCallId.get(id);
      if (info) info.summarized = true;
    }
  };

  /** Replaces the raw results of `ids` with one summary item, exactly as flush() does. */
  const applyPruneToContext = (ids, summaryText, label, refStart = 1) => {
    const idSet = new Set(ids);
    let first = null;
    for (let i = 0; i < ctx.length; i++) {
      if (ctx[i].kind === "toolResult" && idSet.has(ctx[i].toolCallId) && !ctx[i].pruned) {
        ctx[i].pruned = true;
        if (first === null) first = i;
      }
    }
    ctx.push({ id: label, kind: "summary", chars: summaryContextChars(summaryText, ids.length, refStart) });
    if (first !== null && (bustPos === null || first < bustPos)) bustPos = first;
  };

  /**
   * One mid-run evaluation, at the point the `context` hook would fire. The runner resolves
   * on the microtask queue, so a plan frozen at request N is applied at request N+1 at the
   * earliest — the same one-request lag the extension has.
   */
  async function midRunTick(reuseReady = false) {
    if (!midCtl) return;
    if (!reuseReady) midCtl.noteRequest();
    const rememberRequest = () => {
      if (prior && !reuseReady) economicRequest = ctx.map(it=>({toolCallId:it.toolCallId,
        chars:it.pruned?stubChars(it.toolCallId):it.chars,priceable:it.priceable!==false}));
    };
    const economics = args.midRunPolicy === "astra-codex" && policy.isAstraCodex({provider,id:model}) ? (plan, ready) => {
      const batch = batchForPlan(plan);
      if (!batch) return null;
      const toolCalls = batch.toolCalls;
      const serialized = midRunModule.serializeBatch(batch, RESULT_MAX_CHARS);
      const chars = ready?.summaryText.length ?? Math.ceil(policy.predict(prior.summaryChars, serialized.length, toolCalls.length));
      const replacement = summaryContextChars("x".repeat(chars),toolCalls.length,nextShortRef) + plan.toolCallIds.reduce((s,id)=>s+stubChars(id),0);
      return policy.quoteCut(economicRequest,plan.toolCallIds,replacement,
        0,prior.tokensPerChar,
        policy.remainingRequests(midRunModule.horizon.expectedRequestsByToolAge,toolAge));
    } : undefined;
    const evaluation = midCtl.evaluate(steps, args.midRun, async (plan) => {
      sumStats.calls++;
      midStats.calls++;
      const batch = batchForPlan(plan);
      if (!batch) return null;
      const toolCalls = batch.toolCalls;
      const serialized = prior ? midRunModule.serializeBatch(batch, RESULT_MAX_CHARS) : serializeBatch(batch);
      if (!args.dry) {
        const userMessage = SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";
        try {
          const { text, usage } = await withRetry((sig) => summarize(userMessage, sig));
          if (usage) { sumStats.input += usage.input ?? 0; sumStats.output += usage.output ?? 0; sumStats.cost += usage.cost?.total ?? 0; }
          return { summaryText: text, serializedChars: serialized.length };
        } catch (e) { sumStats.failed++; return null; }
      }
      const predicted = drySummary(serialized.length,toolCalls.length);
      sumStats.cost += predicted.usage.cost.total;
      return { summaryText: predicted.text, serializedChars: serialized.length, usage:predicted.usage };
    }, {economics,applyBelowHigh:reuseReady});
    if (prior) {
      decisions.push({request:midCtl.getRequestCount(),toolAge,reuseReady,action:evaluation.action,reason:evaluation.reason,
        cutTurnIndex:evaluation.plan?.cutTurnIndex,tools:evaluation.plan?.toolCallIds.length,quote:evaluation.quote});
    }
    if (evaluation.action === "started") { await Promise.resolve(); await Promise.resolve(); rememberRequest(); return; }
    if (evaluation.action !== "apply") { rememberRequest(); return; }

    const { plan, summary } = evaluation;
    const toolCalls = plan.toolCallIds.map((id) => tcById.get(id)).filter(Boolean);
    const rawChars = toolCalls.reduce((s, tc) => s + tc.resultText.length, 0);
    const rec = { midRun: true, cutTurnIndex: plan.cutTurnIndex, atPhaseBoundary: plan.atPhaseBoundary,
      tools: toolCalls.length, rawChars, serializedChars: summary.serializedChars, summaryChars: summary.summaryText.length,
      prunedTokens: plan.prunedTokens, keptTokens: plan.keptTokens, skipped: summary.summaryText.length > rawChars };
    await appendFile(summariesPath, JSON.stringify(rec) + "\n");
    const refStart = prior ? nextShortRef : 1;
    if (prior) nextShortRef += toolCalls.length;
    // Both outcomes consume the plan; the frontier advances either way, as in the extension.
    markSummarized(plan.toolCallIds);
    if (rec.skipped) { sumStats.skipped++; midStats.skipped++; }
    else {
      sumStats.summarized++; sumStats.ratios.push(summary.summaryText.length / rawChars);
      applyPruneToContext(plan.toolCallIds, summary.summaryText, `midrun-${plan.cutTurnIndex}`, refStart);
      midPrunes++; midStats.prunedTokens += plan.prunedTokens;
      if (reuseReady) midStats.regularFlushReuses++; else midStats.toolChainCuts++;
    }
    midCtl.confirmApplied(plan);
    rememberRequest();
  }

  async function flush(afterIndex) {
    await midRunTick(true);
    // Reuse a ready background result, and never buy an in-flight range twice.
    for (const gb of pending.values()) gb.toolCallIds = gb.toolCallIds.filter((id) => !summarizedIds.has(id));
    const owned = new Set(midCtl?.getPendingPlan()?.toolCallIds ?? []);
    const groups = [...pending.entries()].map(([g,gb])=>[g,{...gb,toolCallIds:gb.toolCallIds.filter(id=>!owned.has(id))}])
      .filter(([,g])=>g.toolCallIds.length);
    pending = new Map([...pending.entries()].map(([g,gb])=>[g,{...gb,toolCallIds:gb.toolCallIds.filter(id=>owned.has(id))}])
      .filter(([,g])=>g.toolCallIds.length));
    // one summarizer call per user-turn group (agent-message batching); run with limited concurrency
    const results = [];
    for (const chunk of chunksOf(groups, args.concurrency)) {
      results.push(...await Promise.all(chunk.map(async ([g, gb]) => {
        const toolCalls = gb.toolCallIds.map((id) => tcById.get(id)).filter(Boolean);
        const batch = { assistantText: gb.assistantTexts.filter(Boolean).join("\n\n"), toolCalls };
        const rawChars = toolCalls.reduce((s, tc) => s + tc.resultText.length, 0);
        const serialized = prior ? midRunModule.serializeBatch(batch, RESULT_MAX_CHARS) : serializeBatch(batch);
        const userMessage = SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";
        let text, usage = null;
        if (args.dry) { ({text,usage}=drySummary(serialized.length,toolCalls.length)); }
        else {
          try { ({ text, usage } = await withRetry((sig) => summarize(userMessage, sig))); }
          catch (e) { sumStats.failed++; return { g, toolCalls, rawChars, error: String(e.message ?? e) }; }
        }
        return { g, toolCalls, rawChars, serializedChars: serialized.length, text, usage };
      })));
    }
    for (const r of results) {
      if (r.error) { await appendFile(summariesPath, JSON.stringify({ group: r.g, error: r.error, tools: r.toolCalls.length, rawChars: r.rawChars }) + "\n"); continue; }
      sumStats.calls++;
      if (r.usage) { sumStats.input += r.usage.input ?? 0; sumStats.output += (r.usage.output ?? 0); sumStats.cost += r.usage.cost?.total ?? 0; }
      const refStart = prior ? nextShortRef : 1;
      if (prior) nextShortRef += r.toolCalls.length;
      const skipped = r.text.length > r.rawChars;
      const rec = { group: r.g, tools: r.toolCalls.length, rawChars: r.rawChars, serializedChars: r.serializedChars, summaryChars: r.text.length,
        skipped, usage: r.usage, summary: args.dry ? undefined : r.text };
      await appendFile(summariesPath, JSON.stringify(rec) + "\n");
      // A skipped batch advances the prune frontier, so mid-run must not re-plan it.
      if (skipped) { sumStats.skipped++; if (midCtl) markSummarized(r.toolCalls.map((tc) => tc.toolCallId)); continue; }
      sumStats.summarized++; sumStats.ratios.push(r.text.length / r.rawChars);
      const ids = r.toolCalls.map((tc) => tc.toolCallId);
      markSummarized(ids);
      applyPruneToContext(ids, r.text, `summary-${r.g}`, refStart);
    }
  }

  for (let idx = 0; idx < path.length; idx++) {
    const e = path[idx];
    if (e.type === "compaction") {
      const keep = ctx.findIndex((it) => it.id === e.firstKeptEntryId);
      ctx = [{ id: e.id, kind: "compaction", chars: (e.summary ?? "").length + 200 }, ...(keep >= 0 ? ctx.slice(keep) : [])];
      const alive = new Set(ctx.map((it) => it.id));
      for (const [g, gb] of pending) gb.toolCallIds = gb.toolCallIds.filter((id) => alive.has(`tr-${id}`));
      // Compaction dropped those results from context; mid-run must stop counting them.
      if (midCtl) {
        for (const step of steps) {
          for (const tc of step.toolCalls) if (!alive.has(`tr-${tc.toolCallId}`)) tc.summarized = true;
        }
        midCtl.discardPending();
        economicRequest = [];
        toolAge = 0;
      }
      compBust = true; bustPos = null;
      continue;
    }
    if (e.type === "custom_message") { ctx.push({ id: e.id, kind: "custom", chars: textOf(e.content).length }); continue; }
    if (e.type !== "message") continue;
    const m = e.message; if (!m) continue;
    if (m.role === "user") { toolAge = 0; group++; ctx.push({ id: e.id, kind: "user", chars: textOf(m.content).length }); continue; }
    if (m.role === "toolResult") {
      const t = textOf(m.content);
      const tc = tcById.get(m.toolCallId);
      if (tc) { tc.resultText = t; tc.isError = m.isError ?? false; }
      const info = stepByCallId.get(m.toolCallId);
      if (info) info.resultChars = t.length;
      ctx.push({ id: `tr-${m.toolCallId}`, kind: "toolResult", chars: t.length, toolCallId: m.toolCallId, pruned: false,
        priceable: !Array.isArray(m.content) || !m.content.some(b=>b?.type==="image") });
      continue;
    }
    if (m.role !== "assistant") continue;
    model = m.model ?? model;
    provider = m.provider ?? provider;
    const key = `${provider}/${model}`;
    if (economicModelKey && key !== economicModelKey) { economicRequest=[]; toolAge=0; midCtl?.invalidatePending(); }
    economicModelKey = key;
    const u = m.usage ?? {};
    // The `context` hook fires here, one call per LLM request.
    await midRunTick();
    const aChars = ctx.reduce((s, it) => s + (prior && it.kind === "summary" ? 0 : it.chars), 0);
    const obs = args.mechanism !== "prune";
    let bChars = 0, bAfterBust = 0;
    const bItems = [];
    for (let i = 0; i < ctx.length; i++) {
      const it = ctx[i]; if (it.pruned && !prior) continue;
      let chars = it.pruned ? stubChars(it.toolCallId) : it.chars;
      if (obs && it.kind === "toolResult" && it.chars >= OBS_THRESHOLD) {
        const sends = it.sends ?? 0;
        if (sends >= OBS_FULL_SENDS) { chars = Math.min(chars, OBS_PLACEHOLDER_CHARS); if (sends === OBS_FULL_SENDS && (bustPos === null || i < bustPos)) bustPos = i; }
        it.sends = sends + 1;
      }
      bItems.push([i, chars]);
    }
    for (const [i, chars] of bItems) { bChars += chars; if (bustPos !== null && i >= bustPos) bAfterBust += chars; }
    calls.push({ idx, aChars, bChars, bAfterBust, bust: bustPos !== null ? "prune" : compBust ? "compaction" : null,
      input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, output: u.output ?? 0 });
    bustPos = null; compBust = false;
    // register the assistant message
    const toolCalls = (m.content ?? []).filter((c) => c && c.type === "toolCall");
    ctx.push({ id: e.id, kind: "assistant", chars: assistantChars(m) });
    const gb = pending.get(group) ?? { assistantTexts: [], toolCallIds: [] };
    gb.assistantTexts.push(textOf(m.content).trim());
    for (const c of toolCalls) { tcById.set(c.id, { toolCallId: c.id, toolName: c.name, args: c.arguments ?? c.input ?? c.args ?? {}, resultText: "(no result)", isError: false }); gb.toolCallIds.push(c.id); }
    if (m.stopReason === "error" || m.stopReason === "aborted") toolAge=0;
    else if (toolCalls.length) toolAge++;
    if (midCtl) {
      if (toolCalls.length) capturedBatches.push({turnIndex:steps.length,timestamp:m.timestamp??0,
        assistantText:textOf(m.content),toolCalls:toolCalls.map(c=>tcById.get(c.id))});
      // Mirror the assistant message into the MidRunStep list the planner reads.
      const step = { turnIndex: steps.length, hasText: textOf(m.content).trim().length > 0,
        errored: m.stopReason === "error" || m.stopReason === "aborted",
        toolCalls: toolCalls.map((c) => ({ toolCallId: c.id, toolName: c.name, resultChars: null, summarized: false })) };
      for (const info of step.toolCalls) stepByCallId.set(info.toolCallId, info);
      steps.push(step);
    }
    if (toolCalls.length) pending.set(group, gb);
    else if (args.mechanism !== "obspack" && [...pending.values()].some((x) => x.toolCallIds.length)) await flush(idx);
    if (!toolCalls.length) toolAge=0;
  }

  // calibration on A (real): tokens = a + b * chars
  const valid = calls.filter((c) => c.input + c.cacheRead + c.cacheWrite > 0);
  const fit = linearFit(valid.map((c) => c.aChars), valid.map((c) => c.input + c.cacheRead + c.cacheWrite));
  const tot = { A: { ctx: 0, uncached: 0 }, B: { ctx: 0, uncached: 0 }, calls: valid.length, prunes: 0 };
  for (const c of valid) {
    const aT = c.input + c.cacheRead + c.cacheWrite;
    const bT = Math.max(0, Math.round(fit.a + fit.b * c.bChars));
    // Real uncached input already includes A's own cache misses (new messages, TTL expiry); a prune adds a bust of
    // everything after the first removed result, so B's uncached is the larger of the two, never smaller than A's.
    let bU = c.input;
    if (c.bust === "prune") { bU = Math.max(c.input, Math.round(fit.b * c.bAfterBust)); tot.prunes++; }
    bU = Math.min(bU, bT);
    c.aTokens = aT; c.bTokens = bT; c.bUncached = bU;
    tot.A.ctx += aT; tot.A.uncached += c.input; tot.B.ctx += bT; tot.B.uncached += bU;
  }
  const sumTokens = sumStats.input + sumStats.output;
  const net = tot.A.ctx ? (tot.A.ctx - tot.B.ctx - sumTokens) / tot.A.ctx : 0;
  const ratios = sumStats.ratios.slice().sort((x, y) => x - y);
  const q = (p) => ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))] : null;
  const result = { file, tag, model, livePruned, branchEntries: path.length, calls: tot.calls, userTurns: group,
    fit: { a: Math.round(fit.a), b: +fit.b.toFixed(4), r2: +fit.r2.toFixed(4) },
    A: tot.A, B: tot.B, summarizer: { ...sumStats, ratios: undefined, tokens: sumTokens, ratioP25: q(0.25), ratioP50: q(0.5), ratioP75: q(0.75) },
    prunes: tot.prunes, ctxReductionPct: +((1 - tot.B.ctx / tot.A.ctx) * 100).toFixed(2), netSavingPct: prior ? null : +(net * 100).toFixed(2),
    uncachedDeltaPct: +(((tot.B.uncached - tot.A.uncached) / tot.A.ctx) * 100).toFixed(2), dry: args.dry, mechanism: args.mechanism, resultCap: RESULT_MAX_CHARS,
    ...(prior ? { summaryEstimate:"calibrated-prior-no-model-calls", summaryTokenUsage:"not-estimated", summaryCostAssumption:"zero-marginal-cost",
      estimatedAstraCost:{A:(tot.A.ctx+9*tot.A.uncached+50*valid.reduce((s,c)=>s+c.output,0))/1e6,
        B:(tot.B.ctx+9*tot.B.uncached+50*valid.reduce((s,c)=>s+c.output,0))/1e6+sumStats.cost},
      pricing:"astra-codex-standard-no-long-context-multiplier" } : {}),
    midRun: args.midRun ? { ...args.midRun, cuts: midPrunes, ...midStats } : null };
  if (prior) await writeFile(join(outDir, `${tag}.decisions.json`), JSON.stringify(decisions,null,2));
  await writeFile(join(outDir, `${tag}.calls.json`), JSON.stringify(calls));
  await writeFile(join(outDir, `${tag}.result.json`), JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = join(REPO, args.out);
  await mkdir(outDir, { recursive: true });
  const pi = await loadPi();
  const summarize = args.dry ? null : await makeSummarizer(pi, args);
  const midRunModule = await loadMidRun(args);
  const files = pickSessions(args);
  const results = [];
  for (const f of files) {
    if (args.top && results.length >= args.top) break;
    const quick = pi.loadEntriesFromFile(f).filter((e) => e.type === "message" && e.message?.role === "assistant").length;
    if (args.top && quick < args.minCalls) continue;
    process.stderr.write(`replay ${basename(f)} (${quick} assistant msgs)\n`);
    const r = await replaySession(f, pi, summarize, args, midRunModule, outDir);
    process.stderr.write(`  A=${r.A.ctx.toLocaleString()} B=${r.B.ctx.toLocaleString()} ctx-${r.ctxReductionPct}% net ${r.netSavingPct === null ? "n/a" : `${r.netSavingPct}%`} prunes=${r.prunes} midCuts=${r.midRun?.cuts ?? 0} skipped=${r.summarizer.skipped} fitR2=${r.fit.r2}\n`);
    results.push(r);
  }
  const lines = ["| session | model | calls | userTurns | A ctx tokens | B ctx tokens | ctx↓% | uncached Δ% | summarizer tokens | net↓% | prunes | mid-run cuts | skipped | ratio p50 | fit R² |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of results) lines.push(`| ${r.tag} | ${r.model} | ${r.calls} | ${r.userTurns} | ${r.A.ctx.toLocaleString()} | ${r.B.ctx.toLocaleString()} | ${r.ctxReductionPct} | ${r.uncachedDeltaPct} | ${r.summaryTokenUsage === "not-estimated" ? "n/a" : r.summarizer.tokens.toLocaleString()} | ${r.netSavingPct ?? "n/a"} | ${r.prunes} | ${r.midRun?.cuts ?? 0} | ${r.summarizer.skipped}/${r.summarizer.calls} | ${r.summarizer.ratioP50?.toFixed(2) ?? "-"} | ${r.fit.r2} |`);
  const A = results.reduce((s, r) => s + r.A.ctx, 0), B = results.reduce((s, r) => s + r.B.ctx, 0), S = results.reduce((s, r) => s + r.summarizer.tokens, 0);
  const AU = results.reduce((s, r) => s + r.A.uncached, 0), BU = results.reduce((s, r) => s + r.B.uncached, 0);
  const midSpec = args.midRun ? ` mid-run=${args.midRun.startTokens}/${args.midRun.highTokens}/${args.midRun.keepTailTokens}/${args.midRun.keepTailCalls}/${args.midRun.minRequestsBetween}` : " mid-run=off";
  lines.push("", `Total: A=${A.toLocaleString()} B=${B.toLocaleString()} summarizer=${args.calibration ? "n/a" : S.toLocaleString()} ctx↓ ${((1 - B / A) * 100).toFixed(2)}% net↓ ${args.calibration ? "n/a" : `${(((A - B - S) / A) * 100).toFixed(2)}%`} uncachedA=${AU.toLocaleString()} uncachedB=${BU.toLocaleString()} (dry=${args.dry}, model=${args.model}:${args.thinking},${midSpec})`);
  await writeFile(join(outDir, "summary.md"), lines.join("\n") + "\n");
  await writeFile(join(outDir, "results.json"), JSON.stringify({ args, results }, null, 2));
  process.stdout.write(lines.join("\n") + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
