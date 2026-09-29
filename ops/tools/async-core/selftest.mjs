// async Core self-test fixtures. Loaded on demand so the runtime module carries no test scaffolding.

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DISPATCH_ENVELOPE_VERSION, isTerminalState } from "./contracts.mjs";
import {
  MAX_WAIT_MS,
  RETAINED_WORKER_ERROR_CODE,
  cloneValue,
  createContext,
  createRuntime,
} from "./runtime.mjs";

export async function runAsyncTaskCoreSelfTest(options) {
  const ctx = createContext(options);
  const {
    ackReviewTask,
    buildResultReceipt,
    buildSubmitReceipt,
    collectTask,
    completionInboxDir,
    completionNoticePath,
    ensureDir,
    isInside,
    isoNow,
    loadPreparedDispatch,
    processAlive,
    readJson,
    reconcileTask,
    registryFile,
    safeTaskId,
    statusTask,
    taskDir,
    taskFiles,
    taskStatusSummary,
    unregisterTaskLocation,
    updateStatus,
    waitTask,
    writeInitialStatus,
    writeJson,
  } = createRuntime(ctx);
  const selfTestRoot = path.join(
    ctx.config.cwd,
    "tmp",
    `async-task-core-self-test-${Date.now()}-${ctx.host.pid}-${ctx.host.randomHex(4)}`,
  );
  // Keep the fixture task root one level below an invocation-unique parent so
  // completionInboxDir(taskRoot) cannot place concurrent self-tests in the
  // shared <cwd>/tmp/async_inbox used by production task roots.
  const root = path.join(selfTestRoot, "tasks");
  const selfTestInvocationId = path.basename(selfTestRoot)
    .replace(/^async-task-core-self-test-/, "")
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .slice(0, 64);
  let selfTestTaskSequence = 0;
  const selfTestTaskId = (prefix) => safeTaskId(
    `${prefix}-${selfTestInvocationId}-${String(++selfTestTaskSequence).padStart(2, "0")}`,
  );
  const testRegistryRoot = path.join(root, "registry");
  const failureRunner = path.join(root, "failure-runner.mjs");
  const fakeRunner = path.join(root, "fake-child-runner.mjs");
  let testRuntime;
  let cleanupState = null;
  let cleanupSelfTestArtifacts = null;
  const fixtureSubmissions = [];
  // Task 目录直接由夹具写出、没走 submitSelfTest() 的登记项。它与 fixtureSubmissions 一起构成
  // 本 invocation 的全部通知归属；通知期望集合只从这一份清单派生，不另抄计数。
  const additionalNoticeOwners = [];
  const fixtureNoticeOwners = () => [
    ...fixtureSubmissions.map((fixture) => ({ task_root: fixture.task_root, task_id: fixture.task_id })),
    ...additionalNoticeOwners,
  ];
  const fixtureNoticePaths = () => fixtureNoticeOwners().map((owner) => (
    completionNoticePath({ task_root: owner.task_root, task_id: owner.task_id })
  ));
  // Record worker identity at the exact spawn return edge.  submitTask() can throw
  // after this point (for example while unref() or the queued status write fails),
  // so successful submission metadata is not a sufficient process inventory.
  const immediateTrackedWorkerProcesses = new Map();
  const parseWorkerSpawn = (args) => {
    const argv = Array.isArray(args?.[1]) ? args[1] : [];
    if (!argv.includes("worker")) return null;
    const value = (name) => {
      const index = argv.indexOf(name);
      return index >= 0 ? String(argv[index + 1] || "") : "";
    };
    const taskRoot = value("--task-root");
    const taskId = value("--task-id");
    if (!taskRoot || !taskId) return null;
    return {
      task_root: path.resolve(taskRoot),
      task_id: taskId,
      argv: [...argv],
    };
  };
  const catalogWithRunner = (runnerPath, key = "self-test") => ({
    ...cloneValue(ctx.config.runnerCatalog),
    [key]: {
      executor: "self-test",
      basename: path.basename(runnerPath),
      aliases: [],
      path: runnerPath,
      defaultModel: "fake-model",
      defaultEffort: "low",
    },
  });
  const makeFixtureRuntime = (overrides = {}, { trackSpawnedPids = false } = {}) => {
    const hostOverrides = { ...(overrides.host || {}) };
    if (trackSpawnedPids) {
      const lowLevelSpawn = hostOverrides.spawn || ctx.host.spawn;
      hostOverrides.spawn = (...args) => {
        const child = lowLevelSpawn(...args);
        const pid = Number(child?.pid);
        const worker = parseWorkerSpawn(args);
        if (worker && Number.isInteger(pid) && pid > 0) {
          immediateTrackedWorkerProcesses.set(pid, { pid, ...worker });
        }
        return child;
      };
    }
    return createRuntime(createContext({
      ...ctx.config,
      ...overrides,
      childEnv: {
        ...cloneValue(ctx.config.childEnv),
        [ctx.config.selfTestEnvironment.registryRoot]: testRegistryRoot,
        [ctx.config.selfTestEnvironment.allowCustomRunner]: "1",
      },
      runnerCatalog: overrides.runnerCatalog || cloneValue(ctx.config.runnerCatalog),
      defaultRunnerEntry: overrides.defaultRunnerEntry || cloneValue(ctx.config.defaultRunnerEntry),
      host: { ...ctx.host, ...hostOverrides },
    }));
  };
  const submitSelfTest = (input) => {
    const taskId = input.task_id || selfTestTaskId("fixture-self-test");
    const submitted = testRuntime.submitTask({
      ...input,
      task_id: taskId,
      registry_root: testRegistryRoot,
      // Each fixture normally owns an invocation-local claim root.  A focused
      // same-repository prompt fixture may pass producer_root explicitly.
      producer_root: input.producer_root || path.join(selfTestRoot, "claims", taskId),
    });
    fixtureSubmissions.push({
      task_id: submitted.task_id,
      task_root: path.resolve(String(input.task_root || ctx.config.defaultTaskRoot)),
      task_dir: submitted.task_dir,
      status_path: taskFiles(submitted.task_dir).status,
      pid: submitted.pid,
      child_pid: null,
    });
    return submitted;
  };
  const SELF_TEST_NATURAL_WORKER_WAIT_MS = 1000;
  const SELF_TEST_TERMINATION_CONFIRM_WAIT_MS = 2000;
  let workerShutdownState = null;
  let workerShutdownPromise = null;
  let operationError = null;
  const knownWorkerRecords = () => [
    ...immediateTrackedWorkerProcesses.values(),
    ...fixtureSubmissions,
  ];
  const statusCandidatesForWorkerRecords = () => {
    const candidates = new Map();
    for (const record of knownWorkerRecords()) {
      const taskRoot = path.resolve(String(record.task_root || ""));
      const taskId = String(record.task_id || "");
      if (taskRoot && taskId) {
        candidates.set(path.resolve(taskFiles(taskDir(taskRoot, taskId)).status), {
          task_root: taskRoot,
          task_id: taskId,
          top_pid: Number(record.pid) || null,
        });
      }
    }
    const roots = new Set([...knownWorkerRecords()]
      .map((record) => String(record.task_root || ""))
      .filter(Boolean)
      .map((rootPath) => path.resolve(rootPath)));
    for (const taskRoot of roots) {
      if (!existsSync(taskRoot)) continue;
      let entries = [];
      try { entries = readdirSync(taskRoot, { withFileTypes: true }); } catch {}
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const taskId = entry.name;
        const statusPath = path.join(taskRoot, taskId, "status.json");
        candidates.set(path.resolve(statusPath), { task_root: taskRoot, task_id: taskId, top_pid: null });
      }
    }
    return candidates;
  };
  const discoverTrackedProcesses = () => {
    const pids = new Set();
    for (const record of knownWorkerRecords()) {
      const pid = Number(record.pid);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    const unknownProcessTrees = [];
    for (const [statusPath, identity] of statusCandidatesForWorkerRecords()) {
      const status = readJson(statusPath, null);
      if (!status) continue;
      const topPid = Number(status.pid) || Number(identity.top_pid) || null;
      const childPid = Number(status.child_pid) || null;
      if (Number.isInteger(topPid) && topPid > 0) pids.add(topPid);
      if (Number.isInteger(childPid) && childPid > 0) pids.add(childPid);
      const fixture = fixtureSubmissions.find((item) => (
        path.resolve(String(item.task_root || "")) === identity.task_root
        && String(item.task_id || "") === identity.task_id
      ));
      if (fixture && childPid) fixture.child_pid = childPid;
      if (
        status.runner_spawn_pending === true
        && Number.isInteger(topPid)
        && topPid > 0
        && !isTrackedWorkerAlive(topPid)
        && !(Number.isInteger(childPid) && childPid > 0)
      ) {
        unknownProcessTrees.push({
          task_root: identity.task_root,
          task_id: identity.task_id,
          top_pid: topPid,
          status_path,
          reason: "process_tree_confirmation_unknown",
        });
      }
    }
    return { pids: [...pids], unknown_process_trees: unknownProcessTrees };
  };
  const isTrackedWorkerAlive = (pid) => {
    try {
      return Boolean(ctx.host.isProcessAlive(pid));
    } catch {
      return true;
    }
  };
  const waitForTrackedWorkers = async (waitMs) => {
    const deadline = ctx.host.nowMs() + Math.max(0, waitMs);
    let discovered = discoverTrackedProcesses();
    while (true) {
      discovered = discoverTrackedProcesses();
      const livePids = discovered.pids.filter((pid) => isTrackedWorkerAlive(pid));
      const unknown = discovered.unknown_process_trees;
      if ((!livePids.length && !unknown.length) || ctx.host.nowMs() >= deadline) {
        return { ...discovered, live_pids: livePids };
      }
      const remaining = Math.max(1, Math.min(25, deadline - ctx.host.nowMs()));
      await new Promise((resolve) => ctx.host.setTimer(resolve, remaining));
    }
  };
  const shutdownTrackedWorkers = () => {
    if (workerShutdownPromise) return workerShutdownPromise;
    workerShutdownPromise = (async () => {
      const natural = await waitForTrackedWorkers(SELF_TEST_NATURAL_WORKER_WAIT_MS);
      const forcedTerminationAttempts = [];
      if (natural.live_pids.length) {
        for (const pid of natural.live_pids) {
          if (!isTrackedWorkerAlive(pid)) continue;
          let requested = false;
          let error = null;
          try {
            requested = Boolean(ctx.host.terminateProcessTree(pid));
          } catch (terminationError) {
            error = terminationError?.message ?? String(terminationError);
          }
          forcedTerminationAttempts.push({ pid, requested, error });
        }
      }
      const confirmation = natural.live_pids.length || natural.unknown_process_trees.length
        ? await waitForTrackedWorkers(SELF_TEST_TERMINATION_CONFIRM_WAIT_MS)
        : natural;
      const unknownProcessTrees = confirmation.unknown_process_trees || [];
      const remainingPids = [
        ...confirmation.live_pids,
        ...unknownProcessTrees.map((item) => item.top_pid).filter(Boolean),
      ];
      const allExited = confirmation.live_pids.length === 0 && unknownProcessTrees.length === 0;
      return {
        tracked_pids: confirmation.pids,
        natural_exit: natural.live_pids.length === 0 && natural.unknown_process_trees.length === 0,
        forced_termination_used: forcedTerminationAttempts.length > 0,
        forced_termination_attempts: forcedTerminationAttempts,
        termination_confirmation_completed: allExited,
        all_tracked_workers_exited: allExited,
        remaining_pids: remainingPids,
        unknown_process_trees: unknownProcessTrees,
        failure_type: unknownProcessTrees.length ? "process_tree_confirmation_unknown" : null,
      };
    })();
    return workerShutdownPromise;
  };
  const workerShutdownError = (state) => {
    const error = new Error(
      `async Core self-test could not confirm controlled worker exit; preserving diagnostics for pid(s): ${state.remaining_pids.join(", ")}`,
    );
    error.code = state.failure_type === "process_tree_confirmation_unknown"
      ? "process_tree_confirmation_unknown"
      : "ASYNC_SELF_TEST_WORKER_SHUTDOWN_UNCONFIRMED";
    error.shutdown = state;
    return error;
  };
  cleanupSelfTestArtifacts = () => {
    const expectedFixtureNoticePaths = fixtureNoticePaths();
    if (!workerShutdownState?.all_tracked_workers_exited) {
      return {
        task_root_removed: false,
        completion_notices_removed: 0,
        expected_completion_notices: expectedFixtureNoticePaths.length,
        expected_completion_notices_removed: 0,
        unexpected_completion_notices: [],
        missing_completion_notices: expectedFixtureNoticePaths.map((noticePath) => path.basename(noticePath)),
        matching_completion_notices_removed: false,
        cleanup_succeeded: false,
        preserved_diagnostics: true,
        errors: ["controlled worker exit was not confirmed; task root and inbox were preserved"],
      };
    }
    const expectedNoticeSet = new Set(expectedFixtureNoticePaths.map((file) => path.resolve(file)));
    const inbox = completionInboxDir(root);
    let completionNoticesRemoved = 0;
    let expectedCompletionNoticesRemoved = 0;
    const observedExpectedNotices = new Set();
    const unexpectedCompletionNotices = [];
    const cleanupErrors = [];
    const removeNotice = (noticePath) => {
      const resolved = path.resolve(noticePath);
      const expected = expectedNoticeSet.has(resolved);
      try {
        rmSync(noticePath, { force: true });
        completionNoticesRemoved += 1;
        if (!expected) {
          const name = path.basename(noticePath);
          if (!unexpectedCompletionNotices.includes(name)) unexpectedCompletionNotices.push(name);
        } else {
          expectedCompletionNoticesRemoved += 1;
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    const noticeMatchesFixture = (noticePath) => {
      if (expectedNoticeSet.has(path.resolve(noticePath))) return true;
      try {
        const notice = readJson(noticePath, {});
        const noticeTaskDir = notice.task_dir ? path.resolve(notice.task_dir) : "";
        return noticeTaskDir === root || noticeTaskDir.startsWith(`${root}${path.sep}`);
      } catch {
        return false;
      }
    };
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (existsSync(inbox)) {
        for (const entry of readdirSync(inbox, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const noticePath = path.join(inbox, entry.name);
          if (!noticeMatchesFixture(noticePath)) continue;
          if (expectedNoticeSet.has(path.resolve(noticePath))) observedExpectedNotices.add(path.resolve(noticePath));
          removeNotice(noticePath);
        }
      }
      for (const noticePath of expectedFixtureNoticePaths) {
        if (!existsSync(noticePath)) continue;
        observedExpectedNotices.add(path.resolve(noticePath));
        removeNotice(noticePath);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      rmSync(selfTestRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      cleanupErrors.push(error);
    }
    let matchingNoticesRemain = false;
    try {
      matchingNoticesRemain = expectedFixtureNoticePaths.some((noticePath) => existsSync(noticePath));
      if (!matchingNoticesRemain && existsSync(inbox)) {
        matchingNoticesRemain = readdirSync(inbox, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .some((entry) => noticeMatchesFixture(path.join(inbox, entry.name)));
      }
    } catch (error) {
      cleanupErrors.push(error);
      matchingNoticesRemain = true;
    }
    const taskRootRemoved = !existsSync(root);
    const selfTestRootRemoved = !existsSync(selfTestRoot);
    const missingCompletionNotices = expectedFixtureNoticePaths
      .filter((noticePath) => !observedExpectedNotices.has(path.resolve(noticePath)))
      .map((noticePath) => path.basename(noticePath));
    return {
      task_root_removed: taskRootRemoved,
      self_test_root_removed: selfTestRootRemoved,
      completion_notices_removed: completionNoticesRemoved,
      expected_completion_notices: expectedFixtureNoticePaths.length,
      expected_completion_notices_removed: expectedCompletionNoticesRemoved,
      unexpected_completion_notices: unexpectedCompletionNotices,
      missing_completion_notices: missingCompletionNotices,
      matching_completion_notices_removed: !matchingNoticesRemain,
      cleanup_succeeded: cleanupErrors.length === 0
        && taskRootRemoved
        && selfTestRootRemoved
        && !matchingNoticesRemain,
      errors: cleanupErrors.map((error) => error?.message ?? String(error)),
    };
  };
  ensureDir(root);
  try {
    writeFileSync(failureRunner, "export {};\\n", "utf8");
  const crossRepoTarget = path.join(root, "target-repo");
  const preparedDir = path.join(root, "tmp", "dispatch_prepare");
  const crossRepoTaskFile = path.join(preparedDir, "cross-repo.task.md");
  const crossRepoDispatchFile = path.join(preparedDir, "cross-repo.dispatch.json");
  const crossRepoTaskRoot = path.join(root, ".runtime", "async_tasks");
  ensureDir(crossRepoTarget);
  ensureDir(preparedDir);
  writeFileSync(crossRepoTaskFile, "# cross-repo read-only self-test\n", "utf8");
  writeJson(crossRepoDispatchFile, {
    contract_version: DISPATCH_ENVELOPE_VERSION,
    producer_root: root,
    target_cwd: crossRepoTarget,
    task_file: crossRepoTaskFile,
    task_root: crossRepoTaskRoot,
    runner_path: Object.values(ctx.config.runnerCatalog).find((entry) => existsSync(entry.path))?.path || fakeRunner,
    execution_profile: "standard",
    result_mode: "read_only_audit",
    context_mode: "project-aware",
    origin_thread_id: "thread-self-test",
    batch_id: "batch-self-test",
    slice_id: "cross-repo",
    display_title: "跨仓只读自检",
  });
  const crossRepoPrepared = loadPreparedDispatch(crossRepoDispatchFile);
  const statusFailureReceipt = buildSubmitReceipt({
    task_id: selfTestTaskId("post-submit-status-failure"),
    task_dir: path.join(root, "missing-post-submit-status"),
    state: "queued",
    revision: "2",
    submitted_at: isoNow(),
    display_title: "status failure fixture",
  });
  const budgetFailureReceipt = buildSubmitReceipt({
    task_id: selfTestTaskId("post-submit-budget-failure"),
    task_dir: path.join(root, "missing-post-submit-budget"),
    state: "queued",
    revision: "2",
    submitted_at: isoNow(),
    display_title: "界".repeat(2000),
  });
  const workerStartFailureId = selfTestTaskId("worker-start-failure-self-test");
  const workerStartFailureDir = taskDir(root, workerStartFailureId);
  const failureCatalog = catalogWithRunner(failureRunner, "failure");
  const atomicFailureRuntime = makeFixtureRuntime({
    registryRoot: testRegistryRoot,
    defaultTaskRoot: root,
    defaultRunnerPath: failureRunner,
    defaultRunnerKey: "failure",
    defaultRunnerEntry: failureCatalog.failure,
    runnerCatalog: failureCatalog,
    allowCustomRunner: true,
    host: {
      spawn() { throw new Error("injected worker start failure"); },
    },
  });
  try {
    atomicFailureRuntime.submitTask({
      task_id: workerStartFailureId,
      task: "worker start failure self-test",
      task_root: root,
      registry_root: testRegistryRoot,
      producer_root: root,
      target_cwd: ctx.config.cwd,
      runner_path: failureRunner,
      model: "fake-model",
      effort: "low",
    });
  } catch {
    // 断言在 checks 中统一输出。
  }
  const workerStartFailureIsAtomic =
    !existsSync(workerStartFailureDir) && !existsSync(registryFile(testRegistryRoot, workerStartFailureId));
  // 回归：notes/tooling/20260910-registry-miss-reported-as-invalid-record.md
  // 别家服务派的任务在本登记根没有记录 → 报「未登记于 <registryRoot>」；记录存在但损坏 → 仍报「Invalid task registry record」。
  const unregisteredTaskId = selfTestTaskId("unregistered-elsewhere-self-test");
  let unregisteredMessage = "";
  try {
    statusTask({ registry_root: testRegistryRoot, task_id: unregisteredTaskId });
  } catch (error) {
    unregisteredMessage = String(error?.message ?? error);
  }
  const corruptRegistryTaskId = selfTestTaskId("corrupt-registry-record-self-test");
  writeFileSync(registryFile(testRegistryRoot, corruptRegistryTaskId), JSON.stringify({ task_id: corruptRegistryTaskId }), "utf8");
  let corruptRegistryMessage = "";
  try {
    statusTask({ registry_root: testRegistryRoot, task_id: corruptRegistryTaskId });
  } catch (error) {
    corruptRegistryMessage = String(error?.message ?? error);
  }
  const registryMissAndCorruptionAreDistinguished =
    unregisteredMessage.includes(`Task ${unregisteredTaskId} is not registered under ${path.resolve(testRegistryRoot)}`) &&
    !unregisteredMessage.includes("Invalid task registry record") &&
    corruptRegistryMessage === `Invalid task registry record: ${corruptRegistryTaskId}`;
  const workerTerminationFailureId = selfTestTaskId("worker-termination-failure-self-test");
  const workerTerminationFailureDir = taskDir(root, workerTerminationFailureId);
  let workerTerminationFailureCode = "";
  const retainedFailureRuntime = makeFixtureRuntime({
    registryRoot: testRegistryRoot,
    defaultTaskRoot: root,
    defaultRunnerPath: failureRunner,
    defaultRunnerKey: "failure",
    defaultRunnerEntry: failureCatalog.failure,
    runnerCatalog: failureCatalog,
    allowCustomRunner: true,
    host: {
      spawn() {
        return {
          pid: 2147483646,
          kill() { throw new Error("injected termination failure"); },
          unref() { throw new Error("injected post-spawn failure"); },
        };
      },
      isProcessAlive() { return true; },
    },
  }, { trackSpawnedPids: true });
  try {
    retainedFailureRuntime.submitTask({
      task_id: workerTerminationFailureId,
      task: "worker termination failure self-test",
      task_root: root,
      registry_root: testRegistryRoot,
      producer_root: root,
      target_cwd: ctx.config.cwd,
      runner_path: failureRunner,
      model: "fake-model",
      effort: "low",
    });
  } catch (error) {
    workerTerminationFailureCode = String(error?.code || "");
  }
  const retainedFailureStatus = readJson(taskFiles(workerTerminationFailureDir).status, {});
  const workerTerminationFailurePreservesTask =
    existsSync(workerTerminationFailureDir) &&
    existsSync(registryFile(testRegistryRoot, workerTerminationFailureId)) &&
    retainedFailureStatus.state === "cancel_requested" &&
    retainedFailureStatus.failure_type === "worker_start_cleanup_failed" &&
    workerTerminationFailureCode === RETAINED_WORKER_ERROR_CODE;
  unregisterTaskLocation(testRegistryRoot, workerTerminationFailureId);
  rmSync(workerTerminationFailureDir, { recursive: true, force: true });
  writeFileSync(
    fakeRunner,
    [
      "import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const args = process.argv.slice(2);",
      "function value(name, fallback='') { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; }",
      "const outDir = value('--outDir');",
      "const taskFile = value('--taskFile');",
      "const model = value('--model');",
      "mkdirSync(outDir, { recursive: true });",
      "writeFileSync(path.join(outDir, 'fake-runner-argv.json'), JSON.stringify(args), 'utf8');",
      "if (model === 'fake-no-outputs') {",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\npass without required outputs\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done' }, null, 2), 'utf8');",
      "  process.exit(0);",
      "}",
      "if (model === 'fake-readonly-final-only') {",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态：completed\\n\\n## 事实与证据\\nreadonly final only evidence.\\n\\n## 已检查内容\\nread-only self-test.\\n\\n## 失败检查\\nnone.\\n\\n## 不确定项\\nnone.\\n\\n## 边界\\nread-only final only.\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done', orchestration: { ok: true, status: 'completed', failure_type: 'none' }, task: { ok: true, status: 'completed', failure_type: 'none' } }, null, 2), 'utf8');",
      "  process.exit(0);",
      "}",
      "if (model === 'fake-task-partial') {",
      "  writeFileSync(path.join(outDir, 'report.md'), '# fake partial report\\n\\nscanned part of scope.\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: partial\\nsummary: fake runner scanned part of scope.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - scope too broad\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态：partial\\n\\n## 事实与证据\\nreport.md\\n\\n## 已检查内容\\npart of scope\\n\\n## 失败检查\\nremaining scope not covered\\n\\n## 不确定项\\nnone\\n\\n## 边界\\nself-test only\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: false, status: 'blocked', orchestration: { ok: true, status: 'completed', failure_type: 'none' }, task: { ok: false, status: 'partial', failure_type: 'task_partial' } }, null, 2), 'utf8');",
      "  process.exit(1);",
      "}",
      "if (model === 'fake-progress-only') {",
      "  writeFileSync(path.join(outDir, 'child-final.md'), 'still scanning core files, will continue next turn...\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done' }, null, 2), 'utf8');",
      "  process.exit(0);",
      "}",
      "if (model === 'fake-done-synonym') {",
      "  writeFileSync(path.join(outDir, 'report.md'), '# fake done-synonym report\\n\\ncomplete.\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: done\\nsummary: fake done synonym.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - none\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态：completed\\n\\n## 事实与证据\\nreport.md\\n\\n## 已检查内容\\ndone synonym\\n\\n## 失败检查\\nnone\\n\\n## 不确定项\\nnone\\n\\n## 边界\\nself-test only\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done', orchestration: { ok: true, status: 'completed', failure_type: 'none' }, task: { ok: true, status: 'done', failure_type: 'none' } }, null, 2), 'utf8');",
      "  process.exit(0);",
      "}",
      "if (model === 'fake-business-failed') {",
      "  writeFileSync(path.join(outDir, 'report.md'), '# fake business-failed report\\n\\nturn ok but task failed.\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: failed\\nsummary: fake business failed.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - task reported failure\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态：failed\\n\\n## 事实与证据\\nreport.md\\n\\n## 已检查内容\\nnone usable\\n\\n## 失败检查\\ncore step failed\\n\\n## 不确定项\\nnone\\n\\n## 边界\\nself-test only\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: false, status: 'failed', orchestration: { ok: true, status: 'completed', failure_type: 'none' }, task: { ok: false, status: 'error', failure_type: 'task_failed' } }, null, 2), 'utf8');",
      "  process.exit(1);",
      "}",
      "if (model === 'fake-write-domain-violation') {",
      "  const auditPath = path.join(outDir, 'write-domain-events.jsonl');",
      "  writeFileSync(auditPath, JSON.stringify({ tool_call_id: 'w-out', tool: 'write', raw_path: 'README.md', allowed: false }) + '\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'report.md'), '# write-domain report\\n\\ncompleted with a blocked out-of-scope request.\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: done\\nsummary: write-domain violation recorded.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - parent review required\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态：completed\\n\\n## 事实与证据\\nwrite-domain audit\\n\\n## 已检查内容\\nwrite guard\\n\\n## 失败检查\\nblocked outside write\\n\\n## 不确定项\\nnone\\n\\n## 边界\\nself-test only\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'completed', orchestration: { ok: true, status: 'completed', failure_type: 'none' }, task: { ok: true, status: 'completed', failure_type: 'none' }, write_domain: { profile: 'pi-child-write-domain/v1', enabled: true, scope_compliant: false, audit_complete: true, blocked_count: 1, violation_count: 2, reported_violation_count: 1, covered_tools: ['write', 'edit'], command_write_enforced: false, audit_path: auditPath } }, null, 2), 'utf8');",
      "  process.exit(0);",
      "}",
      "if (model === 'fake-invalid-final') {",
      "  writeFileSync(path.join(outDir, 'child-final.md'), 'still enumerating publish manifest fields, will continue next turn...\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: false, status: 'failed', failure_type: 'child_turn_failed', turn: { id: 'turn-failed', startAck: true, status: 'failed' }, orchestration: { ok: false, status: 'failed', failure_type: 'child_turn_failed' }, task: { ok: false, status: 'missing', failure_type: 'task_status_missing' } }, null, 2), 'utf8');",
      "  process.exit(1);",
      "}",
      "if (model === 'fake-high-tool-count') {",
      "  writeFileSync(path.join(outDir, 'child-task-live.json'), JSON.stringify({ rev: 1, status: 'running', phase: 'tool_call', updated_at: new Date().toISOString(), last_event_at: new Date().toISOString(), tool_call_counts: [{ key: 'shell_command', count: 120 }] }, null, 2), 'utf8');",
      "  await new Promise((resolve) => setTimeout(resolve, 300));",
      "  writeFileSync(path.join(outDir, 'report.md'), '# high tool count report\\n\\ncompleted normally.\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: done\\nsummary: high tool count completed.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - none\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态：completed\\n\\n## 事实与证据\\nreport.md\\n\\n## 已检查内容\\nhigh tool count\\n\\n## 失败检查\\nnone\\n\\n## 不确定项\\nnone\\n\\n## 边界\\nself-test only\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done', received_max_tool_calls: args.includes('--maxToolCalls'), orchestration: { ok: true, status: 'completed' }, task: { ok: true, status: 'completed' } }, null, 2), 'utf8');",
      "  process.exit(0);",
      "}",
      "if (model === 'fake-elapsed-hint') {",
      "  writeFileSync(path.join(outDir, 'child-task-live.json'), JSON.stringify({ rev: 1, status: 'running', phase: 'turn_wait', updated_at: new Date().toISOString(), last_event_at: new Date().toISOString(), tool_call_counts: [{ key: 'slow-shell', count: 3 }] }, null, 2), 'utf8');",
      "  await new Promise((resolve) => setTimeout(resolve, 900));",
      "  writeFileSync(path.join(outDir, 'report.md'), '# elapsed hint report\\n\\ncompleted normally.\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: done\\nsummary: elapsed hint completed.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - none\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态：completed\\n\\n## 事实与证据\\nreport.md\\n\\n## 已检查内容\\nelapsed hint\\n\\n## 失败检查\\nnone\\n\\n## 不确定项\\nnone\\n\\n## 边界\\nself-test only\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done', orchestration: { ok: true, status: 'completed' }, task: { ok: true, status: 'completed' } }, null, 2), 'utf8');",
      "  process.exit(0);",
      "}",
      "if (model === 'fake-provider-error-once') {",
      "  const marker = path.join(outDir, 'provider-error-marker');",
      "  let firstAttempt = false;",
      "  try { readFileSync(marker, 'utf8'); } catch { firstAttempt = true; }",
      "  if (firstAttempt) {",
      "    writeFileSync(marker, 'attempt-1 provider_error', 'utf8');",
      "    writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态:failed\\n', 'utf8');",
      "    writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: false, status: 'failed', failure_type: 'provider_error', error: 'This operation was aborted', orchestration: { ok: false, status: 'failed', failure_type: 'provider_error' } }, null, 2), 'utf8');",
      "    process.exit(1);",
      "  }",
      "  writeFileSync(path.join(outDir, 'report.md'), '# provider retry report\\n\\nsecond attempt ok.\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: done\\nsummary: retried after provider error.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - none\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态：completed\\n\\n## 事实与证据\\nreport.md\\n\\n## 已检查内容\\nprovider retry\\n\\n## 失败检查\\nnone\\n\\n## 不确定项\\nnone\\n\\n## 边界\\nself-test only\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done', orchestration: { ok: true, status: 'completed', failure_type: 'none' }, task: { ok: true, status: 'completed', failure_type: 'none' } }, null, 2), 'utf8');",
      "  process.exit(0);",
      "}",
      "if (model === 'fake-provider-error-always') {",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态:failed\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: false, status: 'failed', failure_type: 'provider_error', error: 'This operation was aborted', orchestration: { ok: false, status: 'failed', failure_type: 'provider_error' } }, null, 2), 'utf8');",
      "  process.exit(1);",
      "}",
      "if (model === 'fake-stalled') {",
      "  // 静默 1500ms（阈值由 submit 的 stall_silence_ms 决定），再发一个新事件让 stall 清除，然后正常收尾。",
      "  writeFileSync(path.join(outDir, 'child-task-live.json'), JSON.stringify({ rev: 1, status: 'running', phase: 'tool_call', updated_at: new Date().toISOString(), last_event_at: new Date().toISOString(), last_tool_call: { type: 'shell_command', name: 'self-test-hang', status: 'running' }, tool_call_counts: [{ key: 'self-test-hang', count: 1 }] }, null, 2), 'utf8');",
      "  await new Promise((resolve) => setTimeout(resolve, 1500));",
      "  for (let rev = 2; rev <= 5; rev += 1) {",
      "    writeFileSync(path.join(outDir, 'child-task-live.json'), JSON.stringify({ rev, status: 'running', phase: 'turn_wait', updated_at: new Date().toISOString(), last_event_at: new Date().toISOString(), last_tool_call: { type: 'shell_command', name: 'self-test-hang', status: 'completed' }, tool_call_counts: [{ key: 'self-test-hang', count: 1 }] }, null, 2), 'utf8');",
      "    await new Promise((resolve) => setTimeout(resolve, 300));",
      "  }",
      "  writeFileSync(path.join(outDir, 'report.md'), '# fake stalled report\\n\\ndone.\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: done\\nsummary: fake stalled runner recovered.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - none\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态：completed\\n\\n## 事实与证据\\nreport.md\\n\\n## 已检查内容\\nfake stalled\\n\\n## 失败检查\\nnone\\n\\n## 不确定项\\nnone\\n\\n## 边界\\nself-test only\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done', orchestration: { ok: true, status: 'completed', failure_type: 'none' }, task: { ok: true, status: 'completed', failure_type: 'none' } }, null, 2), 'utf8');",
      "  process.exit(0);",
      "}",
      "if (model === 'fake-slow-running') {",
      "  writeFileSync(path.join(outDir, 'child-task-live.json'), JSON.stringify({ rev: 1, status: 'running', phase: 'turn_wait', updated_at: new Date().toISOString(), last_event_at: new Date().toISOString(), last_tool_call: { type: 'shell_command', name: 'self-test-sleep', status: 'running' }, tool_call_counts: [{ key: 'self-test-sleep', count: 1 }] }, null, 2), 'utf8');",
      "  await new Promise((resolve) => setTimeout(resolve, 1200));",
      "  writeFileSync(path.join(outDir, 'report.md'), '# fake slow report\\n\\ndone.\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: done\\nsummary: fake slow runner completed.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - none\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\n任务状态：completed\\n\\n## 事实与证据\\nreport.md\\n\\n## 已检查内容\\nfake slow\\n\\n## 失败检查\\nnone\\n\\n## 不确定项\\nnone\\n\\n## 边界\\nself-test only\\n', 'utf8');",
      "  writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done', orchestration: { ok: true, status: 'completed', failure_type: 'none' }, task: { ok: true, status: 'completed', failure_type: 'none' } }, null, 2), 'utf8');",
      "  process.exit(0);",
      "}",
      "const taskText = readFileSync(taskFile, 'utf8');",
      "writeFileSync(path.join(outDir, 'report.md'), '# fake report\\n\\n' + taskText.slice(0, 120) + '\\n', 'utf8');",
      "writeFileSync(path.join(outDir, 'handoff.md'), 'verdict: done\\nsummary: fake runner completed.\\nfiles_read_or_changed:\\n  - report.md\\nevidence_paths:\\n  - report.md\\nblockers:\\n  - none\\n', 'utf8');",
      "writeFileSync(path.join(outDir, 'child-final.md'), '## 结论\\npass\\n\\n## 事实与证据\\nreport.md\\n\\n## 已检查内容\\nfake\\n\\n## 失败检查\\nnone\\n\\n## 不确定项\\nnone\\n\\n## 边界\\nself-test only\\n', 'utf8');",
      "const simulatedTurn = args.includes('--simProfileJson') ? { turn: { id: 'simulation-fixture-turn', startAck: true, completed: true } } : {};",
      "writeFileSync(path.join(outDir, 'child-task-result.json'), JSON.stringify({ ok: true, status: 'done', ...simulatedTurn, orchestration: { ok: true, status: 'completed', failure_type: 'none' }, task: { ok: true, status: 'completed', failure_type: 'none' } }, null, 2), 'utf8');",
    ].join("\n"),
    "utf8",
  );
  const fixtureCatalog = catalogWithRunner(fakeRunner);
  testRuntime = makeFixtureRuntime({
    registryRoot: testRegistryRoot,
    defaultTaskRoot: root,
    defaultRunnerPath: fakeRunner,
    defaultRunnerKey: "self-test",
    defaultRunnerEntry: fixtureCatalog["self-test"],
    runnerCatalog: fixtureCatalog,
    allowCustomRunner: true,
  }, { trackSpawnedPids: true });
  const formalReport = path.join(root, "business-report.md");
  const formalHandoff = path.join(root, "business-handoff.md");
  const packagePath = path.join(root, "fake.task-package.json");
  const taskFile = path.join(root, "fake.task-package.task.md");
  writeFileSync(
    packagePath,
    JSON.stringify(
      {
        task_package: {
          package_id: "fake-package",
          runtime_context: { output_root: root },
          expected_output: {
            mode: "file",
            file_path: formalReport,
            resolved_file_path: formalReport,
          },
          handoff_contract: {
            require_final_handoff: true,
            handoff_file_required: true,
            handoff_file: formalHandoff,
            resolved_handoff_file: formalHandoff,
            accept_verdicts: ["done", "needs_owner"],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  // 无 task package 挂靠的独立 task 文件：inferTaskPackagePath 找不到同名 .json，
  // taskPackageOutputs 走 missing 分支，用于验证真失败（无 durable 产物）场景不受其它用例的 durable report 干扰。
  const bareTaskFile = path.join(root, "bare-no-package.task.md");
  writeFileSync(bareTaskFile, "self-test bare fake child task without task package", "utf8");
  writeFileSync(taskFile, "self-test fake child task", "utf8");
  const deadTaskId = selfTestTaskId("dead-worker-self-test");
  const deadTaskDir = taskDir(root, deadTaskId);
  additionalNoticeOwners.push({ task_root: root, task_id: deadTaskId });
  const deadFiles = taskFiles(deadTaskDir);
  const deadTask = {
    task_id: deadTaskId,
    created_at: isoNow(),
    task_root: root,
    task_dir: deadTaskDir,
    runner_path: fakeRunner,
    runtime_role: "",
    model: "fake-model",
    effort: "low",
    context_mode: "isolated",
    target_cwd: ctx.config.cwd,
    task_source_path: bareTaskFile,
    task_package_path: null,
  };
  ensureDir(deadTaskDir);
  writeJson(deadFiles.task, deadTask);
  writeInitialStatus(deadFiles, deadTask);
  updateStatus(deadFiles, { state: "running", pid: 2147483647, started_at: isoNow() });
  const deadWorkerStatus = reconcileTask({ task_root: root, task_id: deadTaskId });
  writeFileSync(formalReport, "# business report\n\nformal report wins.\n", "utf8");
  writeFileSync(
    formalHandoff,
    [
      "FINAL_HANDOFF:",
      "  package_id: fake-package",
      "  verdict: done",
      "  summary: formal handoff wins.",
      "  output:",
      "    target_repo: null",
      `    file_path: ${formalReport}`,
      `    resolved_file_path: ${formalReport}`,
      `    handoff_file: ${formalHandoff}`,
      `    resolved_handoff_file: ${formalHandoff}`,
      "  scope_actual:",
      "    read: []",
      "    written:",
      `      - ${formalReport}`,
      `      - ${formalHandoff}`,
      "    deleted: []",
      "  validation:",
      "    required_files_loaded: true",
      "    expected_output_satisfied: true",
      "    scope_compliant: true",
      "    mechanical_check: pass",
      "  evidence_refs:",
      `    - ${formalReport}`,
      "",
    ].join("\n"),
    "utf8",
  );
  const createFormalTaskVariant = (label) => {
    const variantReport = path.join(root, `${label}-business-report.md`);
    const variantHandoff = path.join(root, `${label}-business-handoff.md`);
    const variantPackage = path.join(root, `${label}.json`);
    const variantTaskFile = path.join(root, `${label}.task.md`);
    const packageData = readJson(packagePath, {});
    packageData.task_package.expected_output.file_path = variantReport;
    packageData.task_package.expected_output.resolved_file_path = variantReport;
    packageData.task_package.handoff_contract.handoff_file = variantHandoff;
    packageData.task_package.handoff_contract.resolved_handoff_file = variantHandoff;
    writeFileSync(variantReport, readFileSync(formalReport, "utf8"), "utf8");
    writeFileSync(
      variantHandoff,
      readFileSync(formalHandoff, "utf8")
        .replaceAll(formalReport, variantReport)
        .replaceAll(formalHandoff, variantHandoff),
      "utf8",
    );
    writeJson(variantPackage, packageData);
    writeFileSync(variantTaskFile, `self-test ${label} fake child task`, "utf8");
    return variantTaskFile;
  };
  const promptContractTaskFile = createFormalTaskVariant("prompt-contract");
  const deleteOnlyPath = path.join(root, "prompt-contract-delete-only.txt");
  const promptContractPackageFixture = readJson(path.join(root, "prompt-contract.json"), {});
  promptContractPackageFixture.task_package.scope = { write: [], write_extra: [], delete: [deleteOnlyPath] };
  writeJson(path.join(root, "prompt-contract.json"), promptContractPackageFixture);
  const missingOutputsTaskFile = createFormalTaskVariant("missing-outputs");
  const taskPartialTaskFile = createFormalTaskVariant("task-partial");
  const invalidHandoffReport = path.join(root, "invalid-handoff-report.md");
  const invalidHandoff = path.join(root, "invalid-handoff.md");
  const invalidHandoffPackage = path.join(root, "invalid-handoff.json");
  const invalidHandoffTaskFile = path.join(root, "invalid-handoff.task.md");
  writeFileSync(invalidHandoffReport, "# invalid handoff fixture\n", "utf8");
  writeFileSync(
    invalidHandoff,
    "FINAL_HANDOFF:\n  package_id: invalid-handoff-package\n  verdict: done\n  validation:\n    mechanical_check: pass\n",
    "utf8",
  );
  writeFileSync(
    invalidHandoffPackage,
    JSON.stringify(
      {
        task_package: {
          package_id: "invalid-handoff-package",
          runtime_context: { output_root: root },
          expected_output: {
            mode: "file",
            file_path: invalidHandoffReport,
            resolved_file_path: invalidHandoffReport,
          },
          handoff_contract: {
            require_final_handoff: true,
            handoff_file_required: true,
            handoff_file: invalidHandoff,
            resolved_handoff_file: invalidHandoff,
            accept_verdicts: ["done", "needs_owner"],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(invalidHandoffTaskFile, "self-test invalid mandatory handoff", "utf8");
  const submit = submitSelfTest({
    task_file: taskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-model",
    effort: "low",
  });
  const promptContractSubmit = submitSelfTest({
    task_file: promptContractTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    producer_root: ctx.config.cwd,
    target_cwd: ctx.config.cwd,
    model: "fake-model",
    effort: "low",
  });
  const promptContractSourcePackagePath = path.join(root, "prompt-contract.json");
  const promptContractPackagePath = path.join(promptContractSubmit.task_dir, "task-package.json");
  const promptContractHandoffPath = path.join(root, "prompt-contract-business-handoff.md");
  const invalidHandoffSubmit = submitSelfTest({
    task_file: invalidHandoffTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-model",
    effort: "low",
    budget: { max_elapsed_minutes: 7 },
  });
  const missingOutputsSubmit = submitSelfTest({
    task_file: missingOutputsTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-no-outputs",
    effort: "low",
  });
  const taskPartialSubmit = submitSelfTest({
    task_file: taskPartialTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-task-partial",
    effort: "low",
  });
  const progressOnlySubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-progress-only",
    effort: "low",
  });
  const readonlyFinalOnlySubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-readonly-final-only",
    effort: "low",
  });
  // A1 词表归一：child final 走同义词 done → business_state=completed、business_state_raw=done。
  const doneSynonymSubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-done-synonym",
    effort: "low",
  });
  // A1 review 联动：业务失败但运输契约 ok → business_state=failed、requires_parent_review=true。
  const businessFailedSubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-business-failed",
    effort: "low",
  });
  const writeDomainViolationSubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-write-domain-violation",
    effort: "low",
  });
  // A3 salvage：invalid_final 无业务报告 → salvage_evidence_paths 指向 task_dir 内实际存在的诊断原件。
  const invalidFinalSubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-invalid-final",
    effort: "low",
  });
  // 兼容旧成本提示：120 次工具调用仍须自然完成，且 wrapper 不再下达 --maxToolCalls。
  const highToolCountSubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-high-tool-count",
    effort: "low",
    budget: { max_tool_calls: 5, max_elapsed_minutes: 15 },
  });
  // 兼容旧 elapsed 提示：提示值不再启动 kill timer。
  const elapsedHintSubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-elapsed-hint",
    effort: "low",
    budget: { max_tool_calls: 80, max_elapsed_minutes: 0.01 },
  });
  // provider_error 的 wrapper 级兜底重试（工具病 20260831-async-wrapper-no-retry）：
  // once 型第一 attempt 断线、第二 attempt 成功；always 型两 attempt 均断线锁「只重试一次」上限
  const providerRetrySubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-provider-error-once",
    effort: "low",
  });
  const providerAlwaysSubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-provider-error-always",
    effort: "low",
  });
  const simSubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-model",
    effort: "low",
    result_mode: "simulated_planning",
    simulation_profile: {
      role: "target-explorer",
      persona: { instructions: "模拟目标仓子代理画像：只读审计。", boundaries: ["不写目标仓"] },
    },
  });
  const simTaskJson = JSON.parse(readFileSync(path.join(simSubmit.task_dir, "task.json"), "utf8"));
  if (
    !simTaskJson.simulation_profile
    || simTaskJson.simulation_profile.simulation !== true
    || simTaskJson.simulation_profile.role !== "target-explorer"
    || simTaskJson.simulation_profile.persona.instructions !== "模拟目标仓子代理画像：只读审计。"
  ) {
    throw new Error("simulation_profile not propagated to task.json");
  }
  const slowSubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-slow-running",
    effort: "low",
  });
  let slowRunningStatus = null;
  for (let i = 0; i < 80; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    slowRunningStatus = statusTask({ task_root: root, task_id: slowSubmit.task_id });
    if (
      slowRunningStatus?.attempts?.[0]?.state === "running" &&
      slowRunningStatus?.live_phase === "turn_wait" &&
      slowRunningStatus?.last_tool_call?.name === "self-test-sleep"
    ) {
      break;
    }
  }
  const slowTerminalOnlyTimeout = await waitTask({
    task_root: root,
    task_id: slowSubmit.task_id,
    after_rev: slowRunningStatus?.revision ?? "",
    wait_ms: 200,
    terminal_only: true,
  });
  const slowWait = await waitTask({
    task_root: root,
    task_id: slowSubmit.task_id,
    after_rev: slowTerminalOnlyTimeout?.revision ?? slowRunningStatus?.revision ?? "",
    wait_ms: 5000,
  });
  // 静默检测：阈值 400ms，假 runner 静默 1500ms 后再发事件；期望先看到 stall 与 stall notice，
  // wait 以 stall 事件返回；带 after_rev 再等则跳过已读 stall，直到终态；终态后 stall 清空、notice 删除。
  const stalledSubmit = submitSelfTest({
    task_file: bareTaskFile,
    task_root: root,
    runner_path: fakeRunner,
    target_cwd: ctx.config.cwd,
    model: "fake-stalled",
    effort: "low",
    stall_silence_ms: 400,
  });
  let stalledStatus = null;
  const stallDeadline = Date.now() + 60000;
  while (Date.now() < stallDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    stalledStatus = statusTask({ task_root: root, task_id: stalledSubmit.task_id });
    if (stalledStatus?.stall?.suspected_at) {
      break;
    }
  }
  const stallNoticeFile = path.join(path.dirname(root), "async_inbox", `${stalledSubmit.task_id}.stall.json`);
  const stallNoticeSeen = existsSync(stallNoticeFile);
  const stallWait = await waitTask({
    task_root: root,
    task_id: stalledSubmit.task_id,
    wait_ms: 1500,
  });
  let stallClearedStatus = null;
  const stallClearDeadline = Date.now() + 60000;
  while (Date.now() < stallClearDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    stallClearedStatus = statusTask({ task_root: root, task_id: stalledSubmit.task_id });
    if (stallClearedStatus?.stall === null || isTerminalState(stallClearedStatus?.state)) {
      break;
    }
  }
  const stallNoticeClearedWithStatus = !existsSync(stallNoticeFile);
  const stallWaitAfterSeen = await waitTask({
    task_root: root,
    task_id: stalledSubmit.task_id,
    after_rev: stallWait?.revision ?? "",
    wait_ms: 60000,
  });
  const stalledFinalStatus = statusTask({ task_root: root, task_id: stalledSubmit.task_id });
  let status = null;
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = statusTask({ task_root: root, task_id: submit.task_id });
    if (isTerminalState(status.state)) {
      break;
    }
  }
  let missingOutputsStatus = null;
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    missingOutputsStatus = statusTask({ task_root: root, task_id: missingOutputsSubmit.task_id });
    if (isTerminalState(missingOutputsStatus.state)) {
      break;
    }
  }
  let taskPartialStatus = null;
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    taskPartialStatus = statusTask({ task_root: root, task_id: taskPartialSubmit.task_id });
    if (isTerminalState(taskPartialStatus.state)) {
      break;
    }
  }
  let progressOnlyStatus = null;
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    progressOnlyStatus = statusTask({ task_root: root, task_id: progressOnlySubmit.task_id });
    if (isTerminalState(progressOnlyStatus.state)) {
      break;
    }
  }
  let readonlyFinalOnlyStatus = null;
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    readonlyFinalOnlyStatus = statusTask({ task_root: root, task_id: readonlyFinalOnlySubmit.task_id });
    if (isTerminalState(readonlyFinalOnlyStatus.state)) {
      break;
    }
  }
  const waitTerminal = async (taskId, maxIters = 100) => {
    let last = null;
    for (let i = 0; i < maxIters; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      last = statusTask({ task_root: root, task_id: taskId });
      if (isTerminalState(last.state)) {
        break;
      }
    }
    return last;
  };
  // provider_error 重试链含 2s 兜底延迟，放宽终态等待窗口
  const providerRetryStatus = await waitTerminal(providerRetrySubmit.task_id, 240);
  const providerAlwaysStatus = await waitTerminal(providerAlwaysSubmit.task_id, 240);
  const doneSynonymStatus = await waitTerminal(doneSynonymSubmit.task_id);
  const invalidHandoffStatus = await waitTerminal(invalidHandoffSubmit.task_id);
  const businessFailedStatus = await waitTerminal(businessFailedSubmit.task_id);
  const writeDomainViolationStatus = await waitTerminal(writeDomainViolationSubmit.task_id);
  const invalidFinalStatus = await waitTerminal(invalidFinalSubmit.task_id);
  const highToolCountStatus = await waitTerminal(highToolCountSubmit.task_id);
  const elapsedHintStatus = await waitTerminal(elapsedHintSubmit.task_id, 200);
  const simStatus = await waitTerminal(simSubmit.task_id);
  let slowFinalStatus = slowWait;
  for (let i = 0; i < 100 && !isTerminalState(slowFinalStatus?.state); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    slowFinalStatus = statusTask({ task_root: root, task_id: slowSubmit.task_id });
  }
  const waitCeilingProbe = await waitTask({
    task_root: root,
    task_id: submit.task_id,
    wait_ms: MAX_WAIT_MS + 1,
  });
  const collect = collectTask({ task_root: root, task_id: submit.task_id, include_report: true });
  const checkedCollect = collectTask({ task_root: root, task_id: submit.task_id, include_report: true, check_handoff: true });
  const missingOutputsCollect = collectTask({ task_root: root, task_id: missingOutputsSubmit.task_id, include_report: true });
  const taskPartialCollect = collectTask({ task_root: root, task_id: taskPartialSubmit.task_id, include_report: true });
  const writeDomainViolationCollect = collectTask({ task_root: root, task_id: writeDomainViolationSubmit.task_id, include_report: true });
  const writeDomainViolationResult = buildResultReceipt(root, writeDomainViolationSubmit.task_id);
  const readonlyFinalOnlyCollect = collectTask({ task_root: root, task_id: readonlyFinalOnlySubmit.task_id, include_report: true });
  const slowCollect = collectTask({ task_root: root, task_id: slowSubmit.task_id, include_report: true });
  const invalidFinalCollect = collectTask({ task_root: root, task_id: invalidFinalSubmit.task_id, include_report: true });
  const highToolCountCollect = collectTask({ task_root: root, task_id: highToolCountSubmit.task_id, include_report: true });
  const elapsedHintCollect = collectTask({ task_root: root, task_id: elapsedHintSubmit.task_id, include_report: true });
  const highToolCountChildResult = readJson(path.join(highToolCountSubmit.task_dir, "child-task-result.json"), {});
  const taskSummary = taskStatusSummary({ task_root: root, limit: 200 });
  // 复核销账三态（status 快照已在上方定格，此处的写入不影响既有断言）：
  // revision 错配拒绝 → 终态销账成功 → 幂等 already_acked；裁决结论保持原判。
  const ackConflict = ackReviewTask({ task_root: root, task_id: businessFailedSubmit.task_id, expected_revision: "999999" });
  const ackFirst = ackReviewTask({ task_root: root, task_id: businessFailedSubmit.task_id });
  const ackAgain = ackReviewTask({ task_root: root, task_id: businessFailedSubmit.task_id });
  const ackedStatus = statusTask({ task_root: root, task_id: businessFailedSubmit.task_id });
  // 标志本就 false 的干净任务：首次 ack 补落确认痕迹（fleet node 出队联动依赖它），再 ack 才幂等。
  const ackCleanFirst = ackReviewTask({ task_root: root, task_id: submit.task_id });
  const ackCleanAgain = ackReviewTask({ task_root: root, task_id: submit.task_id });
  const ackCleanStatus = statusTask({ task_root: root, task_id: submit.task_id });
  // 确认痕迹必须穿透 summary 的两级字段挑选（listTasks → taskStatusSummary）——
  // 面板 fleet node 出队联动只看 summary 投影，漏字段则销账在 UI 上永不生效。
  const ackedSummary = taskStatusSummary({ task_root: root, limit: 200 });
  const invalidFinalSalvagePaths = Array.isArray(invalidFinalStatus?.salvage_evidence_paths)
    ? invalidFinalStatus.salvage_evidence_paths
    : [];
  const salvageEvidenceOk =
    invalidFinalSalvagePaths.length > 0 &&
    invalidFinalSalvagePaths.every((candidate) => candidate && existsSync(candidate)) &&
    invalidFinalSalvagePaths.some((candidate) => candidate.endsWith("child-final.md")) &&
    invalidFinalStatus?.salvage_report_path === null;
  // A2：标准成功任务 task_dir 文件清单收敛——退役 dump / 共享 child-runner 日志 / 空 worker 日志一律不落。
  const doneTaskFiles = new Set(readdirSync(doneSynonymSubmit.task_dir));
  const forbiddenTaskFiles = [
    "child-task.stdout.json",
    "child-task.stderr.json",
    "child-task.notifications.json",
    "child-task.requests.json",
    "child-task.summary.json",
    "worker.stdout.log",
    "worker.stderr.log",
    "child-runner.stdout.log",
    "child-runner.stderr.log",
    "child-runner.attempt-1.stderr.log",
    "partial-observation.md",
  ];
  const requiredTaskFiles = [
    "task.json",
    "task.md",
    "status.json",
    "result.json",
    "report.md",
    "handoff.md",
    "child-final.md",
    "child-task-result.json",
  ];
  const standardTaskFileSetConverged =
    forbiddenTaskFiles.every((name) => !doneTaskFiles.has(name)) &&
    requiredTaskFiles.every((name) => doneTaskFiles.has(name));
  const expectedFixtureTasks = fixtureNoticeOwners();
  const expectedFixtureNoticePaths = fixtureNoticePaths();
  const expectedFixtureTerminalPaths = expectedFixtureTasks.flatMap((fixture) => {
    const files = taskFiles(fixture.task_dir || taskDir(fixture.task_root, fixture.task_id));
    return [files.status, files.result];
  });
  const fixtureTerminalFilesPresent = () => (
    expectedFixtureTerminalPaths.every((file) => existsSync(file)) &&
    expectedFixtureTasks.every((fixture) => {
      try {
        const dir = fixture.task_dir || taskDir(fixture.task_root, fixture.task_id);
        return isTerminalState(readJson(taskFiles(dir).status, {}).state);
      } catch {
        return false;
      }
    })
  );
  const fixtureCompletionNoticesPresent = () => (
    expectedFixtureNoticePaths.every((noticePath) => existsSync(noticePath))
  );
  const waitForFixtureSettlement = async () => {
    let terminalFilesPresent = false;
    let completionNoticesPresent = false;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      terminalFilesPresent = fixtureTerminalFilesPresent();
      completionNoticesPresent = fixtureCompletionNoticesPresent();
      if (terminalFilesPresent && completionNoticesPresent) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    terminalFilesPresent = fixtureTerminalFilesPresent();
    completionNoticesPresent = fixtureCompletionNoticesPresent();
    let workerProcessesExited = false;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      workerProcessesExited = fixtureSubmissions.every((fixture) => (
        Number.isInteger(Number(fixture.pid)) && !processAlive(fixture.pid)
      ));
      if (workerProcessesExited) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    workerProcessesExited = fixtureSubmissions.every((fixture) => (
      Number.isInteger(Number(fixture.pid)) && !processAlive(fixture.pid)
    ));
    return {
      terminal_files_present: terminalFilesPresent,
      completion_notices_present: completionNoticesPresent,
      worker_processes_exited: workerProcessesExited,
    };
  };
  const fixtureSettlement = await waitForFixtureSettlement();
  workerShutdownState = await shutdownTrackedWorkers();
  if (!workerShutdownState.all_tracked_workers_exited) {
    throw workerShutdownError(workerShutdownState);
  }
  const checks = {
    post_submit_status_failure_preserves_task_id:
      statusFailureReceipt.task_id?.startsWith("post-submit-status-failure-") &&
      statusFailureReceipt.state === "queued" &&
      statusFailureReceipt.post_submit_failures?.some((failure) => failure.step === "status_task"),
    post_submit_budget_failure_preserves_task_id:
      budgetFailureReceipt.task_id?.startsWith("post-submit-budget-failure-") &&
      budgetFailureReceipt.state === "queued" &&
      budgetFailureReceipt.post_submit_failures?.some((failure) => failure.step === "assert_token_budget"),
    cross_repo_task_root_owned_by_producer:
      crossRepoPrepared.input.target_cwd === path.resolve(crossRepoTarget) &&
      crossRepoPrepared.input.task_root === path.resolve(crossRepoTaskRoot) &&
      !isInside(path.join(crossRepoTarget, ".runtime"), crossRepoPrepared.input.task_root),
    prepared_batch_metadata_is_preserved:
      crossRepoPrepared.input.origin_thread_id === "thread-self-test" &&
      crossRepoPrepared.input.batch_id === "batch-self-test" &&
      crossRepoPrepared.input.slice_id === "cross-repo" &&
      crossRepoPrepared.input.display_title === "跨仓只读自检",
    worker_start_failure_is_atomic: workerStartFailureIsAtomic,
    registry_miss_and_corruption_are_distinguished: registryMissAndCorruptionAreDistinguished,
    worker_termination_failure_preserves_task: workerTerminationFailurePreservesTask,
    prepared_prompt_copy_preserves_task_package_bytes:
      existsSync(promptContractPackagePath) &&
      readFileSync(promptContractPackagePath).equals(readFileSync(promptContractSourcePackagePath)),
    runner_receives_handoff_check_spec: (() => {
      // worker 把终态复验同一条 checker 命令以 --handoffCheck 下发给 child runner（submit_task_result 当场复验用）。
      const argvPath = path.join(promptContractSubmit.task_dir, "fake-runner-argv.json");
      if (!existsSync(argvPath)) return false;
      const argv = JSON.parse(readFileSync(argvPath, "utf8"));
      const index = argv.indexOf("--handoffCheck");
      if (index < 0) return false;
      const spec = JSON.parse(argv[index + 1]);
      return Array.isArray(spec.argv)
        && spec.argv.some((item) => /subagent_handoff_check(\.bundle)?\.mjs$/.test(String(item)))
        && spec.argv[spec.argv.indexOf("--task-package") + 1] === promptContractPackagePath
        && spec.argv[spec.argv.indexOf("--handoff-file") + 1] === promptContractHandoffPath
        && spec.argv[spec.argv.indexOf("--format") + 1] === "json"
        && typeof spec.env?.SUBAGENT_CONTROL_REPO_ROOT === "string"
        && spec.env.SUBAGENT_PROJECT_ROOT === spec.env.SUBAGENT_CONTROL_REPO_ROOT;
    })(),
    runner_receives_elapsed_limit: (() => {
      // 未给 budget 用默认 90 分钟；给了 max_elapsed_minutes 按分钟换算，都经 --timeoutMs 交 runner 执行。
      const timeoutArg = (taskDir) => {
        const argvPath = path.join(taskDir, "fake-runner-argv.json");
        if (!existsSync(argvPath)) return null;
        const argv = JSON.parse(readFileSync(argvPath, "utf8"));
        const index = argv.indexOf("--timeoutMs");
        return index < 0 ? null : argv[index + 1];
      };
      return timeoutArg(promptContractSubmit.task_dir) === String(90 * 60000)
        && timeoutArg(invalidHandoffSubmit.task_dir) === String(7 * 60000);
    })(),
    runner_receives_task_local_write_domain_spec: (() => {
      const argvPath = path.join(promptContractSubmit.task_dir, "fake-runner-argv.json");
      if (!existsSync(argvPath)) return false;
      const argv = JSON.parse(readFileSync(argvPath, "utf8"));
      const index = argv.indexOf("--writeDomainSpec");
      if (index < 0 || argv[index + 1] !== path.join(promptContractSubmit.task_dir, "write-domain.json")) return false;
      const spec = JSON.parse(readFileSync(argv[index + 1], "utf8"));
      return spec.contract_version === "pi-child-write-domain/v1"
        && spec.task_id === promptContractSubmit.task_id
        && Array.isArray(spec.paths)
        && spec.paths.some((item) => path.resolve(item).toLowerCase() === path.resolve(promptContractHandoffPath).toLowerCase())
        && spec.delete_paths?.some((item) => path.resolve(item).toLowerCase() === path.resolve(deleteOnlyPath).toLowerCase());
    })(),
    write_domain_excludes_delete_only_paths: (() => {
      const taskRecord = readJson(path.join(promptContractSubmit.task_dir, "task.json"), {});
      const key = (item) => path.resolve(item).toLowerCase();
      return taskRecord.write_claim_paths?.some((item) => key(item) === key(deleteOnlyPath))
        && !taskRecord.write_domain_paths?.some((item) => key(item) === key(deleteOnlyPath))
        && taskRecord.write_domain_delete_paths?.some((item) => key(item) === key(deleteOnlyPath));
    })(),
    stall_notice_lifecycle:
      stalledStatus?.state === "running" &&
      stalledStatus?.stall?.last_tool === "self-test-hang" &&
      stalledStatus?.stall?.threshold_seconds === 0 &&
      stalledStatus?.stall?.attempt === 1 &&
      stallNoticeSeen &&
      stallWait?.stall_notice_observed === true &&
      stallWait?.completion_notice_observed === false &&
      stallWait?.timed_out === false &&
      stallWait?.state === "running" &&
      stallClearedStatus?.state === "running" &&
      stallClearedStatus?.stall === null &&
      stallNoticeClearedWithStatus &&
      stallWaitAfterSeen?.stall_notice_observed === false &&
      stallWaitAfterSeen?.completion_notice_observed === true &&
      stalledFinalStatus?.state === "done" &&
      stalledFinalStatus?.stall === null &&
      !existsSync(stallNoticeFile),
    durable_artifact_pointer:
      missingOutputsStatus?.state === "done" &&
      missingOutputsStatus?.contract_state === "ok" &&
      missingOutputsStatus?.artifact_state === "durable_artifact_pointer" &&
      missingOutputsStatus?.attempts?.[0]?.synthetic_artifacts?.includes("report") &&
      missingOutputsStatus?.attempts?.[0]?.synthetic_artifacts?.includes("handoff") &&
      existsSync(missingOutputsSubmit.report_path) &&
      existsSync(missingOutputsSubmit.handoff_path) &&
      readFileSync(missingOutputsSubmit.report_path, "utf8").includes(String(missingOutputsCollect.business_report_path)) &&
      missingOutputsCollect.artifact_manifest?.artifact_contract_ok === true &&
      missingOutputsCollect.artifact_manifest?.artifact_state === "durable_artifact_pointer",
    partial_is_reviewable:
      taskPartialStatus?.state === "done" &&
      taskPartialStatus?.business_state === "partial" &&
      taskPartialStatus?.requires_parent_review === true &&
      readFileSync(taskPartialSubmit.report_path, "utf8").includes("fake partial report"),
    progress_only_is_contract_failure:
      progressOnlyStatus?.state === "failed" &&
      progressOnlyStatus?.contract_state === "missing_required_output" &&
      Boolean(progressOnlyStatus?.last_progress_line) &&
      progressOnlyStatus?.last_progress_line.includes("still scanning core files"),
    child_final_synthesis:
      readonlyFinalOnlyStatus?.state === "done" &&
      readonlyFinalOnlyStatus?.contract_state === "ok" &&
      readonlyFinalOnlyStatus?.artifact_state === "child_final_synthesized" &&
      readonlyFinalOnlyStatus?.requires_parent_review === true &&
      readonlyFinalOnlyStatus?.attempts?.[0]?.synthetic_artifacts?.includes("report") &&
      readonlyFinalOnlyStatus?.attempts?.[0]?.synthetic_artifacts?.includes("handoff") &&
      readonlyFinalOnlyCollect.artifact_manifest?.artifact_state === "child_final_synthesized" &&
      readonlyFinalOnlyCollect.report?.includes("readonly final only evidence") &&
      readonlyFinalOnlyCollect.handoff_summary?.verdict === "done",
    collect_prefers_durable_outputs:
      collect.handoff_source === "task_package" &&
      collect.report_source === "task_package" &&
      collect.handoff_summary?.package_id === "fake-package" &&
      collect.handoff.includes("formal handoff wins") &&
      collect.report?.includes("formal report wins") &&
      collect.parent_consumption?.transport_state === "done" &&
      collect.parent_consumption?.business_result === "completed" &&
      collect.parent_consumption?.artifact_result === "durable_present" &&
      collect.parent_consumption?.handoff_mechanical_state === "pass" &&
      collect.parent_consumption?.requires_parent_review === false,
    parent_handoff_check:
      status?.handoff_check_status === "pass" &&
      checkedCollect.handoff_check?.status === "pass" &&
      checkedCollect.parent_consumption?.mechanical_check_verified_by_parent === true &&
      checkedCollect.collect_warnings?.length === 0,
    invalid_mandatory_handoff_requires_parent_review:
      invalidHandoffStatus?.state === "done" &&
      invalidHandoffStatus?.contract_state === "invalid_handoff" &&
      invalidHandoffStatus?.failure_type === "handoff_check_failed" &&
      invalidHandoffStatus?.handoff_check_status === "fail" &&
      invalidHandoffStatus?.requires_parent_review === true,
    telemetry_is_non_controlling:
      typeof slowRunningStatus?.tool_call_count === "number" &&
      slowRunningStatus?.tool_call_count >= 1 &&
      typeof slowRunningStatus?.live_age_seconds === "number" &&
      slowRunningStatus?.progress_state === "running",
    business_state_normalization:
      doneSynonymStatus?.state === "done" &&
      doneSynonymStatus?.business_state === "completed" &&
      doneSynonymStatus?.business_state_raw === "done" &&
      businessFailedStatus?.state === "done" &&
      businessFailedStatus?.business_state === "failed" &&
      businessFailedStatus?.business_state_raw === "error" &&
      businessFailedStatus?.requires_parent_review === true,
    write_domain_violation_requires_parent_review:
      writeDomainViolationStatus?.state === "done" &&
      writeDomainViolationStatus?.business_state === "completed" &&
      writeDomainViolationStatus?.requires_parent_review === true &&
      writeDomainViolationStatus?.write_domain_scope_compliant === false &&
      writeDomainViolationStatus?.write_domain_enabled === true &&
      writeDomainViolationStatus?.write_domain_audit_complete === true &&
      writeDomainViolationStatus?.write_domain_violation_count === 2 &&
      writeDomainViolationStatus?.write_domain_reported_violation_count === 1 &&
      writeDomainViolationStatus?.write_domain_covered_tools?.includes("edit") &&
      writeDomainViolationCollect?.write_domain?.violation_count === 2 &&
      writeDomainViolationCollect?.write_domain?.command_write_enforced === false &&
      writeDomainViolationResult?.mechanical_summary?.write_domain_scope_compliant === false &&
      writeDomainViolationResult?.mechanical_summary?.write_domain_audit_complete === true &&
      writeDomainViolationResult?.mechanical_summary?.write_domain_violation_count === 2 &&
      writeDomainViolationResult?.mechanical_summary?.write_domain_command_write_enforced === false &&
      writeDomainViolationCollect?.parent_consumption?.write_domain?.scope_compliant === false &&
      writeDomainViolationCollect?.collect_warnings?.includes("write_domain_violation_or_incomplete_audit"),
    review_ack_clears_flag_and_keeps_verdict:
      ackConflict?.ok === false &&
      ackConflict?.reason === "revision_conflict" &&
      ackFirst?.ok === true &&
      ackFirst?.acked === true &&
      ackAgain?.ok === true &&
      ackAgain?.acked === false &&
      ackAgain?.reason === "already_acked" &&
      ackedStatus?.requires_parent_review === false &&
      typeof ackedStatus?.review_acked_at === "string" &&
      ackedStatus?.business_state === "failed",
    review_ack_records_trace_on_clean_task:
      ackCleanFirst?.ok === true &&
      ackCleanFirst?.acked === true &&
      ackCleanAgain?.ok === true &&
      ackCleanAgain?.acked === false &&
      ackCleanAgain?.reason === "already_acked" &&
      typeof ackCleanStatus?.review_acked_at === "string" &&
      ackCleanStatus?.requires_parent_review === false,
    review_ack_visible_in_summary:
      ackedSummary.tasks.some((item) =>
        item.task_id === businessFailedSubmit.task_id &&
        item.requires_parent_review === false &&
        typeof item.review_acked_at === "string"),
    invalid_final_salvage:
      invalidFinalStatus?.state === "failed" &&
      invalidFinalStatus?.contract_state === "invalid_final" &&
      invalidFinalStatus?.failure_type === "child_turn_failed" &&
      invalidFinalStatus?.turn_status === "failed" &&
      invalidFinalStatus?.salvage_report_path === null &&
      salvageEvidenceOk &&
      invalidFinalStatus?.requires_parent_review === true &&
      invalidFinalCollect.artifact_manifest?.salvage_report === null &&
      Array.isArray(invalidFinalCollect.artifact_manifest?.salvage_evidence_paths) &&
      invalidFinalCollect.artifact_manifest.salvage_evidence_paths.length > 0 &&
      invalidFinalCollect.parent_consumption?.salvage_evidence_paths?.length > 0 &&
      invalidFinalCollect.parent_consumption?.turn_status === "failed",
    standard_task_file_set: standardTaskFileSetConverged,
    high_tool_count_does_not_cancel:
      highToolCountStatus?.state === "done" &&
      highToolCountStatus?.cancel_reason === null &&
      highToolCountStatus?.tool_call_count === 120 &&
      highToolCountCollect.parent_consumption?.transport_state === "done" &&
      highToolCountChildResult?.received_max_tool_calls === false,
    elapsed_hint_does_not_cancel:
      elapsedHintStatus?.state === "done" &&
      elapsedHintStatus?.cancel_reason === null &&
      elapsedHintCollect.parent_consumption?.transport_state === "done",
    simulation_fixture_reaches_terminal: isTerminalState(simStatus?.state),
    simulation_artifacts_attested: (() => {
      const file = path.join(simSubmit.task_dir, "real-run-attestation.json");
      if (!existsSync(file)) return false;
      const proof = JSON.parse(readFileSync(file, "utf8"));
      return proof.verified === true && proof.result_mode === "simulated_planning";
    })(),
    provider_error_does_not_auto_retry:
      providerRetryStatus?.state === "failed" &&
      providerRetryStatus?.failure_type === "provider_error" &&
      providerRetryStatus?.attempts?.length === 1,
    dead_worker_is_terminal_and_reviewable:
      deadWorkerStatus?.state === "failed" &&
      deadWorkerStatus?.failure_type === "worker_process_exit" &&
      deadWorkerStatus?.requires_parent_review === true &&
      deadWorkerStatus?.artifact_state === "worker_exit_before_final",
    // 汇总必须覆盖全部夹具任务：下界由夹具清单派生，不写死数字。
    summary_has_all_tasks: taskSummary.task_count >= expectedFixtureTasks.length,
    summary_has_no_budget_cancellation: !taskSummary.buckets?.by_state?.cancelled,
  };
  cleanupState = cleanupSelfTestArtifacts();
  checks.fixture_terminal_files_present = fixtureSettlement.terminal_files_present;
  checks.fixture_worker_processes_exited = fixtureSettlement.worker_processes_exited
    && workerShutdownState.natural_exit
    && !workerShutdownState.forced_termination_used;
  checks.fixture_completion_notices_present = fixtureSettlement.completion_notices_present;
  checks.fixture_task_root_cleanup = cleanupState.task_root_removed;
  checks.fixture_completion_notice_cleanup = cleanupState.matching_completion_notices_removed;
  checks.fixture_cleanup_succeeded = cleanupState.cleanup_succeeded;
  const output = {
    ok: Object.values(checks).every(Boolean),
    checks,
    task_root: root,
    post_submit_failure_cases: {
      status_task: statusFailureReceipt,
      assert_token_budget: budgetFailureReceipt,
    },
    submit,
    status,
    collect: {
      task_id: collect.task_id,
      state: collect.state,
      handoff_path: collect.handoff_path,
      report_path: collect.report_path,
      handoff_source: collect.handoff_source,
      report_source: collect.report_source,
      handoff_summary: collect.handoff_summary,
      parent_consumption: collect.parent_consumption,
      handoff_present: Boolean(collect.handoff),
      checked_handoff: checkedCollect.handoff_check,
    },
    artifact_path_mismatch_case: {
      submit: missingOutputsSubmit,
      status: missingOutputsStatus,
      collect: {
        task_id: missingOutputsCollect.task_id,
        state: missingOutputsCollect.state,
        contract_state: missingOutputsCollect.contract_state,
        business_report_path: missingOutputsCollect.business_report_path,
        artifact_manifest: missingOutputsCollect.artifact_manifest,
      },
    },
    task_partial_case: {
      submit: taskPartialSubmit,
      status: taskPartialStatus,
      collect: {
        task_id: taskPartialCollect.task_id,
        state: taskPartialCollect.state,
        business_state: taskPartialCollect.business_state,
        requires_parent_review: taskPartialCollect.requires_parent_review,
      },
    },
    progress_only_case: {
      submit: progressOnlySubmit,
      status: progressOnlyStatus,
    },
    readonly_final_only_case: {
      submit: readonlyFinalOnlySubmit,
      status: readonlyFinalOnlyStatus,
      collect: {
        task_id: readonlyFinalOnlyCollect.task_id,
        state: readonlyFinalOnlyCollect.state,
        artifact_manifest: readonlyFinalOnlyCollect.artifact_manifest,
        handoff_summary: readonlyFinalOnlyCollect.handoff_summary,
      },
    },
    running_visibility_case: {
      submit: slowSubmit,
      running_status: slowRunningStatus,
      wait: slowWait,
      terminal_only_timeout: slowTerminalOnlyTimeout,
      final_status: slowFinalStatus,
      collect: {
        task_id: slowCollect.task_id,
        state: slowCollect.state,
        completion_notice: slowCollect.artifact_manifest?.completion_notice,
      },
      progress_aggregate: {
        tool_call_count: slowRunningStatus?.tool_call_count,
        live_age_seconds: slowRunningStatus?.live_age_seconds,
        progress_state: slowRunningStatus?.progress_state,
      },
    },
    business_state_normalization_case: {
      done_synonym: {
        state: doneSynonymStatus?.state,
        business_state: doneSynonymStatus?.business_state,
        business_state_raw: doneSynonymStatus?.business_state_raw,
      },
      business_failed: {
        state: businessFailedStatus?.state,
        business_state: businessFailedStatus?.business_state,
        business_state_raw: businessFailedStatus?.business_state_raw,
        requires_parent_review: businessFailedStatus?.requires_parent_review,
      },
    },
    salvage_case: {
      state: invalidFinalStatus?.state,
      contract_state: invalidFinalStatus?.contract_state,
      salvage_report_path: invalidFinalStatus?.salvage_report_path,
      salvage_evidence_paths: invalidFinalSalvagePaths,
      salvage_evidence_ok: salvageEvidenceOk,
      requires_parent_review: invalidFinalStatus?.requires_parent_review,
    },
    stall_observation: {
      detected: { state: stalledStatus?.state, stall: stalledStatus?.stall },
      notice_seen: stallNoticeSeen,
      wait: { state: stallWait?.state, stall_notice_observed: stallWait?.stall_notice_observed, completion_notice_observed: stallWait?.completion_notice_observed, timed_out: stallWait?.timed_out },
      cleared: { state: stallClearedStatus?.state, stall: stallClearedStatus?.stall },
      notice_cleared: stallNoticeClearedWithStatus,
      after_seen: { state: stallWaitAfterSeen?.state, stall_notice_observed: stallWaitAfterSeen?.stall_notice_observed, completion_notice_observed: stallWaitAfterSeen?.completion_notice_observed },
      final: { state: stalledFinalStatus?.state, stall: stalledFinalStatus?.stall },
    },
    non_interference_case: {
      high_tool_count: {
        state: highToolCountStatus?.state,
        cancel_reason: highToolCountStatus?.cancel_reason,
        tool_call_count: highToolCountStatus?.tool_call_count,
        received_max_tool_calls: highToolCountChildResult?.received_max_tool_calls,
        parent_consumption: highToolCountCollect.parent_consumption,
      },
      elapsed_hint: {
        state: elapsedHintStatus?.state,
        cancel_reason: elapsedHintStatus?.cancel_reason,
        parent_consumption: elapsedHintCollect.parent_consumption,
      },
      dead_worker: {
        state: deadWorkerStatus?.state,
        failure_type: deadWorkerStatus?.failure_type,
        requires_parent_review: deadWorkerStatus?.requires_parent_review,
      },
    },
    task_status_summary: {
      task_count: taskSummary.task_count,
      buckets: taskSummary.buckets,
      high_tool_task: taskSummary.tasks.find((item) => item.task_id === highToolCountSubmit.task_id),
      sample_task_ids: taskSummary.tasks.slice(0, 5).map((item) => item.task_id),
    },
  };
  output.cleanup = cleanupState;
  output.worker_shutdown = workerShutdownState;
  return output;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let shutdownError = null;
    try {
      if (!workerShutdownState) {
        workerShutdownState = await shutdownTrackedWorkers();
      }
    } catch (error) {
      shutdownError = error;
    }
    if (workerShutdownState?.all_tracked_workers_exited && cleanupSelfTestArtifacts) {
      if (!cleanupState || !cleanupState.cleanup_succeeded) {
        const retry = cleanupSelfTestArtifacts();
        if (!cleanupState || retry.cleanup_succeeded) cleanupState = retry;
      }
    }
    if (shutdownError || !workerShutdownState?.all_tracked_workers_exited) {
      const failure = shutdownError || workerShutdownError(
        workerShutdownState || { remaining_pids: trackedWorkerPids() },
      );
      if (operationError) {
        throw new AggregateError(
          [operationError, failure],
          "async Core self-test failed and controlled worker cleanup could not be confirmed",
        );
      }
      throw failure;
    }
  }
}
