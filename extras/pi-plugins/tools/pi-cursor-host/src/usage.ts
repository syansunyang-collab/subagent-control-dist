import type { AssistantMessage } from "@earendil-works/pi-ai";

export type RunShape = {
	/** Tool-call messages the run handed to Pi. Each one is followed by another model call. */
	toolBatches: number;
	/**
	 * Model calls seen in the stream (completed thinking blocks). Cursor makes calls of its own that show
	 * no tool event, e.g. a tool-schema lookup before the first custom tool call. 0 when the model does
	 * not think and the count is unknown.
	 */
	modelCalls?: number;
	/** Estimated context at the end of the previous run of the same agent. */
	previousContext?: number;
	/** Characters handed to this run; at most one token each. */
	sentChars?: number;
	/** Characters of the tool results handed back during this run. */
	resultChars?: number;
};

/** Mixed code and prose; only used when no earlier context size anchors the estimate. */
const RESULT_CHARS_PER_TOKEN = 3;

/**
 * Cursor reports usage once per run, summed over every model call of the run. The billed sums go into
 * the token fields, accumulating followup runs in the same Pi reply. `totalTokens`, which Pi and threshold-based extensions read as the context size,
 * gets an estimate of the prompt of the run's last model call:
 *
 * - no tool calls: the prompt barely grows between calls, so it is the sum divided by the number of calls;
 * - tool calls: the prompt grows as results accumulate, so the last call is extrapolated linearly from
 *   the average, anchored on the context at the end of the previous run when that is known, otherwise
 *   on the size of the results and output the run added.
 *
 * When the number of calls is unknown (no thinking blocks) and there were no tool calls, a sum that is a
 * multiple of "previous context + text sent" is divided back, which catches a call Cursor repeated.
 *
 * Returns the estimated context size so the caller can carry it into the next run.
 */
export function applyRunUsage(output: Pick<AssistantMessage, "usage">, usage: unknown, shape: RunShape): number {
	const previousContext = shape.previousContext ?? 0;
	if (!usage || typeof usage !== "object") return previousContext;
	const record = usage as Record<string, unknown>;
	const read = (key: string) => {
		const value = Number(record[key] ?? 0);
		return Number.isFinite(value) ? value : 0;
	};
	// Cursor's inputTokens is the whole prompt, cached part included (measured over consecutive chat turns:
	// input 15046 with cacheRead 14968, then input 15106 with cacheRead 15045). Pi's `input` is the
	// uncached share, so that input + cacheRead adds up to the prompt once.
	const prompt = read("inputTokens");
	const produced = read("outputTokens");
	const cacheRead = read("cacheReadTokens");
	output.usage.output += produced;
	output.usage.cacheRead += cacheRead;
	output.usage.cacheWrite += read("cacheWriteTokens");
	output.usage.input += Math.max(0, prompt - cacheRead);

	const seen = shape.modelCalls ?? 0;
	// Parallel tool calls of one model call can reach Pi as separate messages (a straggler), so the
	// batches overcount; the thinking blocks are the better count whenever there are any.
	const calls = seen > 0 ? seen : shape.toolBatches + 1;
	const average = prompt / calls;
	let lastCall = average;
	if (shape.toolBatches > 0) {
		const growth = (shape.resultChars ?? 0) / RESULT_CHARS_PER_TOKEN + produced;
		const firstCall = previousContext > 0 ? Math.min(previousContext, average) : Math.max(0, average - growth / 2);
		lastCall = Math.min(prompt, Math.max(average, 2 * average - firstCall));
	} else if (seen === 0 && previousContext > 0 && shape.sentChars !== undefined) {
		lastCall = prompt / Math.max(1, Math.round(prompt / (previousContext + shape.sentChars)));
	}
	const context = Math.round(lastCall) + produced;
	output.usage.totalTokens = context;
	return context;
}
