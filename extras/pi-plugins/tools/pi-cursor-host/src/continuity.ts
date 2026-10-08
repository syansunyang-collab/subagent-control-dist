import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * Identity of a Pi message that survives content rewrites by other extensions
 * (context pruning replaces tool result bodies but keeps the call id, and annotates message text).
 */
export function messageKey(message: Message): string {
	if (message.role === "toolResult") return `toolResult:${message.toolCallId}`;
	return `${message.role}:${message.timestamp}`;
}

export type TurnPlan =
	/** History differs from what the Cursor agent has seen: new agent, replay the transcript. */
	| { kind: "fresh" }
	/**
	 * The live run is waiting on exactly these tool results: hand them back into it. `steered` holds
	 * user messages Pi queued behind the results (the user typed while the tools ran).
	 */
	| { kind: "resume"; results: ToolResultMessage[]; steered: Message[] }
	/** The agent is idle and only user messages were added: send them as the next run. */
	| { kind: "followup"; added: Message[] };

/**
 * Decide how a Pi request relates to the Cursor agent held for the session.
 * `known` is the key list of every message the agent has already seen (or produced).
 */
export function planTurn(
	known: readonly string[] | undefined,
	pendingIds: readonly string[],
	messages: readonly Message[],
): TurnPlan {
	if (!known || known.length === 0 || messages.length <= known.length) return { kind: "fresh" };
	for (let i = 0; i < known.length; i++) {
		if (messageKey(messages[i]) !== known[i]) return { kind: "fresh" };
	}
	const added = messages.slice(known.length);

	if (pendingIds.length > 0) {
		// Pi appends every tool result first, then any steering messages, then asks the model again.
		const firstOther = added.findIndex((message) => message.role !== "toolResult");
		const results = (firstOther < 0 ? added : added.slice(0, firstOther)) as ToolResultMessage[];
		const steered = firstOther < 0 ? [] : added.slice(firstOther);
		const answered = new Set(results.map((result) => result.toolCallId));
		const exact =
			answered.size === results.length &&
			answered.size === pendingIds.length &&
			pendingIds.every((id) => answered.has(id)) &&
			steered.every((message) => message.role === "user");
		return exact ? { kind: "resume", results, steered } : { kind: "fresh" };
	}

	return added.every((message) => message.role === "user") ? { kind: "followup", added: [...added] } : { kind: "fresh" };
}
