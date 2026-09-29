export {
  AGGREGATION_WORKER_ENTRY,
  BUNDLED_MODULE,
  CONFIG_WORKER_ENTRY,
  EXPECTED_CONTRACT_VERSION,
  DEFAULT_CONTROL_REPO_PATH,
  LOOPBACK_HOST,
  PANEL_ROOT,
  PanelError,
  assertContractVersion,
  buildAsyncCoreOptions,
  createAsyncTaskService,
  derivePort,
  loadAsyncCore,
  resolveAsyncCorePath,
  resolveControlRepoPath,
  resolvePanelPaths,
  resolvePanelRoot,
  resolvePanelStateRoot,
  resolveRegistryRoot,
  resolveRuntimeAssetRoot,
  validateControlRepo,
} from "./async-core.mjs";
export { PanelProjection } from "./projection.mjs";
export { createPanelServer, runCli, startServer } from "./server.mjs";

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./server.mjs";

function requiredValue(argv, index, argument) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`启动参数缺少值：${argument}`);
  }
  return value;
}

function setControlRepo(options, value) {
  if (options.controlRepoPath && path.resolve(options.controlRepoPath) !== path.resolve(value)) {
    throw new Error("--control-repo 与 --control-root 指向不同路径");
  }
  options.controlRepoPath = value;
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const options = { browser: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--browser") {
      options.browser = true;
      continue;
    }
    if (argument.startsWith("--control-repo=")) {
      const value = argument.slice("--control-repo=".length);
      if (!value.trim()) throw new Error("--control-repo 不能为空");
      setControlRepo(options, value);
      continue;
    }
    if (argument === "--control-repo" || argument === "--control-root") {
      setControlRepo(options, requiredValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (["--host", "--port", "--parent-pid"].includes(argument)) {
      const value = requiredValue(argv, index, argument);
      if (argument === "--host" && value !== "127.0.0.1") {
        throw new Error("服务只允许绑定 127.0.0.1");
      }
      if (argument === "--port") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port 必须是 0-65535 的整数");
        options.port = port;
      }
      if (argument === "--parent-pid") {
        const parentPid = Number(value);
        if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error("--parent-pid 必须是正整数");
        options.parentPid = parentPid;
      }
      index += 1;
      continue;
    }
    throw new Error(`未知启动参数：${argument}`);
  }
  return options;
}

function openBrowser(url) {
  if (process.env.AGENT_PANEL_NO_BROWSER === "1") return;
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/d", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }
  const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseCliArgs(argv);
    const server = await runCli(options);
    if (options.browser) openBrowser(server.config.resolvedLoopbackUrl);
    return server;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return null;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) await main();
