import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

if (!process.env.PI_0991_TEST_ROOT) {
  test("installed 0.99.1 bundle entries", { skip: "Set PI_0991_TEST_ROOT to the isolated npm candidate" }, () => {});
} else {
  const root = resolve(process.env.PI_0991_TEST_ROOT);
  const scratch = resolve("test-results/pi-0991-upgrade/host/rpc-agent");
  mkdirSync(scratch, { recursive: true });
  const env = { ...process.env, PI_CODING_AGENT_DIR: scratch };
  const overlay = JSON.parse(readFileSync("tools/pi-prompt-stability/manifest-0.99.1.json"));
  const shared = overlay.host.files.filter((e) => e.path.startsWith("dist/bundle/chunks/chunk-") && e.before === null);

  test("CLI and RPC entrypoints reach the same rebuilt host chunks", () => {
    for (const entry of ["cli-runtime.js", "rpc-entry.js", "index.js"]) {
      const source = readFileSync(join(root, "dist/bundle", entry), "utf8");
      assert.ok(shared.some((e) => source.includes(e.path.split("/").at(-1))), `${entry} missing rebuilt host graph`);
    }
  });

  test("actual bundled CLI launches RPC with isolated settings and responds to get_state", async () => {
    const child = spawn(process.execPath, [join(root, "dist/bundle/cli.js"), "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session"],
      { cwd: scratch, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timer;
    try {
      const response = new Promise((accept, reject) => {
        timer = setTimeout(() => reject(new Error(`RPC timeout: ${out}\n${err}`)), 15000);
        child.on("error", reject);
        child.stderr.on("data", (data) => { err += data; });
        child.stdout.on("data", (data) => {
          out += data;
          for (const line of out.split("\n")) {
            try {
              const reply = JSON.parse(line);
              if (reply.id === "probe") accept(reply);
            } catch {}
          }
        });
        child.on("exit", (code) => reject(new Error(`RPC exited ${code}: ${out}\n${err}`)));
      });
      child.stdin.write(JSON.stringify({ id: "probe", type: "get_state" }) + "\n");
      const reply = await response;
      assert.equal(reply.success, true);
      assert.equal(reply.command, "get_state");
      console.log(JSON.stringify({ rpc: reply, settingsDirectory: scratch, modelRequests: 0 }));
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      if (child.exitCode === null) await new Promise((accept) => child.once("exit", accept));
    }
  });
}
