#!/usr/bin/env node
// ops/tools/task_package_build.py 的 CLI 同形复刻：flag 集合、默认值、main() 分支顺序与退出码规则
// 与 Python argparse 一致（该工具没有 --format 选项）。业务逻辑全在 dispatch-core/task_package_build.mjs；
// 本文件只做「恰好一个输入源」这类 argparse.Namespace 形状的 argv 归约（Python 侧同样是 CLI 专属的
// load_seed_from_args，未进 dispatch-core 导出，见迁移回报）。
import process from "node:process";

import { ToolError, readStdinText } from "./dispatch-core/_tool_common.mjs";
import {
  buildAndWriteOutput,
  buildPackage,
  loadSeed,
  normRepoPath,
  parseSeed,
  renderMessage,
  routeProfiles,
  sampleSeed,
} from "./dispatch-core/task_package_build.mjs";
import { selfTest } from "./task_package_build.selftest.mjs";

const PROGRAM = "task_package_build.mjs";
const USAGE = `usage: ${PROGRAM} [-h] [--seed SEED] [--seed-stdin] [--sample-route SAMPLE_ROUTE]`
  + " [--output OUTPUT] [--message] [--print-json] [--list-routes] [--self-test]";
const DESCRIPTION =
  "将主代理填写的 package_seed JSON 校验并组装成完整的 task_package_envelope JSON。\n" +
  "日常派发请直接用 dispatch_prepare.mjs（已封装本步骤）；本工具用于单独构建并检视完整包，或调试构包问题。";
const EPILOG =
  "典型用法：\n" +
  "  node task_package_build.mjs --seed seed.json --output notes/manifests/pkg.json\n" +
  "  node task_package_build.mjs --sample-route verify-agent__code-verification --message\n" +
  "  node task_package_build.mjs --list-routes\n\n" +
  "规则真源：ops/policies/runtime-tools.md";

const OPTIONS = [
  { flag: "--seed", dest: "seed", kind: "value" },
  { flag: "--seed-stdin", dest: "seedStdin", kind: "flag" },
  { flag: "--sample-route", dest: "sampleRoute", kind: "value" },
  { flag: "--output", dest: "output", kind: "value" },
  { flag: "--message", dest: "message", kind: "flag" },
  { flag: "--print-json", dest: "printJson", kind: "flag" },
  { flag: "--list-routes", dest: "listRoutes", kind: "flag" },
  { flag: "--self-test", dest: "selfTest", kind: "flag" },
];

class ArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgumentError";
  }
}

class HelpRequested extends Error {}

function helpText() {
  return `${USAGE}\n\n${DESCRIPTION}\n\n${EPILOG}\n`;
}

function matchOption(token) {
  const exact = OPTIONS.find((option) => option.flag === token);
  if (exact) return exact;
  const prefixed = OPTIONS.filter((option) => option.flag.startsWith(token));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new ArgumentError(`ambiguous option: ${token} could match ${prefixed.map((option) => option.flag).join(", ")}`);
  }
  return null;
}

export function parseArgs(argv) {
  const args = {
    seed: null,
    seedStdin: false,
    sampleRoute: null,
    output: null,
    message: false,
    printJson: false,
    listRoutes: false,
    selfTest: false,
  };
  const tokens = [...argv];
  while (tokens.length) {
    const token = tokens.shift();
    if (token === "-h" || token === "--help") throw new HelpRequested();
    if (!token.startsWith("--")) throw new ArgumentError(`unrecognized arguments: ${token}`);
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const inline = equals >= 0 ? token.slice(equals + 1) : null;
    const option = matchOption(name);
    if (!option) throw new ArgumentError(`unrecognized arguments: ${token}`);
    if (option.kind === "flag") {
      if (inline !== null) throw new ArgumentError(`argument ${option.flag}: ignored explicit argument '${inline}'`);
      args[option.dest] = true;
      continue;
    }
    let value = inline;
    if (value === null) {
      if (!tokens.length) throw new ArgumentError(`argument ${option.flag}: expected one argument`);
      value = tokens.shift();
    }
    args[option.dest] = value;
  }
  return args;
}

// Python load_seed_from_args：argparse.Namespace 形状的输入源归约，非业务逻辑，未进 dispatch-core 导出。
function loadSeedFromArgs(args) {
  const sources = [Boolean(args.seed), Boolean(args.seedStdin), Boolean(args.sampleRoute)];
  if (sources.filter(Boolean).length !== 1) {
    throw new ToolError("provide exactly one of --seed, --seed-stdin or --sample-route");
  }
  if (args.sampleRoute) return sampleSeed(args.sampleRoute);
  if (args.seedStdin) return parseSeed(readStdinText("--seed-stdin"));
  return loadSeed(args.seed);
}

export function main(argv) {
  const args = parseArgs(argv);
  if (args.listRoutes) {
    process.stdout.write(`${Object.keys(routeProfiles()).sort().join("\n")}\n`);
    return 0;
  }
  if (args.selfTest) {
    selfTest();
    process.stdout.write("task_package_build self-test: pass\n");
    return 0;
  }
  if (args.message && args.printJson) {
    throw new ToolError("--message and --print-json cannot be used together");
  }
  const seed = loadSeedFromArgs(args);
  const pkg = args.output ? buildAndWriteOutput(seed, args.output) : buildPackage(seed);
  if (args.message) {
    process.stdout.write(`${renderMessage(pkg)}\n`);
  } else if (args.output && !args.printJson) {
    const taskPackage = pkg.task_package;
    process.stdout.write(
      `wrote output=${normRepoPath(args.output)} package_id=${taskPackage.package_id} route_id=${seed.route_id ?? ""}\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify(pkg, null, 2)}\n`);
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof HelpRequested) {
    process.stdout.write(helpText());
    process.exitCode = 0;
  } else if (error instanceof ArgumentError) {
    process.stderr.write(`${USAGE}\n${PROGRAM}: error: ${error.message}\n`);
    process.exitCode = 2;
  } else if (["ToolError", "KeyError", "ValueError"].includes(error?.name)) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
