import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLabHarness } from "./lab-harness.ts";

for (const reason of ["missing", "syntax-error", "invalid-fields", "read-failed"]) {
  test(`configuration ${reason} is visible and never starts a summarizer`, async () => {
    const h = makeLabHarness({ mode: "budget-summary", keepRecentToolTurns: 0 });
    const file = join(h.dir, ".pi/agent/context-prune/policy-lab.json");
    try {
      await h.sessionStart();
      if (reason === "missing") rmSync(file);
      if (reason === "syntax-error") writeFileSync(file, "{");
      if (reason === "invalid-fields") writeFileSync(file, JSON.stringify({ mode: "cold-mask", stageSummary: "false" }));
      if (reason === "read-failed") { rmSync(file); mkdirSync(file); }
      await h.reloadExtension();
      const config = h.labEvents().at(-1).config;
      assert.equal(config.mode, "cold-mask");
      assert.equal(config.stageSummary, false);
      assert(h.notifications.some(message => message.includes(reason)));
      assert.equal(h.notifications.filter(message => message.includes("using cold-mask")).length, 1);
      h.prompt("task");
      await h.turn(["old", "recent"], { resultText: () => "x".repeat(60000) });
      await h.request(); await h.request(); await h.turnEnd(); await h.agentEnd(); await h.settle();
      assert.equal(h.summarizerPrompts().length, 0);
    } finally { h.cleanup(); }
  });
}
