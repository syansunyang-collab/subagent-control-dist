#!/usr/bin/env node
// ops/tools/task_package_lint.py 的 CLI 同形复刻：flag 集合、默认值、main() 分支顺序与退出码规则
// 与 Python argparse 一致。校验逻辑全在 dispatch-core/task_package_lint.mjs；本文件只做「恰好一个
// 输入源」这类 argparse.Namespace 形状的 argv 归约（Python 侧同样是 CLI 专属的 load_package_from_args，
// 未进 dispatch-core 导出，见迁移回报）。
import process from "node:process";

import { ToolError, emit, readStdinText } from "./dispatch-core/_tool_common.mjs";
import { loadPackage, lintPackage, parsePackage } from "./dispatch-core/task_package_lint.mjs";
import { selfTest } from "./task_package_lint.selftest.mjs";

const PROGRAM = "task_package_lint.mjs";
const USAGE = `usage: ${PROGRAM} [-h] [--file FILE] [--package PACKAGE] [--stdin]`
  + " [--format {text,json}] [--self-test]";
const DESCRIPTION =
  "对已构建的 task_package_envelope JSON 做静态校验：路由固定头匹配、scope 路径合法、handoff 契约完整等。\n" +
  "主代理在派发前或 CI 流水线中调用，确认任务包格式正确、不含已知的遗留字段和结构错误。";
const EPILOG =
  "典型用法：\n" +
  "  node task_package_lint.mjs --file notes/manifests/pkg.json\n" +
  "  node task_package_build.mjs --seed seed.json | node task_package_lint.mjs --stdin\n\n" +
  "规则真源：ops/policies/runtime-tools.md";

const OPTIONS = [
  { flag: "--file", dest: "file", kind: "value" },
  { flag: "--package", dest: "package", kind: "value" },
  { flag: "--stdin", dest: "stdin", kind: "flag" },
  { flag: "--format", dest: "format", kind: "value", choices: ["text", "json"] },
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
  const args = { file: null, package: null, stdin: false, format: "text", selfTest: false };
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
    if (option.choices && !option.choices.includes(value)) {
      throw new ArgumentError(
        `argument ${option.flag}: invalid choice: '${value}' (choose from ${option.choices.map((item) => `'${item}'`).join(", ")})`,
      );
    }
    args[option.dest] = value;
  }
  return args;
}

// Python load_package_from_args：argparse.Namespace 形状的输入源归约，非业务逻辑，未进 dispatch-core 导出。
function loadPackageFromArgs(args) {
  const sources = [Boolean(args.file), Boolean(args.package), Boolean(args.stdin)];
  if (sources.filter(Boolean).length !== 1) {
    throw new ToolError("provide exactly one of --file, --package or --stdin");
  }
  if (args.stdin) return parsePackage(readStdinText("--stdin"));
  if (args.package) return loadPackage(args.package);
  return loadPackage(args.file);
}

export function main(argv) {
  const args = parseArgs(argv);
  if (args.selfTest) {
    selfTest();
    process.stdout.write("task_package_lint self-test: pass\n");
    return 0;
  }
  const pkg = loadPackageFromArgs(args);
  const issues = lintPackage(pkg);
  const data = { status: issues.length ? "fail" : "pass", issue_count: issues.length, issues };
  const text = [`status: ${data.status}`, `issue_count: ${data.issue_count}`, ...issues.map((issue) => `- ${issue}`)].join("\n");
  emit(data, args.format, text);
  return issues.length ? 1 : 0;
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
