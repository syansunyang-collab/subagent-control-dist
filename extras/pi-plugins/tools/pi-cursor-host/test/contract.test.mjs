import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_SETTING_SOURCES, hostToolAllowlist, instructionSettingSources } from "../src/contract.js";

test("empty setting sources so Cursor disk MCP/rules stay out", () => {
	assert.deepEqual(HOST_SETTING_SOURCES, []);
});

test("no Pi tools means no MCP capability group", () => {
	assert.deepEqual(hostToolAllowlist(0), []);
});

test("Pi tools keep only the MCP group, not Cursor host tools", () => {
	assert.deepEqual(hostToolAllowlist(3), ["mcp"]);
	assert.equal(hostToolAllowlist(1).includes("shell"), false);
	assert.equal(hostToolAllowlist(1).includes("read"), false);
});

test("system-slot does not load Cursor disk sources", () => {
	assert.deepEqual(instructionSettingSources("system-slot"), []);
});

test("locked accounts use project rules, not the user turn", () => {
	assert.deepEqual(instructionSettingSources("project-rules"), ["project"]);
});


