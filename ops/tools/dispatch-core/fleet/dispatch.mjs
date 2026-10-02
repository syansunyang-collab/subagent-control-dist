// fleet_scheduler.mjs 按职责拆出的 dispatch。只搬移代码，不改行为。
import { api } from "./api.mjs";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pyIsRelativeTo, pyJsonDumps, pySpawnSync, pyStr, pyStrip } from "../_py.mjs";
import {
  isRecord,
  pathlibJoin,
  loadJson as readJson,
  rel,
  resolveLikePython,
  ROOT,
  ToolError,
  utcNow,
} from "../_tool_common.mjs";
import {
  deepCopy,
  nodeCommand,
  nodeDependencyArtifacts,
  nodeDependencyPolicy,
  nodeKind,
} from "../fleet_manifest_check.mjs";
import { DISPATCH_PREPARE_TIMEOUT_SECONDS, INITIAL_LIVENESS_GRACE_SECONDS } from "./constants.mjs";
import { deps } from "./deps.mjs";
import { hostPaths } from "./host-paths.mjs";
import { runDir, safeId, seedPath, statePath, utcAfter, writeJson } from "./paths.mjs";
import { notEmptyPy, positiveInt, pyInt } from "./py-utils.mjs";
import { ensureRouteRecord, frozenRequestedRoute, routeSnapshot, updateRouteFromPayload } from "./route.mjs";

export function commandNodeCwd(spec) {
  const declared = pyStrip(pyStr(spec.cwd || ""));
  if (!declared) return ROOT;
  const cwd = resolveLikePython(pathlibJoin(ROOT, declared));
  if (!pyIsRelativeTo(cwd, ROOT)) {
    throw new ToolError(`command cwd escapes repository root: ${declared}`);
  }
  return cwd;
}

/** Expose run identity and, when declared, the dependency artifact index to the command. */
export function commandNodeEnv(state, node, manifestNode) {
  const env = { ...process.env };
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  env.FLEET_RUN_ID = runId;
  env.FLEET_NODE_ID = pyStr(node.id || "");
  env.FLEET_RUN_DIR = runDir(root, runId);
  env.FLEET_STATE_PATH = statePath(root, runId);
  if (!nodeDependencyArtifacts(manifestNode).length) return env;
  const [artifacts, entries] = api.dependencyResultEntries(state, node, manifestNode);
  if (nodeDependencyPolicy(manifestNode) === "all_settled") {
    env.FLEET_DEPENDENCY_RESULT_INDEX = api.writeDependencyResultIndex(state, node, manifestNode, entries);
  }
  if (artifacts.length) env.FLEET_DEPENDENCY_ARTIFACTS = artifacts.join(path.delimiter);
  return env;
}

export function executeCommandNode(state, node, manifestNode, { dryRun = false } = {}) {
  // 至少一次语义：state 在 tick 结束才落盘，命令执行中途崩溃会在 resume 时重跑，命令必须可重入。
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  const spec = nodeCommand(manifestNode);
  const argv = [...(spec.argv || [])];
  let cwd;
  try {
    if (!argv.length) throw new ToolError(`command node ${pyStr(node.id ?? null)} has no argv`);
    cwd = commandNodeCwd(spec);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    // 无效命令直接结算负结果，不重复执行。
    api.markFailure(node, {
      contractState: "command_invalid",
      failureType: "command_invalid",
      error: String(error.message),
      fleetState: state,
    });
    return {
      status: "failed",
      node_id: node.id,
      error: String(error.message),
    };
  }
  const timeout = pyInt(spec.timeout_seconds || 600);
  if (dryRun) {
    return {
      status: "ok",
      node_id: node.id,
      dry_run: true,
      dispatch: { would_run: argv, cwd, timeout_seconds: timeout },
    };
  }
  let env;
  try {
    env = commandNodeEnv(state, node, manifestNode);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    api.markFailure(node, {
      contractState: "dependency_artifact_missing",
      failureType: "dependency_artifact_missing",
      error: String(error.message),
      fleetState: state,
    });
    return { status: "failed", node_id: node.id, error: String(error.message) };
  }
  const attempt = positiveInt(node.command_attempts) + 1;
  node.command_attempts = attempt;
  const logsDir = path.join(runDir(root, runId), "commands");
  mkdirSync(logsDir, { recursive: true });
  const stdoutPath = path.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.stdout.log`);
  const stderrPath = path.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.stderr.log`);
  const startedAt = deps.monotonic();
  let failure = null;
  let exitCode = null;
  let stdoutText = "";
  let stderrText = "";
  const workerResultPath = path.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.process.json`);
  const workerSpecPath = path.join(logsDir, `${safeId(pyStr(node.id))}.attempt-${attempt}.spec.json`);
  writeJson(workerSpecPath, { argv, cwd, timeout_ms: timeout * 1000, cancel_path: api.cancellationPath(root, runId), result_path: workerResultPath });
  const proc = pySpawnSync(process.execPath, [hostPaths.SCHEDULER_CLI_PATH, "command-worker", "--spec", workerSpecPath], {
    cwd,
    env,
    encoding: "utf8",
    timeout: (timeout + 40) * 1000,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  const workerResult = existsSync(workerResultPath) ? readJson(workerResultPath) : null;
  if (workerResult?.cancelled || (existsSync(api.cancellationPath(root, runId)) && !workerResult)) {
    writeFileSync(stdoutPath, pyStr(proc.stdout ?? ""));
    writeFileSync(stderrPath, pyStr(proc.stderr ?? ""));
    node.command_termination = workerResult || { confirmed: false, error: "command supervisor result missing" };
    api.setNodeState(state, node, workerResult?.confirmed ? "cancelled" : "running", { eventType: workerResult?.confirmed ? "agent_settled" : "agent_progress", businessState: workerResult?.confirmed ? "cancelled" : "running" });
    node.command_result = { argv, cwd, attempt, stdout_path: stdoutPath, stderr_path: stderrPath };
    node.not_executed = Boolean(workerResult?.not_executed);
    node.cancel_reason = "user_requested";
    return { status: "ok", node_id: node.id, terminal: Boolean(workerResult?.confirmed), cancelled: Boolean(workerResult?.confirmed) };
  }
  stdoutText = pyStr(proc.stdout ?? "");
  stderrText = pyStr(proc.stderr ?? "");
  if (workerResult?.timed_out) {
    failure = ["command_timeout", `command timed out after ${timeout}s`];
  } else if (workerResult?.error) {
    failure = [workerResult.error_code === "ENOENT" ? "command_not_found" : "command_spawn_failed", workerResult.error];
  } else if (proc.error && proc.error.code === "ENOENT") {
    failure = ["command_not_found", `command executable not found: ${argv[0]}`];
  } else if (proc.error && proc.error.code === "ETIMEDOUT") {
    stdoutText = pyStr(proc.stdout ?? "");
    stderrText = pyStr(proc.stderr ?? "");
    failure = ["command_timeout", `command timed out after ${timeout}s`];
  } else if (proc.error) {
    failure = ["command_spawn_failed", `command spawn failed: ${proc.error.message}`];
  } else if (proc.signal && proc.status === null) {
    stdoutText = pyStr(proc.stdout ?? "");
    stderrText = pyStr(proc.stderr ?? "");
    failure = ["command_timeout", `command timed out after ${timeout}s`];
  } else {
    exitCode = proc.status;
    stdoutText = pyStr(proc.stdout ?? "");
    stderrText = pyStr(proc.stderr ?? "");
    if (exitCode !== 0) {
      failure = ["command_failed", `command exited ${exitCode}: ${pyStrip(stderrText).slice(0, 800)}`];
    }
  }
  const durationSeconds = Math.round((deps.monotonic() - startedAt) * 1000) / 1000;
  try {
    writeFileSync(stdoutPath, stdoutText, "utf8");
    writeFileSync(stderrPath, stderrText, "utf8");
  } catch (error) {
    if (failure === null) failure = ["command_log_write_failed", `cannot persist command logs: ${error.message}`];
  }
  node.command_result = {
    argv,
    cwd,
    attempt,
    exit_code: exitCode,
    duration_seconds: durationSeconds,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  };
  node.updated_at = utcNow();
  if (failure !== null) {
    const [contractState, error] = failure;
    const quarantined = !workerResult?.confirmed;
    node.resource_quarantined = quarantined;
    (quarantined ? api.markParentReview : api.markFailure)(node, {
      contractState,
      failureType: quarantined ? "retained_worker" : contractState,
      error,
      fleetState: state,
    });
    node.last_status.stdout_path = stdoutPath;
    node.last_status.stderr_path = stderrPath;
    return {
      status: node.state,
      node_id: node.id,
      error,
    };
  }
  node.last_status = {
    source: "fleet_command",
    state: "done",
    business_state: "completed",
    exit_code: 0,
    duration_seconds: durationSeconds,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    // 命令的 stdout 就是它对下游的正式产物，接进 dependency_artifacts 的 report 解析链。
    report_path: stdoutPath,
  };
  api.setNodeState(state, node, "done", {
    eventType: "agent_settled",
    businessState: "completed",
    command: argv[0],
    duration_seconds: durationSeconds,
  });
  return {
    status: "ok",
    node_id: node.id,
    terminal: true,
    exit_code: 0,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  };
}

/** A gate is a pure decision point: it opens as needs_parent_review and waits for review. */
export function openGateNode(state, node, { dryRun = false } = {}) {
  if (dryRun) {
    return {
      status: "ok",
      node_id: node.id,
      dry_run: true,
      dispatch: { gate: "would_open" },
    };
  }
  node.review_required = true;
  node.review_decision = "pending";
  node.last_status = {
    source: "fleet_gate",
    state: "needs_parent_review",
    business_state: "gate_open",
    requires_parent_review: true,
  };
  api.setNodeState(state, node, "needs_parent_review", {
    eventType: "gate_opened",
    businessState: "gate_open",
  });
  return { status: "ok", node_id: node.id, terminal: true, gate: "opened" };
}

export function dispatchNodeImpl(state, manifest, node, manifestNode, { dryRun = false } = {}) {
  const kind = pyStr(node.kind || nodeKind(manifestNode));
  if (kind === "command") return executeCommandNode(state, node, manifestNode, { dryRun });
  if (kind === "gate") return openGateNode(state, node, { dryRun });
  const root = pyStr(state.state_root);
  const runId = pyStr(state.run_id);
  let seed;
  try {
    seed = api.seedWithDependencyArtifacts(state, node, manifestNode, manifest);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    if (!nodeDependencyArtifacts(manifestNode).length) throw error;
    api.markFailure(node, {
      contractState: "dependency_artifact_missing",
      failureType: "dependency_artifact_missing",
      error: String(error.message),
      fleetState: state,
    });
    return { status: "failed", node_id: node.id, error: String(error.message) };
  }
  const seedFile = seedPath(root, runId, pyStr(node.id));
  writeJson(seedFile, seed);
  let dispatchCwd = ROOT;
  if (node.isolation === "worktree") {
    dispatchCwd = dryRun
      ? path.join(runDir(root, runId), "worktrees", safeId(pyStr(node.id)))
      : api.ensureWorktree(state, node);
  }
  const cmd = [
    process.execPath,
    hostPaths.DISPATCH_PREPARE_PATH,
    "--seed-stdin",
    "--format",
    "json",
    "--async-task-root",
    pyStr(api.nodeTaskRoot(state, node)),
    "--batch-id",
    runId,
  ];
  const dispatchOverrides = isRecord(state.dispatch_overrides) ? state.dispatch_overrides : {};
  const requestedRoute = frozenRequestedRoute(node);
  if (requestedRoute) {
    if (Object.hasOwn(requestedRoute, "pick")) cmd.push("--async-pick", requestedRoute.pick);
    if (Object.hasOwn(requestedRoute, "model")) cmd.push("--async-model", requestedRoute.model);
    if (Object.hasOwn(requestedRoute, "effort")) cmd.push("--async-effort", requestedRoute.effort);
    if (Object.hasOwn(requestedRoute, "authorization")) {
      cmd.push("--async-authorization", typeof requestedRoute.authorization === "string"
        ? requestedRoute.authorization
        : pyJsonDumps(requestedRoute.authorization));
    }
  }
  if (dispatchOverrides.context_mode) {
    cmd.push("--async-context-mode", pyStr(dispatchOverrides.context_mode));
  }
  if (dryRun) cmd.push("--action", "preview");
  let result;
  if (dryRun) {
    result = {
      status: "ok",
      dry_run: true,
      would_run: cmd,
      cwd: dispatchCwd,
      seed_path: rel(seedFile),
    };
  } else {
    const raw = deps.runCommand(cmd, dispatchCwd, {
      stdin: pyJsonDumps(seed),
      timeout: DISPATCH_PREPARE_TIMEOUT_SECONDS,
    });
    if (raw.exit_code !== 0) {
      const stderr = raw.stderr.slice(0, 1200);
      const stdout = raw.stdout.slice(0, 1200);
      const error = pyStrip(stderr) || pyStrip(stdout)
        || `dispatch_prepare exited ${raw.exit_code} without output`;
      node.dispatch = { exit_code: raw.exit_code, error: stderr, stdout };
      const safetyFailure = /write claim|identity|write.domain|write.scope|retained.worker/i.test(error);
      (safetyFailure ? api.markParentReview : api.markFailure)(node, {
        contractState: "dispatch_prepare_failed",
        failureType: error.toLowerCase().includes("write claim") ? "write_claim_conflict" : "dispatch_prepare_exit",
        error,
        fleetState: state,
      });
      return {
        status: node.state,
        node_id: node.id,
        error,
      };
    }
    result = api.parseJsonStdout(raw, "dispatch_prepare");
  }
  node.dispatch = result;
  const frozenSelection = isRecord(result.selection) ? result.selection
    : isRecord(result.async_preview?.selection) ? result.async_preview.selection
    : isRecord(result.async_model_selection?.selection) ? result.async_model_selection.selection
    : null;
  if (frozenSelection) ensureRouteRecord(node).frozen = deepCopy(frozenSelection);
  node.updated_at = utcNow();
  if (dryRun) return { status: "ok", node_id: node.id, dry_run: true, dispatch: result };
  const taskId = result.task_id;
  if (!taskId) {
    const error = "dispatch result missing task_id";
    api.markParentReview(node, {
      contractState: "dispatch_result_invalid",
      failureType: "dispatch_missing_task_id",
      error,
      fleetState: state,
    });
    return {
      status: "needs_parent_review",
      node_id: node.id,
      reason: "dispatch_result_requires_parent_review",
      error,
    };
  }
  node.task_id = taskId;
  node.receipt_task_id = taskId;
  if (result.warnings?.length) node.warnings = [...result.warnings];
  else delete node.warnings;
  updateRouteFromPayload(node, result, "dispatch_receipt");
  node.task_root = pyStr(api.nodeTaskRoot(state, node));
  api.setNodeState(state, node, pyStr(result.state || "submitted"), {
    eventType: "agent_started",
    businessState: pyStr(result.business_state || "") || null,
    dispatch_source: "dispatch_prepare",
    route: routeSnapshot(node),
  });
  node.next_liveness_check_at = utcAfter(INITIAL_LIVENESS_GRACE_SECONDS);
  return { status: "ok", node_id: node.id, task_id: taskId, dispatch: result };
}

export function dispatchNode(state, manifest, node, manifestNode, options = {}) {
  return deps.dispatchNode(state, manifest, node, manifestNode, options);
}

/** Keep the default tick surface useful without echoing the full task package. */
export function compactDispatchOutcome(outcome) {
  const data = {};
  for (const key of ["status", "node_id", "task_id", "dry_run", "error"]) {
    if (notEmptyPy(outcome[key])) data[key] = outcome[key];
  }

  const dispatch = outcome.dispatch;
  if (isRecord(dispatch)) {
    for (const key of [
      "delivery_mode",
      "resolved_delivery",
      "warnings",
      "model",
      "effort",
      "package_id",
      "task_package_path",
      "seed_path",
      "cwd",
    ]) {
      if (notEmptyPy(dispatch[key])) data[key] = dispatch[key];
    }
    const businessOutput = dispatch.business_output;
    if (isRecord(businessOutput)) {
      for (const key of ["expected_report_path", "expected_handoff_path"]) {
        if (notEmptyPy(businessOutput[key])) data[key] = businessOutput[key];
      }
    }
  }
  return data;
}

Object.assign(api, {
  commandNodeCwd,
  commandNodeEnv,
  executeCommandNode,
  openGateNode,
  dispatchNodeImpl,
  dispatchNode,
  compactDispatchOutcome,
});
