/** Shape of `Cursor.models.list()` entries that this provider relies on. */
export type CatalogParam = { id: string; value: string };
export type CatalogModel = {
	id: string;
	displayName?: string;
	parameters?: Array<{ id: string; values: Array<{ value: string }> }>;
	variants?: Array<{ params: CatalogParam[]; isDefault?: boolean }>;
};

export type PiThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const PI_LEVELS: PiThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const GROK_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** Offline catalog. Grok must carry `effort` here or Pi Web treats it as non-reasoning. */
export const FALLBACK_MODELS: CatalogModel[] = [
	{ id: "composer-2.5", displayName: "Composer 2.5" },
	{
		id: "grok-4.7",
		displayName: "Grok 4.7",
		parameters: [
			{ id: "context", values: ["256k", "500k"].map((value) => ({ value })) },
			{ id: "reasoning_effort", values: GROK_EFFORTS.map((value) => ({ value })) },
		],
		variants: ["256k", "500k"].flatMap((context) => GROK_EFFORTS.map((value) => ({
			params: [{ id: "context", value: context }, { id: "reasoning_effort", value }, { id: "fast", value: "false" }],
			isDefault: context === "256k" && value === "high",
		}))),
	},
	{
		id: "grok-4.6",
		displayName: "Grok 4.6",
		parameters: [{ id: "effort", values: GROK_EFFORTS.map((value) => ({ value })) }],
		variants: GROK_EFFORTS.map((value) => ({
			params: [{ id: "effort", value }],
			isDefault: value === "high",
		})),
	},
	{ id: "auto", displayName: "Auto" },
];

/** One entry in Pi's model list. A Cursor model with several context sizes yields one entry per size. */
export type HostModel = {
	id: string;
	name: string;
	cursorId: string;
	/** Value of Cursor's `context` parameter for this entry, when the model has one. */
	context?: string;
	contextWindow: number;
	reasoning: boolean;
	/** Pi level -> Cursor effort value; null marks a level the model does not offer. */
	thinkingLevelMap: Partial<Record<"off" | PiThinkingLevel, string | null>>;
};

/** Cursor models name their effort parameter differently. */
const EFFORT_PARAM_IDS = ["effort", "reasoning", "reasoning_effort"];
/** Cursor spells Pi's `xhigh` as `extra-high` on some models. */
const LEVEL_ALIASES: Record<string, string[]> = { xhigh: ["xhigh", "extra-high"] };
const DEFAULT_CONTEXT_WINDOW = 200000;
/**
 * The catalog names a context size only for models that offer a choice. For the rest the window is on
 * the model's page, https://cursor.com/docs/models/<slug> (read 2026-09-17); models not listed here are
 * 200k there, or have no page. Cursor's Grok models are 256k by design, not xAI's 500k.
 */
const DOCUMENTED_CONTEXT_WINDOWS: Record<string, number> = {
	"grok-4.6": 256000,
	"grok-4.5": 256000,
	"gpt-5.3-codex": 272000,
	"gpt-5.2": 272000,
	"gpt-5.4-mini": 272000,
	"gpt-5.4-nano": 272000,
	"gpt-5-mini": 272000,
	"kimi-k2.7-code": 262000,
};

function paramValues(model: CatalogModel, id: string): string[] | undefined {
	return model.parameters?.find((param) => param.id === id)?.values.map((entry) => entry.value);
}

function effortParam(model: CatalogModel): { id: string; values: string[] } | undefined {
	for (const id of EFFORT_PARAM_IDS) {
		const values = paramValues(model, id);
		if (values?.length) return { id, values };
	}
	return undefined;
}

const EFFORT_RANK = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Pi marks levels a model lacks as unavailable, but a CLI flag or a restored session can still ask
 * for one. Take the closest level the model has, leaning lower, instead of whatever variant is listed first.
 */
function nearestEffort(values: readonly string[], level: PiThinkingLevel): string | undefined {
	const wanted = EFFORT_RANK.indexOf(level);
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const value of values) {
		const rank = EFFORT_RANK.indexOf(value === "extra-high" ? "xhigh" : value);
		if (rank < 0) continue;
		const distance = Math.abs(rank - wanted) + (rank > wanted ? 0.5 : 0);
		if (distance < bestDistance) {
			best = value;
			bestDistance = distance;
		}
	}
	return best;
}

export function parseContextWindow(value: string | undefined): number {
	const match = value?.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([km])$/);
	if (!match) return DEFAULT_CONTEXT_WINDOW;
	return Math.round(Number(match[1]) * (match[2] === "m" ? 1_000_000 : 1_000));
}

export function toHostModels(catalog: readonly CatalogModel[]): HostModel[] {
	const models: HostModel[] = [];
	for (const entry of catalog) {
		const effort = effortParam(entry);
		const hasThinkingSwitch = paramValues(entry, "thinking") !== undefined;
		const thinkingLevelMap: HostModel["thinkingLevelMap"] = {};
		if (effort) {
			for (const level of PI_LEVELS) {
				const spelled = (LEVEL_ALIASES[level] ?? [level]).find((value) => effort.values.includes(value));
				thinkingLevelMap[level] = spelled ?? null;
			}
			thinkingLevelMap.off = hasThinkingSwitch ? "off" : effort.values.includes("none") ? "none" : null;
		}

		// The smallest context is the plain model id; larger ones cost more and are opt-in by suffix,
		// whatever Cursor's own default variant is.
		const contexts = paramValues(entry, "context");
		const ordered: Array<string | undefined> = contexts
			? [...contexts].sort((a, b) => parseContextWindow(a) - parseContextWindow(b))
			: [undefined];
		const defaultContext = ordered[0];
		for (const context of ordered) {
			const isDefault = context === defaultContext;
			models.push({
				id: isDefault ? entry.id : `${entry.id}-${context}`,
				name: `${entry.displayName ?? entry.id}${isDefault ? "" : ` (${context})`}`,
				cursorId: entry.id,
				context,
				contextWindow: context ? parseContextWindow(context) : (DOCUMENTED_CONTEXT_WINDOWS[entry.id] ?? DEFAULT_CONTEXT_WINDOW),
				reasoning: Boolean(effort || hasThinkingSwitch),
				thinkingLevelMap,
			});
		}
	}
	return models;
}

/**
 * Cursor parameters for one request. Only combinations that Cursor lists as a variant are sent;
 * when the exact combination is missing, the closest variant wins.
 */
export function selectCursorModel(
	entry: CatalogModel | undefined,
	host: Pick<HostModel, "cursorId" | "context" | "thinkingLevelMap">,
	level: PiThinkingLevel | undefined,
): { id: string; params?: CatalogParam[] } {
	if (!entry?.variants?.length) return { id: host.cursorId };
	const effort = effortParam(entry);
	const wanted = new Map<string, string>();
	if (host.context) wanted.set("context", host.context);
	if (paramValues(entry, "fast")) wanted.set("fast", "false");
	if (paramValues(entry, "thinking")) wanted.set("thinking", level ? "true" : "false");
	if (effort) {
		const value = level
			? (host.thinkingLevelMap[level] ?? nearestEffort(effort.values, level))
			: effort.values.includes("none")
				? "none"
				: undefined;
		if (value && value !== "off") wanted.set(effort.id, value);
	}

	let best = entry.variants[0];
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const variant of entry.variants) {
		let score = variant.isDefault ? 0.5 : 0;
		for (const [id, value] of wanted) {
			const actual = variant.params.find((param) => param.id === id)?.value;
			// Context and the thinking switch decide cost and behaviour; effort and speed are tuning.
			const weight = id === "context" || id === "thinking" ? 100 : 10;
			if (actual === value) score += weight;
			else if (actual !== undefined) score -= weight;
		}
		if (score > bestScore) {
			best = variant;
			bestScore = score;
		}
	}
	return best.params.length ? { id: entry.id, params: best.params.map((param) => ({ ...param })) } : { id: entry.id };
}
