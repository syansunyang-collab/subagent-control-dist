#!/usr/bin/env node
// ops/tools/subagent_preload.py 的 CLI 同形复刻：解析 argv → 调 dispatch-core 导出 → emit。
// 子命令 render 与顶层 --self-test/--format 与 Python argparse（含 subparsers）等价；
// argparse 允许 --format 同时出现在顶层与 render 子命令，这里合并为单一全局解析（语义等价）。
import path from "node:path";
import process from "node:process";

import { ROOT, ToolError, emit, pathlibJoin, resolveLikePython } from "./dispatch-core/_tool_common.mjs";
import { renderTaskMaterialFile } from "./dispatch-core/subagent_preload.mjs";
import { selfTest } from "./subagent_preload.selftest.mjs";

const PROGRAM = "subagent_preload.mjs";
const USAGE = `usage: ${PROGRAM} [-h] [--self-test] [--format {text,json}] {render} ...`;
const DESCRIPTION =
  "读取 task package 文件并渲染完整任务材料（角色运行提示词 + 公共提示词 + 能力提示词 + 任务包 + 输出模板），" +
  "供 direct file-ref 派发的子代理启动后读取；async 路线的任务材料文件也由本渲染逻辑生成。";
const EPILOG =
  "典型用法：node ops/tools/subagent_preload.mjs render --package tmp/dispatch_prepare/<id>.task-package.json\n" +
  "使用时机与边界见 ops/policies/runtime-tools.md";

class ArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgumentError";
  }
}

class HelpRequested extends Error {}

function helpText() {
  return (
    `${USAGE}\n\n${DESCRIPTION}\n\n` +
    "options:\n" +
    "  -h, --help            show this help message and exit\n" +
    "  --self-test           运行内置自测并报告检查项结果。\n" +
    "  --format {text,json}\n\n" +
    "subcommands:\n" +
    "  render --package PACKAGE [--format {text,json}]\n" +
    `      包含 task_package 的 JSON 文件路径（task_package 包装或裸对象均可）。\n\n${EPILOG}\n`
  );
}

function takeValue(tokens, flag, inline) {
  if (inline !== null) return inline;
  if (!tokens.length) throw new ArgumentError(`argument ${flag}: expected one argument`);
  return tokens.shift();
}

export function parseArgs(argv) {
  const args = { command: null, package: null, format: "text", selfTest: false };
  const tokens = [...argv];
  let inRender = false;
  while (tokens.length) {
    const token = tokens.shift();
    if (token === "-h" || token === "--help") throw new HelpRequested();
    const isFlag = token.startsWith("--");
    const equals = isFlag ? token.indexOf("=") : -1;
    const name = equals > 0 ? token.slice(0, equals) : token;
    const inline = equals > 0 ? token.slice(equals + 1) : null;
    if (!isFlag) {
      if (args.command !== null) throw new ArgumentError(`unrecognized arguments: ${token}`);
      if (token !== "render") {
        throw new ArgumentError(`argument command: invalid choice: '${token}' (choose from 'render')`);
      }
      args.command = "render";
      inRender = true;
      continue;
    }
    if (name === "--self-test") {
      if (inline !== null) throw new ArgumentError(`argument --self-test: ignored explicit argument '${inline}'`);
      args.selfTest = true;
      continue;
    }
    if (name === "--format") {
      const value = takeValue(tokens, "--format", inline);
      if (!["text", "json"].includes(value)) {
        throw new ArgumentError(`argument --format: invalid choice: '${value}' (choose from 'text', 'json')`);
      }
      args.format = value;
      continue;
    }
    if (name === "--package") {
      if (!inRender) throw new ArgumentError(`unrecognized arguments: ${token}`);
      args.package = takeValue(tokens, "--package", inline);
      continue;
    }
    throw new ArgumentError(`unrecognized arguments: ${token}`);
  }
  if (args.command === "render" && !args.package) {
    throw new ArgumentError("the following arguments are required: --package");
  }
  return args;
}

export function main(argv) {
  const args = parseArgs(argv);
  try {
    if (args.selfTest) {
      const data = selfTest();
      const text = data.status === "ok" ? "subagent_preload self-test passed" : "subagent_preload self-test failed";
      return emit(data, args.format, text);
    }
    if (args.command === "render") {
      const context = renderTaskMaterialFile(resolveLikePython(pathlibJoin(ROOT, args.package)));
      const data = { status: "ok", package: args.package, additional_context: context };
      return emit(data, args.format, context);
    }
    process.stdout.write(helpText());
    return 2;
  } catch (error) {
    if (error instanceof ToolError || error?.name === "ToolError") {
      return emit({ status: "failed", error: String(error.message) }, args.format, `failed: ${error.message}`);
    }
    throw error;
  }
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
  } else {
    throw error;
  }
}
