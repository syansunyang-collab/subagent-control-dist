#!/usr/bin/env node
// ops/tools/fleet_scheduler.py 的 CLI 同形复刻：九个子命令、每个子命令的 flag 集合、choices、
// required 与默认值逐条对齐 argparse；退出码经 dispatch-core/_tool_common.mjs 的 emit()。
// 调度语义全在 dispatch-core/fleet_scheduler.mjs。
import process from "node:process";

import { ToolError, emit } from "./dispatch-core/_tool_common.mjs";
import { pyJsonDumps } from "./dispatch-core/_py.mjs";
import {
  TERMINAL_STATES,
  cancelRun,
  driveRun,
  formatStatusSummary,
  launchDriver,
  normalizeDispatchOverrides,
  pauseRun,
  readJson,
  resumeRun,
  reviewRun,
  safeId,
  startRun,
  statePath,
  stateRoot,
  statusRun,
  tickRun,
  waitRun,
} from "./dispatch-core/fleet_scheduler.mjs";
import { selfTest } from "./fleet_scheduler.selftest.mjs";
import { runFleetCommand } from "./dispatch-core/fleet-command-worker.mjs";

const PROGRAM = "fleet_scheduler.mjs";
const FORMAT = { dest: "format", default: "text", choices: ["text", "json"] };

// 每个子命令的参数表：value 参带 { dest, default, choices?, type?, required? }，
// store_true 参在 FLAGS 里；review 的三选一是 argparse 的 required=True 互斥组。
const COMMANDS = {
  "command-worker": {
    values: { "--spec": { dest: "spec", required: true } }, flags: {},
  },
  cancel: {
    values: {
      "--run-id": { dest: "run_id", required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--reason": { dest: "reason", required: true },
      "--format": FORMAT,
    }, flags: {},
  },
  start: {
    values: {
      "--manifest": { dest: "manifest", default: null, required: true },
      "--run-id": { dest: "run_id", default: "" },
      "--state-root": { dest: "state_root", default: "" },
      "--async-context-mode": { dest: "async_context_mode", default: "", choices: ["isolated", "project-aware"] },
      "--format": FORMAT,
    },
    flags: { "--force": "force" },
  },
  pause: {
    values: {
      "--run-id": { dest: "run_id", required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--reason": { dest: "reason", required: true },
      "--format": FORMAT,
    }, flags: {},
  },
  tick: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--format": FORMAT,
    },
    flags: { "--dry-run": "dry_run", "--verbose": "verbose" },
  },
  wait: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--wait-ms": { dest: "wait_ms", default: 60000, type: "int" },
      "--format": FORMAT,
    },
    flags: { "--verbose": "verbose" },
  },
  resume: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--format": FORMAT,
    },
    flags: { "--dry-run": "dry_run", "--verbose": "verbose" },
  },
  run: {
    values: {
      "--manifest": { dest: "manifest", default: "" },
      "--run-id": { dest: "run_id", default: "" },
      "--state-root": { dest: "state_root", default: "" },
      "--wait-ms": { dest: "wait_ms", default: 60000, type: "int" },
      "--async-context-mode": { dest: "async_context_mode", default: "", choices: ["isolated", "project-aware"] },
      "--format": FORMAT,
    },
    flags: { "--force": "force" },
  },
  drive: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--wait-ms": { dest: "wait_ms", default: 60000, type: "int" },
      "--format": FORMAT,
    },
    flags: {},
  },
  status: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--format": FORMAT,
    },
    flags: { "--summary": "summary" },
  },
  review: {
    values: {
      "--run-id": { dest: "run_id", default: null, required: true },
      "--state-root": { dest: "state_root", default: "" },
      "--node-id": { dest: "node_id", default: null, required: true },
      "--evidence": { dest: "evidence", default: null },
      "--reason": { dest: "reason", default: "" },
      "--format": FORMAT,
    },
    flags: { "--accept": "accept", "--block": "block", "--requeue": "requeue" },
    decisionGroup: ["--accept", "--block", "--requeue"],
  },
  "self-test": {
    values: { "--format": FORMAT },
    flags: {},
  },
};

const USAGE = `usage: ${PROGRAM} [-h] {start,tick,wait,resume,run,drive,status,review,cancel,pause,self-test} ...`;

function argparseError(message) {
  process.stderr.write(`${USAGE}\n${PROGRAM}: error: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${USAGE}\n\nRun a bounded tick-based scheduler for fleet dispatch manifests.\n`);
    process.exit(0);
  }
  const command = argv.length ? String(argv[0]) : null;
  if (command === null) return { command: null, format: "text" };
  if (!Object.hasOwn(COMMANDS, command)) {
    argparseError(`argument command: invalid choice: '${command}' (choose from ${Object.keys(COMMANDS).map((item) => `'${item}'`).join(", ")})`);
  }
  const spec = COMMANDS[command];
  const args = { command };
  for (const item of Object.values(spec.values)) args[item.dest] = item.default;
  for (const dest of Object.values(spec.flags)) args[dest] = false;
  const seen = new Set();
  const rest = argv.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = String(rest[index]);
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq > 0 ? token.slice(0, eq) : token;
    const inlineValue = token.startsWith("--") && eq > 0 ? token.slice(eq + 1) : null;
    if (Object.hasOwn(spec.flags, name)) {
      if (inlineValue !== null) argparseError(`argument ${name}: ignored explicit argument '${inlineValue}'`);
      args[spec.flags[name]] = true;
      seen.add(name);
      continue;
    }
    const item = Object.hasOwn(spec.values, name) ? spec.values[name] : null;
    if (!item) argparseError(`unrecognized arguments: ${token}`);
    let value = inlineValue;
    if (value === null) {
      index += 1;
      if (index >= rest.length) argparseError(`argument ${name}: expected one argument`);
      value = String(rest[index]);
    }
    if (item.choices && !item.choices.includes(value)) {
      argparseError(`argument ${name}: invalid choice: '${value}' (choose from ${item.choices.map((choice) => `'${choice}'`).join(", ")})`);
    }
    if (item.type === "int") {
      if (!/^[+-]?\d+$/.test(value.trim())) argparseError(`argument ${name}: invalid int value: '${value}'`);
      args[item.dest] = Number.parseInt(value.trim(), 10);
      seen.add(name);
      continue;
    }
    args[item.dest] = value;
    seen.add(name);
  }
  const missing = Object.entries(spec.values)
    .filter(([name, item]) => item.required && !seen.has(name))
    .map(([name]) => name);
  if (missing.length) argparseError(`the following arguments are required: ${missing.join(", ")}`);
  if (spec.decisionGroup) {
    const chosen = spec.decisionGroup.filter((name) => args[spec.flags[name]]);
    if (chosen.length === 0) argparseError(`one of the arguments ${spec.decisionGroup.join(" ")} is required`);
    if (chosen.length > 1) argparseError(`argument ${chosen[1]}: not allowed with argument ${chosen[0]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fmt = Object.hasOwn(args, "format") ? args.format : "text";
  try {
    if (args.command === "command-worker") return await runFleetCommand(args.spec);
    if (args.command === "cancel") {
      const root = stateRoot(args.state_root);
      const data = cancelRun(args.run_id, root, args.reason);
      if (data.status === "cancelling") data.driver = await launchDriver(args.run_id, root, 1000);
      return emit(data, fmt, `fleet ${data.status}: ${data.run_id}`);
    }
    if (args.command === "start") {
      const dispatchOverrides = normalizeDispatchOverrides(args.async_context_mode);
      const data = startRun(
        args.manifest,
        args.run_id,
        stateRoot(args.state_root),
        args.force,
        dispatchOverrides,
      );
      return emit(data, fmt, `fleet run started: ${data.run_id} (${data.nodes} nodes)`);
    }
    if (args.command === "pause") {
      const data = pauseRun(args.run_id, stateRoot(args.state_root), args.reason);
      return emit(data, fmt, `Fleet 暂停状态：${data.state}，run_id=${data.run_id}`);
    }
    if (args.command === "tick") {
      const data = tickRun(args.run_id, stateRoot(args.state_root), args.dry_run, args.verbose);
      const label = data.dry_run ? "would submit" : "submitted";
      return emit(data, fmt, `fleet tick ok: ${data.submitted.length} ${label}`);
    }
    if (args.command === "wait") {
      const data = waitRun(args.run_id, stateRoot(args.state_root), args.wait_ms, { verbose: args.verbose });
      return emit(
        data,
        fmt,
        `fleet wait ${data.event}: notices=${Object.hasOwn(data, "notice_count") ? data.notice_count : 0}`
        + ` active=${data.active}`,
      );
    }
    if (args.command === "resume") {
      const data = resumeRun(args.run_id, stateRoot(args.state_root), {
        dryRun: args.dry_run,
        verbose: args.verbose,
      });
      return emit(data, fmt, `fleet resume ok: ${args.run_id}`);
    }
    if (args.command === "run") {
      const root = stateRoot(args.state_root);
      let runId;
      if (args.manifest) {
        const dispatchOverrides = normalizeDispatchOverrides(args.async_context_mode);
        const started = startRun(args.manifest, args.run_id, root, args.force, dispatchOverrides);
        runId = String(started.run_id);
      } else {
        if (!args.run_id) throw new ToolError("run requires --manifest for a new run or --run-id to resume");
        if (args.async_context_mode) {
          throw new ToolError("dispatch overrides are fixed when the run starts; omit them when resuming");
        }
        runId = safeId(args.run_id);
      }
      const data = await launchDriver(runId, root, args.wait_ms);
      return emit(data, fmt, `fleet driver launched: ${runId} pid=${data.pid}`);
    }
    if (args.command === "drive") {
      const data = driveRun(args.run_id, stateRoot(args.state_root), args.wait_ms);
      return emit(data, fmt, `fleet driver ${data.status}: ${args.run_id}`);
    }
    if (args.command === "status") {
      const data = statusRun(args.run_id, stateRoot(args.state_root), args.summary);
      const text = args.summary
        ? formatStatusSummary(data)
        : `fleet status ok: ${pyJsonDumps(data.counts)}`;
      return emit(data, fmt, text);
    }
    if (args.command === "review") {
      const decisionValue = args.accept ? "accepted" : args.block ? "blocked" : "requeued";
      const reviewRoot = stateRoot(args.state_root);
      const data = reviewRun(
        args.run_id,
        reviewRoot,
        args.node_id,
        decisionValue,
        args.evidence,
        args.reason,
      );
      const reviewedState = readJson(statePath(reviewRoot, args.run_id));
      const unfinished = (Array.isArray(reviewedState.nodes) ? reviewedState.nodes : []).some(
        (node) => node && typeof node === "object" && !Array.isArray(node) && !TERMINAL_STATES.has(node.state),
      );
      if (unfinished) {
        // 裁决后自动续驾：ready 队列不能没有机械持有者，否则 run 静默停摆。
        data.driver = await launchDriver(args.run_id, reviewRoot, 60000);
      }
      return emit(data, fmt, `fleet review ${decisionValue}: ${data.node_id} -> ${data.node_state}`);
    }
    if (args.command === "self-test") {
      const data = selfTest();
      return emit(data, fmt, `fleet_scheduler self-test ${data.status}`);
    }
    throw new ToolError("choose a command: start, tick, wait, resume, run, drive, status, review, cancel, pause, self-test");
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    return emit({ status: "failed", error: String(error.message) }, fmt, `failed: ${error.message}`);
  }
}

process.exitCode = await main();
