#!/usr/bin/env node
// fleet_scheduler self-test 子命令的机械用例集（ops/tools/fleet_scheduler_selftest.py 的移植），
// 经 node ops/tools/fleet_scheduler.mjs self-test 调用。checks 键名与 true/false 语义与 Python 逐条一致。
// 唯一移植改写：命令节点的 argv 由 `python -c ...` 改为 `node -e ...`，被验证的行为不变。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import * as fs from "./dispatch-core/fleet_scheduler.mjs";
import { ROOT, ToolError } from "./dispatch-core/_tool_common.mjs";
import { MANIFEST_SCHEMA_VERSION } from "./dispatch-core/fleet_manifest_check.mjs";

const NODE = process.execPath;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function deepEqual(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function selfTestScanSeed(goal, reads) {
  return {
    route_id: "explorer-agent__codebase-scan",
    goal,
    scope: { read: [...reads] },
    contract: { scan_mode: "slice_scan", focus: "structure", question: "self-test" },
  };
}

function selfTestTwoNodeManifest() {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: "fleet-scheduler-self-test",
    budget: { max_running_total: 2, max_submitted_per_tick: 2 },
    nodes: [
      { id: "scan-a", seed: selfTestScanSeed("self-test scan A", ["ops/tools"]) },
      {
        id: "scan-b",
        depends_on: ["scan-a"],
        seed: selfTestScanSeed("self-test scan B", ["ops/policies"]),
      },
    ],
  };
}

function stMutationLock(root) {
  let serialized;
  fs.runMutationLock(root, "lock-self-test", () => {
    try {
      fs.runMutationLock(root, "lock-self-test", () => {}, { timeoutSeconds: 0.05 });
      serialized = false;
    } catch (error) {
      serialized = String(error?.message ?? error).includes("mutation lock busy");
    }
  }, { timeoutSeconds: 0.1 });
  return { concurrent_tick_is_serialized: serialized };
}

function stPrimaryRun(root, manifestFile, reviewEvidence) {
  const dispatchOverrideFixture = fs.normalizeDispatchOverrides("isolated");
  const started = fs.startRun(manifestFile, "", root, false, dispatchOverrideFixture);
  const ticked = fs.tickRun(started.run_id, root, true);
  const verboseTicked = fs.tickRun(started.run_id, root, true, true);
  const wouldRun = verboseTicked.submitted[0].dispatch.would_run;
  const fullOutcomeSample = {
    status: "ok",
    node_id: "sample-node",
    task_id: "sample-task",
    dispatch: {
      delivery_mode: "async_subagent",
      model: "sample-model",
      effort: "medium",
      package_id: "sample-package",
      task_package_path: "tmp/dispatch_prepare/sample.task-package.json",
      spawn_payload: "large transport material that must stay out of default tick output",
      business_output: {
        expected_report_path: "notes/explorer/sample.md",
        expected_handoff_path: "notes/handoffs/sample.md",
      },
    },
  };
  const compactOutcomeSample = fs.compactDispatchOutcome(fullOutcomeSample);
  const state = fs.readJson(fs.statePath(root, started.run_id));
  const scanA = fs.indexNodes(state)["scan-a"];
  const taskRoot = path.join(fs.runDir(root, started.run_id), "async_tasks");
  scanA.state = "running";
  scanA.task_id = "task-self-test-a";
  scanA.task_root = taskRoot;
  const inbox = fs.asyncCompletionInbox(taskRoot);
  mkdirSync(inbox, { recursive: true });
  fs.writeJson(path.join(inbox, "task-self-test-a.json"), {
    task_id: "task-self-test-a",
    state: "done",
    write_domain_scope_compliant: false,
    requires_parent_review: true,
    report_path: path.join(root, "report.md"),
    handoff_path: path.join(root, "handoff.md"),
  });
  const waitedNotice = fs.waitForCompletionNotices(state, 0);
  const timeoutState = {
    state_root: root,
    run_id: started.run_id,
    nodes: [
      {
        id: "timeout-node",
        state: "running",
        task_id: "task-without-notice",
        task_root: taskRoot,
      },
    ],
  };
  const waitedTimeout = fs.waitForCompletionNotices(timeoutState, 0);
  const refreshSummary = fs.refreshActiveNodes(state);
  fs.writeJson(fs.statePath(root, started.run_id), state);
  const tickWhileReviewPending = fs.tickRun(started.run_id, root, false);
  const reviewPendingState = fs.readJson(fs.statePath(root, started.run_id));
  const reviewPendingScanB = fs.indexNodes(reviewPendingState)["scan-b"];
  const summaryBeforeReview = fs.statusRun(started.run_id, root, true);
  const acceptedReview = fs.reviewRun(
    started.run_id,
    root,
    "scan-a",
    "accepted",
    reviewEvidence,
    "self-test accept",
  );
  const tickAfterReview = fs.tickRun(started.run_id, root, true);
  const summaryAfterReview = fs.statusRun(started.run_id, root, true);
  const acceptedState = fs.readJson(fs.statePath(root, started.run_id));
  const acceptedScanA = fs.indexNodes(acceptedState)["scan-a"];
  return {
    start_ok: started.status === "ok",
    tick_dry_run_ok: ticked.status === "ok" && ticked.dry_run === true,
    autodrive_tasks_share_cockpit_root_and_run_batch: wouldRun.includes("--batch-id")
      && wouldRun[wouldRun.indexOf("--batch-id") + 1] === started.run_id
      && deepEqual(wouldRun.slice(-2), ["--action", "preview"])
      && wouldRun.includes(fs.DEFAULT_ASYNC_TASK_ROOT),
    dispatch_overrides_persist_in_run_state: deepEqual(state.dispatch_overrides, dispatchOverrideFixture),
    dispatch_overrides_forward_to_dispatch_prepare: [
      "--async-context-mode",
      "isolated",
    ].every((item) => wouldRun.includes(item)),
    tick_event_uses_compact_submission: compactOutcomeSample.task_id === "sample-task"
      && compactOutcomeSample.expected_report_path === "notes/explorer/sample.md"
      && !Object.hasOwn(compactOutcomeSample, "dispatch"),
    fleet_wait_detects_any_completion_notice: waitedNotice.event === "completion_notice"
      && waitedNotice.notice_count === 1
      && waitedNotice.notices[0].task_id === "task-self-test-a"
      && waitedNotice.status_checked === false,
    fleet_wait_timeout_does_not_check_status: waitedTimeout.event === "timeout"
      && waitedTimeout.notice_count === 0
      && waitedTimeout.status_checked === false,
    one_node_ready: ticked.submitted.length === 1,
    dependency_skipped: ticked.skipped.some((item) => item.node_id === "scan-b"),
    completion_inbox_updates_review_gate: refreshSummary.inbox === 1
      && scanA.state === "needs_parent_review"
      && (scanA.last_status ?? {}).source === "completion_notice",
    review_pending_holds_dependency_without_blocking: deepEqual(tickWhileReviewPending.submitted, [])
      && reviewPendingScanB.state === "pending"
      && (reviewPendingScanB.blocked_by ?? null) === null,
    review_accept_unblocks_dependencies: acceptedReview.node_state === "done"
      && acceptedScanA.review_required === false
      && tickAfterReview.submitted.some((item) => item.node_id === "scan-b"),
    status_summary_reports_review_gate: summaryBeforeReview.summary.counts.needs_parent_review === 1
      && summaryBeforeReview.summary.needs_review[0].id === "scan-a"
      && summaryBeforeReview.summary.needs_review[0].requires_parent_review === true,
    status_summary_reports_next_ready: summaryAfterReview.summary.next_ready.some((item) => item.id === "scan-b"),
  };
}

function stBatchGetTelemetry(root) {
  const listRunId = "fleet-scheduler-list-self-test";
  const listTaskRoot = path.join(fs.runDir(root, listRunId), "async_tasks");
  const listTaskDir = path.join(listTaskRoot, "task-self-test-list");
  mkdirSync(listTaskDir, { recursive: true });
  fs.writeJson(path.join(listTaskDir, "task.json"), {
    task_id: "task-self-test-list",
    task_root: listTaskRoot,
    task_dir: listTaskDir,
    target_cwd: ROOT,
  });
  fs.writeJson(path.join(listTaskDir, "status.json"), {
    task_id: "task-self-test-list",
    state: "running",
    created_at: fs.utcNow(),
    updated_at: fs.utcNow(),
    requires_parent_review: false,
  });
  // A4 case 8：写 live 事件流，让 batch get 聚合出 tool_call_count / live_age_seconds / progress_state。
  fs.writeJson(path.join(listTaskDir, "child-task-live.json"), {
    rev: 5,
    status: "running",
    phase: "tool_call",
    updated_at: fs.utcNow(),
    last_event_at: fs.utcNow(),
    last_tool_call: { type: "shell_command", name: "self-test-shell", status: "running" },
    tool_call_counts: [{ key: "self-test-shell", count: 4 }],
  });
  const listState = {
    state_root: root,
    run_id: listRunId,
    nodes: [
      {
        id: "list-node",
        state: "running",
        task_id: "task-self-test-list",
        task_root: listTaskRoot,
        updated_at: fs.utcNow(),
      },
      {
        id: "deferred-node",
        state: "running",
        task_id: "task-self-test-deferred",
        task_root: listTaskRoot,
        next_liveness_check_at: fs.utcAfter(300),
        updated_at: fs.utcNow(),
      },
    ],
  };
  const listRefreshSummary = fs.refreshActiveNodes(listState);
  const listNode = listState.nodes[0];
  const deferredNode = listState.nodes[1];
  return {
    async_get_is_scoped_to_run_task_ids: listRefreshSummary.queried === 1
      && listRefreshSummary.reconciled === 0
      && (listNode.last_status ?? {}).source === "async_get",
  };
}

function stCriticality(root) {
  const criticalManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: "fleet-scheduler-criticality-self-test",
    budget: { max_running_total: 1, max_submitted_per_tick: 1 },
    nodes: [
      { id: "root-shallow", seed: selfTestScanSeed("self-test shallow", ["ops/tools"]) },
      { id: "root-deep", seed: selfTestScanSeed("self-test deep", ["ops/policies"]) },
      {
        id: "middle",
        depends_on: ["root-deep"],
        seed: selfTestScanSeed("self-test middle", ["ops/protocols"]),
      },
      {
        id: "leaf",
        depends_on: ["middle"],
        seed: selfTestScanSeed("self-test leaf", ["ops/workflows"]),
      },
    ],
  };
  const criticalManifestFile = path.join(root, "critical-manifest.json");
  fs.writeJson(criticalManifestFile, criticalManifest);
  const criticalStarted = fs.startRun(criticalManifestFile, "", root, false);
  const criticalTicked = fs.tickRun(criticalStarted.run_id, root, true);
  return { criticality_orders_ready_nodes: criticalTicked.submitted[0].node_id === "root-deep" };
}

function stReviewBlock(root, manifestFile, reviewEvidence) {
  const blockStarted = fs.startRun(manifestFile, "fleet-review-block-self-test", root, false);
  const blockState = fs.readJson(fs.statePath(root, blockStarted.run_id));
  const blockScanA = fs.indexNodes(blockState)["scan-a"];
  blockScanA.state = "needs_parent_review";
  blockScanA.task_id = "task-review-block";
  fs.writeJson(fs.statePath(root, blockStarted.run_id), blockState);
  const blockedReview = fs.reviewRun(
    blockStarted.run_id,
    root,
    "scan-a",
    "blocked",
    reviewEvidence,
    "self-test block",
  );
  fs.tickRun(blockStarted.run_id, root, false);
  const stateAfterBlock = fs.readJson(fs.statePath(root, blockStarted.run_id));
  const blockedScanA = fs.indexNodes(stateAfterBlock)["scan-a"];
  const blockedScanB = fs.indexNodes(stateAfterBlock)["scan-b"];
  return {
    review_block_blocks_dependencies: blockedReview.node_state === "blocked"
      && blockedScanA.review_required === false
      && blockedScanB.state === "blocked"
      && blockedScanB.blocked_by === "scan-a",
  };
}

function stReviewRequeue(root, manifestFile, reviewEvidence) {
  const requeueStarted = fs.startRun(manifestFile, "fleet-review-requeue-self-test", root, false);
  const requeueState = fs.readJson(fs.statePath(root, requeueStarted.run_id));
  const requeueScanA = fs.indexNodes(requeueState)["scan-a"];
  requeueScanA.state = "needs_parent_review";
  requeueScanA.task_id = "task-review-requeue";
  requeueScanA.dispatch = { task_id: "task-review-requeue" };
  requeueScanA.last_status = { state: "done", requires_parent_review: true };
  fs.writeJson(fs.statePath(root, requeueStarted.run_id), requeueState);
  const requeuedReview = fs.reviewRun(
    requeueStarted.run_id,
    root,
    "scan-a",
    "requeued",
    reviewEvidence,
    "self-test requeue",
  );
  const requeuedState = fs.readJson(fs.statePath(root, requeueStarted.run_id));
  const requeuedScanA = fs.indexNodes(requeuedState)["scan-a"];
  const requeueResetVerified = requeuedReview.node_state === "pending"
    && requeuedScanA.task_id === null
    && requeuedScanA.dispatch === null
    && requeuedScanA.last_status === null
    && requeuedScanA.review_required === false
    && requeuedScanA.review_decision === null
    && Array.isArray(requeuedScanA.review_history)
    && requeuedScanA.review_history[requeuedScanA.review_history.length - 1].decision === "requeued"
    && requeuedScanA.superseded_task_ids[requeuedScanA.superseded_task_ids.length - 1] === "task-review-requeue";
  const requeueTaskRoot = path.join(fs.runDir(root, requeueStarted.run_id), "async_tasks");
  requeuedScanA.task_root = requeueTaskRoot;
  const requeueInbox = fs.asyncCompletionInbox(requeueTaskRoot);
  mkdirSync(requeueInbox, { recursive: true });
  requeuedScanA.state = "running";
  requeuedScanA.task_id = "task-review-requeue-fresh";
  requeuedScanA.receipt_task_id = "task-review-requeue-fresh";
  fs.writeJson(path.join(requeueInbox, "task-review-requeue.json"), {
    task_id: "task-review-requeue",
    state: "done",
  });
  const staleReceiptRefresh = fs.refreshActiveNodes(requeuedState);
  const staleReceiptIgnored = staleReceiptRefresh.inbox === 0
    && requeuedScanA.state === "running"
    && (requeuedScanA.last_status ?? null) === null;
  fs.writeJson(path.join(requeueInbox, "task-review-requeue-fresh.json"), {
    task_id: "task-review-requeue-fresh",
    state: "done",
  });
  const freshReceiptRefresh = fs.refreshActiveNodes(requeuedState);
  const unboundNode = { id: "unbound", state: "running", task_id: null };
  const unboundReceiptApplied = fs.applyAsyncStatus(
    unboundNode,
    { task_id: "task-review-requeue", state: "done" },
    "self_test",
  );
  return {
    review_requeue_resets_node: requeueResetVerified,
    stale_requeue_receipt_does_not_update_fresh_attempt: staleReceiptIgnored,
    fresh_requeue_receipt_updates_current_attempt: freshReceiptRefresh.inbox === 1
      && requeuedScanA.receipt_task_id === "task-review-requeue-fresh",
    receipt_without_current_task_id_is_rejected: unboundReceiptApplied === false
      && unboundNode.state === "running"
      && (unboundNode.last_status ?? null) === null,
  };
}

function stCompletedRequeue(root, manifestFile, reviewEvidence) {
  const completedRequeueStarted = fs.startRun(
    manifestFile,
    "fleet-completed-requeue-self-test",
    root,
    false,
  );
  const completedRequeueState = fs.readJson(fs.statePath(root, completedRequeueStarted.run_id));
  const completedRequeueScanA = fs.indexNodes(completedRequeueState)["scan-a"];
  completedRequeueScanA.state = "done";
  completedRequeueScanA.task_id = "task-completed-stale-evidence";
  fs.writeJson(fs.statePath(root, completedRequeueStarted.run_id), completedRequeueState);
  const completedRequeueReview = fs.reviewRun(
    completedRequeueStarted.run_id,
    root,
    "scan-a",
    "requeued",
    reviewEvidence,
    "self-test stale completed evidence",
  );
  const completedRequeueResult = fs.indexNodes(
    fs.readJson(fs.statePath(root, completedRequeueStarted.run_id)),
  )["scan-a"];
  return {
    completed_node_can_requeue_stale_evidence: completedRequeueReview.node_state === "pending"
      && completedRequeueResult.task_id === null
      && completedRequeueResult.review_history[completedRequeueResult.review_history.length - 1].previous_state === "done",
  };
}

function stTerminalClassification() {
  const failedTerminalNode = { id: "failed-terminal", state: "running" };
  fs.applyAsyncStatus(
    failedTerminalNode,
    { state: "failed", failure_type: "worker_process_exit", requires_parent_review: true },
    "self_test",
  );
  const userCancelledNode = { id: "user-cancelled", state: "running" };
  fs.applyAsyncStatus(
    userCancelledNode,
    { state: "cancelled", cancel_reason: "user_requested", requires_parent_review: false },
    "self_test",
  );
  const nonUserCancelledNode = { id: "non-user-cancelled", state: "running" };
  fs.applyAsyncStatus(
    nonUserCancelledNode,
    { state: "cancelled", cancel_reason: "worker_shutdown", requires_parent_review: false },
    "self_test",
  );
  return {
    failed_terminal_settles_without_review: failedTerminalNode.state === "failed"
      && failedTerminalNode.review_required === false,
    explicit_user_cancel_stays_cancelled: userCancelledNode.state === "cancelled"
      && userCancelledNode.review_required === false,
    non_user_cancel_settles_failure: nonUserCancelledNode.state === "failed"
      && nonUserCancelledNode.review_required === false,
  };
}

function stBlockRecovery() {
  const historicalBlockState = {
    nodes: [
      { id: "upstream", state: "done", depends_on: [] },
      { id: "downstream", state: "blocked", blocked_by: "upstream", depends_on: ["upstream"] },
    ],
  };
  const historicalById = fs.indexNodes(historicalBlockState);
  const releasedHistoricalBlocks = fs.releaseResolvedDependencyBlocks(historicalBlockState, historicalById);
  const recoveredDownstream = historicalById.downstream;
  const dispatchFailureNode = { id: "dispatch-failure", state: "pending" };
  fs.markFailure(dispatchFailureNode, {
    contractState: "dispatch_prepare_failed",
    failureType: "dispatch_prepare_exit",
    error: "dispatch_prepare exited 1 without output",
  });
  const legacyDispatchState = {
    nodes: [
      {
        id: "legacy-dispatch-failure",
        state: "blocked",
        task_id: null,
        dispatch: { error: "", stdout: "" },
      },
    ],
  };
  const promotedLegacyDispatchFailures = fs.promoteLegacyDispatchFailureBlocks(legacyDispatchState);
  const promotedLegacyDispatchNode = legacyDispatchState.nodes[0];
  return {
    resolved_dependency_block_recovers_to_pending: deepEqual(releasedHistoricalBlocks, ["downstream"])
      && recoveredDownstream.state === "pending"
      && (recoveredDownstream.blocked_by ?? null) === null,
    dispatch_failure_settles_without_review: dispatchFailureNode.state === "failed"
      && dispatchFailureNode.review_required === false
      && dispatchFailureNode.last_status.contract_state === "dispatch_prepare_failed",
  };
}

function stDriverOutcomes() {
  const completedDriverState = { nodes: [{ id: "done", state: "done" }] };
  const reviewDriverState = {
    nodes: [
      { id: "review", state: "needs_parent_review" },
      { id: "downstream", state: "pending", depends_on: ["review"] },
    ],
  };
  const blockedDriverState = { nodes: [{ id: "blocked", state: "blocked" }] };
  const runningDriverState = { nodes: [{ id: "running", state: "running" }] };
  return {
    autodrive_outcome_is_mechanical: fs.driverOutcome(completedDriverState) === "completed"
      && fs.driverOutcome(reviewDriverState) === "needs_parent_review"
      && fs.driverOutcome(blockedDriverState) === "blocked"
      && fs.driverOutcome(runningDriverState) === "running",
  };
}

function stDependencyArtifacts(root, manifest) {
  const dependencyReport = path.join(root, "dependency-report.md");
  writeFileSync(dependencyReport, "# dependency report\n", "utf8");
  const artifactState = {
    nodes: [
      { id: "upstream", state: "done", last_status: { report_path: dependencyReport } },
      { id: "reducer", state: "pending", depends_on: ["upstream"] },
    ],
  };
  const artifactManifestNode = {
    id: "reducer",
    depends_on: ["upstream"],
    dependency_artifacts: ["report"],
    seed: fs.deepCopy(manifest.nodes[1].seed),
  };
  const injectedArtifactSeed = fs.seedWithDependencyArtifacts(
    artifactState,
    fs.indexNodes(artifactState).reducer,
    artifactManifestNode,
  );
  const missingArtifactState = {
    state_root: root,
    run_id: "missing-artifact",
    nodes: [
      { id: "upstream", state: "done", last_status: {} },
      { id: "reducer", state: "pending", depends_on: ["upstream"] },
    ],
  };
  const missingArtifactNode = fs.indexNodes(missingArtifactState).reducer;
  const missingArtifactOutcome = fs.dispatchNode(
    missingArtifactState,
    manifest,
    missingArtifactNode,
    artifactManifestNode,
    { dryRun: false },
  );
  return {
    dependency_artifacts_injected_into_downstream_seed:
      ((injectedArtifactSeed.scope ?? {}).read ?? []).includes(fs.resolveLikePython(dependencyReport)),
    missing_dependency_artifact_settles_failure: missingArtifactOutcome.status === "failed"
      && missingArtifactNode.state === "failed"
      && missingArtifactNode.review_required === false
      && missingArtifactNode.last_status.contract_state === "dependency_artifact_missing",
  };
}

function stAllSettled(root, manifest) {
  const settledReport = path.join(root, "settled-partial-report.md");
  writeFileSync(settledReport, "# partial but consumable\n", "utf8");
  const settledState = {
    state_root: root,
    run_id: "all-settled-partial",
    nodes: [
      {
        id: "upstream",
        state: "needs_parent_review",
        review_required: true,
        review_decision: "pending",
        last_status: {
          state: "done",
          business_state: "partial",
          requires_parent_review: true,
          report_path: settledReport,
        },
      },
      {
        id: "reducer",
        state: "pending",
        depends_on: ["upstream"],
        dependency_policy: "all_settled",
      },
    ],
  };
  const settledUpdates = fs.registerAllSettledConsumers(settledState);
  const settledById = fs.indexNodes(settledState);
  const settledUpstream = settledById.upstream;
  const settledReducer = settledById.reducer;
  const settledManifestNode = {
    id: "reducer",
    depends_on: ["upstream"],
    dependency_artifacts: ["report"],
    dependency_policy: "all_settled",
    seed: fs.deepCopy(manifest.nodes[1].seed),
  };
  const settledSeed = fs.seedWithDependencyArtifacts(settledState, settledReducer, settledManifestNode);
  const settledIndexPath = fs.dependencyResultIndexPath(root, "all-settled-partial", "reducer");
  const settledIndex = fs.readJson(settledIndexPath);
  const failedSettledState = {
    state_root: root,
    run_id: "all-settled-failed",
    nodes: [
      {
        id: "upstream",
        state: "needs_parent_review",
        review_required: true,
        review_decision: "pending",
        last_status: {
          state: "failed",
          business_state: "failed",
          requires_parent_review: true,
          contract_state: "worker_failed",
          failure_type: "worker_process_exit",
        },
      },
      {
        id: "reducer",
        state: "pending",
        depends_on: ["upstream"],
        dependency_policy: "all_settled",
      },
    ],
  };
  fs.registerAllSettledConsumers(failedSettledState);
  const failedSettledById = fs.indexNodes(failedSettledState);
  const failedSettledReducer = failedSettledById.reducer;
  const failedSettledSeed = fs.seedWithDependencyArtifacts(
    failedSettledState,
    failedSettledReducer,
    settledManifestNode,
  );
  const failedSettledIndex = fs.readJson(
    fs.dependencyResultIndexPath(root, "all-settled-failed", "reducer"),
  );
  const completedSettledDriverState = fs.deepCopy(failedSettledState);
  completedSettledDriverState.nodes[1].state = "done";
  const settledReads = (settledSeed.scope ?? {}).read ?? [];
  return {
    all_settled_defers_leaf_review_to_reducer: deepEqual(settledUpdates, ["upstream"])
      && settledUpstream.state === "done"
      && settledUpstream.review_required === false
      && deepEqual(settledUpstream.review_deferred_to, ["reducer"]),
    all_settled_reducer_accepts_partial_dependency: fs.dependenciesReady(settledReducer, settledById)
      && fs.blockedByFailedDependency(settledReducer, settledById) === null,
    all_settled_injects_report_and_result_index: settledReads.includes(fs.resolveLikePython(settledReport))
      && settledReads.includes(fs.resolveLikePython(settledIndexPath))
      && settledReads[0] === fs.resolveLikePython(settledIndexPath)
      && settledIndex.dependencies[0].business_state === "partial"
      && settledIndex.dependencies[0].artifact_state === "available",
    all_settled_missing_artifact_is_reducer_input: fs.dependenciesReady(failedSettledReducer, failedSettledById)
      && fs.blockedByFailedDependency(failedSettledReducer, failedSettledById) === null
      && failedSettledIndex.dependencies[0].execution_state === "failed"
      && failedSettledIndex.dependencies[0].artifact_state === "missing"
      && (((failedSettledSeed.scope ?? {}).read) ?? []).includes(
        fs.resolveLikePython(fs.dependencyResultIndexPath(root, "all-settled-failed", "reducer")),
      ),
    all_settled_reducer_completion_closes_run: fs.driverOutcome(completedSettledDriverState) === "completed",
  };
}

function stStateRootGuard() {
  let rejected;
  try {
    fs.stateRoot(path.dirname(ROOT));
    rejected = false;
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    rejected = true;
  }
  return { external_state_root_rejected: rejected };
}

function stAcceptanceGate() {
  // acceptance_results 门禁:缺块只标注、随依赖索引交 reducer 推导,不重派;合格放行并清标注。
  const gateRoot = mkdtempSync(path.join(selfTestRoot(), "fleet-acceptance-gate-"));
  try {
    const gateManifestById = {
      "verify-a": {
        id: "verify-a",
        seed: {
          route_id: "verify-agent__code-verification",
          slug: "gate-leaf",
          contract: {
            acceptance_context: {
              acceptance_ids: ["AC-01", "AC-02"],
              items: [{ acceptance_id: "AC-01" }, { acceptance_id: "AC-02" }],
            },
          },
        },
      },
      reduce: {
        id: "reduce",
        reducer: true,
        is_reducer: true,
        seed: { route_id: "verify-agent__acceptance-synthesis" },
      },
    };

    const gateState = () => ({
      nodes: [
        { id: "verify-a", state: "done", task_id: "task-gate-1", review_history: [] },
        { id: "reduce", state: "pending", task_id: null },
      ],
      events: [],
      event_revision: 0,
      revision: 0,
    });

    const missingState = gateState();
    const missingActions = fs.enforceAcceptanceResultsGate(missingState, gateManifestById, { reportRoot: gateRoot });
    const missNode = fs.indexNodes(missingState)["verify-a"];
    const gateAnnotatesWithoutRequeue = missingActions.length === 1
      && missingActions[0].action === "derive_from_prose"
      && missNode.state === "done"
      && missNode.task_id === "task-gate-1"
      && Boolean(missNode.acceptance_results_block)
      && missNode.acceptance_results_checked === "task-gate-1";
    const gateChecksOncePerTask = deepEqual(
      fs.enforceAcceptanceResultsGate(missingState, gateManifestById, { reportRoot: gateRoot }),
      [],
    );
    const [, gateIndexEntries] = fs.dependencyResultEntries(
      missingState,
      { id: "reduce", state: "pending", task_id: null, depends_on: ["verify-a"] },
      { id: "reduce", dependency_policy: "all_settled" },
    );
    const gateAnnotationReachesReducerIndex = gateIndexEntries.some(
      (entry) => entry.node_id === "verify-a" && entry.acceptance_results_block,
    );
    const block = JSON.stringify(
      {
        acceptance_results: [
          { acceptance_id: "AC-01", gate: "pass", evidence_refs: [] },
          { acceptance_id: "AC-02", gate: "fail", evidence_refs: [] },
        ],
      },
      null,
      2,
    );
    writeFileSync(
      path.join(gateRoot, "gate-leaf.md"),
      `# report\n\n\`\`\`json acceptance_results\n${block}\n\`\`\`\n`,
      "utf8",
    );
    const okState = gateState();
    const okActions = fs.enforceAcceptanceResultsGate(okState, gateManifestById, { reportRoot: gateRoot });
    const gatePassesValidBlock = deepEqual(okActions, [])
      && fs.indexNodes(okState)["verify-a"].state === "done"
      && fs.indexNodes(okState)["verify-a"].acceptance_results_checked === "task-gate-1"
      && !Object.hasOwn(fs.indexNodes(okState)["verify-a"], "acceptance_results_block");
    return {
      acceptance_gate_annotates_without_requeue: gateAnnotatesWithoutRequeue,
      acceptance_gate_checks_once_per_task: gateChecksOncePerTask,
      acceptance_gate_annotation_reaches_reducer_index: gateAnnotationReachesReducerIndex,
      acceptance_gate_passes_valid_block: gatePassesValidBlock,
    };
  } finally {
    rmSync(gateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function stCompaction() {
  // A3：salvage 指针化后 compact_node 白名单透传 salvage_evidence_paths（非空数组不被裁掉）。
  const compacted = fs.compactNode({
    id: "salvage-probe",
    state: "done",
    last_status: {
      salvage_report_path: null,
      salvage_evidence_paths: ["/tmp/task/child-final.md"],
    },
  });
  return {
    salvage_evidence_paths_survives_compaction: deepEqual(compacted.salvage_evidence_paths, ["/tmp/task/child-final.md"]),
  };
}

function stCommandNodes(root) {
  const marker = path.join(root, "command-marker.txt");
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: "fleet-command-self-test",
    nodes: [
      {
        id: "produce",
        kind: "command",
        command: {
          argv: [
            NODE,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'made', 'utf8'); console.log('produced');`,
          ],
          timeout_seconds: 120,
        },
      },
      {
        id: "consume",
        kind: "command",
        depends_on: ["produce"],
        command: {
          argv: [
            NODE,
            "-e",
            `process.exit(require('node:fs').readFileSync(${JSON.stringify(marker)}, 'utf8') === 'made' ? 0 : 7);`,
          ],
          timeout_seconds: 120,
        },
      },
    ],
  };
  const manifestFile = path.join(root, "command-manifest.json");
  fs.writeJson(manifestFile, manifest);
  const dryStarted = fs.startRun(manifestFile, "fleet-command-dry-self-test", root, false);
  const dryTick = fs.tickRun(dryStarted.run_id, root, true, true);
  const dryDispatch = dryTick.submitted[0].dispatch ?? {};
  const started = fs.startRun(manifestFile, "", root, false);
  const first = fs.tickRun(started.run_id, root, false);
  const stateAfterFirst = fs.readJson(fs.statePath(root, started.run_id));
  const produceNode = fs.indexNodes(stateAfterFirst).produce;
  const second = fs.tickRun(started.run_id, root, false);
  const stateAfterSecond = fs.readJson(fs.statePath(root, started.run_id));
  const consumeNode = fs.indexNodes(stateAfterSecond).consume;
  const stdoutLog = (produceNode.command_result ?? {}).stdout_path ?? "";
  const failManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: "fleet-command-fail-self-test",
    nodes: [
      {
        id: "boom",
        kind: "command",
        command: { argv: [NODE, "-e", "process.exit(3);"], timeout_seconds: 60 },
      },
    ],
  };
  const failFile = path.join(root, "command-fail-manifest.json");
  fs.writeJson(failFile, failManifest);
  const failStarted = fs.startRun(failFile, "", root, false);
  fs.tickRun(failStarted.run_id, root, false);
  const boom = fs.indexNodes(fs.readJson(fs.statePath(root, failStarted.run_id))).boom;
  const dependencyReport = path.join(root, "command-dependency-report.md");
  writeFileSync(dependencyReport, "# upstream report\n", "utf8");
  const indexState = {
    state_root: root,
    run_id: "command-index-self-test",
    nodes: [
      { id: "upstream", state: "done", last_status: { report_path: dependencyReport } },
      { id: "check-index", state: "pending", depends_on: ["upstream"] },
    ],
  };
  const indexManifestNode = {
    id: "check-index",
    kind: "command",
    depends_on: ["upstream"],
    dependency_artifacts: ["report"],
    dependency_policy: "all_settled",
    command: {
      argv: [
        NODE,
        "-e",
        "const index = JSON.parse(require('node:fs').readFileSync(process.env.FLEET_DEPENDENCY_RESULT_INDEX, 'utf8'));"
        + " process.exit(index.dependencies[0].artifact_state === 'available' ? 0 : 9);",
      ],
      timeout_seconds: 120,
    },
  };
  const indexNode = fs.indexNodes(indexState)["check-index"];
  const indexOutcome = fs.dispatchNode(indexState, manifest, indexNode, indexManifestNode, { dryRun: false });
  return {
    command_node_executes_and_completes: first.status === "ok"
      && produceNode.state === "done"
      && (produceNode.last_status ?? {}).source === "fleet_command"
      && existsSync(marker),
    command_completion_releases_downstream: second.submitted.some((item) => item.node_id === "consume")
      && consumeNode.state === "done"
      && stateAfterSecond.run_state === "completed",
    command_dry_run_reports_argv: dryTick.dry_run === true
      && Boolean(dryDispatch.would_run)
      && dryDispatch.would_run[0] === NODE,
    command_stdout_persisted: Boolean(stdoutLog) && existsSync(stdoutLog),
    command_failure_settles_without_review: boom.state === "failed"
      && (boom.last_status ?? {}).contract_state === "command_failed"
      && boom.review_required === false,
    command_receives_dependency_result_index: indexOutcome.status === "ok" && indexNode.state === "done",
  };
}

function stGateNodes(root) {
  const gateManifest = (runId) => ({
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    nodes: [
      {
        id: "before",
        kind: "command",
        command: { argv: [NODE, "-e", "console.log('before gate');"], timeout_seconds: 60 },
      },
      { id: "confirm", kind: "gate", depends_on: ["before"] },
      {
        id: "after",
        kind: "command",
        depends_on: ["confirm"],
        command: { argv: [NODE, "-e", "console.log('after gate');"], timeout_seconds: 60 },
      },
    ],
  });

  const evidence = path.join(root, "gate-review-evidence.md");
  writeFileSync(evidence, "# gate decision evidence\n", "utf8");
  const acceptFile = path.join(root, "gate-accept-manifest.json");
  fs.writeJson(acceptFile, gateManifest("fleet-gate-accept-self-test"));
  const started = fs.startRun(acceptFile, "", root, false);
  fs.tickRun(started.run_id, root, false);
  fs.tickRun(started.run_id, root, false);
  const openedState = fs.readJson(fs.statePath(root, started.run_id));
  const confirm = fs.indexNodes(openedState).confirm;
  const afterHold = fs.indexNodes(openedState).after;
  const outcomeWhileOpen = fs.driverOutcome(openedState);
  const accepted = fs.reviewRun(started.run_id, root, "confirm", "accepted", evidence, "gate accept");
  fs.tickRun(started.run_id, root, false);
  const finalState = fs.readJson(fs.statePath(root, started.run_id));
  const blockFile = path.join(root, "gate-block-manifest.json");
  fs.writeJson(blockFile, gateManifest("fleet-gate-block-self-test"));
  const blockStarted = fs.startRun(blockFile, "", root, false);
  fs.tickRun(blockStarted.run_id, root, false);
  fs.tickRun(blockStarted.run_id, root, false);
  fs.reviewRun(blockStarted.run_id, root, "confirm", "blocked", evidence, "gate block");
  fs.tickRun(blockStarted.run_id, root, false);
  const blockedState = fs.readJson(fs.statePath(root, blockStarted.run_id));
  const blockedAfter = fs.indexNodes(blockedState).after;
  return {
    gate_opens_after_dependency_done: confirm.state === "needs_parent_review"
      && confirm.review_decision === "pending"
      && (confirm.last_status ?? {}).source === "fleet_gate",
    gate_holds_downstream_until_decision: afterHold.state === "pending"
      && outcomeWhileOpen === "needs_parent_review",
    gate_accept_releases_downstream: accepted.node_state === "done"
      && fs.indexNodes(finalState).after.state === "done"
      && finalState.run_state === "completed",
    gate_block_blocks_downstream: blockedAfter.state === "blocked"
      && blockedAfter.blocked_by === "confirm"
      && blockedState.failure_fuse.status === "tripped",
  };
}

/** 复现 real-k3-dag-run 的 gate 穿透拓扑：all_settled 消费者不得绕过未裁决的 gate。 */
function stGateAllSettled(root) {
  const bypassManifest = (runId) => ({
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    nodes: [
      {
        id: "before",
        kind: "command",
        command: { argv: [NODE, "-e", "console.log('upstream artifact body');"], timeout_seconds: 60 },
      },
      { id: "confirm", kind: "gate", depends_on: ["before"] },
      {
        id: "after",
        kind: "command",
        depends_on: ["before", "confirm"],
        dependency_artifacts: ["report"],
        dependency_policy: "all_settled",
        command: { argv: [NODE, "-e", "console.log('after gate');"], timeout_seconds: 60 },
      },
    ],
  });

  const evidence = path.join(root, "gate-all-settled-evidence.md");
  writeFileSync(evidence, "# gate all_settled evidence\n", "utf8");
  const acceptFile = path.join(root, "gate-all-settled-manifest.json");
  fs.writeJson(acceptFile, bypassManifest("fleet-gate-all-settled-self-test"));
  const started = fs.startRun(acceptFile, "", root, false);
  fs.tickRun(started.run_id, root, false);
  fs.tickRun(started.run_id, root, false);
  fs.tickRun(started.run_id, root, false);
  const openedState = fs.readJson(fs.statePath(root, started.run_id));
  const confirm = fs.indexNodes(openedState).confirm;
  const afterHold = fs.indexNodes(openedState).after;
  const held = confirm.state === "needs_parent_review"
    && afterHold.state === "pending"
    && fs.driverOutcome(openedState) === "needs_parent_review"
    && !(confirm.all_settled_consumers ?? []).length
    && confirm.review_required === true;
  fs.reviewRun(started.run_id, root, "confirm", "accepted", evidence, "gate all_settled accept");
  fs.tickRun(started.run_id, root, false);
  const finalState = fs.readJson(fs.statePath(root, started.run_id));
  const afterFinal = fs.indexNodes(finalState).after;
  const indexFile = fs.dependencyResultIndexPath(root, fs.readJson(fs.statePath(root, started.run_id)).run_id, "after");
  const indexData = existsSync(indexFile) ? fs.readJson(indexFile) : { dependencies: [] };
  const entries = {};
  for (const entry of (indexData.dependencies ?? [])) entries[entry.node_id] = entry;
  const beforeEntry = entries.before ?? {};
  const confirmEntry = entries.confirm ?? {};

  const blockFile = path.join(root, "gate-all-settled-block-manifest.json");
  fs.writeJson(blockFile, bypassManifest("fleet-gate-all-settled-block-self-test"));
  const blockStarted = fs.startRun(blockFile, "", root, false);
  fs.tickRun(blockStarted.run_id, root, false);
  fs.tickRun(blockStarted.run_id, root, false);
  fs.reviewRun(blockStarted.run_id, root, "confirm", "blocked", evidence, "gate all_settled block");
  fs.tickRun(blockStarted.run_id, root, false);
  const blockedState = fs.readJson(fs.statePath(root, blockStarted.run_id));
  const blockedAfter = fs.indexNodes(blockedState).after;
  return {
    gate_not_bypassed_by_all_settled_consumer: held,
    gate_accept_releases_all_settled_consumer: afterFinal.state === "done"
      && finalState.run_state === "completed",
    gate_dependency_skips_artifact_requirement: confirmEntry.artifact_state === "not_requested",
    command_stdout_serves_as_report_artifact: beforeEntry.artifact_state === "available"
      && Boolean((beforeEntry.artifacts ?? {}).report),
    gate_block_blocks_all_settled_consumer: blockedAfter.state === "blocked"
      && blockedAfter.blocked_by === "confirm",
  };
}

function stDriverChain(root) {
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: "fleet-driver-chain-self-test",
    nodes: [
      {
        id: "one",
        kind: "command",
        command: { argv: [NODE, "-e", "console.log('one');"], timeout_seconds: 60 },
      },
      {
        id: "two",
        kind: "command",
        depends_on: ["one"],
        command: { argv: [NODE, "-e", "console.log('two');"], timeout_seconds: 60 },
      },
    ],
  };
  const manifestFile = path.join(root, "driver-chain-manifest.json");
  fs.writeJson(manifestFile, manifest);
  const started = fs.startRun(manifestFile, "", root, false);
  const outcome = fs.driveRun(started.run_id, root, 1000);
  const state = fs.readJson(fs.statePath(root, started.run_id));
  return {
    driver_drains_synchronous_chain: outcome.status === "completed"
      && outcome.ticks >= 2
      && fs.indexNodes(state).two.state === "done",
  };
}

function selfTestRoot() {
  const testRoot = path.join(ROOT, ".runtime", "self-tests", "migration-lock");
  mkdirSync(testRoot, { recursive: true });
  return testRoot;
}

export function selfTest() {
  const manifest = selfTestTwoNodeManifest();
  const testRoot = selfTestRoot();
  const root = mkdtempSync(path.join(testRoot, "fleet-self-test-"));
  try {
    const manifestFile = path.join(root, "manifest.json");
    fs.writeJson(manifestFile, manifest);
    const reviewEvidence = path.join(root, "review-evidence.md");
    writeFileSync(reviewEvidence, "self-test review evidence\n", "utf8");
    const scenarios = [
      () => stMutationLock(root),
      () => stPrimaryRun(root, manifestFile, reviewEvidence),
      () => stBatchGetTelemetry(root),
      () => stCriticality(root),
      () => stReviewBlock(root, manifestFile, reviewEvidence),
      () => stReviewRequeue(root, manifestFile, reviewEvidence),
      () => stCompletedRequeue(root, manifestFile, reviewEvidence),
      () => stTerminalClassification(),
      () => stBlockRecovery(),
      () => stDriverOutcomes(),
      () => stDependencyArtifacts(root, manifest),
      () => stAllSettled(root, manifest),
      () => stStateRootGuard(),
      () => stAcceptanceGate(),
      () => stCompaction(),
      () => stCommandNodes(root),
      () => stGateNodes(root),
      () => stGateAllSettled(root),
      () => stDriverChain(root),
    ];
    const checks = {};
    for (const scenario of scenarios) {
      for (const [name, passed] of Object.entries(scenario())) {
        if (Object.hasOwn(checks, name)) throw new ToolError(`duplicate self-test check name: ${name}`);
        checks[name] = Boolean(passed);
      }
    }
    return {
      status: Object.values(checks).every(Boolean) ? "ok" : "failed",
      checks,
      verification: {
        batch_get_uses_only_run_task_ids: checks.async_get_is_scoped_to_run_task_ids,
        completion_wait_does_not_poll_status: checks.fleet_wait_timeout_does_not_check_status,
        failed_terminal_requires_parent_decision: checks.failed_terminal_requires_parent_decision,
        review_gate_semantics_preserved: checks.review_accept_unblocks_dependencies
          && checks.review_block_blocks_dependencies
          && checks.review_requeue_resets_node,
        all_settled_reducer_semantics: checks.all_settled_defers_leaf_review_to_reducer
          && checks.all_settled_reducer_accepts_partial_dependency
          && checks.all_settled_missing_artifact_is_reducer_input
          && checks.all_settled_reducer_completion_closes_run,
      },
    };
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
