#!/usr/bin/env node
/**
 * Replay Pi native compact() against frozen historical cut-points.
 *
 * Inputs: the CASES session JSONL files, the user-level Pi installation, and
 * provider credentials only when `run` calls models. `prepare` and `score` do
 * not call a provider. Outputs go to the ignored
 * test-results/compaction-quality-<date>/replay directory (override with --out).
 *
 * The script never mutates settings.json, source sessions, or live Pi state.
 * Missing inputs, model failures, and scoring errors exit non-zero.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
let OUT_DIR = join(REPO, "test-results", "compaction-quality-20260816", "replay");
const PI_ROOT = join(
  homedir(),
  "AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent",
);
const AGENT_DIR = join(homedir(), ".pi/agent");
const MIDRUN_INSTRUCTIONS =
  "Preserve the active user task, completed work, decisions, changed files, failures, pending tool-loop state, exact file paths, numeric results, and next steps so execution can resume immediately after compaction.";

const require = createRequire(join(PI_ROOT, "package.json"));

async function loadPi() {
  const compactionUrl = pathToFileURL(join(PI_ROOT, "dist/core/compaction/compaction.js")).href;
  const utilsUrl = pathToFileURL(join(PI_ROOT, "dist/core/compaction/utils.js")).href;
  const sessionUrl = pathToFileURL(join(PI_ROOT, "dist/core/session-manager.js")).href;
  const runtimeUrl = pathToFileURL(join(PI_ROOT, "dist/core/model-runtime.js")).href;
  const registryUrl = pathToFileURL(join(PI_ROOT, "dist/core/model-registry.js")).href;
  const [
    compaction,
    utils,
    session,
    runtimeMod,
    registryMod,
  ] = await Promise.all([
    import(compactionUrl),
    import(utilsUrl),
    import(sessionUrl),
    import(runtimeUrl),
    import(registryUrl),
  ]);
  return {
    prepareCompaction: compaction.prepareCompaction,
    compact: compaction.compact,
    DEFAULT_COMPACTION_SETTINGS: compaction.DEFAULT_COMPACTION_SETTINGS,
    computeFileLists: utils.computeFileLists,
    loadEntriesFromFile: session.loadEntriesFromFile,
    ModelRuntime: runtimeMod.ModelRuntime,
    ModelRegistry: registryMod.ModelRegistry,
  };
}

const CASES = [
  {
    id: "case1-iterative",
    title: "长会话迭代更新（旧摘要 + 新增量）",
    file: join(
      AGENT_DIR,
      "sessions/--E--Pi_Coding_Agent--/2026-08-07T21-19-16-309Z_019fde18-3555-72c7-acea-e0b9cbef66c0.jsonl",
    ),
    timestamp: "2026-08-11T17:53:59.162Z",
    tokensBefore: 298063,
  },
  {
    id: "case2-split-turn",
    title: "单轮 split-turn（Turn Context）",
    file: join(
      AGENT_DIR,
      "sessions/--E--ControlPlane--/2026-08-12T15-30-07-492Z_019ff698-5a04-70ca-9dd6-5e01a55716ce.jsonl",
    ),
    timestamp: "2026-08-12T15:41:31.979Z",
    tokensBefore: 261054,
  },
  {
    id: "case3-drift",
    title: "现网 0731 模板漂移切点",
    file: join(
      AGENT_DIR,
      "pi-web-sessions/2026-08-15T18-32-33-659Z_01a006b2-747b-7d89-9114-fcd3aa2283d4.jsonl",
    ),
    timestamp: "2026-08-15T18:02:01.166Z",
    tokensBefore: 251896,
  },
  {
    id: "case4-live-self",
    title: "本会话活体快照（压缩实验会话自身，无原始压缩锚点）",
    live: {
      file: join(
        REPO,
        "test-results/compaction-quality-20260911-live/case4-source-snapshot.jsonl",
      ),
    },
  },
];

const ARMS = {
  A: {
    id: "A",
    label: "sol-high",
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    thinkingLevel: "high",
  },
  B: {
    id: "B",
    label: "0731-high",
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4-flash-0731",
    thinkingLevel: "high",
  },
  C: {
    id: "C",
    label: "0731-off",
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4-flash-0731",
    thinkingLevel: "off",
  },
  D: {
    id: "D",
    label: "0731-xhigh",
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4-flash-0731",
    thinkingLevel: "xhigh",
  },
  E: {
    id: "E",
    label: "0731-high-preset",
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4-flash-0731@preset/pi-compaction-fp8",
    thinkingLevel: "high",
  },
  F: {
    id: "F",
    label: "v41-high-preset",
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4.1-flash@preset/pi-compaction-fp8",
    thinkingLevel: "high",
  },
  G: {
    id: "G",
    label: "ocgo-v4f-high",
    provider: "opencode-go",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "high",
  },
  H: {
    id: "H",
    label: "ocgo-v41-high",
    provider: "opencode-go",
    modelId: "deepseek-v4.1-flash",
    thinkingLevel: "high",
  },
  I: {
    id: "I",
    label: "ocgo-v4f-max",
    provider: "opencode-go",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "max",
    reserveTokens: 131072,
  },
  J: {
    id: "J",
    label: "ocgo-v41-max",
    provider: "opencode-go",
    modelId: "deepseek-v4.1-flash",
    thinkingLevel: "max",
    reserveTokens: 131072,
  },
  K: {
    id: "K",
    label: "ocgo-v4f-high-r128k",
    provider: "opencode-go",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "high",
    reserveTokens: 131072,
  },
  L: {
    id: "L",
    label: "ocgo-v41-high-r128k",
    provider: "opencode-go",
    modelId: "deepseek-v4.1-flash",
    thinkingLevel: "high",
    reserveTokens: 131072,
  },
  M: {
    id: "M",
    label: "ocgo-v41-max-r16k",
    provider: "opencode-go",
    modelId: "deepseek-v4.1-flash",
    thinkingLevel: "max",
  },
};

function parseArgs(argv) {
  const args = {
    cmd: "prepare",
    cases: CASES.map((c) => c.id),
    arms: ["A", "B", "C"],
  };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) {
    args.cmd = rest.shift();
  }
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--cases" && rest[i + 1]) {
      args.cases = rest[++i].split(",").map((s) => {
        const raw = s.trim();
        if (/^\d+$/.test(raw)) return CASES[Number(raw) - 1]?.id ?? raw;
        if (/^case\d+$/i.test(raw)) {
          const n = Number(raw.slice(4));
          return CASES[n - 1]?.id ?? raw;
        }
        return raw;
      });
    } else if (token === "--arms" && rest[i + 1]) {
      args.arms = rest[++i].split(",").map((s) => s.trim().toUpperCase());
    } else if (token === "--out" && rest[i + 1]) {
      args.out = rest[++i];
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function buildSessionPath(entries, leafId) {
  const index = new Map();
  for (const entry of entries) {
    if (entry?.id) index.set(entry.id, entry);
  }
  const leaf = index.get(leafId);
  if (!leaf) return [];
  const path = [];
  let current = leaf;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    path.push(current);
    seen.add(current.id);
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

function findCompaction(entries, spec) {
  const hits = entries.filter(
    (entry) =>
      entry?.type === "compaction" &&
      entry.timestamp === spec.timestamp &&
      entry.tokensBefore === spec.tokensBefore,
  );
  if (hits.length === 0) {
    throw new Error(`No compaction ${spec.timestamp} tokensBefore=${spec.tokensBefore} in ${spec.file}`);
  }
  if (hits.length > 1) {
    throw new Error(`Ambiguous compaction locator in ${spec.file}: ${hits.length} hits`);
  }
  return hits[0];
}

function restorePreviousFileOperations(preparation, branchEntries) {
  const previous = [...branchEntries].reverse().find((entry) => entry.type === "compaction");
  if (!previous || typeof previous.details !== "object" || previous.details === null) {
    return { restored: false, addedRead: 0, addedModified: 0 };
  }
  const details = previous.details;
  let addedRead = 0;
  let addedModified = 0;
  if (Array.isArray(details.readFiles)) {
    for (const path of details.readFiles) {
      if (typeof path === "string" && !preparation.fileOps.read.has(path)) {
        preparation.fileOps.read.add(path);
        addedRead += 1;
      }
    }
  }
  if (Array.isArray(details.modifiedFiles)) {
    for (const path of details.modifiedFiles) {
      if (typeof path === "string" && !preparation.fileOps.edited.has(path)) {
        preparation.fileOps.edited.add(path);
        addedModified += 1;
      }
    }
  }
  return { restored: true, addedRead, addedModified };
}

function messageStats(messages) {
  let chars = 0;
  let toolResults = 0;
  for (const message of messages) {
    if (message?.role === "toolResult") toolResults += 1;
    const content = message?.content;
    if (typeof content === "string") chars += content.length;
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block?.text === "string") chars += block.text.length;
        else chars += JSON.stringify(block ?? {}).length;
      }
    } else if (content) {
      chars += JSON.stringify(content).length;
    }
  }
  return { count: messages.length, chars, toolResults };
}

function headingList(text) {
  return [...text.matchAll(/^#{1,3} .+$/gm)].map((m) => m[0]);
}

function hasHeading(text, title) {
  return new RegExp(`^## ${title}\\s*$`, "m").test(text);
}

function extractFacts(text) {
  const paths = new Set(
    (text.match(/[A-Za-z]:\\[^\s`"'<>\]]+/g) ?? []).map((s) => s.replace(/[),.;]+$/, "")),
  );
  const hashes = new Set((text.match(/\b[0-9a-f]{7,40}\b/g) ?? []).filter((h) => /[a-f]/.test(h)));
  const taskIds = new Set(text.match(/\basync-codex-[0-9T:.-]+Z-[0-9a-f]+\b/g) ?? []);
  return { paths, hashes, taskIds };
}

function toLocalIso(ts) {
  const date = new Date(ts);
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().replace("T", " ").replace("Z", " UTC+8");
}

async function prepareCase(pi, spec) {
  const file = spec.live ? spec.live.file : spec.file;
  if (!existsSync(file)) {
    throw new Error(`Missing session file: ${file}`);
  }
  const entries = pi.loadEntriesFromFile(file);
  let original = null;
  let tipId;
  if (spec.live) {
    const referenced = new Set(entries.map((e) => e?.parentId).filter(Boolean));
    const leaves = entries.filter((e) => e?.id && !referenced.has(e.id));
    leaves.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const tip = leaves[leaves.length - 1];
    if (!tip) throw new Error(`${spec.id}: no leaf entry in ${file}`);
    tipId = tip.id;
  } else {
    original = findCompaction(entries, spec);
    if (!original.parentId) {
      throw new Error(`${spec.id}: compaction ${original.id} has no parentId`);
    }
    tipId = original.parentId;
  }
  const pathEntries = buildSessionPath(entries, tipId);
  if (pathEntries.length === 0) {
    throw new Error(`${spec.id}: empty branch for tip=${tipId}`);
  }
  const preparation = pi.prepareCompaction(pathEntries, pi.DEFAULT_COMPACTION_SETTINGS);
  if (!preparation) {
    throw new Error(`${spec.id}: prepareCompaction returned undefined`);
  }
  const restore = restorePreviousFileOperations(preparation, pathEntries);
  const files = pi.computeFileLists(preparation.fileOps);
  const history = messageStats(preparation.messagesToSummarize);
  const prefix = messageStats(preparation.turnPrefixMessages);
  return {
    spec,
    original,
    pathEntries,
    preparation,
    restore,
    files,
    history,
    prefix,
    meta: {
      caseId: spec.id,
      title: spec.title,
      file,
      original: original
        ? {
            id: original.id,
            parentId: original.parentId,
            timestamp: original.timestamp,
            timestampLocal: toLocalIso(original.timestamp),
            fromHook: original.fromHook ?? false,
            tokensBefore: original.tokensBefore,
            firstKeptEntryId: original.firstKeptEntryId,
            summaryChars: (original.summary ?? "").length,
            usage: original.usage ?? null,
            headings: headingList(original.summary ?? ""),
          }
        : null,
      liveTip: spec.live ? tipId : undefined,
      prepared: {
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId: preparation.firstKeptEntryId,
        isSplitTurn: preparation.isSplitTurn,
        hasPreviousSummary: Boolean(preparation.previousSummary),
        previousSummaryChars: preparation.previousSummary?.length ?? 0,
        history,
        prefix,
        files: {
          read: files.readFiles.length,
          modified: files.modifiedFiles.length,
        },
        restore,
        firstKeptMatchesOriginal: original
          ? preparation.firstKeptEntryId === original.firstKeptEntryId
          : undefined,
      },
    },
  };
}

function prepJson(prepared) {
  return {
    ...prepared.meta,
    customInstructions: MIDRUN_INSTRUCTIONS,
    readFiles: prepared.files.readFiles,
    modifiedFiles: prepared.files.modifiedFiles,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function ensureOutDir() {
  await mkdir(OUT_DIR, { recursive: true });
}

async function cmdPrepare(pi, caseIds) {
  await ensureOutDir();
  const rows = [];
  for (const id of caseIds) {
    const spec = CASES.find((c) => c.id === id);
    if (!spec) throw new Error(`Unknown case ${id}`);
    process.stderr.write(`prepare ${id} ...\n`);
    const prepared = await prepareCase(pi, spec);
    const out = join(OUT_DIR, `${id}-prep.json`);
    await writeJson(out, prepJson(prepared));
    rows.push(prepared.meta);
    process.stderr.write(
      `  original firstKept=${prepared.meta.original?.firstKeptEntryId ?? "(live 无锚点)"} tokens=${prepared.meta.original?.tokensBefore ?? prepared.meta.prepared.tokensBefore} hook=${prepared.meta.original?.fromHook ?? "n/a"}\n`,
    );
    process.stderr.write(
      `  replay   firstKept=${prepared.meta.prepared.firstKeptEntryId} tokens=${prepared.meta.prepared.tokensBefore} split=${prepared.meta.prepared.isSplitTurn} match=${prepared.meta.prepared.firstKeptMatchesOriginal}\n`,
    );
    process.stderr.write(
      `  history msgs=${prepared.history.count} chars=${prepared.history.chars} prefix msgs=${prepared.prefix.count} chars=${prepared.prefix.chars}\n`,
    );
  }
  return rows;
}

async function resolveArm(pi, arm) {
  const runtime = await pi.ModelRuntime.create({
    authPath: join(AGENT_DIR, "auth.json"),
    modelsStorePath: join(AGENT_DIR, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const registry = new pi.ModelRegistry(runtime);
  const model = registry.find(arm.provider, arm.modelId);
  if (!model) {
    throw new Error(`Model not found: ${arm.provider}/${arm.modelId}`);
  }
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`Auth failed for ${arm.provider}/${arm.modelId}: ${auth.error}`);
  }
  if (arm.provider === "opencode-go" || model.provider === "opencode-go") {
    const sessionId = randomUUID();
    auth.headers = {
      ...auth.headers,
      "x-opencode-session": sessionId,
      "x-opencode-client": "pi",
      "User-Agent": "pi-coding-agent/0.85.1",
    };
    auth.sessionId = sessionId;
  }
  return { runtime, registry, model, auth };
}

function usageView(usage) {
  if (!usage || typeof usage !== "object") return null;
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : {};
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    reasoning: usage.reasoning ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    costTotal: cost.total ?? null,
    cost,
  };
}

async function runArm(pi, prepared, arm, timeoutMs) {
  const resolved = await resolveArm(pi, arm);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const preparation = arm.reserveTokens
    ? {
        ...prepared.preparation,
        settings: {
          ...prepared.preparation.settings,
          reserveTokens: arm.reserveTokens,
        },
      }
    : prepared.preparation;
  try {
    const result = await pi.compact(
      preparation,
      resolved.model,
      resolved.auth.apiKey,
      resolved.auth.headers,
      MIDRUN_INSTRUCTIONS,
      controller.signal,
      arm.thinkingLevel,
      undefined,
      resolved.auth.env,
      undefined,
      undefined,
      resolved.auth.sessionId,
    );
    return {
      ok: true,
      arm: arm.id,
      label: arm.label,
      provider: arm.provider,
      modelId: arm.modelId,
      thinkingLevel: arm.thinkingLevel,
      wallMs: Date.now() - started,
      firstKeptEntryId: result.firstKeptEntryId,
      tokensBefore: result.tokensBefore,
      usage: usageView(result.usage),
      details: result.details ?? null,
      summary: result.summary ?? "",
    };
  } catch (error) {
    return {
      ok: false,
      arm: arm.id,
      label: arm.label,
      provider: arm.provider,
      modelId: arm.modelId,
      thinkingLevel: arm.thinkingLevel,
      wallMs: Date.now() - started,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function markdownReport(prepared, result) {
  const lines = [
    `# ${prepared.spec.id} / ${result.arm} ${result.label}`,
    "",
    `- case: ${prepared.spec.title}`,
    `- model: ${result.provider}/${result.modelId}`,
    `- thinkingLevel: ${result.thinkingLevel}`,
    `- wallMs: ${result.wallMs}`,
    `- ok: ${result.ok}`,
    `- original compaction: ${prepared.original ? `${prepared.original.id} @ ${prepared.meta.original.timestampLocal}` : "(live 快照，无原始压缩锚点）"}`,
    `- original fromHook: ${prepared.meta.original?.fromHook ?? "n/a"}`,
    `- firstKept replay/original: ${result.firstKeptEntryId ?? prepared.preparation.firstKeptEntryId} / ${prepared.original?.firstKeptEntryId ?? "n/a"}`,
    `- tokensBefore replay/original: ${result.tokensBefore ?? prepared.preparation.tokensBefore} / ${prepared.original?.tokensBefore ?? "n/a"}`,
  ];
  if (result.usage) {
    lines.push(
      `- usage: in=${result.usage.input} out=${result.usage.output} reasoning=${result.usage.reasoning} total=${result.usage.totalTokens} cost=${result.usage.costTotal}`,
    );
  }
  if (!result.ok) {
    lines.push("", "## Error", "", "```", result.error, "```");
    return `${lines.join("\n")}\n`;
  }
  lines.push("", "## Summary", "", result.summary);
  return `${lines.join("\n")}\n`;
}

async function cmdRun(pi, caseIds, armIds) {
  await ensureOutDir();
  const timeoutMs = 12 * 60 * 1000;
  const results = [];
  for (const id of caseIds) {
    const spec = CASES.find((c) => c.id === id);
    if (!spec) throw new Error(`Unknown case ${id}`);
    process.stderr.write(`\n=== prepare ${id} ===\n`);
    const prepared = await prepareCase(pi, spec);
    await writeJson(join(OUT_DIR, `${id}-prep.json`), prepJson(prepared));
    const jobs = armIds.map((armId) => {
      const arm = ARMS[armId];
      if (!arm) throw new Error(`Unknown arm ${armId}`);
      return { arm, stamp: new Date().toISOString() };
    });
    process.stderr.write(`run ${id} arms=${jobs.map((j) => j.arm.id).join(",")} in parallel\n`);
    const armResults = await Promise.all(
      jobs.map(async ({ arm, stamp }) => {
        process.stderr.write(`  start ${id} ${arm.id} ${arm.label} @ ${stamp}\n`);
        const result = await runArm(pi, prepared, arm, timeoutMs);
        const stored = { ...result };
        delete stored.summary;
        stored.summaryChars = result.summary?.length ?? 0;
        stored.headings = result.ok ? headingList(result.summary) : [];
        stored.startedAt = stamp;
        const base = join(OUT_DIR, `${id}-${arm.id}-${arm.label}`);
        await writeFile(`${base}.md`, markdownReport(prepared, result), "utf8");
        await writeJson(`${base}.json`, stored);
        if (result.ok) {
          process.stderr.write(
            `  ok ${id} ${arm.id} wall=${result.wallMs}ms sum=${result.summary.length} in=${result.usage?.input} out=${result.usage?.output} rea=${result.usage?.reasoning} cost=${result.usage?.costTotal}\n`,
          );
        } else {
          process.stderr.write(`  FAIL ${id} ${arm.id} ${result.error}\n`);
        }
        return stored;
      }),
    );
    results.push(...armResults);
  }
  await writeJson(join(OUT_DIR, "run-index.json"), {
    finishedAt: new Date().toISOString(),
    results,
  });
  return results;
}

function scoreTemplate(summary) {
  const required = [
    "Goal",
    "Constraints & Preferences",
    "Progress",
    "Key Decisions",
    "Next Steps",
    "Critical Context",
  ];
  const present = required.filter((title) => hasHeading(summary, title));
  const invented = headingList(summary).filter((line) => {
    if (!line.startsWith("## ")) return false;
    const title = line.slice(3).trim();
    return ![
      "Goal",
      "Constraints & Preferences",
      "Progress",
      "Key Decisions",
      "Next Steps",
      "Critical Context",
      "Original Request",
      "Early Progress",
      "Context for Suffix",
    ].includes(title);
  });
  const dumpedConversation = summary.includes("<conversation>") || /\[User\]:/.test(summary);
  return {
    present,
    missing: required.filter((title) => !present.includes(title)),
    invented,
    dumpedConversation,
    templateScore: Math.max(0, present.length * (8 / 6) - invented.length * 2 - (dumpedConversation ? 8 : 0)),
  };
}

function overlapScore(gold, got, max) {
  if (gold.size === 0) return { hit: 0, total: 0, extra: 0, score: max };
  let hit = 0;
  for (const item of gold) if (got.has(item)) hit += 1;
  let extra = 0;
  for (const item of got) if (!gold.has(item)) extra += 1;
  const recall = hit / gold.size;
  const penalty = Math.min(1, extra / Math.max(1, gold.size));
  return {
    hit,
    total: gold.size,
    extra,
    score: Math.max(0, max * recall - max * 0.5 * penalty),
  };
}

async function cmdScore(caseIds) {
  await ensureOutDir();
  const lines = [
    "# Compaction replay scorecard",
    "",
    `生成时间：${new Date().toISOString()} （文件内 UTC；汇报请换算 UTC+8）`,
    "",
  ];
  for (const id of caseIds) {
    const prepPath = join(OUT_DIR, `${id}-prep.json`);
    if (!existsSync(prepPath)) {
      lines.push(`## ${id}`, "", "缺少 prep.json，先跑 prepare/run。", "");
      continue;
    }
    const prep = JSON.parse(await readFile(prepPath, "utf8"));
    const pi = await loadPi();
    const spec = CASES.find((c) => c.id === id);
    const prepared = await prepareCase(pi, spec);
    const goldText = [
      prepared.original?.summary ?? "",
      prepared.preparation.previousSummary ?? "",
      ...prepared.files.readFiles,
      ...prepared.files.modifiedFiles,
    ].join("\n");
    const gold = extractFacts(goldText);
    gold.paths = new Set([...gold.paths, ...prepared.files.readFiles, ...prepared.files.modifiedFiles]);
    lines.push(`## ${id}`, "", prep.title, "");
    lines.push(
      prep.original
        ? `- original ${prep.original.timestampLocal} hook=${prep.original.fromHook} sum=${prep.original.summaryChars} firstKeptMatch=${prep.prepared.firstKeptMatchesOriginal}`
        : `- live 快照：无原始压缩锚点；tip=${prep.liveTip ?? "?"} tokensBefore=${prep.prepared.tokensBefore}`,
    );
    lines.push("");
    lines.push("| 臂 | 模板齐全 | 自造标题 | 回灌原文 | 路径 hit/gold/extra | hash hit/gold/extra | 字数 | 费用 | 耗时 |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const armId of Object.keys(ARMS)) {
      const arm = ARMS[armId];
      const resultPath = join(OUT_DIR, `${id}-${arm.id}-${arm.label}.json`);
      const mdPath = join(OUT_DIR, `${id}-${arm.id}-${arm.label}.md`);
      if (!existsSync(resultPath) || !existsSync(mdPath)) {
        lines.push(`| ${armId} ${arm.label} | — | — | — | 未跑 | 未跑 | — | — | — |`);
        continue;
      }
      const meta = JSON.parse(await readFile(resultPath, "utf8"));
      if (!meta.ok) {
        lines.push(`| ${armId} ${arm.label} | FAIL | | | ${meta.error} | | | | ${meta.wallMs}ms |`);
        continue;
      }
      const md = await readFile(mdPath, "utf8");
      const summary = md.split("\n## Summary\n\n").slice(1).join("\n## Summary\n\n");
      const template = scoreTemplate(summary);
      const facts = extractFacts(summary);
      const pathScore = overlapScore(gold.paths, facts.paths, 8);
      const hashScore = overlapScore(gold.hashes, facts.hashes, 8);
      lines.push(
        `| ${armId} ${arm.label} | ${template.present.length}/6 | ${template.invented.length} | ${template.dumpedConversation} | ${pathScore.hit}/${pathScore.total}/${pathScore.extra} | ${hashScore.hit}/${hashScore.total}/${hashScore.extra} | ${summary.length} | ${meta.usage?.costTotal ?? "?"} | ${(meta.wallMs / 1000).toFixed(1)}s |`,
      );
    }
    lines.push("");
  }
  const out = join(OUT_DIR, "scorecard.md");
  await writeFile(out, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`${lines.join("\n")}\n`);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!["prepare", "run", "score"].includes(args.cmd)) {
    throw new Error(`Usage: node tools/compaction-replay.mjs prepare|run|score [--cases 3] [--arms A,B,C] [--out dir]`);
  }
  if (args.out) {
    OUT_DIR = isAbsolute(args.out) ? args.out : join(REPO, args.out);
  }
  process.stderr.write(`piRoot=${PI_ROOT}\nout=${OUT_DIR}\ncmd=${args.cmd} cases=${args.cases.join(",")} arms=${args.arms.join(",")}\n`);
  if (args.cmd === "score") {
    await cmdScore(args.cases);
    return;
  }
  const pi = await loadPi();
  if (args.cmd === "prepare") {
    await cmdPrepare(pi, args.cases);
    return;
  }
  await cmdRun(pi, args.cases, args.arms);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
