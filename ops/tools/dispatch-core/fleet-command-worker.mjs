import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { terminateChildProcessTree } from "../pi_child_bash_process_tree.mjs";

// Node 从 v18 起拒绝直接 spawn .cmd/.bat，而 Python 的 CreateProcess 能直接执行它们；
// 监督进程必须保持 dispatch-core/_py.mjs pySpawnSync 的批处理语义，否则 Windows 命令节点
// 在 spawn 时就被 EINVAL 拒绝（见 tests/control_plane/dispatch_core_fleet_parity.test.mjs C4）。
function spawnFleetCommand(argv, options) {
  const [command, ...args] = argv;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(String(command))) {
    const quote = (value) => {
      const text = String(value);
      return /[\s"^&|<>()%!]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
    };
    return spawn([command, ...args].map(quote).join(" "), [], { ...options, shell: true });
  }
  return spawn(command, args, options);
}

// 由调度器同步等待的监督进程；独立事件循环可在 tick 持锁时响应取消。
export async function runFleetCommand(specPath) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  if (existsSync(spec.cancel_path)) {
    writeFileSync(spec.result_path, JSON.stringify({ cancelled: true, confirmed: true, not_executed: true }));
    return 0;
  }
  const child = spawnFleetCommand(spec.argv, {
    cwd: spec.cwd, env: process.env, detached: process.platform !== "win32",
    windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
  });
  let proof = null;
  let cancelled = false;
  let timedOut = false;
  const started = Date.now();
  const timer = setInterval(() => {
    cancelled ||= existsSync(spec.cancel_path);
    timedOut ||= Date.now() - started >= spec.timeout_ms;
    if ((cancelled || timedOut) && child.exitCode === null && child.signalCode === null && child.pid) {
      proof = terminateChildProcessTree(child.pid);
    }
  }, 100);
  try {
    const result = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ error: error.message, error_code: error.code }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    writeFileSync(spec.result_path, JSON.stringify({ ...result, cancelled, timed_out: timedOut, confirmed: proof?.confirmed ?? !(cancelled || timedOut), proof }));
    return result.code ?? 1;
  } finally {
    clearInterval(timer);
  }
}
