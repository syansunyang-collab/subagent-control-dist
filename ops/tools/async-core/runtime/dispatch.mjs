import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pick, readJson } from "../../_fs-utils.mjs";
import { CROSS_REPO_RESULT_MODES, DISPATCH_ENVELOPE_VERSION, SUPPORTED_DISPATCH_ENVELOPE_VERSIONS } from ".././contracts.mjs";
import { STALL_SILENCE_DEFAULT_MS } from "./shared.mjs";

export function createDispatch(ctx, rt) {
  const isInside = (...args) => rt.isInside(...args);
  const truncateText = (...args) => rt.truncateText(...args);
  const normalizeWriteDomainPath = (...args) => rt.normalizeWriteDomainPath(...args);

  function readTaskText(input = {}) {
    const task = pick(input, ["task"], "");
    if (task) {
      return task;
    }
    const taskFile = taskSourcePath(input);
    if (taskFile) {
      return readFileSync(taskFile, "utf8");
    }
    throw new Error("submit requires task or task_file");
  }

  function taskSourcePath(input = {}) {
    const taskFile = pick(input, ["task-file", "task_file", "taskFile"], "");
    return taskFile ? path.resolve(ctx.config.cwd, taskFile) : null;
  }

  function runnerEntries() {
    return Object.values(ctx.config.runnerCatalog).filter((entry) => entry && typeof entry === "object");
  }

  function runnerEntryForPath(runnerPath) {
    const resolved = path.resolve(ctx.config.cwd, String(runnerPath || ""));
    const entries = runnerEntries();
    const exact = entries.find((entry) => entry.path && path.resolve(ctx.config.cwd, entry.path) === resolved);
    if (exact) return exact;
    const basename = path.basename(resolved).toLowerCase();
    return entries.find((entry) => [entry.basename, ...(entry.aliases || [])]
      .map((value) => String(value || "").toLowerCase())
      .includes(basename)) || null;
  }

  function runnerBasenames() {
    return runnerEntries().flatMap((entry) => [entry.basename, ...(entry.aliases || [])])
      .map((value) => String(value || "").toLowerCase()).filter(Boolean);
  }

  function resolveChildRunnerPath(candidate) {
    const trimmed = String(candidate || "").trim();
    if (trimmed && !(/[\\\\/]/.test(trimmed))) {
      const entry = runnerEntries().find((item) => [item.basename, ...(item.aliases || [])]
        .map((value) => String(value || "").toLowerCase()).includes(trimmed.toLowerCase()));
      if (entry?.path) return path.resolve(ctx.config.cwd, entry.path);
    }
    return path.resolve(ctx.config.cwd, trimmed || ctx.config.defaultRunnerPath);
  }

  function isTrustedChildRunner(runnerPath) {
    let canonical;
    let trustedRootCanonical;
    try {
      canonical = realpathSync.native(path.resolve(ctx.config.cwd, runnerPath));
      trustedRootCanonical = realpathSync.native(ctx.config.trustedRunnerRoot);
    } catch {
      return false;
    }
    const trustedBasenames = new Set(ctx.config.trustedRunnerBasenames.map((value) => value.toLowerCase()));
    return path.dirname(canonical) === trustedRootCanonical
      && trustedBasenames.has(path.basename(canonical).toLowerCase());
  }

  function assertRunnerAllowed(runnerPath) {
    if (!isTrustedChildRunner(runnerPath) && !ctx.config.allowCustomRunner) {
      throw new Error(
        ctx.config.runnerTrustFailureMessage,
      );
    }
  }

  function defaultModelEffortForRunner(runnerPath) {
    const entry = runnerEntryForPath(runnerPath) || ctx.config.defaultRunnerEntry;
    // Catalog values only fill missing request fields; validate after merging.
    return { model: String(entry?.defaultModel || ""), effort: String(entry?.defaultEffort || "") };
  }

  // Executor metadata stays in the adapter-owned runner catalog; it does not change the dispatch contract.
  function loadPreparedDispatch(dispatchFileValue) {
    const dispatchFile = path.resolve(ctx.config.cwd, String(dispatchFileValue ?? "").trim());
    if (!dispatchFileValue || !existsSync(dispatchFile)) {
      throw new Error("submit_prepared requires an existing dispatch_file");
    }
    if (!dispatchFile.endsWith(".dispatch.json")) {
      throw new Error("dispatch_file must end with .dispatch.json");
    }
    const envelope = readJson(dispatchFile, null);
    const envelopeVersion = String(envelope?.contract_version || "");
    if (!envelope || !SUPPORTED_DISPATCH_ENVELOPE_VERSIONS.includes(envelopeVersion)) {
      throw new Error(
        `dispatch_file contract_version must be one of ${SUPPORTED_DISPATCH_ENVELOPE_VERSIONS.join(", ")}`,
      );
    }
    if (
      envelopeVersion === DISPATCH_ENVELOPE_VERSION &&
      (!Object.hasOwn(envelope, "origin_thread_id") || typeof envelope.origin_thread_id !== "string")
    ) {
      throw new Error(`${DISPATCH_ENVELOPE_VERSION} dispatch_file requires string origin_thread_id`);
    }
    const producerRootValue = String(envelope.producer_root ?? "").trim();
    const targetCwdValue = String(envelope.target_cwd ?? "").trim();
    const taskFileValue = String(envelope.task_file ?? "").trim();
    const taskRootValue = String(envelope.task_root ?? "").trim();
    if (!producerRootValue || !targetCwdValue || !taskFileValue || !taskRootValue) {
      throw new Error("dispatch_file is missing producer_root, target_cwd, task_file, or task_root");
    }
    const producerRoot = path.resolve(ctx.config.cwd, producerRootValue);
    const targetCwd = path.resolve(ctx.config.cwd, targetCwdValue);
    const taskFile = path.resolve(ctx.config.cwd, taskFileValue);
    const taskRoot = path.resolve(ctx.config.cwd, taskRootValue);
    const controlledDir = path.join(producerRoot, "tmp", "dispatch_prepare");
    if (!isInside(controlledDir, dispatchFile) || !isInside(controlledDir, taskFile)) {
      throw new Error("dispatch_file and task_file must stay inside producer_root/tmp/dispatch_prepare");
    }
    if (!taskFile.endsWith(".task.md") || !existsSync(taskFile)) {
      throw new Error("dispatch_file task_file must reference an existing *.task.md");
    }
    if (!existsSync(targetCwd)) {
      throw new Error("dispatch_file target_cwd does not exist");
    }
    if (!isInside(path.join(producerRoot, ".runtime"), taskRoot)) {
      throw new Error("dispatch_file task_root must stay inside producer_root/.runtime");
    }
    const executionProfile = String(envelope.execution_profile || "standard");
    if (!["standard", "simulation", "evidence_only_v1"].includes(executionProfile)) {
      throw new Error("dispatch_file execution_profile is not supported");
    }
    const runnerCandidate = String(envelope.runner_path || "").trim();
    const runnerPath = resolveChildRunnerPath(runnerCandidate);
    if (!runnerBasenames().includes(path.basename(runnerPath).toLowerCase()) || !existsSync(runnerPath)) {
      throw new Error(`dispatch_file runner must resolve to an existing ${runnerBasenames().join(" or ")}`);
    }
    assertRunnerAllowed(runnerPath);
    const runnerDefaults = defaultModelEffortForRunner(runnerPath);
    const contextMode = String(envelope.context_mode || ctx.config.defaultContextMode);
    if (!["isolated", "project-aware"].includes(contextMode)) {
      throw new Error("dispatch_file context_mode is not supported");
    }
    const simulation = envelope.simulation && typeof envelope.simulation === "object" ? envelope.simulation : {};
    const resultMode = String(envelope.result_mode || "");
    if (resultMode && !CROSS_REPO_RESULT_MODES.includes(resultMode)) {
      throw new Error(`dispatch_file result_mode must be one of ${CROSS_REPO_RESULT_MODES.join(", ")}`);
    }
    const crossRepo = (
      normalizeWriteDomainPath(producerRoot, producerRoot)
      !== normalizeWriteDomainPath(targetCwd, targetCwd)
    );
    if (crossRepo && !resultMode) {
      throw new Error("cross-repo dispatch requires result_mode");
    }
    if (
      executionProfile === "simulation" &&
      (
        resultMode !== "simulated_planning"
        || !simulation.role
        || !simulation.persona
        || typeof simulation.persona !== "object"
        || Array.isArray(simulation.persona)
      )
    ) {
      throw new Error("simulation dispatch requires result_mode=simulated_planning and structured role/persona");
    }
    if (executionProfile !== "simulation" && resultMode === "simulated_planning") {
      throw new Error("result_mode=simulated_planning requires execution_profile=simulation");
    }
    const primaryModel = String(envelope.model || runnerDefaults.model).trim();
    const primaryEffort = String(envelope.effort || runnerDefaults.effort).trim();
    if (!primaryModel) throw new Error("dispatch_file is missing model and runner catalog default model");
    if (!primaryEffort) throw new Error("dispatch_file is missing effort and runner catalog default effort");
    return {
      dispatchFile,
      input: {
        task_file: taskFile,
        target_cwd: targetCwd,
        task_root: taskRoot,
        producer_root: producerRoot,
        runner_path: runnerPath,
        runtime_role: String(envelope.runtime_role || ""),
        model: primaryModel,
        effort: primaryEffort,
        selection: envelope.selection && typeof envelope.selection === "object" ? envelope.selection : null,
        origin_thread_id: truncateText(String(envelope.origin_thread_id || ""), 160),
        batch_id: truncateText(String(envelope.batch_id || ""), 120),
        slice_id: truncateText(String(envelope.slice_id || ""), 120),
        display_title: truncateText(String(envelope.display_title || ""), 240),
        context_mode: contextMode,
        result_mode: resultMode,
        simulation_profile: executionProfile === "simulation"
          ? { simulation: true, role: String(simulation.role), persona: simulation.persona }
          : null,
        save_raw_evidence: Boolean(envelope.save_raw_evidence),
        turn_timeout_ms: Number(envelope.turn_timeout_ms || 0),
        stall_silence_ms: envelope.stall_silence_ms === undefined || envelope.stall_silence_ms === null
          ? STALL_SILENCE_DEFAULT_MS
          : Math.max(0, Number(envelope.stall_silence_ms) || 0),
        budget: envelope.budget && typeof envelope.budget === "object" ? envelope.budget : {},
        execution_profile: executionProfile,
        dispatch_file: dispatchFile,
      },
    };
  }

  function inferTaskPackagePath(taskFilePath = "") {
    if (!taskFilePath) {
      return null;
    }
    const candidates = [];
    if (taskFilePath.endsWith(".task.md")) {
      candidates.push(`${taskFilePath.slice(0, -".task.md".length)}.json`);
    }
    candidates.push(taskFilePath.replace(/\.md$/i, ".json"));
    return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
  }

  return {
    readTaskText,
    taskSourcePath,
    runnerEntries,
    runnerEntryForPath,
    runnerBasenames,
    resolveChildRunnerPath,
    isTrustedChildRunner,
    assertRunnerAllowed,
    defaultModelEffortForRunner,
    loadPreparedDispatch,
    inferTaskPackagePath,
  };
}
