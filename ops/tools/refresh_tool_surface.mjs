// 从真实 MCP server 拉工具面，重写 contract test 的完整 EXPECTED_TOOL_SURFACE
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST = `${REPO}/ops/tools/subagent_service_contract_test.mjs`;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

const child = spawn("node", [`${REPO}/ops/tools/subagent_service.mjs`, "mcp"], { cwd: REPO });
let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id && pending.has(message.id)) pending.get(message.id)(message);
    } catch { /* 非 JSON 行忽略 */ }
  }
});
function call(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

await call(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "surface-refresh", version: "0" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const listed = await call(2, "tools/list", {});
child.kill();

const surface = listed.result.tools.map((tool) => canonicalValue({
  name: tool.name,
  inputSchema: tool.inputSchema,
  outputSchema: tool.outputSchema,
  annotations: tool.annotations,
}));
const json = JSON.stringify(surface);

let text = readFileSync(TEST, "utf8");
text = text.replace(/const EXPECTED_TOOL_SURFACE = \[.*\];/, `const EXPECTED_TOOL_SURFACE = ${json};`);
writeFileSync(TEST, text, "utf8");
console.log("tools:", surface.length);
