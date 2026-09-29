#!/usr/bin/env node
// ops/tools/subagent_handoff_check.py 的 CLI 同形入口：解析 argv → 调 dispatch-core 导出 → emit。
// flag 集合、默认值、互斥与 --format json|text 输出与 Python argparse 一致（见 py 侧 parse_args 的六个 add_argument）。
import process from "node:process";
// canonical 自检沿用 runner 下发的 producer 根，不继承业务命令的 target 根。
const checkerSpec = process.env.PI_TASK_RESULT_HANDOFF_CHECK
  ? JSON.parse(process.env.PI_TASK_RESULT_HANDOFF_CHECK) : null;
const packageFlag = checkerSpec?.argv?.indexOf("--task-package") ?? -1;
if (packageFlag >= 0 && process.argv.includes(checkerSpec.argv[packageFlag + 1])
    && checkerSpec.env?.SUBAGENT_PROJECT_ROOT) {
  process.env.SUBAGENT_PROJECT_ROOT = checkerSpec.env.SUBAGENT_PROJECT_ROOT;
}
const { ToolError, emit, readStdinText, repoPath } = await import("./dispatch-core/_tool_common.mjs");
const { pyReadTextReplace } = await import("./dispatch-core/_py.mjs");
const {
  buildText,
  checkHandoff,
  loadJson,
  loadTaskPackageById,
  runSelfTest,
  taskPath,
} = await import("./dispatch-core/subagent_handoff_check.mjs");

const PROGRAM = "subagent_handoff_check.mjs";
const USAGE = `usage: ${PROGRAM} [-h] [--task-package TASK_PACKAGE] [--package-id PACKAGE_ID]`
  + " [--handoff-file HANDOFF_FILE] [--handoff-stdin] [--format {text,json}] [--self-test]";
const DESCRIPTION = "子代理退出前机械自检 FINAL_HANDOFF 的结构完整性、标识一致性和引用路径有效性。"
  + "子代理在输出 FINAL_HANDOFF 之前调用此工具，取得 mechanical_check=pass 后才能退出；"
  + "主代理也可用此工具验收子代理回执。";
const EPILOG = `典型用法：node ops/tools/${PROGRAM} --package-id <id> --handoff-stdin < handoff.yaml\n`
  + "使用时机与边界见 ops/policies/runtime-tools.md";

const OPTIONS = [
  { flag: "--task-package", dest: "taskPackage", kind: "value", metavar: "TASK_PACKAGE", help: "任务包 JSON 文件路径（含 task_package 包装或裸 task_package 对象均可）；与 --package-id 二选一提供。" },
  { flag: "--package-id", dest: "packageId", kind: "value", metavar: "PACKAGE_ID", help: "通过 package_id 自动在 tmp/dispatch_prepare/（含 preparations/prep-*/package.json）和 notes/manifests/ 中查找任务包文件；与 --task-package 二选一提供。" },
  { flag: "--handoff-file", dest: "handoffFile", kind: "value", metavar: "HANDOFF_FILE", help: "包含 FINAL_HANDOFF 内容的文件路径；与 --handoff-stdin 二选一提供。" },
  { flag: "--handoff-stdin", dest: "handoffStdin", kind: "flag", help: "从标准输入读取 FINAL_HANDOFF 文本；与 --handoff-file 二选一提供。" },
  { flag: "--format", dest: "format", kind: "value", metavar: "{text,json}", choices: ["text", "json"], help: "输出格式：text 输出人类可读检查摘要，json 输出机器可读完整检查结果。" },
  { flag: "--self-test", dest: "selfTest", kind: "flag", help: "运行内部冒烟测试并报告结果。" },
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
  lines.push("", EPILOG);
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
  const args = {
    taskPackage: null,
    packageId: null,
    handoffFile: null,
    handoffStdin: false,
    format: "text",
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
  if (args.selfTest) return runSelfTest();
  if (Boolean(args.taskPackage) === Boolean(args.packageId)) {
    throw new ToolError("provide exactly one of --task-package or --package-id");
  }
  if (Boolean(args.handoffFile) === Boolean(args.handoffStdin)) {
    throw new ToolError("provide exactly one of --handoff-file or --handoff-stdin");
  }
  let taskPackage;
  if (args.packageId) {
    [, taskPackage] = loadTaskPackageById(args.packageId);
  } else {
    taskPackage = loadJson(repoPath(args.taskPackage, "task_package", { mustExist: true }));
  }
  let handoffText;
  let actualHandoffPath;
  if (args.handoffStdin) {
    // Python sys.stdin.read() 走通用换行翻译；readStdinText 负责编码回退，这里补同一换行归一。
    handoffText = readStdinText("handoff").replace(/\r\n|\r/g, "\n");
    actualHandoffPath = null;
  } else {
    actualHandoffPath = taskPath(args.handoffFile, taskPackage, { label: "handoff_file", mustExist: true });
    handoffText = pyReadTextReplace(actualHandoffPath);
  }
  const data = checkHandoff(taskPackage, handoffText, { actualHandoffPath });
  return emit(data, args.format, buildText(data));
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
  } else if (error instanceof ToolError || error?.name === "ToolError") {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
