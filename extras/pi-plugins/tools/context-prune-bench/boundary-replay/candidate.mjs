// The installed production selection functions remain the sole eligibility oracle.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const policy = await import(pathToFileURL(path.resolve('tmp/context-prune-pause-fix/dist/lab-exports.js')));
const { collectLabToolTurns, selectLabCandidates } = policy;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function choose({ input, successfulInputs, branch, seenIds, visibleIds, releasedIds,
  triggerTokens = 6000, keepRecentToolTurns = 2 }) {
  const turns = collectLabToolTurns(branch);
  const options = { seenIds, visibleIds, releasedIds, keepRecentToolTurns,
    excludeToolNames: ['context_tree_query'], triggerTokens };
  const baseline = selectLabCandidates(turns, options);
  if (!baseline.toolCalls.length || baseline.rawTokens < triggerTokens)
    return { reason: 'production-threshold-or-protection', selected: [] };
  // Historical boundaries must be a byte-identical prefix of an already successful
  // request in THIS arm. No speculative seed, and never a future request.
  const boundaries = successfulInputs.flatMap((past, requestIndex) => {
    if (!past || !Array.isArray(past.input) || !equal(past.settings, input.settings)) return [];
    let end = 0;
    while (end < Math.min(past.input.length, input.input.length) && equal(past.input[end], input.input[end])) end++;
    return end ? [{ end, requestIndex }] : [];
  }).sort((a, b) => b.end - a.end);
  if (!boundaries.length) return { reason: 'no-matching-successful-prefix', selected: [] };
  const allowed = new Set(baseline.toolCalls.map(c => c.toolCallId));
  for (const boundary of boundaries) {
    // The whole assistant tool call and its output must be after the boundary.
    const ids = new Set(input.input.slice(boundary.end).filter(x =>
      ['function_call_output', 'custom_tool_call_output'].includes(x.type)).map(x => x.call_id));
    const eligible = new Set([...ids].filter(id => allowed.has(id)));
    const selection = selectLabCandidates(turns, { ...options, visibleIds: new Set([...visibleIds].filter(id => eligible.has(id))) });
    if (selection.toolCalls.length && selection.rawTokens >= triggerTokens) {
      return { reason: 'selected', boundary, selected: selection.toolCalls.map(c => c.toolCallId),
        rawTokens: selection.rawTokens, retainedItems: boundary.end };
    }
  }
  return { reason: 'no-eligible-batch-behind-matching-boundary', selected: [],
    longestMatchingItems: boundaries[0].end, productionRawTokens: baseline.rawTokens };
}
export function productionChoice({ branch, seenIds, visibleIds, releasedIds, triggerTokens = 6000,
  keepRecentToolTurns = 2 }) {
  const selection = selectLabCandidates(collectLabToolTurns(branch), { seenIds, visibleIds, releasedIds,
    keepRecentToolTurns, excludeToolNames: ['context_tree_query'], triggerTokens });
  return selection.rawTokens >= triggerTokens ? selection.toolCalls.map(c => c.toolCallId) : [];
}
