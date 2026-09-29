#!/usr/bin/env node
// ops/tools/review_evidence.py 的 CLI 同形复刻：只接受 --self-test；任何其它调用都按 Python 一样
// 立即报错，因为直接生成证据包属于 dispatch_prepare.py 的内部步骤。
import process from "node:process";

import { ToolError } from "./dispatch-core/_tool_common.mjs";
import { selfTest } from "./review_evidence.selftest.mjs";

const PROGRAM = "review_evidence.mjs";
const USAGE = `usage: ${PROGRAM} [-h] [--self-test]`;
const DESCRIPTION = "为静态终验生成有界机械证据包。日常派发由 dispatch_prepare.mjs 自动调用。";

class ArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgumentError";
  }
}

class HelpRequested extends Error {}

function helpText() {
  return `${USAGE}\n\n${DESCRIPTION}\n`;
}

export function parseArgs(argv) {
  const args = { selfTest: false };
  for (const token of argv) {
    if (token === "-h" || token === "--help") throw new HelpRequested();
    if (token === "--self-test") {
      args.selfTest = true;
      continue;
    }
    throw new ArgumentError(`unrecognized arguments: ${token}`);
  }
  return args;
}

export function main(argv) {
  const args = parseArgs(argv);
  if (!args.selfTest) throw new ToolError("direct evidence preparation is internal; use dispatch_prepare.mjs");
  selfTest();
  process.stdout.write("review_evidence self-test: pass\n");
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
  } else if (["ToolError", "ValueError"].includes(error?.name)) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
