#!/usr/bin/env node
// 构建并启动全局 Agent Panel。ops/tools/agent_panel_launcher.py 的 CLI 复刻：
// flag 集合、分支顺序、JSON 输出形态（indent=2、键按插入序、不排序）与退出码规则一致。
import process from "node:process";

import {
  BUILD_STATE_PATH,
  ENDPOINT_PATH,
  MANIFEST_PATH,
  SHELL_STATE_PATH,
  backgroundBuild,
  deriveEndpoint,
  ensureAgentPanel,
  isOurPanel,
  probeHealth,
  readJson,
  selfTest,
  validManifest,
} from "./dispatch-core/agent_panel_launcher.mjs";

const USAGE = "usage: agent_panel_launcher.mjs [-h] [--build] [--status] [--self-test]";
const FLAGS = new Map([
  ["--background-build", "backgroundBuild"],
  ["--build", "build"],
  ["--status", "status"],
  ["--self-test", "selfTest"],
]);

function parseArgs(argv) {
  const args = { backgroundBuild: false, build: false, status: false, selfTest: false, help: false };
  for (const token of argv) {
    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }
    const key = FLAGS.get(token);
    if (!key) {
      process.stderr.write(`${USAGE}\nagent_panel_launcher.mjs: error: unrecognized arguments: ${token}\n`);
      process.exit(2);
    }
    args[key] = true;
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      `${USAGE}\n\n构建并启动全局 Agent Panel。\n\noptions:\n` +
        "  -h, --help   show this help message and exit\n" +
        "  --build      重新构建全局桌面壳；服务运行中时先关闭面板。\n" +
        "  --status     查看 launcher、构建和窗口状态。\n" +
        "  --self-test  运行不启动窗口的机械自测。\n",
    );
    return 0;
  }
  if (args.backgroundBuild || args.build) return await backgroundBuild();
  let result;
  if (args.selfTest) {
    result = selfTest();
  } else if (args.status) {
    const endpoint = deriveEndpoint();
    const health = await probeHealth(Number(endpoint.port));
    result = {
      status: isOurPanel(health, endpoint) ? "running" : "stopped",
      monitor_root: health?.control_repo_path ?? null,
      endpoint: readJson(ENDPOINT_PATH),
      shell: readJson(SHELL_STATE_PATH),
      build: readJson(BUILD_STATE_PATH),
      manifest: readJson(MANIFEST_PATH),
      // 与启动器自身复用判据一致：壳存在且构建对应当前发布。
      reusable: Boolean(validManifest().executable),
    };
  } else {
    result = await ensureAgentPanel();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return ["failed", "fail"].includes(result.status) ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
