/**
 * Token accounting for replacement decisions.
 *
 * Copied from the verified mid-run watermark tree
 * (`tmp/context-prune-bench/pi-context-prune-progress/src/token-count.ts`) so the policy lab can
 * reuse the same algorithm without a cross-tree import. Same encoding (o200k_base), same ledger
 * shape, same skip rule: a replacement is applied only when it saves tokens.
 */
import { encode } from "gpt-tokenizer/encoding/o200k_base";

/** Encoding used for every replacement measurement in this tree. */
export const REPLACEMENT_TOKEN_ENCODING = "o200k_base";

/**
 * Counts the tokens a text costs in the replacement encoding.
 * Returns 0 for empty/undefined input so callers can sum without guards.
 */
export function countTextTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return encode(text, { disallowedSpecial: new Set() }).length;
}

/** Token ledger for one replacement decision. */
export interface ReplacementLedger {
  rawTokens: number;
  stubTokens: number;
  summaryTokens: number;
  /** Tokens saved by the replacement; <= 0 means the replacement is not worth applying. */
  netTokens: number;
}

/** Measures raw text, the replacement receipt, and the summary against each other. */
export function evaluateReplacementNet(input: {
  rawTexts: readonly string[];
  stubTexts: readonly string[];
  summaryText: string;
}): ReplacementLedger {
  const rawTokens = input.rawTexts.reduce((sum, text) => sum + countTextTokens(text), 0);
  const stubTokens = input.stubTexts.reduce((sum, text) => sum + countTextTokens(text), 0);
  const summaryTokens = countTextTokens(input.summaryText);
  return {
    rawTokens,
    stubTokens,
    summaryTokens,
    netTokens: rawTokens - stubTokens - summaryTokens,
  };
}

/** True when the ledger shows no saving, so the raw text must stay. */
export function shouldSkipOversizedReplacement(ledger: ReplacementLedger): boolean {
  return ledger.netTokens <= 0;
}
