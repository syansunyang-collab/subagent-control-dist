const PAGE_REASONING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type PageReasoning = typeof PAGE_REASONING[number];

export function getPageAnswerDefaults(): { model: string; reasoning: PageReasoning } {
  const config = loadFeatureConfig().pageAnswer;
  const model = config?.model ?? "openai-codex/gpt-5.6-luna";
  const reasoning = config?.reasoning ?? "low";
  if (typeof model !== "string" || !model.includes("/")) {
    throw new Error("pageAnswer.model must be provider/model-id.");
  }
  if (!PAGE_REASONING.includes(reasoning as PageReasoning)) {
    throw new Error("pageAnswer.reasoning must be off, minimal, low, medium, high, or xhigh.");
  }
  return { model, reasoning: reasoning as PageReasoning };
}
