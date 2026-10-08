// Isolated WS observer. Raw frames and response items live only in this instance.
import { createHash } from 'node:crypto';
const json = value => JSON.stringify(value);
const hash = value => createHash('sha256').update(json(value)).digest('hex');
const bytes = value => Buffer.byteLength(json(value));
const comparable = body => { const { input, previous_response_id, client_metadata, ...rest } = body; return rest; };
export function firstDiff(a, b) {
  let i = 0;
  while (i < Math.min(a.length, b.length) && json(a[i]) === json(b[i])) i++;
  return i;
}
export class EffectiveChain {
  responses = new Map();
  previous = null;
  pending = null;
  // Mirrors getCachedWebSocketInputDelta in the installed Codex provider: full
  // request input = last full logical input + converted assistant output + delta.
  request(frame) {
    const parent = frame.previous_response_id ? this.responses.get(frame.previous_response_id) : null;
    const reset = !frame.previous_response_id;
    const status = reset ? 'full-reset' : !parent ? 'missing-parent' :
      parent.failed ? 'failed-parent' : json(comparable(frame)) !== json(parent.comparable) ? 'settings-mismatch' : 'delta';
    const input = status === 'delta' ? [...parent.input, ...parent.output, ...frame.input] :
      reset ? frame.input : null;
    const previous = this.previous;
    const row = { status, inputCount: input?.length ?? null, inputBytes: input && bytes(input),
      firstDiff: input && previous ? firstDiff(previous, input) : null,
      previousItems: previous?.length ?? null, frameHash: hash(frame),
      effectiveHash: input && hash(input), prefixBytes: input && previous ?
        input.slice(0, firstDiff(previous, input)).reduce((n, item) => n + bytes(item), 0) : null };
    this.pending = { input, comparable: comparable(frame), row };
    return row;
  }
  response(event, convertedOutput) {
    if (!this.pending) return null;
    const { input, comparable, row } = this.pending;
    if (!['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) return null;
    const success = event.type === 'response.completed' && event.response?.status === 'completed';
    const id = event.response?.id;
    if (id) this.responses.set(id, { input, comparable, output: convertedOutput ?? event.response?.output ?? [],
      failed: !success || !input, rawOutputHash: hash(event.response?.output ?? []),
      outputHash: hash(convertedOutput ?? event.response?.output ?? []) });
    if (success && input) this.previous = input;
    this.pending = null;
    return { success, responseIdHash: hash(id ?? null), outputHash: hash(event.response?.output ?? []),
      convertedOutputHash: hash(convertedOutput ?? event.response?.output ?? []), ...row,
      usage: event.response?.usage ? { inputTokens: event.response.usage.input_tokens,
        cachedTokens: event.response.usage.input_tokens_details?.cached_tokens,
        outputTokens: event.response.usage.output_tokens } : null };
  }
  // A completed provider turn may yield a normalized conversion different from raw response.output.
  // Use that converted form when comparing to Pi's next logical input, never guess from raw SSE deltas.
  setConvertedOutput(id, items) {
    const response = this.responses.get(id);
    if (response && !response.failed) response.output = items;
  }
}
