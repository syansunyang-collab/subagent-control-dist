#!/usr/bin/env node
// ops/tools/runtime_retention.py 的 CLI 同形复刻：四个 flag、默认值、main() 分支顺序与退出码规则一致。
// self_test 的实现留在 dispatch-core/runtime_retention.mjs（Python 侧同样内联在工具模块里，没有伴生自测模块）。
import process from "node:process";

import { ToolError, emit } from "./dispatch-core/_tool_common.mjs";
import {
  buildData,
  buildText,
  resolveAsyncTasksDir,
  selfTest,
  setAsyncTasksDir,
} from "./dispatch-core/runtime_retention.mjs";

const PROGRAM = "runtime_retention.mjs";
const USAGE = `usage: ${PROGRAM} [-h] [--apply] [--task-root TASK_ROOT] [--self-test] [--format {text,json}]`;
const DESCRIPTION = "清理运行态旧文件："
  + ".runtime/cockpit/state/ 下的旧运行态文件、"
  + ".runtime/cockpit/async_tasks/ 下终态超过 7 天的任务目录、"
  + "tmp/dispatch_prepare/ 下超过 7 天的任务包文件，以及这些任务对应的用户级定位索引。"
  + "本工具只负责清场。";

const OPTIONS = [
  { flag: "--apply", dest: "apply", kind: "flag", help: "实际删除候选文件；默认只预览。" },
  { flag: "--task-root", dest: "taskRoot", kind: "value", metavar: "TASK_ROOT", help: "覆盖 async 任务根；优先级高于 SUBAGENT_TASK_ROOT 和仓内默认。" },
  { flag: "--self-test", dest: "selfTest", kind: "flag", help: "运行隔离的 registry 生命周期回归后退出。" },
  { flag: "--format", dest: "format", kind: "value", metavar: "{text,json}", choices: ["text", "json"], help: "输出格式。（默认：json）" },
];

class ArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgumentError";
  }
}

class HelpRequested extends Error {}

function helpText() {
  const lines = [USAGE, "", DESCRIPTION, "", "options:", "  -h, --help            show this help message and exit"];
  for (const option of OPTIONS) {
    const invocation = option.kind === "value" ? `${option.flag} ${option.metavar}` : option.flag;
    lines.push(`  ${invocation}`);
    lines.push(`      ${option.help}`);
  }
  return `${lines.join("\n")}\n`;
}

// argparse 允许唯一前缀缩写；这里保持同一语义。
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
  const args = { apply: false, taskRoot: "", selfTest: false, format: "json" };
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

export function main(argv) {
  const args = parseArgs(argv);
  try {
    if (args.selfTest) return emit(selfTest(), args.format, "runtime_retention self-test: pass\n");
    if (args.taskRoot) setAsyncTasksDir(resolveAsyncTasksDir(args.taskRoot));
    const data = buildData(args);
    return emit(data, args.format, buildText(data));
  } catch (error) {
    if (!(error instanceof ToolError || error?.name === "ToolError")) throw error;
    return emit(
      { tool: "runtime_retention", status: "failed", exit_code: 1, error: error.message },
      "text",
      `failed: ${error.message}`,
    );
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
