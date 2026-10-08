import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value ?? 'null').digest('hex');
export const text = value => ({ type: 'text', text: value });
export const user = (content, timestamp) => ({ role: 'user', content, timestamp });
export const tool = { name: 'fixed_observation', description: 'Return a fixed synthetic observation.', parameters: { type: 'object', properties: {}, required: [] } };
// The independent early prefix is present before the large toolResult and never replaced.
export const prefix = 'Use fixed_observation once when asked. Use the supplied observation for later answers.\n' +
  Array.from({ length: 1800 }, (_, i) => `reference-${i.toString(36).padStart(4, '0')} amber cedar quartz delta; preserve this reference.\n`).join('');
export const observation = Array.from({ length: 2400 }, (_, i) => `observation-${i.toString(36).padStart(4, '0')} amber cedar quartz delta`).join('\n');
export const context = messages => ({ systemPrompt: prefix, tools: [tool], messages });
export const opening = [user('Invoke fixed_observation now.', 2)];
export const makeHistory = call => {
  const actualCall = call?.content.find(part => part.type === 'toolCall' && part.name === tool.name);
  if (!actualCall) return null;
  const result = { role: 'toolResult', toolCallId: actualCall.id, toolName: tool.name,
    content: [text(observation)], isError: false, timestamp: 3 };
  return [...opening, call, result];
};
export const prune = history => history.map((message, index) => index === 2
  ? { ...message, content: [text('[synthetic prune: fixed observation replaced]')] } : message);

// Inspect raw outbound frames only in memory; log fingerprints and positions, not prompt content.
export function auditFrames(frames, groups) {
  const errors = [];
  const baseline = frames[0];
  const prefixBytes = Buffer.byteLength(baseline?.instructions ?? '');
  const prefixHash = digest(baseline?.instructions ?? '');
  const toolsHash = digest(JSON.stringify(baseline?.tools));
  const row = frames.map((frame, index) => {
    const previous = index > 0 ? frames[index - 1] : null;
    const firstInputDifference = previous ? Array.from({ length: Math.max(previous.input.length, frame.input.length) }, (_, i) => i)
      .find(i => JSON.stringify(previous.input[i]) !== JSON.stringify(frame.input[i])) ?? null : null;
    if (frame.instructions !== baseline.instructions || digest(JSON.stringify(frame.tools)) !== toolsHash) errors.push(`${groups[index]}: prefix/tools changed`);
    return { group: groups[index], inputCount: frame.input.length, prefixHash: digest(frame.instructions),
      prefixBytes: Buffer.byteLength(frame.instructions), toolsHash: digest(JSON.stringify(frame.tools)),
      firstInputDifference, firstDifferenceAfterPrefix: firstInputDifference !== null,
      cacheKeyHash: digest(JSON.stringify(frame.prompt_cache_key)).slice(0, 16),
      turnIdHash: digest(JSON.stringify(frame.client_metadata?.turn_id)).slice(0, 16),
      turnStateHash: digest(JSON.stringify(frame.client_metadata?.['x-codex-turn-state'])).slice(0, 16) };
  });
  if (prefixBytes < 32000) errors.push('retained prefix too short for >=8k token design');
  if (frames[2] && frames[3] && JSON.stringify(frames[2].input) === JSON.stringify(frames[3].input)) errors.push('prune did not change input');
  if (frames[2] && frames[3] && frames[2].input.length !== frames[3].input.length) errors.push('prune changed input shape');
  return { prefixBytes, prefixHash, toolsHash, rows: row, errors };
}
