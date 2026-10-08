/**
 * Experiment config for the policy-lab entry point.
 *
 * Read-only: the lab never writes this file. Resolution order is
 *   $PI_CODING_AGENT_DIR/context-prune/policy-lab.json
 *   $HOME/.pi/agent/context-prune/policy-lab.json
 *   <getAgentDir()>/context-prune/policy-lab.json
 * so an isolated driver can point the lab at its own agent dir with either
 * PI_CODING_AGENT_DIR or HOME. Missing or broken configuration falls back to
 * cold-mask without summaries; the loader reports the cause once at startup.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, SUMMARIZER_THINKING_LEVELS, type ContextPruneConfig, type SummarizerThinking } from "./types.js";
import {
  DEFAULT_COMPACTION_HOLD_RATIO,
  DEFAULT_KEEP_RECENT_TOOL_TURNS,
  DEFAULT_PRICE_LINE_RATIO,
  DEFAULT_PRICE_LINES,
  DEFAULT_TRIGGER_TOKENS,
  LAB_MODES,
  type LabMode,
} from "./lab-policy.js";

export interface LabConfig {
  /** Release policy under test. */
  mode: LabMode;
  /** Releasable raw tokens that trigger one release round. */
  triggerTokens: number;
  /** Newest complete tool turns that are never released. */
  keepRecentToolTurns: number;
  /** Summarizer model ("default" = active model, or "provider/model-id"). */
  summarizerModel: string;
  /** Thinking level requested from the summarizer. */
  summarizerThinking: SummarizerThinking;
  /** Per-result character cap shown to the summarizer (0 disables the cap). */
  summarizerMaxCharsPerResult: number;
  /** Share of the active model's price line at which every old result is released (0 disables). */
  priceLineRatio: number;
  /** "provider/model-id" pattern -> request input size billed at a higher rate. */
  priceLines: Record<string, number>;
  /** cold-mask: no new release while Pi's context usage is at or above this share of the window (0 disables). */
  compactionHoldRatio: number;
  /** cold-mask: summarize the results released in a user turn when the turn ends. */
  stageSummary: boolean;
}

export const DEFAULT_LAB_CONFIG: LabConfig = {
  mode: "budget-summary",
  triggerTokens: DEFAULT_TRIGGER_TOKENS,
  keepRecentToolTurns: DEFAULT_KEEP_RECENT_TOOL_TURNS,
  summarizerModel: DEFAULT_CONFIG.summarizerModel,
  summarizerThinking: DEFAULT_CONFIG.summarizerThinking,
  summarizerMaxCharsPerResult: DEFAULT_CONFIG.summarizerMaxCharsPerResult,
  priceLineRatio: DEFAULT_PRICE_LINE_RATIO,
  priceLines: { ...DEFAULT_PRICE_LINES },
  compactionHoldRatio: DEFAULT_COMPACTION_HOLD_RATIO,
  stageSummary: true,
};

/** Config file candidates, most specific first. */
export function labConfigPaths(): string[] {
  const paths: string[] = [];
  const agentDirOverride = process.env.PI_CODING_AGENT_DIR;
  if (agentDirOverride) paths.push(join(agentDirOverride, "context-prune", "policy-lab.json"));
  if (process.env.HOME) paths.push(join(process.env.HOME, ".pi", "agent", "context-prune", "policy-lab.json"));
  paths.push(join(getAgentDir(), "context-prune", "policy-lab.json"));
  return [...new Set(paths)];
}

export const SAFE_LAB_CONFIG: LabConfig = { ...DEFAULT_LAB_CONFIG, mode: "cold-mask", stageSummary: false };

/** Validates one raw JSON object into a LabConfig, field by field. */
export function normalizeLabConfig(raw: unknown): LabConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected a configuration object");
  const source = raw as Record<string, unknown>;
  for (const [field, value] of Object.entries(source)) {
    let valid = false;
    switch (field) {
      case "mode": valid = LAB_MODES.includes(value as LabMode); break;
      case "summarizerThinking": valid = SUMMARIZER_THINKING_LEVELS.some(level => level.value === value); break;
      case "summarizerModel": valid = typeof value === "string" && value.trim().length > 0; break;
      case "stageSummary": valid = typeof value === "boolean"; break;
      case "triggerTokens": valid = typeof value === "number" && Number.isFinite(value) && value >= 1; break;
      case "keepRecentToolTurns":
      case "summarizerMaxCharsPerResult": valid = typeof value === "number" && Number.isFinite(value) && value >= 0; break;
      case "priceLineRatio":
      case "compactionHoldRatio": valid = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; break;
      case "priceLines":
        valid = !!value && typeof value === "object" && !Array.isArray(value)
          && Object.keys(value).length > 0 && Object.entries(value).every(([pattern, tokens]) =>
            pattern.length > 0 && typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 1);
        break;
    }
    if (!valid) throw new Error(`invalid field: ${field}`);
  }
  const config = { ...DEFAULT_LAB_CONFIG, ...source } as LabConfig;
  return {
    ...config,
    triggerTokens: Math.floor(config.triggerTokens),
    keepRecentToolTurns: Math.floor(config.keepRecentToolTurns),
    summarizerMaxCharsPerResult: Math.floor(config.summarizerMaxCharsPerResult),
    priceLines: Object.fromEntries(Object.entries(config.priceLines).map(([pattern, tokens]) => [pattern, Math.floor(tokens)])),
  };
}

/** Loads and validates once; missing/broken config never enables summarizer requests. */
export async function loadLabConfig(): Promise<{ config: LabConfig; path: string | null; warning: string | null }> {
  const fallback = (path: string | null, reason: string) => ({
    config: SAFE_LAB_CONFIG, path,
    warning: `policy-lab: ${path ?? "configuration"}: ${reason}; using cold-mask without summaries`,
  });
  for (const path of labConfigPaths()) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return fallback(path, `read-failed (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return fallback(path, `syntax-error (${error instanceof Error ? error.message : String(error)})`);
    }
    try {
      return { config: normalizeLabConfig(raw), path, warning: null };
    } catch (error) {
      return fallback(path, `invalid-fields (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return fallback(null, "missing (no policy-lab.json found)");
}

/** Config shape expected by the reused summarizer. */
export function toSummarizerConfig(lab: LabConfig): ContextPruneConfig {
  return {
    ...DEFAULT_CONFIG,
    enabled: true,
    summarizerModel: lab.summarizerModel,
    summarizerThinking: lab.summarizerThinking,
    summarizerMaxCharsPerResult: lab.summarizerMaxCharsPerResult,
  };
}
