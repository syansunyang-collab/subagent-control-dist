#!/usr/bin/env node
// dispatch-core/seed_minimal.mjs 与 task_package_profiles.mjs 的 JSON 桥接面。
// Python 版 seed_minimal.py 没有 CLI：本文件是波 4b 新增的内部接口，只服务两类调用方——
// 留在 Python 的离线校验器（acceptance_contract_check.py）与 live canary 脚本，
// 它们过去直接 import 编译链模块，现在改经 _tool_common.node_json 取 JSON。
// 不是给模型用的日常入口；派发一律走 `node ops/tools/dispatch_prepare.mjs`。
// 输出契约：stdout 一个 JSON 对象 {"result": <值>}，退出码 0；ToolError → stderr 文案 + 退出码 1。
import process from "node:process";

import { ToolError, canonicalJson, readStdinText } from "./dispatch-core/_tool_common.mjs";
import { cardFor, exampleSeed, expandSeed } from "./dispatch-core/seed_minimal.mjs";
import { profileFor } from "./dispatch-core/task_package_profiles.mjs";

const PROGRAM = "seed_minimal.mjs";
const USAGE = `usage: ${PROGRAM} {example-seed,card,profile,expand} [--route-id ROUTE_ID] [--seed-stdin]\n`
  + `       ${PROGRAM} --self-test`;
const SELF_TEST_ROUTE = "explorer-agent__codebase-scan";

class ArgumentError extends Error {}

function parseArgs(argv) {
  const args = { command: null, routeId: null, seedStdin: false, selfTest: false, help: false };
  const tokens = [...argv];
  while (tokens.length) {
    const token = tokens.shift();
    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }
    if (token === "--self-test") {
      args.selfTest = true;
      continue;
    }
    if (token === "--seed-stdin") {
      args.seedStdin = true;
      continue;
    }
    if (token === "--route-id") {
      if (!tokens.length) throw new ArgumentError("argument --route-id: expected one argument");
      args.routeId = tokens.shift();
      continue;
    }
    if (token.startsWith("--route-id=")) {
      args.routeId = token.slice("--route-id=".length);
      continue;
    }
    if (token.startsWith("-")) throw new ArgumentError(`unrecognized arguments: ${token}`);
    if (args.command !== null) throw new ArgumentError(`unrecognized arguments: ${token}`);
    args.command = token;
  }
  return args;
}

function run(args) {
  if (args.command === "expand") {
    if (!args.seedStdin) throw new ToolError("expand requires --seed-stdin");
    return expandSeed(JSON.parse(readStdinText("seed")));
  }
  if (!args.routeId) throw new ToolError(`${args.command} requires --route-id`);
  if (args.command === "example-seed") return exampleSeed(args.routeId);
  if (args.command === "card") return cardFor(args.routeId);
  if (args.command === "profile") return profileFor(args.routeId);
  throw new ToolError(`unknown command: ${args.command}`);
}

function selfTest() {
  const checks = {};
  const example = exampleSeed(SELF_TEST_ROUTE);
  checks.example_seed_carries_route_id = example.route_id === SELF_TEST_ROUTE;
  const card = cardFor(SELF_TEST_ROUTE);
  checks.card_is_object_or_null = card === null || (typeof card === "object" && !Array.isArray(card));
  const profile = profileFor(SELF_TEST_ROUTE);
  checks.profile_has_card = typeof profile === "object" && profile !== null && "card" in profile;
  const expanded = expandSeed(example);
  checks.expand_seed_returns_task_package = typeof expanded === "object" && expanded !== null && Boolean(expanded.route_id);
  // 未知 route 在 dispatch-core 里是 KeyError（Python 同源），不是 ToolError；只断言点名了 route_id。
  checks.unknown_route_is_rejected = (() => {
    try {
      exampleSeed("no-such-agent__no-such-route");
      return false;
    } catch (error) {
      return String(error?.message ?? "").includes("no-such-agent__no-such-route");
    }
  })();
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return { tool: "seed_minimal", status: failed.length ? "failed" : "ok", route_id: SELF_TEST_ROUTE, checks, failed };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
  } else if (args.selfTest) {
    const data = selfTest();
    process.stdout.write(`${canonicalJson(data)}\n`);
    process.exitCode = data.status === "ok" ? 0 : 1;
  } else if (!args.command) {
    process.stderr.write(`${USAGE}\n${PROGRAM}: error: a subcommand or --self-test is required\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write(`${canonicalJson({ result: run(args) })}\n`);
    process.exitCode = 0;
  }
} catch (error) {
  if (error instanceof ArgumentError) {
    process.stderr.write(`${USAGE}\n${PROGRAM}: error: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
