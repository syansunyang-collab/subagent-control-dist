import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Script, createContext } from "node:vm";
import test from "node:test";

const root = process.env.PI_WS_TEST_PI_AI_ROOT || "E:/ControlPlane/web/app/node_modules/@earendil-works/pi-ai";
const source = await readFile(join(root, "dist/api/openai-codex-responses.js"), "utf8");
const start = source.indexOf("const SESSION_WEBSOCKET_CACHE_TTL_MS");
const end = source.indexOf("let _cachedWebsocket", start);
assert.ok(start >= 0 && end > start, "supported provider state section");
const section = source.slice(start, end).replace(/^export /gm, "");
const factory = new Script(`(function(){${section};return {acquireWebSocketAttempt,recordWebSocketFailure,recordWebSocketSuccess,releaseWebSocketRecoveryProbe,getOpenAICodexWebSocketDebugStats,resetOpenAICodexWebSocketDebugStats};})()`);

function fixture() {
  let now = 1000;
  class WebSocketCloseError extends Error { constructor(code) { super("close " + code); this.code = code; } }
  const context = createContext({
    Date: { now: () => now }, WebSocketCloseError,
    WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE: 1009,
    registerSessionResourceCleanup() {}, closeWebSocketSilently() {}, clearTimeout() {},
    formatThrownValue: String,
  });
  return { api: factory.runInContext(context), load: () => factory.runInContext(context), advance: (ms) => { now += ms; }, oversize: () => new WebSocketCloseError(1009) };
}

test("actual provider permits one cooldown probe and releases aborted probes", () => {
  const f = fixture(); const a = f.api;
  assert.equal(a.acquireWebSocketAttempt("s", 1000).allowed, true);
  a.recordWebSocketFailure("s", new Error("transport"), 1000);
  assert.equal(a.acquireWebSocketAttempt("s", 1000).allowed, false);
  f.advance(30000);
  assert.equal(a.acquireWebSocketAttempt("s", 1000).recoveryProbe, true);
  assert.equal(a.acquireWebSocketAttempt("s", 1000).allowed, false);
  a.releaseWebSocketRecoveryProbe("s", true);
  assert.equal(a.acquireWebSocketAttempt("s", 1000).allowed, true);
  a.recordWebSocketSuccess("s", true);
  assert.equal(a.getOpenAICodexWebSocketDebugStats("s").websocketFallbackActive, false);
  assert.equal(a.getOpenAICodexWebSocketDebugStats("s").websocketRecoveries, 1);
});

test("actual provider backs off to five minutes and gates oversize recovery by body shrinkage", () => {
  const f = fixture(); const a = f.api;
  for (const cooldown of [30000, 60000, 120000, 240000, 300000, 300000]) {
    a.recordWebSocketFailure("s", new Error("transport"), 1000);
    f.advance(cooldown - 1);
    assert.equal(a.acquireWebSocketAttempt("s", 1000).allowed, false);
    f.advance(1);
    assert.equal(a.acquireWebSocketAttempt("s", 1000).allowed, true);
  }
  a.recordWebSocketFailure("large", f.oversize(), 1000);
  f.advance(1000000);
  assert.equal(a.acquireWebSocketAttempt("large", 801).allowed, false);
  assert.equal(a.acquireWebSocketAttempt("large", 800).recoveryProbe, true);
});

test("independent provider module instances share state and reset only the selected session", () => {
  const f = fixture(); const b = f.load();
  f.api.recordWebSocketFailure("a", new Error("transport"), 1000);
  f.api.recordWebSocketFailure("b", new Error("transport"), 1000);
  assert.equal(b.acquireWebSocketAttempt("a", 1000).allowed, false);
  b.resetOpenAICodexWebSocketDebugStats("a");
  assert.equal(f.api.acquireWebSocketAttempt("a", 1000).allowed, true);
  assert.equal(f.api.acquireWebSocketAttempt("b", 1000).allowed, false);
});
