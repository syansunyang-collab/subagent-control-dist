import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export const agentDir = join(homedir(), '.pi/agent');
const here = dirname(fileURLToPath(import.meta.url));
const hash = s => createHash('sha256').update(s).digest('hex');
export function patchPage(source) {
  const importLine = 'import { rewriteCodexPayload } from "../../../extensions/openai-codex-sol-context-alias.ts";\n';
  const anchor = 'import type { ExtensionContext } from "@earendil-works/pi-coding-agent";\n';
  const oldOptions = '}, { apiKey: auth.apiKey, headers: auth.headers, signal, maxTokens: OUTPUT_TOKENS });';
  let next = source;
  if (!next.includes(importLine)) {
    if (!next.includes(anchor) || !next.includes(oldOptions)) throw new Error('Unrecognized page-query implementation');
    next = next.replace(anchor, anchor + importLine).replace(oldOptions,
      '}, { apiKey: auth.apiKey, headers: auth.headers, signal, maxTokens: OUTPUT_TOKENS, onPayload: payload => rewriteCodexPayload(payload, model) });');
  }
  if (!next.includes('getPageAnswerDefaults')) {
    const modelLine = 'const model = resolveModel(ctx, input.model);';
    if (!next.includes(modelLine) || !next.includes('signal, maxTokens: OUTPUT_TOKENS')) throw new Error('Unrecognized page-answer options');
    next = next.replace('import { complete,', 'import { completeSimple as complete,')
      .replace(anchor, anchor + 'import { getPageAnswerDefaults } from "./feature-config.ts";\n')
      .replace(modelLine, 'const defaults = getPageAnswerDefaults();\n\tconst model = resolveModel(ctx, input.model ?? defaults.model);')
      .replace('signal, maxTokens: OUTPUT_TOKENS', 'signal, reasoning: defaults.reasoning, maxTokens: OUTPUT_TOKENS');
  }
  const errorGuard = 'if (response.stopReason === "error") throw new Error(response.errorMessage || "Page answer model failed");';
  const lengthGuard = 'if (response.stopReason === "length") throw new Error("Page answer was truncated by the output limit");';
  if (!next.includes(lengthGuard)) {
    if (!next.includes(errorGuard)) throw new Error('Unrecognized page-answer completion guard');
    next = next.replace(errorGuard, errorGuard + '\n\t' + lengthGuard);
  }
  return next;
}
export function patchFeatures(source) {
  if (source.includes('export function getPageAnswerDefaults')) return source;
  const oldType = 'type FeatureConfig = { image?: { enabled?: unknown } };';
  if (!source.includes(oldType)) throw new Error('Unrecognized feature-config implementation');
  return source.replace(oldType, 'type FeatureConfig = { image?: { enabled?: unknown }; pageAnswer?: { model?: unknown; reasoning?: unknown } };')
    + '\n' + readFileSync(join(here, 'page-answer-config.inc'), 'utf8');
}
export function patchIndex(source) {
  const previous = 'Optional provider/model-id override for mode answer. Defaults to the current Pi model.';
  const current = 'Optional provider/model-id override for mode answer. Defaults to pageAnswer.model; reasoning uses pageAnswer.reasoning.';
  if (source.includes(current)) return source;
  if (!source.includes(previous)) throw new Error('Unrecognized answerModel description');
  return source.replace(previous, current);
}
export function apply(root = agentDir) {
  const pkg = join(root, 'npm/node_modules/pi-web-access');
  const pagePath = join(pkg, 'page-query.ts');
  const featurePath = join(pkg, 'feature-config.ts');
  const indexPath = join(pkg, 'index.ts');
  const aliasPath = join(root, 'extensions/openai-codex-sol-context-alias.ts');
  const page = readFileSync(pagePath, 'utf8');
  const feature = readFileSync(featurePath, 'utf8');
  const index = readFileSync(indexPath, 'utf8');
  // 别名扩展归控制仓，由控制仓 bootstrap 安装；这里只给网页问答接线。
  if (!existsSync(aliasPath)) throw new Error('Missing extensions/openai-codex-sol-context-alias.ts; run the control repo bootstrap first');
  const patchedPage = patchPage(page);
  const patchedFeature = patchFeatures(feature);
  const patchedIndex = patchIndex(index);
  if (feature !== patchedFeature) writeFileSync(featurePath, patchedFeature);
  if (page !== patchedPage) writeFileSync(pagePath, patchedPage);
  if (index !== patchedIndex) writeFileSync(indexPath, patchedIndex);
  return { changed: page !== patchedPage || feature !== patchedFeature || index !== patchedIndex, pageSha256: hash(patchedPage), featureSha256: hash(patchedFeature), aliasSha256: hash(readFileSync(aliasPath, 'utf8')) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(apply(), null, 2));
