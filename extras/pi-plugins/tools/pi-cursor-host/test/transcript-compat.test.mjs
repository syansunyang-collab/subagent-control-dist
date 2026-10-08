import assert from "node:assert/strict";
import test from "node:test";
import { hydrateContext } from "../src/transcript-compat.ts";

test("rebuilds prompt and tools via official transcript APIs", () => {
	const read = { name: "read", description: "r", parameters: {} };
	const bash = { name: "bash", description: "b", parameters: {} };
	const context = hydrateContext({
		messages: [
			{ role: "system", content: "base", toolsAdded: [read, bash], timestamp: 0 },
			{ role: "system", content: "extra", toolsRemoved: [{ name: "bash" }], timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		],
	});
	assert.equal(context.systemPrompt, "base\n\nextra");
	assert.deepEqual(context.tools?.map((tool) => tool.name), ["read"]);
});
