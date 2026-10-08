#!/usr/bin/env node
/**
 * Offline replay for the economic mid-run trigger (notes/general/prune-midrun-economic-plan-20260920.md).
 *
 * No model calls, no network. Session loading (`loadEntriesFromFile`, active-branch walk), the
 * chars -> tokens calibration and the prefix-cache-bust cost model are the ones replay.mjs uses;
 * the trigger itself is the plan's rule, evaluated at every boundary between requests:
 *
 *     cut  when   R * P_cache * N  >  S * (P_in - P_cache)
 *     cut  when   prompt tokens >= forcePct * tierTokens      (hard price-tier line)
 *
 *   R = reclaimable tokens (originals - summary - stubs) over the not-yet-pruned tool results
 *       older than the keep-tail (last `keepTailTurns` tool turns).
 *   S = tokens from the first modified context position to the end that survive the cut
 *       (stubs + everything after it + the appended summary), i.e. the prefix-cache suffix that
 *       has to be re-paid at full input price on the next request.
 *
 * Strategies (`--strategies`):
 *   end-of-run        current production behaviour: prune only when an assistant message
 *                     carries no tool calls (pruneOn=agent-message)
 *   econ-N<k>         end-of-run plus the economic trigger with N = k
 *   econ-N<k>-stub    econ-N<k> with the summarizer removed everywhere: summary length 0,
 *                     program stubs only
 *
 * Usage:
 *   node tools/context-prune-bench/replay_econ.mjs --sessions a.jsonl,b.jsonl --out <dir>
 *        [--strategies end-of-run,econ-N5,econ-N10,econ-N20,econ-N10-stub]
 *        [--calibration <economic-calibration.json>] [--result-cap 8000]
 *        [--price-in 10 --price-cache 1 --price-out 50 --tier 272000 --force-pct 0.85]
 *        [--keep-tail-turns 2]
 *
 * Reads only: the session snapshots given, the installed Pi dist, the calibration JSON.
 * Writes only: files under --out.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(HERE));
const PI_ROOT = join(homedir(), "AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent");

// --- pi-context-prune serialization constants (same as replay.mjs) ---------------------
const SUMMARY_OPEN = "<context-prune-summary>";
const SUMMARY_CLOSE = "</context-prune-summary>";
const PRUNED_RESULT_MARKER = "[pi-context-prune]";

/** src/result-stub.ts prunedResultText(), inlined so this script reads no worktree. */
function prunedResultText(toolName, toolCallId) {
  return `${PRUNED_RESULT_MARKER} This ${toolName} result was summarized and pruned from context; ` +
    `see the pruner-summary message that follows. Full output: context_tree_query with id "${toolCallId}".`;
}
function summaryContextChars(summaryLen, n, startIndex = 1) {
  const refs = Array.from({ length: n }, (_, i) => `\`t${i + startIndex}\``).join(", ");
  const footer = `\n\n---\n**Summarized tool refs**: ${refs}\nUse \`context_tree_query\` with these refs to retrieve the original full outputs.`;
  return SUMMARY_OPEN.length + 1 + summaryLen + footer.length + 1 + SUMMARY_CLOSE.length;
}
/** Chars the summarizer would see for a batch; mirrors src/batch-capture.ts serializeBatchForSummarizer. */
function serializedChars(batch, cap) {
  let n = 0;
  if (batch.assistantText) n += `Assistant said: ${batch.assistantText}\n`.length + 1;
  const parts = batch.toolCalls.map((tc) => {
    const status = tc.isError ? "ERROR" : "OK";
    const argsJson = JSON.stringify(tc.args, null, 2);
    let len = tc.resultText.length;
    if (cap > 0 && len > cap) len = cap + ` ...[${len - cap} chars truncated]`.length;
    return `Tool: ${tc.toolName}(${argsJson})\nResult (${status}): `.length + len;
  });
  n += parts.reduce((s, v) => s + v, 0) + Math.max(0, parts.length - 1) * "\n---\n".length;
  return n;
}

// --- args ------------------------------------------------------------------------------
function parseArgs(argv) {
  const a = {
    out: null, sessions: [], resultCap: 8000, keepTailTurns: 2,
    priceIn: 10, priceCache: 1, priceOut: 50, tier: 272000, forcePct: 0.85,
    strategies: ["end-of-run", "econ-N5", "econ-N10", "econ-N20", "econ-N10-stub"],
    calibration: join(REPO, "notes/verify/astra-economic-midrun-evidence-20260920/calibration.json"),
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--out") (a.out = v, i++);
    else if (k === "--sessions") (a.sessions = v.split(",").map((s) => s.trim()).filter(Boolean), i++);
    else if (k === "--strategies") (a.strategies = v.split(",").map((s) => s.trim()).filter(Boolean), i++);
    else if (k === "--calibration") (a.calibration = v, i++);
    else if (k === "--result-cap") (a.resultCap = Number(v), i++);
    else if (k === "--keep-tail-turns") (a.keepTailTurns = Number(v), i++);
    else if (k === "--price-in") (a.priceIn = Number(v), i++);
    else if (k === "--price-cache") (a.priceCache = Number(v), i++);
    else if (k === "--price-out") (a.priceOut = Number(v), i++);
    else if (k === "--tier") (a.tier = Number(v), i++);
    else if (k === "--force-pct") (a.forcePct = Number(v), i++);
    else throw new Error(`unknown arg ${k}`);
  }
  if (!a.out) throw new Error("--out is required");
  if (!a.sessions.length) throw new Error("--sessions is required");
  return a;
}
/** "econ-N10-stub" -> {econ:true, N:10, stubOnly:true}; "end-of-run" -> {econ:false}. */
function parseStrategy(name) {
  if (name === "end-of-run") return { name, econ: false, N: 0, stubOnly: false };
  if (name === "end-of-run-stub") return { name, econ: false, N: 0, stubOnly: true };
  const m = /^econ-N(\d+)(-stub)?$/.exec(name);
  if (!m) throw new Error(`unknown strategy ${name}`);
  return { name, econ: true, N: Number(m[1]), stubOnly: Boolean(m[2]) };
}

// --- session loading (identical to replay.mjs) -----------------------------------------
async function loadPi() {
  const s = await import(pathToFileURL(join(PI_ROOT, "dist/core/session-manager.js")).href);
  return { loadEntriesFromFile: s.loadEntriesFromFile };
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
function linearFit(xs, ys) {
  const n = xs.length; if (n < 2) return { a: 0, b: 0.25, r2: 0 };
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  const b = sxx ? sxy / sxx : 0, a = my - b * mx;
  let ssr = 0; for (let i = 0; i < n; i++) ssr += (ys[i] - (a + b * xs[i])) ** 2;
  return { a, b, r2: syy ? 1 - ssr / syy : 0 };
}
const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// --- one replay pass --------------------------------------------------------------------
/**
 * Walks the active branch once under `strat`. `fit` (chars -> tokens) is null on the baseline
 * pass, in which case only `aChars` per request is produced and no pruning happens at all.
 */
function pass(path, strat, args, prior, fit) {
  const predictSummary = (serialized, tools) =>
    Math.max(0, Math.round(prior.intercept + prior.perInputChar * serialized + prior.perToolCall * tools));
  const toTokens = (chars) => Math.max(0, Math.round(fit.a + fit.b * chars));
  const forceAt = args.forcePct * args.tier;

  let ctx = [];                     // {id, kind, chars, toolCallId, pruned}
  const tcById = new Map();
  let pending = new Map();          // userTurnGroup -> {assistantTexts, toolCallIds}
  let group = 0;
  const calls = [];
  let bustPos = null;
  const prunedIds = new Set();
  const toolTurns = [];             // [[toolCallId,...], ...] one per assistant message with tool calls
  let nextRef = 1;
  const cuts = [];
  let skipped = 0, summarized = 0;

  const stubChars = (id) => prunedResultText(tcById.get(id)?.toolName ?? "tool", id).length;
  const itemChars = (it) => (it.pruned ? stubChars(it.toolCallId) : it.chars);

  /** Replaces raw results of `ids` with stubs and appends one summary item; marks the bust position. */
  const applyPrune = (ids, summaryLen, nTools) => {
    const idSet = new Set(ids);
    let first = null;
    for (let i = 0; i < ctx.length; i++) {
      if (ctx[i].kind === "toolResult" && idSet.has(ctx[i].toolCallId) && !ctx[i].pruned) {
        ctx[i].pruned = true; if (first === null) first = i;
      }
    }
    for (const id of ids) prunedIds.add(id);
    if (summaryLen > 0) ctx.push({ kind: "summary", chars: summaryContextChars(summaryLen, nTools, nextRef) });
    nextRef += nTools;
    if (first !== null && (bustPos === null || first < bustPos)) bustPos = first;
    return first;
  };

  /** Candidate set for a mid-run cut: unpruned results older than the keep-tail. */
  const candidates = () => {
    const keep = new Set();
    for (const t of toolTurns.slice(-args.keepTailTurns)) for (const id of t) keep.add(id);
    const ids = [];
    for (const t of toolTurns) for (const id of t) if (!keep.has(id) && !prunedIds.has(id) && tcById.has(id)) ids.push(id);
    const present = new Set(ctx.filter((it) => it.kind === "toolResult" && !it.pruned).map((it) => it.toolCallId));
    return ids.filter((id) => present.has(id));
  };

  const quote = (ids) => {
    const tcs = ids.map((id) => tcById.get(id));
    const origChars = tcs.reduce((s, tc) => s + tc.resultText.length, 0);
    const ser = serializedChars({ assistantText: "", toolCalls: tcs }, args.resultCap);
    const sumLen = strat.stubOnly ? 0 : predictSummary(ser, ids.length);
    const sumItem = sumLen > 0 ? summaryContextChars(sumLen, ids.length, nextRef) : 0;
    const stubs = ids.reduce((s, id) => s + stubChars(id), 0);
    const reclaimChars = origChars - sumItem - stubs;
    const idSet = new Set(ids);
    let first = ctx.findIndex((it) => it.kind === "toolResult" && idSet.has(it.toolCallId) && !it.pruned);
    let suffixChars = sumItem;
    if (first >= 0) for (let i = first; i < ctx.length; i++) suffixChars += idSet.has(ctx[i].toolCallId) && ctx[i].kind === "toolResult" ? stubChars(ctx[i].toolCallId) : itemChars(ctx[i]);
    return { origChars, sumLen, sumItem, stubs, reclaimChars, suffixChars, first,
      R: toTokens(reclaimChars) - toTokens(0), S: toTokens(suffixChars) - toTokens(0) };
  };

  /** End-of-run flush: one batch per user-turn group, exactly as pruneOn=agent-message does. */
  const flush = () => {
    // Anything a mid-run cut reclaimed would have been reclaimed here anyway: a cut's incremental
    // benefit window ends at the first flush after it.
    for (const c of cuts) if (c.chainRemaining === undefined) c.chainRemaining = calls.length - c.call;
    for (const [g, gb] of [...pending.entries()]) {
      const ids = gb.toolCallIds.filter((id) => !prunedIds.has(id) && tcById.has(id));
      if (!ids.length) { pending.delete(g); continue; }
      const tcs = ids.map((id) => tcById.get(id));
      const rawChars = tcs.reduce((s, tc) => s + tc.resultText.length, 0);
      const ser = serializedChars({ assistantText: gb.assistantTexts.filter(Boolean).join("\n\n"), toolCalls: tcs }, args.resultCap);
      const sumLen = strat.stubOnly ? 0 : predictSummary(ser, ids.length);
      const stubs = ids.reduce((s, id) => s + stubChars(id), 0);
      // the extension's skip rule: a replacement no smaller than the original is not worth applying
      if ((sumLen > 0 ? summaryContextChars(sumLen, ids.length, nextRef) : 0) + stubs >= rawChars) {
        skipped++; for (const id of ids) prunedIds.add(id); // frontier advances either way
      } else { summarized++; applyPrune(ids, sumLen, ids.length); }
      pending.delete(g);
    }
  };

  for (let idx = 0; idx < path.length; idx++) {
    const e = path[idx];
    if (e.type === "compaction") {
      const keep = ctx.findIndex((it) => it.id === e.firstKeptEntryId);
      ctx = [{ id: e.id, kind: "compaction", chars: (e.summary ?? "").length + 200 }, ...(keep >= 0 ? ctx.slice(keep) : [])];
      const alive = new Set(ctx.map((it) => it.id));
      for (const [, gb] of pending) gb.toolCallIds = gb.toolCallIds.filter((id) => alive.has(`tr-${id}`));
      toolTurns.length = 0;
      bustPos = null;
      for (const c of cuts) {
        if (c.remaining === undefined) c.remaining = calls.length - c.call;
        if (c.chainRemaining === undefined) c.chainRemaining = calls.length - c.call;
      }
      continue;
    }
    if (e.type === "custom_message") { ctx.push({ id: e.id, kind: "custom", chars: textOf(e.content).length }); continue; }
    if (e.type !== "message") continue;
    const m = e.message; if (!m) continue;
    if (m.role === "user") { group++; ctx.push({ id: e.id, kind: "user", chars: textOf(m.content).length }); continue; }
    if (m.role === "toolResult") {
      const t = textOf(m.content);
      const tc = tcById.get(m.toolCallId);
      if (tc) { tc.resultText = t; tc.isError = m.isError ?? false; }
      ctx.push({ id: `tr-${m.toolCallId}`, kind: "toolResult", chars: t.length, toolCallId: m.toolCallId, pruned: false });
      continue;
    }
    if (m.role !== "assistant") continue;
    const u = m.usage ?? {};

    // --- boundary between requests: the economic trigger fires here ---------------------
    if (strat.econ && fit) {
      const ids = candidates();
      if (ids.length) {
        const q = quote(ids);
        const promptNow = toTokens(ctx.reduce((s, it) => s + itemChars(it), 0));
        const forced = promptNow >= forceAt;
        const pays = q.R * args.priceCache * strat.N > q.S * (args.priceIn - args.priceCache);
        if (q.reclaimChars > 0 && (pays || forced)) {
          applyPrune(ids, q.sumLen, ids.length);
          summarized++;
          cuts.push({ call: calls.length, reason: forced ? "tier" : "econ", tools: ids.length,
            R: q.R, S: q.S, origChars: q.origChars, promptNow, remaining: undefined, chainRemaining: undefined });
        }
      }
    }

    // --- cost of this request ------------------------------------------------------------
    const aChars = ctx.reduce((s, it) => s + (it.kind === "summary" ? 0 : it.chars), 0);
    let bChars = 0, bAfterBust = 0, sumChars = 0;
    for (let i = 0; i < ctx.length; i++) {
      const c = itemChars(ctx[i]);
      bChars += c;
      if (ctx[i].kind === "summary") sumChars += c;
      if (bustPos !== null && i >= bustPos) bAfterBust += c;
    }
    calls.push({ idx, aChars, bChars, bAfterBust, sumChars, busted: bustPos !== null,
      input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, output: u.output ?? 0 });
    bustPos = null;

    // --- register the assistant message ---------------------------------------------------
    const toolCalls = (m.content ?? []).filter((c) => c && c.type === "toolCall");
    ctx.push({ id: e.id, kind: "assistant", chars: assistantChars(m) });
    const gb = pending.get(group) ?? { assistantTexts: [], toolCallIds: [] };
    gb.assistantTexts.push(textOf(m.content).trim());
    for (const c of toolCalls) {
      tcById.set(c.id, { toolCallId: c.id, toolName: c.name, args: c.arguments ?? c.input ?? c.args ?? {}, resultText: "(no result)", isError: false });
      gb.toolCallIds.push(c.id);
    }
    if (toolCalls.length) { pending.set(group, gb); toolTurns.push(toolCalls.map((c) => c.id)); }
    else if (fit && [...pending.values()].some((x) => x.toolCallIds.length)) flush();
  }
  for (const c of cuts) {
    if (c.remaining === undefined) c.remaining = calls.length - c.call;
    if (c.chainRemaining === undefined) c.chainRemaining = calls.length - c.call;
  }
  return { calls, cuts, skipped, summarized };
}

// --- costing -----------------------------------------------------------------------------
function cost(calls, fit, args, baselineInputs) {
  const toTokens = (chars) => Math.max(0, Math.round(fit.a + fit.b * chars));
  const t = { prompt: 0, uncached: 0, output: 0, usd: 0, usdNoTier: 0, tierCalls: 0, peak: 0, summaryTokensBilled: 0 };
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const realInput = baselineInputs[i];
    const T = toTokens(c.bChars);
    let U = c.busted ? Math.max(realInput, Math.round(fit.b * c.bAfterBust)) : realInput;
    U = Math.min(U, T);
    const cached = T - U;
    const base = (U * args.priceIn + cached * args.priceCache + c.output * args.priceOut) / 1e6;
    const mult = T >= args.tier ? 2 : 1;
    t.prompt += T; t.uncached += U; t.output += c.output;
    t.summaryTokensBilled += Math.round(fit.b * c.sumChars); // accumulated summary text re-sent every request
    t.usd += base * mult; t.usdNoTier += base;
    if (mult === 2) t.tierCalls++;
    if (T > t.peak) t.peak = T;
  }
  return t;
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = join(REPO, args.out);
  await mkdir(outDir, { recursive: true });
  if (!existsSync(args.calibration)) throw new Error(`calibration not found: ${args.calibration}`);
  const calib = JSON.parse(readFileSync(args.calibration, "utf8"));
  if (calib.training.resultCap !== args.resultCap) throw new Error("--result-cap must match the calibration's training cap");
  const prior = calib.summaryChars;
  const pi = await loadPi();
  const strategies = args.strategies.map(parseStrategy);
  const out = [];

  for (const file of args.sessions) {
    const entries = pi.loadEntriesFromFile(file);
    const path = activeBranch(entries);
    const livePruned = path.filter((e) => e.customType === "context-prune-summary").length;
    const tag = basename(file).slice(0, 19) + "_" + basename(dirname(file)).replace(/^--|--$/g, "").slice(0, 30);
    process.stderr.write(`replay ${tag} (${path.length} entries, livePruned=${livePruned})\n`);

    // baseline pass: unpruned context chars per request, used only for the chars -> tokens fit
    const base = pass(path, { name: "baseline", econ: false, stubOnly: false, N: 0 }, args, prior, null);
    const keepIdx = base.calls.map((c, i) => [c, i]).filter(([c]) => c.input + c.cacheRead + c.cacheWrite > 0).map(([, i]) => i);
    const fit = linearFit(keepIdx.map((i) => base.calls[i].aChars), keepIdx.map((i) => {
      const c = base.calls[i]; return c.input + c.cacheRead + c.cacheWrite;
    }));
    const realTotals = keepIdx.reduce((s, i) => {
      const c = base.calls[i];
      return { prompt: s.prompt + c.input + c.cacheRead + c.cacheWrite, uncached: s.uncached + c.input, output: s.output + c.output };
    }, { prompt: 0, uncached: 0, output: 0 });
    process.stderr.write(`  fit a=${Math.round(fit.a)} b=${fit.b.toFixed(4)} R2=${fit.r2.toFixed(4)} calls=${keepIdx.length}\n`);

    const perStrategy = {};
    for (const strat of strategies) {
      const r = pass(path, strat, args, prior, fit);
      const kept = keepIdx.map((i) => r.calls[i]);
      const baselineInputs = keepIdx.map((i) => base.calls[i].input);
      const c = cost(kept, fit, args, baselineInputs);
      const paid = (x, n) => x.R * args.priceCache * n > x.S * (args.priceIn - args.priceCache);
      const payback = r.cuts.filter((x) => paid(x, x.remaining)).length;
      const paybackChain = r.cuts.filter((x) => paid(x, x.chainRemaining)).length;
      perStrategy[strat.name] = {
        ...c, calls: kept.length, cuts: r.cuts.length, cutsEcon: r.cuts.filter((x) => x.reason === "econ").length,
        cutsTier: r.cuts.filter((x) => x.reason === "tier").length,
        medianR: median(r.cuts.map((x) => x.R)), medianS: median(r.cuts.map((x) => x.S)),
        medianRemaining: median(r.cuts.map((x) => x.remaining)), medianChainRemaining: median(r.cuts.map((x) => x.chainRemaining)),
        paybackCuts: payback, paybackShare: r.cuts.length ? +(payback / r.cuts.length).toFixed(4) : null,
        paybackChainCuts: paybackChain, paybackChainShare: r.cuts.length ? +(paybackChain / r.cuts.length).toFixed(4) : null,
        endOfRunPrunes: r.summarized - r.cuts.length, endOfRunSkipped: r.skipped,
      };
      await writeFile(join(outDir, `${tag}.${strat.name}.cuts.json`), JSON.stringify(r.cuts));
      process.stderr.write(`  ${strat.name.padEnd(14)} prompt=${c.prompt.toLocaleString()} uncached=${c.uncached.toLocaleString()} usd=${c.usd.toFixed(3)} (noTier ${c.usdNoTier.toFixed(3)}) cuts=${r.cuts.length} payback=${payback}\n`);
    }
    out.push({ file, tag, livePruned, calls: keepIdx.length, fit: { a: Math.round(fit.a), b: +fit.b.toFixed(4), r2: +fit.r2.toFixed(4) }, real: realTotals, strategies: perStrategy });
  }

  // aggregate
  const agg = {};
  for (const s of strategies) {
    const rows = out.map((o) => o.strategies[s.name]);
    const allCuts = [];
    for (const o of out) allCuts.push(...JSON.parse(readFileSync(join(outDir, `${o.tag}.${s.name}.cuts.json`), "utf8")));
    const paid = (x, n) => x.R * args.priceCache * n > x.S * (args.priceIn - args.priceCache);
    const payback = allCuts.filter((x) => paid(x, x.remaining)).length;
    const paybackChain = allCuts.filter((x) => paid(x, x.chainRemaining)).length;
    agg[s.name] = {
      prompt: rows.reduce((a, r) => a + r.prompt, 0), uncached: rows.reduce((a, r) => a + r.uncached, 0),
      usd: +rows.reduce((a, r) => a + r.usd, 0).toFixed(4), usdNoTier: +rows.reduce((a, r) => a + r.usdNoTier, 0).toFixed(4),
      tierCalls: rows.reduce((a, r) => a + r.tierCalls, 0), cuts: allCuts.length,
      summaryTokensBilled: rows.reduce((a, r) => a + r.summaryTokensBilled, 0),
      cutsEcon: allCuts.filter((x) => x.reason === "econ").length, cutsTier: allCuts.filter((x) => x.reason === "tier").length,
      medianR: median(allCuts.map((x) => x.R)), medianS: median(allCuts.map((x) => x.S)),
      medianRemaining: median(allCuts.map((x) => x.remaining)),
      medianChainRemaining: median(allCuts.map((x) => x.chainRemaining)),
      paybackCuts: payback, paybackShare: allCuts.length ? +(payback / allCuts.length).toFixed(4) : null,
      paybackChainCuts: paybackChain, paybackChainShare: allCuts.length ? +(paybackChain / allCuts.length).toFixed(4) : null,
      endOfRunPrunes: rows.reduce((a, r) => a + r.endOfRunPrunes, 0), endOfRunSkipped: rows.reduce((a, r) => a + r.endOfRunSkipped, 0),
      peak: Math.max(...rows.map((r) => r.peak)),
    };
  }
  const lines = ["| strategy | prompt tokens | uncached tokens | USD (tier) | USD (no tier) | cuts | econ/tier | median R | median S | median chain-left | payback (chain) | payback (session) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  const pct = (v) => (v === null ? "-" : (v * 100).toFixed(1) + "%");
  for (const s of strategies) {
    const a = agg[s.name];
    lines.push(`| ${s.name} | ${a.prompt.toLocaleString()} | ${a.uncached.toLocaleString()} | ${a.usd.toFixed(2)} | ${a.usdNoTier.toFixed(2)} | ${a.cuts} | ${a.cutsEcon}/${a.cutsTier} | ${a.medianR ?? "-"} | ${a.medianS ?? "-"} | ${a.medianChainRemaining ?? "-"} | ${pct(a.paybackChainShare)} | ${pct(a.paybackShare)} |`);
  }
  await writeFile(join(outDir, "summary.md"), lines.join("\n") + "\n");
  await writeFile(join(outDir, "results.json"), JSON.stringify({ args, calibrationSource: args.calibration, sessions: out, aggregate: agg }, null, 2));
  process.stdout.write(lines.join("\n") + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
