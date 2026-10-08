import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "tmp/antigravity-native-system-update");
const out = path.join(root, "test-results/pi-antigravity-native-20261006/system-update");
const cwd = path.join(dir, "work"), home = path.join(dir, "home");
const agent = "pi-native-update-probe", agentFile = path.join(cwd, `.agents/agents/${agent}/agent.md`);
const cli = path.join(root, "tmp/antigravity-wire-capture-20261006/agy-capture.exe");
for (const d of [out, cwd, path.dirname(agentFile), path.join(home, ".gemini/antigravity-cli")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, ".gemini/antigravity-cli/settings.json"), JSON.stringify({ modelProvider: "gemini", trustedWorkspaces: [cwd] }));
const requests = [], ids = [], markers = [`SYS_FIRST_${randomUUID()}`, `SYS_SECOND_${randomUUID()}`];
let turn = 0;
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  requests.push({ turn, path: req.url.split("?")[0], body });
  if (req.url.includes("countTokens")) { res.setHeader("Content-Type", "application/json"); return res.end('{"totalTokens":10}'); }
  res.setHeader("Content-Type", "text/event-stream");
  res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: `ANSWER_TURN_${turn}` }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } })}\n\n`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"), GEMINI_API_KEY: "capture-only-not-a-real-key", GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}`, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "localhost,127.0.0.1" };
try {
  for (turn = 0; turn < 2; turn++) {
    fs.writeFileSync(agentFile, `---\nname: ${agent}\ndescription: System update fixture.\nmainAgent: true\nsubagent: false\nexcludeDefaultComponents: true\ninheritCustomizations: false\ntools: []\n---\n\n${markers[turn]}\nReply briefly.\n`);
    const args = ["--agent", agent, "--model", "gemini-3.6-flash", "--effort", "low", "--output-format", "stream-json", "--print-timeout", "30s"];
    if (ids[0]) args.push("--conversation", ids[0]);
    args.push("--print", `TASK_TURN_${turn}`);
    const child = spawn(cli, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (d) => stdout += d); child.stderr.on("data", (d) => stderr += d);
    const exit = await new Promise((r, reject) => { child.once("error", reject); child.once("close", r); });
    fs.writeFileSync(path.join(out, `turn-${turn}.stdout.jsonl`), stdout); fs.writeFileSync(path.join(out, `turn-${turn}.stderr.log`), stderr);
    assert.equal(exit, 0, stderr);
    const result = stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l)).findLast((e) => e.event === "result").result;
    assert.equal(result.status, "SUCCESS"); ids.push(result.conversation_id);
  }
  const main = requests.filter((r) => r.path.includes("models/gemini-3.6-flash:"));
  assert.equal(main.length, 2);
  assert.ok(JSON.stringify(main[0].body.systemInstruction).includes(markers[0]), "Initial custom agent did not load");
  const verdict = { responseStubbed: true, backend: "isolated CLI Gemini API", sameConversationId: ids[0] === ids[1], changedAgentSystemLoaded: JSON.stringify(main[1].body.systemInstruction).includes(markers[1]), staleSystemGone: !JSON.stringify(main[1].body.systemInstruction).includes(markers[0]), previousUserRetained: JSON.stringify(main[1].body.contents).includes("TASK_TURN_0"), previousAssistantRetained: JSON.stringify(main[1].body.contents).includes("ANSWER_TURN_0"), conversationIds: ids };
  fs.writeFileSync(path.join(out, "requests.json"), JSON.stringify(requests, null, 2)); fs.writeFileSync(path.join(out, "verdict.json"), JSON.stringify(verdict, null, 2)); console.log(JSON.stringify(verdict, null, 2));
} finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
