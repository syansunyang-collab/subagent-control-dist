#!/usr/bin/env node
// ops/tools/review_evidence_benchmark.py 的复刻：把静态终验取证快路径与记录在案的 71 分钟基线对比。
// argparse 同形（--report / --self-test），门限、基线与 gates 键集逐字一致。
// 差异登记：Python 的 load_fixture 把 argv 里的 "$PYTHON" 换成 sys.executable；JS 没有等价的
// 解释器句柄，换成 PATH 上的 "python"。当前夹具不含该占位符（mechanical_checks 已改走 node）。
// isolatedSelfTestSeed 的三条 echo 桩由 Python 解释器改为 process.execPath：桩只量取证流水线自身
// 的起进程开销，换解释器不改变它衡量的东西，并让本工具不再依赖 Python。
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ROOT, ToolError, loadJson, rel } from "./dispatch-core/_tool_common.mjs";
import { packagePathForTemp } from "./dispatch-core/dispatch_prepare.mjs";
import { PROFILE, attachReviewEvidence } from "./dispatch-core/review_evidence.mjs";
import { expandSeed } from "./dispatch-core/seed_minimal.mjs";
import { renderTaskMaterialFile } from "./dispatch-core/subagent_preload.mjs";
import { buildPackage } from "./dispatch-core/task_package_build.mjs";

const PROGRAM = "review_evidence_benchmark.mjs";
const USAGE = `usage: ${PROGRAM} [-h] [--report REPORT] [--self-test]`;
const DESCRIPTION = "测量 recorder 同工况静态终验机械快路径。";

const FIXTURE = path.join(ROOT, "ops", "fixtures", "review-evidence-recorder-verification.json");
// 历史采集基线(一次真实运行的快照),仅作降幅对比锚点,非跨仓强制阈值;新环境可重新采集替换。
const ORIGINAL = {
  wall_ms: 4_279_923,
  shell_calls: 125,
  task_material_bytes: 44_951,
  task_package_bytes: 15_017,
  report_bytes: 9_946,
};
const LIMITS = {
  mechanical_prepare_ms: 30_000,
  task_material_bytes: 20_000,
  task_package_bytes: 8_000,
  report_bytes: 4_000,
};

export function loadFixture() {
  const seed = loadJson(FIXTURE);
  for (const check of seed.contract.mechanical_checks) {
    check.argv = check.argv.map((item) => (item === "$PYTHON" ? "python" : item));
  }
  return seed;
}

export function reduction(before, after) {
  return Math.round(((before - after) / before) * 100 * 10000) / 10000;
}

export function isolatedSelfTestSeed() {
  const seed = loadFixture();
  seed.scope.read = ["target.py"];
  const contract = seed.contract;
  contract.affected_files = ["target.py"];
  contract.changed_surfaces = ["target.py: state_patch", "target.py: recorder_lock"];
  // 三条 echo 桩只为量 review_evidence 取证流水线自身的开销(逐条起进程、收集输出、写证据包),不验证任何工具;
  // 真实工具自测由 fixture 的 mechanical_checks 和 toolchain_check.py 负责。
  contract.mechanical_checks = ["pipeline-echo-a", "pipeline-echo-b", "pipeline-echo-c"].map((checkId) => ({
    id: checkId,
    argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(checkId)} + "\\n")`],
    cwd: ".",
    timeout_seconds: 30,
  }));
  return seed;
}

export function benchmarkOnce(seed, { sourceRoot = null, evidenceOutput = null } = {}) {
  const expanded = expandSeed(seed);
  const envelope = buildPackage(expanded);
  let packagePath = null;
  let evidencePath = null;
  try {
    const started = performance.now();
    const evidenceRef = attachReviewEvidence(envelope, { execute: true, root: sourceRoot, outputPath: evidenceOutput });
    const mechanicalMs = Math.round((performance.now() - started) * 1000) / 1000;
    if (!evidenceRef) throw new ToolError("benchmark expected review evidence");
    packagePath = packagePathForTemp(envelope);
    const material = renderTaskMaterialFile(packagePath);
    const packageBytes = statSync(packagePath).size;
    const materialBytes = Buffer.byteLength(material, "utf8");
    evidencePath = String(evidenceRef.path);
    if (!path.isAbsolute(evidencePath)) evidencePath = path.join(ROOT, evidencePath);
    const evidence = loadJson(evidencePath);
    const checks = evidence.mechanical_checks ?? [];
    const sourceText = JSON.stringify(evidence.sources ?? []);
    const checksAllPassed = Boolean(checks.length) && checks.every((item) => item.passed);
    const current = {
      mechanical_prepare_ms: mechanicalMs,
      task_material_bytes: materialBytes,
      task_package_bytes: packageBytes,
      evidence_bytes: statSync(evidencePath).size,
      mechanical_check_count: checks.length,
      mechanical_check_failures: checks.filter((item) => !item.passed).length,
      report_bytes_budget: LIMITS.report_bytes,
      profile: evidenceRef.profile,
    };
    const gates = {
      profile_evidence_only: current.profile === PROFILE,
      mechanical_checks_pass: current.mechanical_check_count === 3 && current.mechanical_check_failures === 0,
      mechanical_prepare_under_30s: mechanicalMs <= LIMITS.mechanical_prepare_ms,
      task_material_under_20kb: materialBytes <= LIMITS.task_material_bytes,
      task_package_under_8kb: packageBytes <= LIMITS.task_package_bytes,
      historical_scope_regression_present: checksAllPassed && sourceText.includes("state_patch"),
      historical_writer_regression_present: checksAllPassed && sourceText.includes("recorder_lock"),
    };
    return {
      status: Object.values(gates).every(Boolean) ? "pass" : "fail",
      fixture: sourceRoot ? "isolated-self-test" : rel(FIXTURE),
      original: ORIGINAL,
      current,
      improvement: {
        mechanical_prepare_vs_original_wall_reduction_pct: reduction(ORIGINAL.wall_ms, Math.round(mechanicalMs)),
        task_material_reduction_pct: reduction(ORIGINAL.task_material_bytes, materialBytes),
        task_package_reduction_pct: reduction(ORIGINAL.task_package_bytes, packageBytes),
      },
      limits: LIMITS,
      gates,
      note: "mechanical_prepare_ms is not the end-to-end model wall time; the real async canary records that separately.",
    };
  } finally {
    if (packagePath !== null) rmSync(packagePath, { force: true });
    if (evidencePath !== null) {
      rmSync(evidencePath, { force: true });
      rmSync(evidencePath.replace(/\.[^.\\/]*$/, ""), { recursive: true, force: true });
    }
  }
}

export function runBenchmark() {
  return benchmarkOnce(loadFixture());
}

export function runSelfTestBenchmark() {
  const tmpRoot = path.join(ROOT, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const sourceRoot = mkdtempSync(path.join(tmpRoot, "review-evidence-benchmark-"));
  try {
    writeFileSync(
      path.join(sourceRoot, "target.py"),
      "def state_patch():\n    return 'state_patch'\n\ndef recorder_lock():\n    return 'recorder_lock'\n",
      "utf8",
    );
    return benchmarkOnce(isolatedSelfTestSeed(), { sourceRoot, evidenceOutput: path.join(sourceRoot, "evidence.json") });
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

class ArgumentError extends Error {}
class HelpRequested extends Error {}

export function parseArgs(argv) {
  const args = { report: null, selfTest: false };
  const tokens = [...argv];
  while (tokens.length) {
    const token = tokens.shift();
    if (token === "-h" || token === "--help") throw new HelpRequested();
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const inline = equals >= 0 ? token.slice(equals + 1) : null;
    if (name === "--self-test") {
      if (inline !== null) throw new ArgumentError(`argument --self-test: ignored explicit argument '${inline}'`);
      args.selfTest = true;
      continue;
    }
    if (name === "--report") {
      let value = inline;
      if (value === null) {
        if (!tokens.length) throw new ArgumentError("argument --report: expected one argument");
        value = tokens.shift();
      }
      args.report = value;
      continue;
    }
    throw new ArgumentError(`unrecognized arguments: ${token}`);
  }
  return args;
}

export function main(argv) {
  const args = parseArgs(argv);
  const result = args.selfTest ? runSelfTestBenchmark() : runBenchmark();
  if (args.report) {
    const report = path.resolve(path.join(ROOT, args.report));
    const allowed = [path.resolve(path.join(ROOT, "test-results")), path.resolve(path.join(ROOT, "tmp"))];
    if (!allowed.some((root) => report === root || report.startsWith(root + path.sep))) {
      throw new ToolError("--report must be under test-results/ or tmp/");
    }
    mkdirSync(path.dirname(report), { recursive: true });
    writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "pass" ? 0 : 1;
}

// Python 的 `if __name__ == "__main__":`：被 import 时只提供导出，不跑 benchmark。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(`${USAGE}\n\n${DESCRIPTION}\n\noptions:\n`
        + "  -h, --help       show this help message and exit\n"
        + "  --report REPORT  可选 JSON 报告路径，必须位于 test-results/ 或 tmp/。\n"
        + "  --self-test      运行同一 benchmark 并按冻结门限断言。\n");
      process.exitCode = 0;
    } else if (error instanceof ArgumentError) {
      process.stderr.write(`${USAGE}\n${PROGRAM}: error: ${error.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
