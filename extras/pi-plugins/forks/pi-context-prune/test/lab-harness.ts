/**
 * Fake Pi runtime for the policy-lab entry (`dist/policy-lab.js`).
 *
 * Same split the production wiring tests use: the session branch and the running
 * agent's message list are separate, `sessionManager.appendCustomMessageEntry`
 * writes the session only, `pi.appendEntry` writes session custom entries, and
 * the `context` hook receives a deep clone of the agent's list. The summarizer is
 * always a fake provider — no test in this tree may reach a real model.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { responsesPayload } from "./host-responses.ts";

// Mirrored from src/*.ts: those modules use `.js` specifiers that node's type
// stripping does not resolve to `.ts`.
const CUSTOM_TYPE_SUMMARY = "context-prune-summary";
const CUSTOM_TYPE_INDEX = "context-prune-index";
const CUSTOM_TYPE_STATS = "context-prune-stats";
const LAB_EVENT_ENTRY_TYPE = "context-prune-lab-event";
const READ_TOOL_NAME = "context_tree_query";

// @ts-expect-error the bundle ships no declaration file; its shape is asserted by the tests.
const extension = (await import("../dist/policy-lab.js")).default as (pi: any) => void;
const { buildContextEntries, sessionEntryToContextMessages } = await import("@earendil-works/pi-coding-agent");

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface LabHarnessOptions {
  mode: "budget-summary" | "cold-mask";
  triggerTokens?: number;
  keepRecentToolTurns?: number;
  summarizerText?: string;
  summarizerModel?: string;
  summarizerThinking?: string;
  summarizerMaxCharsPerResult?: number;
  /** auto: resolve immediately; deferred: wait for releaseSummarizer(); fail: stream throws. */
  summarizerMode?: "auto" | "deferred" | "fail";
  /** Extra keys written to policy-lab.json (for schema/validation tests). */
  rawConfig?: Record<string, unknown>;
  selectChoice?: string;
  /** Active model seen by the extension (default fake/fake-model, which has no price line). */
  model?: { provider: string; id: string; api?: string };
  /** What ctx.getContextUsage() returns (default: unknown). */
  contextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}

export interface TurnOptions {
  /** Source identity of the assistant that produced the tool calls (default active model). */
  sourceModel?: { provider: string; api?: string; id: string };
  toolName?: string;
  args?: (id: string) => Record<string, unknown>;
  resultText?: (id: string) => string;
  isError?: boolean;
  /** Adds an image block to the result of this id, making the result protected. */
  imageFor?: string;
  /** Provider usage recorded on the assistant message of this turn. */
  usage?: { input: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface LabHarness {
  dir: string;
  branch: any[];
  agent: any[];
  notifications: string[];
  sessionStart(): Promise<void>;
  prompt(text: string): void;
  turn(ids: string[], options?: TurnOptions): Promise<void>;
  /** An assistant message with tool calls whose results are not recorded yet. */
  assistantCall(ids: string[], options?: TurnOptions): void;
  /** Records the tool results for calls announced earlier. */
  results(ids: string[], options?: TurnOptions): void;
  turnEnd(): Promise<void>;
  request(options?: { stopReason?: string; omitProviderIds?: string[]; providerHook?: boolean; inspectPayload?: (payload: any) => void }): Promise<any[]>;
  agentEnd(): Promise<void>;
  sessionTree(): Promise<void>;
  sessionShutdown(reason: string): Promise<void>;
  beforeCompact(): Promise<void>;
  compact(): void;
  reload(): void;
  reloadExtension(): Promise<void>;
  command(args: string): Promise<void>;
  threshold(args: string): Promise<void>;
  abort(): void;
  readBack(ids: string[], offset?: number, limit?: number): Promise<{ text: string; details: any }>;
  readTool: any;
  labEvents(): any[];
  indexedIds(): string[];
  statsEntries(): any[];
  summaries(): any[];
  summarizerPrompts(): string[];
  releaseSummarizer(): void;
  setSummarizerMode(mode: "auto" | "deferred" | "fail"): void;
  setSummarizerText(text: string): void;
  toolNames(): string[];
  settle(): Promise<void>;
  cleanup(): void;
}

const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeLabHarness(options: LabHarnessOptions): LabHarness {
  const dir = mkdtempSync(join(tmpdir(), "pcp-lab-"));
  const configDir = join(dir, ".pi", "agent", "context-prune");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "policy-lab.json"),
    JSON.stringify({
      mode: options.mode,
      triggerTokens: options.triggerTokens ?? 100,
      keepRecentToolTurns: options.keepRecentToolTurns ?? 2,
      ...(options.summarizerModel ? { summarizerModel: options.summarizerModel } : {}),
      ...(options.summarizerThinking ? { summarizerThinking: options.summarizerThinking } : {}),
      ...(options.summarizerMaxCharsPerResult !== undefined ? { summarizerMaxCharsPerResult: options.summarizerMaxCharsPerResult } : {}),
      ...(options.rawConfig ?? {}),
    }),
  );

  const branch: any[] = [];
  const agent: any[] = [];
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const summarizerPrompts: string[] = [];
  const releases: Array<() => void> = [];
  let summarizerMode = options.summarizerMode ?? "auto";
  let summarizerText = options.summarizerText ?? "- summarized batch";
  let clock = Date.parse("2026-09-21T00:00:00Z");
  const tick = () => (clock += 1000);
  const abortController = new AbortController();

  let lastId: string | null = null;
  const append = (entry: any) => {
    const id = `e${branch.length}`;
    branch.push({ ...entry, id, parentId: lastId });
    lastId = id;
    return id;
  };
  const rebuild = () => {
    lastId = branch.at(-1)?.id ?? null;
    agent.length = 0;
    agent.push(...buildContextEntries(branch).flatMap(sessionEntryToContextMessages));
  };
  const record = (message: any) => {
    message.timestamp = tick();
    agent.push(message);
    append({ type: "message", message, timestamp: new Date(message.timestamp).toISOString() });
  };

  const makeStream = (messages: any[]) => {
    summarizerPrompts.push(messages?.[0]?.content?.[0]?.text ?? "");
    const partial = { content: [{ type: "text", text: summarizerText }] };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (summarizerMode === "deferred") releases.push(release);
    const wait = summarizerMode === "deferred" ? gate : Promise.resolve();
    return {
      async *[Symbol.asyncIterator]() {
        await wait;
        yield { type: "text_end", partial };
      },
      async result() {
        await wait;
        return { content: partial.content, usage, stopReason: "stop" };
      },
    };
  };

  const model = options.model ?? { provider: "fake", id: "fake-model" };
  const pi = {
    on(name: string, handler: any) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerMessageRenderer() {},
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    getActiveTools: () => [],
    setActiveTools() {},
    appendEntry(customType: string, data: unknown) {
      return append({ type: "custom", customType, data });
    },
    sendMessage(message: any) {
      const timestamp = tick();
      agent.push({ role: "custom", ...message, timestamp });
      append({ type: "custom_message", ...message, timestamp: new Date(timestamp).toISOString() });
    },
  };

  const ctx = {
    hasUI: true,
    signal: abortController.signal,
    model,
    getContextUsage: () => options.contextUsage?.(),
    modelRegistry: {
      find: () => model,
      getAvailable: () => [],
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "k", headers: {}, env: {} };
      },
      getProvider: () => ({
        stream(_model: any, context: any) {
          if (summarizerMode === "fail") throw new Error("fake summarizer failure");
          return makeStream(context?.messages ?? []);
        },
      }),
    },
    sessionManager: {
      getBranch: () => branch,
      buildContextEntries: () => buildContextEntries(branch),
      getLeafId: () => lastId,
      getSessionId: () => "lab-session",
      appendCustomEntry(customType: string, data: unknown) {
        return append({ type: "custom", customType, data });
      },
      appendCustomMessageEntry(customType: string, content: string, display: boolean, details: unknown) {
        return append({ type: "custom_message", customType, content, display, details, timestamp: new Date(tick()).toISOString() });
      },
    },
    ui: {
      select: async () => options.selectChoice,
      notify: (message: string) => notifications.push(message),
      setStatus() {},
      setWidget() {},
    },
  };

  extension(pi as any);

  const defaultResultText = (id: string) => `${id}:${"x".repeat(800)}`;
  const callBlocks = (ids: string[], options: TurnOptions) =>
    ids.map((id) => ({
      type: "toolCall",
      id,
      name: options.toolName ?? "read",
      arguments: options.args?.(id) ?? { path: id },
    }));
  const resultMessages = (ids: string[], options: TurnOptions) =>
    ids.map((id) => {
      const text = (options.resultText ?? defaultResultText)(id);
      const content: any[] = [{ type: "text", text }];
      if (options.imageFor?.includes(id)) content.push({ type: "image", data: "aGk=", mimeType: "image/png" });
      return {
        role: "toolResult",
        toolCallId: id,
        toolName: options.toolName ?? "read",
        content,
        isError: options.isError ?? false,
      };
    });

  return {
    dir,
    branch,
    agent,
    notifications,
    async sessionStart() {
      process.env.PI_CODING_AGENT_DIR = join(dir, ".pi", "agent");
      process.env.HOME = dir;
      process.env.USERPROFILE = dir;
      await handlers.get("session_start")!({}, ctx);
    },
    prompt(text: string) {
      record({ role: "user", content: [{ type: "text", text }] });
    },
    async turn(ids: string[], options: TurnOptions = {}) {
      const source = options.sourceModel ?? model;
      const message: any = { role: "assistant", provider: source.provider, api: source.api, model: source.id,
        content: callBlocks(ids, options), stopReason: "toolUse" };
      if (options.usage) {
        const { input, output = 0, cacheRead = 0, cacheWrite = 0 } = options.usage;
        message.usage = { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: usage.cost };
      }
      record(message);
      const toolResults = resultMessages(ids, options);
      for (const result of toolResults) record(result);
      await handlers.get("turn_end")!({ message, toolResults, turnIndex: branch.length }, ctx);
    },
    assistantCall(ids: string[], options: TurnOptions = {}) {
      const source = options.sourceModel ?? model;
      record({ role: "assistant", provider: source.provider, api: source.api, model: source.id,
        content: callBlocks(ids, options), stopReason: "toolUse" });
    },
    results(ids: string[], options: TurnOptions = {}) {
      for (const result of resultMessages(ids, options)) record(result);
    },
    async turnEnd() {
      await handlers.get("turn_end")!({ message: null, toolResults: [], turnIndex: branch.length }, ctx);
    },
    async request(options = {}) {
      const messages = structuredClone(agent);
      const out = await handlers.get("context")!({ messages }, ctx);
      const sent = (out?.messages ?? messages) as any[];
      if (options.providerHook !== false) {
        const payload = responsesPayload(model, sent);
        // Remove actual wire outputs for the provider-visible subset test, after host conversion.
        const resultIds = sent.filter(m => m.role === "toolResult").map(m => m.toolCallId);
        let resultIndex = 0;
        payload.input = payload.input.filter(item => {
          if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") return true;
          return !options.omitProviderIds?.includes(resultIds[resultIndex++]);
        });
        options.inspectPayload?.(payload);
        await handlers.get("before_provider_request")?.({ payload }, ctx);
      }
      await handlers.get("message_end")?.({ message: { role: "assistant", stopReason: options.stopReason ?? "stop", content: [], usage } }, ctx);
      return sent;
    },
    async agentEnd() {
      await handlers.get("agent_end")!({ messages: structuredClone(agent) }, ctx);
    },
    async sessionTree() {
      await handlers.get("session_tree")!({}, ctx);
    },
    async sessionShutdown(reason: string) {
      await handlers.get("session_shutdown")!({ reason }, ctx);
    },
    async beforeCompact() {
      await handlers.get("session_before_compact")!({ reason: "manual" }, ctx);
    },
    compact() {
      append({ type: "compaction", summary: "earlier work", firstKeptEntryId: "", tokensBefore: 0, timestamp: new Date(tick()).toISOString() });
      rebuild();
    },
    reload: rebuild,
    async reloadExtension() {
      await handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
      rebuild();
      extension(pi as any);
      await handlers.get("session_start")!({}, ctx);
    },
    async command(args: string) {
      await commands.get(`pruner-${args}`).handler("", ctx);
    },
    async threshold(args: string) {
      await commands.get("pruner-threshold").handler(args, ctx);
    },
    abort() {
      abortController.abort();
    },
    async readBack(ids: string[], offset?: number, limit?: number) {
      const tool = tools.get(READ_TOOL_NAME);
      if (!tool) throw new Error(`read-back tool ${READ_TOOL_NAME} is not registered`);
      const out = await tool.execute("read-call", { toolCallIds: ids, offset, limit }, abortController.signal, undefined, ctx);
      return { text: out.content.map((block: any) => block.text).join("\n"), details: out.details };
    },
    readTool: tools.get(READ_TOOL_NAME),
    labEvents: () => branch.filter((entry) => entry.type === "custom" && entry.customType === LAB_EVENT_ENTRY_TYPE).map((entry) => entry.data),
    indexedIds: () =>
      branch
        .filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE_INDEX)
        .flatMap((entry: any) => entry.data.toolCalls.map((toolCall: any) => toolCall.toolCallId)),
    statsEntries: () => branch.filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE_STATS).map((entry) => entry.data),
    summaries: () => branch.filter((entry) => entry.type === "custom_message" && entry.customType === CUSTOM_TYPE_SUMMARY),
    summarizerPrompts: () => [...summarizerPrompts],
    releaseSummarizer() {
      const pending = releases.splice(0, releases.length);
      for (const release of pending) release();
    },
    setSummarizerMode(mode) {
      summarizerMode = mode;
    },
    setSummarizerText(text: string) {
      summarizerText = text;
    },
    toolNames: () => [...tools.keys()],
    settle: () => settle(),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Tool results in a message list that carry a lab receipt. */
export const receiptsIn = (messages: any[]) =>
  messages.filter((message) => message?.role === "toolResult" && /^\[pruned:t/.test(message.content?.[0]?.text ?? ""));

/** Tool results in a message list that still carry their original text. */
export const rawResultsIn = (messages: any[]) =>
  messages.filter((message) => message?.role === "toolResult" && !/^\[pruned:t/.test(message.content?.[0]?.text ?? ""));

export const summariesIn = (messages: any[]) =>
  messages.filter((message) => message?.role === "custom" && message.customType === CUSTOM_TYPE_SUMMARY);

export const CUSTOM_TYPES = { summary: CUSTOM_TYPE_SUMMARY, index: CUSTOM_TYPE_INDEX, labEvent: LAB_EVENT_ENTRY_TYPE, stats: CUSTOM_TYPE_STATS };
