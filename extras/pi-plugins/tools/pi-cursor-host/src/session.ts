import type { AgentOptions, Run, SDKAgent, SDKCustomToolResult, SDKMessage } from "@cursor/sdk";
import type { AssistantMessage, AssistantMessageEventStream, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { toSdkToolResult, type HostPrompt } from "./prompt.ts";
import { leakedHostTools, type ToolProposal } from "./tools.ts";
import { applyRunUsage } from "./usage.ts";

/** Parallel tool calls of one model step arrive within the same tick; this window collects them. */
const TOOL_BATCH_WINDOW_MS = 150;
/** Results kept for replay; a step rarely carries more than a handful of parallel calls. */
const DELIVERED_RESULTS_KEPT = 64;
/** A held agent nobody came back to (Pi session abandoned mid-tool) is released after this long. */
const SESSION_IDLE_MS = Number(process.env.PI_CURSOR_HOST_IDLE_MS) > 0 ? Number(process.env.PI_CURSOR_HOST_IDLE_MS) : 30 * 60 * 1000;


/** `PI_CURSOR_HOST_DEBUG=1` prints one line per request decision to stderr. */
export function debug(message: string): void {
	if (envFlag("PI_CURSOR_HOST_DEBUG")) process.stderr.write(`[cursor-host] ${message}\n`);
}

export function envFlag(name: string): boolean | undefined {
	const raw = process.env[name]?.trim().toLowerCase();
	if (!raw) return undefined;
	if (["0", "false", "off", "no"].includes(raw)) return false;
	if (["1", "true", "on", "yes"].includes(raw)) return true;
	return undefined;
}


// ---------------------------------------------------------------------------------------------
// One Pi assistant message under construction.
// ---------------------------------------------------------------------------------------------

export type EndReason = "toolUse" | "stop";

export class Turn {
	private textIndex?: number;
	private thinkingIndex?: number;
	private settled = false;
	private resolveDone!: (reason: EndReason) => void;
	private rejectDone!: (error: unknown) => void;
	readonly done: Promise<EndReason>;
	readonly output: AssistantMessage;
	private readonly stream: AssistantMessageEventStream;
	/** Shared across the turns of one Pi request so a retry does not emit a second start event. */
	private readonly started: { value: boolean };

	constructor(output: AssistantMessage, stream: AssistantMessageEventStream, started: { value: boolean }) {
		this.output = output;
		this.stream = stream;
		this.started = started;
		this.done = new Promise<EndReason>((resolve, reject) => {
			this.resolveDone = resolve;
			this.rejectDone = reject;
		});
		// A failure can land before the request awaits `done`; the awaiting code still sees it.
		this.done.catch(() => {});
	}

	get hasContent(): boolean {
		return this.output.content.length > 0;
	}

	start(): void {
		if (this.started.value) return;
		this.started.value = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	text(delta: string): void {
		if (!delta) return;
		this.start();
		if (this.textIndex == null) {
			this.textIndex = this.output.content.length;
			this.output.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex: this.textIndex, partial: this.output });
		}
		(this.output.content[this.textIndex] as TextContent).text += delta;
		this.stream.push({ type: "text_delta", contentIndex: this.textIndex, delta, partial: this.output });
	}

	thinking(delta: string): void {
		if (!delta) return;
		this.start();
		if (this.thinkingIndex == null) {
			this.thinkingIndex = this.output.content.length;
			this.output.content.push({ type: "thinking", thinking: "" });
			this.stream.push({ type: "thinking_start", contentIndex: this.thinkingIndex, partial: this.output });
		}
		(this.output.content[this.thinkingIndex] as ThinkingContent).thinking += delta;
		this.stream.push({ type: "thinking_delta", contentIndex: this.thinkingIndex, delta, partial: this.output });
	}

	toolCall(proposal: ToolProposal): void {
		this.start();
		this.closeBlocks();
		const contentIndex = this.output.content.length;
		const toolCall: ToolCall = { type: "toolCall", id: proposal.id, name: proposal.name, arguments: proposal.args };
		this.output.content.push(toolCall);
		this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
		this.stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(proposal.args), partial: this.output });
		this.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.output });
	}

	private closeBlocks(): void {
		if (this.thinkingIndex != null) {
			const block = this.output.content[this.thinkingIndex] as ThinkingContent;
			this.stream.push({ type: "thinking_end", contentIndex: this.thinkingIndex, content: block.thinking, partial: this.output });
			this.thinkingIndex = undefined;
		}
		if (this.textIndex != null) {
			const block = this.output.content[this.textIndex] as TextContent;
			this.stream.push({ type: "text_end", contentIndex: this.textIndex, content: block.text, partial: this.output });
			this.textIndex = undefined;
		}
	}

	finish(reason: EndReason): void {
		if (this.settled) return;
		this.settled = true;
		this.closeBlocks();
		this.resolveDone(reason);
	}

	fail(error: unknown): void {
		if (this.settled) return;
		this.settled = true;
		this.closeBlocks();
		this.rejectDone(error);
	}
}

// ---------------------------------------------------------------------------------------------
// One Cursor agent held for one Pi session.
// ---------------------------------------------------------------------------------------------

type PendingCall = {
	promise: Promise<SDKCustomToolResult>;
	resolve: (result: SDKCustomToolResult) => void;
	reject: (error: unknown) => void;
};

export class HeldSession {
	agent?: SDKAgent;
	/** Keys of every Pi message this agent has seen or produced. */
	known: string[] = [];
	alive = true;
	private run?: Run;
	private turn?: Turn;
	private readonly pending = new Map<string, PendingCall>();
	/**
	 * Results already handed back in this run. After a dropped connection the SDK resumes from its last
	 * checkpoint and calls `execute` again with the same id, also for calls that had completed.
	 */
	private readonly delivered = new Map<string, SDKCustomToolResult>();
	/** Proposals that arrived while no Pi request was attached. */
	private queued: ToolProposal[] = [];
	/** Steering receipts belong to this run, never to a later run or a disposed session. */
	private runState?: {
		run: Run;
		steers: Array<{ turn: Turn | undefined; receipt: Promise<HostPrompt | undefined> }>;
	};
	private model?: AgentOptions["model"];
	private batchTimer?: ReturnType<typeof setTimeout>;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private toolBatches = 0;
	/** Completed thinking blocks of the current run: one per model call, including calls Cursor makes on its own. */
	private modelCalls = 0;
	/** Characters of tool results handed back in the current run; sizes the prompt growth inside the run. */
	private resultChars = 0;
	/** Size of the text handed to the current run; bounds the context estimate of a run without tool calls. */
	private sentChars = 0;
	/** Estimated context size at the end of the previous run; anchors the next run's estimate. */
	private lastContext = 0;
	readonly key: string;
	readonly signature: string;
	/** Sessions for one-off requests (summaries, overlapping calls) are not shared through the map. */
	readonly registered: boolean;
	private readonly onDispose?: (session: HeldSession) => void;

	constructor(key: string, signature: string, registered: boolean, onDispose?: (session: HeldSession) => void) {
		this.key = key;
		this.signature = signature;
		this.registered = registered;
		this.onDispose = onDispose;
	}

	/**
	 * Calls Pi has been asked to execute. Parallel calls can straggle in after the message that
	 * carried the first ones was closed; those wait in `queued` and Pi does not owe a result yet.
	 */
	get pendingIds(): string[] {
		const unsurfaced = new Set(this.queued.map((proposal) => proposal.id));
		return [...this.pending.keys()].filter((id) => !unsurfaced.has(id));
	}

	get hasLiveRun(): boolean {
		return this.run !== undefined;
	}

	get busy(): boolean {
		return this.turn !== undefined;
	}

	get canSteer(): boolean {
		return typeof this.run?.steer === "function";
	}

	/** `customTools.execute` lands here: surface the call to Pi and wait for Pi's result. */
	readonly propose = (proposal: ToolProposal): Promise<SDKCustomToolResult> => {
		// A transport retry can deliver the same call again; Pi must not execute it twice.
		const existing = this.pending.get(proposal.id);
		if (existing) {
			debug(`replayed call ${proposal.id} joins the result Pi still owes`);
			return existing.promise;
		}
		const delivered = this.delivered.get(proposal.id);
		if (delivered) {
			debug(`replayed call ${proposal.id} answered from the delivered result`);
			return Promise.resolve(delivered);
		}
		if (!this.alive) return Promise.reject(new Error("Cursor host session is closed"));

		let resolve!: PendingCall["resolve"];
		let reject!: PendingCall["reject"];
		const promise = new Promise<SDKCustomToolResult>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		this.pending.set(proposal.id, { promise, resolve, reject });
		if (this.turn) this.surface(proposal);
		else this.queued.push(proposal);
		return promise;
	};

	private surface(proposal: ToolProposal): void {
		const turn = this.turn;
		if (!turn) return;
		turn.toolCall(proposal);
		if (this.batchTimer) clearTimeout(this.batchTimer);
		this.batchTimer = setTimeout(() => {
			this.batchTimer = undefined;
			this.toolBatches++;
			turn.finish("toolUse");
		}, TOOL_BATCH_WINDOW_MS);
	}

	attach(turn: Turn): void {
		if (!this.alive) throw new Error("Cursor host session is closed");
		if (this.turn) throw new Error("Cursor host session already serves another request");
		this.turn = turn;
		// Idle time only counts while no Pi request is attached; a long model step is not idleness.
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		for (const proposal of this.queued.splice(0)) this.surface(proposal);
	}

	detach(turn: Turn): void {
		if (this.turn !== turn) return;
		this.turn = undefined;
		if (this.alive) this.armIdleTimer();
	}

	async startRun(prompt: HostPrompt, model: AgentOptions["model"]): Promise<void> {
		if (!this.alive) throw new Error("Cursor host session is closed");
		if (!this.agent) throw new Error("Cursor agent is not created");
		this.toolBatches = 0;
		this.modelCalls = 0;
		this.resultChars = 0;
		this.sentChars = prompt.text.length + prompt.images.length * 4000;
		this.delivered.clear();
		this.model = model;
		const run = await this.agent.send(
			{
				text: prompt.text || "Continue.",
				images: prompt.images.length ? prompt.images.map((image) => ({ data: image.data, mimeType: image.mimeType })) : undefined,
			},
			// The thinking level can change between Pi turns; the held agent takes it per run.
			{ model },
		);
		if (!this.alive) {
			void run.cancel().catch(() => {});
			throw new Error("Cursor host session is closed");
		}
		this.run = run;
		this.runState = { run, steers: [] };
		void this.pump(run);
	}

	/**
	 * User text Pi queued behind the tool results. Called before the results are handed back, so Cursor
	 * appends it right after them, the same order Pi uses. If Cursor hands the message back or the call
	 * fails, the text is not lost: it becomes the next run once this one ends.
	 */
	steer(prompt: HostPrompt): void {
		const state = this.runState;
		if (!this.alive || !state || !prompt.text) return;
		const receipt = (async () => {
			if (typeof state.run.steer !== "function") return prompt;
			const outcome = await state.run.steer(prompt.text);
			debug(`steer outcome=${outcome}`);
			return outcome === "complete_delivered" ? undefined : prompt;
		})().catch((error) => {
			debug(`steer failed: ${error instanceof Error ? error.message : String(error)}`);
			return prompt;
		});
		state.steers.push({ turn: this.turn, receipt });
	}

	resolveResults(results: Parameters<typeof toSdkToolResult>[0][]): void {
		for (const result of results) {
			const call = this.pending.get(result.toolCallId);
			if (!call) continue;
			this.pending.delete(result.toolCallId);
			const sdkResult = toSdkToolResult(result);
			for (const block of sdkResult.content) this.resultChars += block.type === "text" ? block.text.length : 4000;
			this.delivered.set(result.toolCallId, sdkResult);
			if (this.delivered.size > DELIVERED_RESULTS_KEPT) this.delivered.delete(this.delivered.keys().next().value as string);
			call.resolve(sdkResult);
		}
	}

	private async pump(run: Run): Promise<void> {
		try {
			for await (const event of run.stream()) this.onEvent(event);
			const result = await run.wait();
			const state = this.runState;
			if (!this.alive || this.run !== run || state?.run !== run) return;
			// wait() may beat steer(): settle ownership before closing this run or its Pi turn.
			const returned = (await Promise.all(state.steers.map((steer) => steer.receipt))).filter(
				(prompt): prompt is HostPrompt => prompt !== undefined,
			);
			if (!this.alive || this.run !== run || this.runState !== state) return;
			this.run = undefined;
			this.runState = undefined;
			if (this.batchTimer) clearTimeout(this.batchTimer);
			this.batchTimer = undefined;
			if (result.status === "error") throw new Error(result.error?.message || "Cursor run failed");
			if (result.status === "cancelled") throw new Error("Cursor run was cancelled");
			if (this.pending.size > 0) {
				// A finished run cannot take results any more; a later resume would wait forever.
				throw new Error(`Cursor run finished with ${this.pending.size} tool call(s) still waiting for a result`);
			}
			const turn = this.turn;
			if (!turn) {
				// Nobody is attached to receive the ending (the backend gave up while Pi was away).
				this.dispose(new Error("Cursor run ended while no Pi request was attached"));
				return;
			}
			this.lastContext = applyRunUsage(turn.output, result.usage, {
				toolBatches: this.toolBatches,
				modelCalls: this.modelCalls,
				previousContext: this.lastContext,
				sentChars: this.sentChars,
				resultChars: this.resultChars,
			});
			debug(`run usage=${JSON.stringify(result.usage)} modelCalls=${this.modelCalls} toolBatches=${this.toolBatches} context=${this.lastContext}`);
			if (returned.length) {
				await this.startRun({
					text: returned.map((prompt) => prompt.text).join("\n\n"),
					images: returned.flatMap((prompt) => prompt.images),
				}, this.model);
				return;
			}
			turn.finish("stop");
		} catch (error) {
			this.dispose(error);
		}
	}

	private onEvent(event: SDKMessage): void {
		const turn = this.turn;
		if (event.type === "system") {
			const leaked = leakedHostTools(event.tools);
			if (leaked.length > 0) throw new Error(`Cursor offered host tools that should have been trimmed: ${leaked.join(", ")}`);
			return;
		}
		if (event.type === "tool_call") {
			// Pi tools arrive through `execute`. Anything else here is a Cursor built-in that slipped through.
			const leaked = leakedHostTools([event.name]);
			if (leaked.length > 0) throw new Error(`Cursor ran a host tool that should have been trimmed: ${leaked.join(", ")}`);
			return;
		}
		if (event.type === "status" && event.status === "ERROR") {
			throw new Error(event.message || "Cursor agent status ERROR");
		}
		if (event.type === "thinking" && event.thinking_duration_ms !== undefined) this.modelCalls++;
		if (!turn) return;
		if (event.type === "thinking") turn.thinking(event.text);
		else if (event.type === "assistant") {
			for (const block of event.message.content) {
				if (block.type === "text") turn.text(block.text);
			}
		}
	}

	private armIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			debug(`idle timeout, releasing agent ${this.agent?.agentId ?? ""}`);
			this.dispose(new Error("Cursor host session idle timeout"));
		}, SESSION_IDLE_MS);
		this.idleTimer.unref?.();
	}

	/** Releases everything and fails the attached request, so no Pi request is left waiting. */
	dispose(reason?: unknown): void {
		if (!this.alive && !this.agent && !this.turn) return;
		this.alive = false;
		if (this.batchTimer) clearTimeout(this.batchTimer);
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.batchTimer = undefined;
		this.idleTimer = undefined;
		const error = reason ?? new Error("Cursor host session closed");
		for (const call of this.pending.values()) {
			call.promise.catch(() => {}); // the SDK may already have stopped listening
			call.reject(error);
		}
		this.pending.clear();
		this.delivered.clear();
		this.queued = [];
		this.runState = undefined;
		const run = this.run;
		this.run = undefined;
		if (run) void run.cancel().catch(() => {});
		try {
			this.agent?.close();
		} catch {
			// Closing an already closed agent is not an error worth surfacing.
		}
		this.agent = undefined;
		this.onDispose?.(this);
		const turn = this.turn;
		this.turn = undefined;
		turn?.fail(error);
	}
}
