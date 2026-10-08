import assert from "node:assert/strict";
import { test } from "node:test";
import { leakedHostTools, toCustomTools } from "../src/tools.ts";

test("customTools expose Pi names and stay pending until Pi answers", async () => {
	const seen = [];
	let answer;
	const tools = toCustomTools(
		[{ name: "read", description: "Pi read", parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } }],
		(proposal) => {
			seen.push(proposal);
			return new Promise((resolve) => {
				answer = resolve;
			});
		},
	);
	assert.equal(Object.keys(tools).join(","), "read");
	assert.equal(tools.read.inputSchema.additionalProperties, false);

	let settled = false;
	const pending = tools.read.execute({ path: "x" }, { toolCallId: "call-1" }).then((result) => {
		settled = true;
		return result;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	assert.deepEqual(seen, [{ id: "call-1", name: "read", args: { path: "x" } }]);

	answer("from pi");
	assert.equal(await pending, "from pi");
});

test("a call without an id still gets a unique one", () => {
	const ids = [];
	const tools = toCustomTools([{ name: "ls", description: "", parameters: {} }], (proposal) => {
		ids.push(proposal.id);
		return Promise.resolve("ok");
	});
	tools.ls.execute({}, {});
	tools.ls.execute({}, undefined);
	assert.equal(new Set(ids).size, 2);
});

test("Cursor built-ins count as leaks, the MCP group does not", () => {
	assert.deepEqual(leakedHostTools(["mcp", "Shell", "read"]), ["Shell", "read"]);
	assert.deepEqual(leakedHostTools(["mcp"]), []);
});
