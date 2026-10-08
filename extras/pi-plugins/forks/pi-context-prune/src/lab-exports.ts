/**
 * Test-facing bundle entry.
 *
 * `node --test` cannot import `src/lab-policy.ts` / `src/lab-config.ts` directly
 * because their `.js` import specifiers are not rewritten by node's type
 * stripping. This module re-exports the pure lab surface so `build:lab` can
 * produce `dist/lab-exports.js` for the offline unit tests. It is never loaded
 * by the extension entry point.
 */
export * from "./lab-policy.js";
export * from "./lab-config.js";
export * from "./token-count.js";
export { serializeBatchForSummarizer } from "./batch-capture.js";
