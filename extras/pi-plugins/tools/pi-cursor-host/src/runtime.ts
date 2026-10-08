import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	AuthenticationError,
	ConfigurationError,
	Cursor,
	FileCredentialStore,
	JsonlLocalAgentStore,
	type AgentOptions,
	type SDKAgent,
	type SDKCustomTool,
	type ToolName,
} from "@cursor/sdk";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { messageKey, planTurn } from "./continuity.ts";
import { fetchCatalog, readCatalogCache } from "./catalog.ts";
import {
	FALLBACK_MODELS,
	selectCursorModel,
	toHostModels,
	type CatalogModel,
	type HostModel,
	type PiThinkingLevel,
} from "./models.ts";
import { hostToolAllowlist, instructionSettingSources } from "./contract.js";
import {
	loadSystemPromptAllowed,
	saveSystemPromptAllowed,
	stripCursorLoadedInstructions,
	writeInstructionSidecar,
	type InstructionMode,
} from "./instructions.ts";
import { replayBudgetChars, serializeFollowup, serializeHostPrompt, type HostPrompt } from "./prompt.ts";
import { toCustomTools } from "./tools.ts";
import { hydrateContext } from "./transcript-compat.ts";
import { HeldSession, Turn, debug, envFlag, type EndReason } from "./session.ts";

export const PROVIDER = "cursor-host";
export { FALLBACK_MODELS } from "./models.ts";

/** Catalog behind the registered Pi models; request parameters are picked from its variants. */
let catalog: readonly CatalogModel[] = FALLBACK_MODELS;
let hostModels: HostModel[] = toHostModels(FALLBACK_MODELS);

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const SYSTEM_PROMPT_ENV = "PI_CURSOR_HOST_SYSTEM_PROMPT";
let systemPromptAllowed: boolean | undefined = loadSystemPromptAllowed();

export function shouldSendSystemPrompt(): boolean {
	const forced = envFlag(SYSTEM_PROMPT_ENV);
	if (forced === false) return false;
	if (forced === true) return true;
	return systemPromptAllowed !== false;
}

export function markSystemPromptAllowed(allowed: boolean): void {
	systemPromptAllowed = allowed;
	saveSystemPromptAllowed(allowed);
}

export function isSystemPromptRejected(error: unknown): boolean {
	const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
	return /system-prompt/i.test(text);
}

export function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST } };
}

export function toProviderModels(entries: readonly CatalogModel[]): Model<Api>[] {
	catalog = entries;
	hostModels = toHostModels(entries);
	return hostModels.map((host) => ({
		id: host.id,
		name: host.name,
		api: "cursor-host-sdk" as Api,
		provider: PROVIDER,
		reasoning: host.reasoning,
		thinkingLevelMap: host.thinkingLevelMap,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { ...ZERO_COST },
		contextWindow: host.contextWindow,
		maxTokens: 32000,
	})) as Model<Api>[];
}

/** The catalog currently behind the Pi model list; a failed refresh keeps it instead of falling back. */
export function currentCatalog(): readonly CatalogModel[] {
	return catalog;
}

/** Cursor model id and parameters for a Pi model id at a Pi thinking level. */
export function cursorModelFor(piModelId: string, level: PiThinkingLevel | undefined) {
	const host = hostModels.find((model) => model.id === piModelId) ?? { cursorId: piModelId, thinkingLevelMap: {} };
	return selectCursorModel(catalog.find((entry) => entry.id === host.cursorId), host, level);
}

export async function resolveApiKey(explicit?: string): Promise<string> {
	const fromArg = explicit?.trim();
	if (fromArg && fromArg !== "$CURSOR_API_KEY" && fromArg !== "cursor-sdk") return fromArg;
	if (process.env.CURSOR_API_KEY?.trim()) return process.env.CURSOR_API_KEY.trim();
	const status = await Cursor.auth.status();
	if (status.status === "logged-in") return "";
	throw new AuthenticationError("Cursor SDK is logged out. Run /login cursor-host or set CURSOR_API_KEY.");
}

export function buildAgentOptions(input: {
	apiKey?: string;
	model: AgentOptions["model"];
	cwd: string;
	systemPrompt?: string;
	instructionMode: InstructionMode;
	instructionDir?: string;
	customTools: Record<string, SDKCustomTool>;
}): AgentOptions {
	const toolNames = Object.keys(input.customTools);
	const useRules = input.instructionMode === "project-rules";
	const options: AgentOptions = {
		model: input.model,
		tools: hostToolAllowlist(toolNames.length) as ToolName[],
		mcpServers: {},
		local: {
			cwd: input.cwd,
			settingSources: instructionSettingSources(input.instructionMode),
			dirs: input.instructionDir ? [input.instructionDir] : undefined,
			customTools: input.customTools,
		},
	};
	if (input.apiKey) options.apiKey = input.apiKey;
	if (!useRules && input.systemPrompt?.trim()) {
		options.systemPrompt = input.systemPrompt.trim();
	}
	return options;
}

async function createLocalAgent(options: AgentOptions, signal?: AbortSignal): Promise<SDKAgent> {
	signal?.throwIfAborted();
	try {
		return await Agent.create(options);
	} catch (error) {
		if (!(error instanceof ConfigurationError) || !/sqlite/i.test(error.message)) throw error;
		signal?.throwIfAborted();
		Cursor.configure({ local: { store: new JsonlLocalAgentStore(join(tmpdir(), "pi-cursor-host-store")) } });
		return await Agent.create(options);
	}
}

const sessions = new Map<string, HeldSession>();
const sessionDirectories = new Map<string, string>();

export function registerSessionDirectory(sessionId: string, cwd: string): void {
	sessionDirectories.set(sessionId, cwd);
}

export function disposeSession(sessionId: string): void {
	for (const [key, session] of sessions) {
		if (key.startsWith(`${sessionId}\n`)) session.dispose();
	}
	sessionDirectories.delete(sessionId);
}

export function disposeAllSessions(): void {
	for (const session of [...sessions.values()]) session.dispose();
	sessionDirectories.clear();
}

function digest(parts: unknown[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export function createCursorHostStream() {
	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};

		void (async () => {
			// Tool-less summaries sharing a session id use that session's directory as well.
			const cwd = sessionDirectories.get(options?.sessionId ?? "") ?? process.cwd();
			const sessionKey = `${options?.sessionId ?? "default"}\n${cwd}`;
			let session: HeldSession | undefined;
			let rejectAbort!: (error: unknown) => void;
			const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
			cancelled.catch(() => {});
			const onAbort = () => {
				const error = new Error("Request was aborted");
				session?.dispose(error);
				rejectAbort(error);
			};
			const checkAbort = () => options?.signal?.throwIfAborted();
			const awaitRequest = <T>(work: Promise<T>): Promise<T> => Promise.race([work, cancelled]);
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			if (options?.signal?.aborted) onAbort();
			const started = { value: false };
			let turn: Turn | undefined;
			try {
				checkAbort();
				context = hydrateContext(context);
				await awaitRequest(Promise.resolve(options?.onPayload?.(
					{ provider: PROVIDER, model: model.id, tools: context.tools?.map((tool) => tool.name) ?? [] },
					model,
				)));
				checkAbort();
				const apiKey = await awaitRequest(resolveApiKey(options?.apiKey));
				checkAbort();
				const instructionText = context.systemPrompt?.trim() ?? "";
				const cursorModel = cursorModelFor(model.id, options?.reasoning);

				const begin = async (instructionMode: InstructionMode): Promise<EndReason> => {
					checkAbort();
					const current = new Turn(output, stream, started);
					turn = current;
					const signature = digest([
						model.id,
						instructionMode,
						instructionText,
						(context.tools ?? []).map((tool) => [tool.name, tool.description, tool.parameters]),
						apiKey ? digest([apiKey]) : "sdk-login",
					]);
					const held = sessions.get(sessionKey);
					// Pi reuses the session id for tool-less side requests (compaction and branch summaries), and a
					// second request can arrive while one is being served. Neither may take over or kill the
					// conversation's agent: they get an agent of their own for the one request.
					const oneShot = !context.tools?.length || held?.busy === true;
					const reusable = !oneShot && held && held.alive && held.signature === signature ? held : undefined;

					let plan = reusable ? planTurn(reusable.known, reusable.pendingIds, context.messages) : ({ kind: "fresh" } as const);
					let steered: HostPrompt | undefined;
					if (reusable && plan.kind === "resume") {
						steered = serializeFollowup(plan.steered);
						const steerable = steered.images.length === 0 && (steered.text === "" || reusable.canSteer);
						// A finished run cannot take results; steering carries text only.
						if (!reusable.hasLiveRun || !steerable) plan = { kind: "fresh" };
					} else if (reusable && plan.kind === "followup" && reusable.hasLiveRun) {
						plan = { kind: "fresh" }; // the agent is still working on straggler calls; do not send into it
					}

					debug(
						`plan=${plan.kind}${oneShot ? " one-shot" : ""}${plan.kind === "resume" && steered?.text ? " steered" : ""} ` +
							`model=${JSON.stringify(cursorModel)} messages=${context.messages.length} pending=${reusable?.pendingIds.length ?? 0} mode=${instructionMode}`,
					);
					if (plan.kind === "fresh" || !reusable) {
						if (!oneShot) held?.dispose(new Error("Conversation history changed; the Cursor agent was replaced"));
						const fresh = new HeldSession(sessionKey, signature, !oneShot, (closed) => {
							if (closed.registered && sessions.get(closed.key) === closed) sessions.delete(closed.key);
						});
						session = fresh;
						if (!oneShot) sessions.set(sessionKey, fresh);
						const creation = createLocalAgent(
							buildAgentOptions({
								apiKey: apiKey || undefined,
								model: cursorModel,
								cwd,
								systemPrompt: instructionText,
								instructionMode,
								instructionDir:
									instructionMode === "project-rules" && instructionText
										? writeInstructionSidecar(stripCursorLoadedInstructions(instructionText, cwd))
										: undefined,
								customTools: toCustomTools(context.tools, fresh.propose),
							}),
							options?.signal,
						).then((agent) => {
							if (!fresh.alive || options?.signal?.aborted) {
								agent.close();
								throw new Error("Cursor agent creation completed after request ended");
							}
							return agent;
						});
						fresh.agent = await awaitRequest(creation);
						checkAbort();
						fresh.known = context.messages.map(messageKey);
						fresh.attach(current);
						const replay = serializeHostPrompt(context.messages, replayBudgetChars(model.contextWindow));
						debug(`replay chars=${replay.text.length} truncated=${replay.text.includes("Earlier transcript omitted")}`);
						checkAbort();
						await awaitRequest(fresh.startRun(replay, cursorModel));
					} else {
						checkAbort();
						session = reusable;
						reusable.known = context.messages.map(messageKey);
						reusable.attach(current);
						if (plan.kind === "resume") {
							if (steered?.text) reusable.steer(steered);
							reusable.resolveResults(plan.results);
						} else {
							checkAbort();
							await awaitRequest(reusable.startRun(serializeFollowup(plan.added), cursorModel));
						}
					}
					checkAbort();
					await awaitRequest(Promise.resolve(options?.onResponse?.({ status: 200, headers: {} }, model)));
					current.start();
					return await awaitRequest(current.done);
				};

				let reason: EndReason;
				const firstMode: InstructionMode = shouldSendSystemPrompt() ? "system-slot" : "project-rules";
				try {
					reason = await begin(firstMode);
					if (firstMode === "system-slot" && instructionText && systemPromptAllowed !== true) markSystemPromptAllowed(true);
				} catch (error) {
					if (firstMode !== "system-slot" || turn?.hasContent || !isSystemPromptRejected(error)) throw error;
					markSystemPromptAllowed(false);
					session?.dispose();
					reason = await begin("project-rules");
				}

				output.stopReason = reason;
				session?.known.push(messageKey(output));
				stream.push({ type: "done", reason, message: output });
			} catch (error) {
				session?.dispose(error);
				// Only the caller's own signal means "aborted"; Pi stops its loop on that instead of retrying.
				const aborted = options?.signal?.aborted === true;
				output.stopReason = aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
			} finally {
				if (turn) session?.detach(turn);
				if (session && !session.registered) session.dispose();
				options?.signal?.removeEventListener("abort", onAbort);
			}
		})();

		return stream;
	};
}

async function catalogCachePath(apiKey?: string): Promise<string> {
	const key = apiKey?.trim() || process.env.CURSOR_API_KEY?.trim();
	const credentials = key ? undefined : await new FileCredentialStore().load();
	const account = digest([credentials?.backendUrl, key || credentials?.apiKey || "logged-out"]);
	return join(homedir(), ".pi", "agent", "pi-cursor-host", "catalog", `${account}.json`);
}

export async function listLiveModels(apiKey?: string, timeoutMs = 8000): Promise<CatalogModel[]> {
	const key = apiKey?.trim();
	return await fetchCatalog(
		await catalogCachePath(key),
		async () => (await Cursor.models.list(key ? { apiKey: key } : undefined)) as CatalogModel[],
		timeoutMs,
	);
}

export async function loadCatalog(apiKey?: string, timeoutMs = 8000): Promise<CatalogModel[]> {
	const cached = await readCatalogCache(await catalogCachePath(apiKey));
	try {
		return await listLiveModels(apiKey, timeoutMs);
	} catch (error) {
		debug(`catalog startup failed: ${error instanceof Error ? error.message : String(error)}`);
		return cached ?? FALLBACK_MODELS;
	}
}
