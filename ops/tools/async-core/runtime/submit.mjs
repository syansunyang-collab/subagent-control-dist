import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureDir, pick } from "../../_fs-utils.mjs";
import { PI_CHILD_WRITE_DOMAIN_PROFILE } from "../../pi_write_domain_extension.mjs";
import { WRITE_CLAIM_CONTRACT_VERSION } from ".././contracts.mjs";
import {
  RETAINED_WORKER_ERROR_CODE,
  STALL_SILENCE_DEFAULT_MS,
} from "./shared.mjs";

export function createSubmit(ctx, rt) {
  const resolveSubmitBudget = (...args) => rt.resolveSubmitBudget(...args);
  const pickBool = (...args) => rt.pickBool(...args);
  const pickNumber = (...args) => rt.pickNumber(...args);
  const writeJson = (...args) => rt.writeJson(...args);
  const isoNow = (...args) => rt.isoNow(...args);
  const truncateText = (...args) => rt.truncateText(...args);
  const safeTaskId = (...args) => rt.safeTaskId(...args);
  const resolveTaskRoot = (...args) => rt.resolveTaskRoot(...args);
  const taskDir = (...args) => rt.taskDir(...args);
  const taskFiles = (...args) => rt.taskFiles(...args);
  const launchTaskWorker = (...args) => rt.launchTaskWorker(...args);
  const readTaskText = (...args) => rt.readTaskText(...args);
  const taskSourcePath = (...args) => rt.taskSourcePath(...args);
  const resolveChildRunnerPath = (...args) => rt.resolveChildRunnerPath(...args);
  const assertRunnerAllowed = (...args) => rt.assertRunnerAllowed(...args);
  const defaultModelEffortForRunner = (...args) => rt.defaultModelEffortForRunner(...args);
  const loadPreparedDispatch = (...args) => rt.loadPreparedDispatch(...args);
  const inferTaskPackagePath = (...args) => rt.inferTaskPackagePath(...args);
  const producerRootForTask = (...args) => rt.producerRootForTask(...args);
  const declaredWritePaths = (...args) => rt.declaredWritePaths(...args);
  const claimFilePath = (...args) => rt.claimFilePath(...args);
  const withWriteClaimLock = (...args) => rt.withWriteClaimLock(...args);
  const assertWriteDomainAvailable = (...args) => rt.assertWriteDomainAvailable(...args);
  const writeInitialStatus = (...args) => rt.writeInitialStatus(...args);
  const completionInboxDir = (...args) => rt.completionInboxDir(...args);
  const worker = (...args) => rt.worker(...args);

  // 传输层只补跨仓边界；身份、交付与回复格式由 runner 的 system 与交付模板给出，任务包由 runner 从文件读取。
  function buildPrompt({ taskText, targetCwd, producerRoot }) {
    const crossRepo = path.resolve(targetCwd) !== path.resolve(producerRoot);
    return [
      taskText.trim(),
      ...(crossRepo
        ? [
            "",
            "## 跨仓边界",
            `- 业务写入和删除限在目标工作区 ${targetCwd} 与任务范围内。`,
            "- 报告与 handoff 写在发起仓的绝对路径（任务包 expected_output.resolved_file_path 与 handoff_contract.resolved_handoff_file）；wrapper 只核验，不代写。",
          ]
        : []),
      "",
    ].join("\n");
  }

  function submitTask(input = {}) {
    const parentTaskId = String(ctx.config.childEnv.SUBAGENT_PARENT_TASK_ID || "").trim() || null;
    const taskRoot = resolveTaskRoot(input);
    const registryRoot = path.resolve(
      pick(input, ["registry-root", "registry_root", "registryRoot"], ctx.config.registryRoot),
    );
    const producerRoot = producerRootForTask(input, taskRoot);
    const taskSource = taskSourcePath(input);
    const taskPackagePath = inferTaskPackagePath(taskSource);
    return withWriteClaimLock(producerRoot, (claimRoot) => {
      // task_id、任务包写域读取、冲突检查、claim 落盘与任务创建同处一个互斥临界区。
      const taskId = safeTaskId(pick(input, ["task-id", "task_id", "taskId"], ""));
      const dir = taskDir(taskRoot, taskId);
      if (existsSync(dir)) {
        throw new Error(`task dir already exists: ${dir}; reuse of task_id would clobber a live task, pick a fresh id`);
      }
      const files = taskFiles(dir);
      const targetCwd = path.resolve(ctx.config.cwd, pick(input, ["target-cwd", "target_cwd", "targetCwd"], ctx.config.cwd));
      const writeClaimPaths = declaredWritePaths(taskPackagePath, { targetCwd, producerRoot });
      const writeDomainPaths = declaredWritePaths(taskPackagePath, {
        targetCwd,
        producerRoot,
        includeDelete: false,
      });
      const writeDomainDeletePaths = declaredWritePaths(taskPackagePath, {
        targetCwd,
        producerRoot,
        includeOutputs: false,
        includeWrites: false,
      });
      assertWriteDomainAvailable(claimRoot, registryRoot, taskId, writeClaimPaths, parentTaskId);
      const writeClaimPath = writeClaimPaths.length ? claimFilePath(claimRoot, taskId) : null;
      let launchAttempted = false;
      try {
        if (writeClaimPath) {
          writeJson(writeClaimPath, {
            contract_version: WRITE_CLAIM_CONTRACT_VERSION,
            task_id: taskId,
            parent_task_id: parentTaskId,
            producer_root: producerRoot,
            task_root: taskRoot,
            registry_root: registryRoot,
            paths: writeClaimPaths,
            created_at: isoNow(),
          });
        }
        const runnerPath = resolveChildRunnerPath(pick(input, ["runner-path", "runner_path", "runnerPath"], ""));
        assertRunnerAllowed(runnerPath);
        const runnerDefaults = defaultModelEffortForRunner(runnerPath);
        const model = pick(input, ["model"], runnerDefaults.model);
        const effort = pick(input, ["effort"], runnerDefaults.effort);
        if (!String(model ?? "").trim()) throw new Error("task is missing model and runner catalog default model");
        if (!String(effort ?? "").trim()) throw new Error("task is missing effort and runner catalog default effort");
        const selection = input.selection && typeof input.selection === "object" ? input.selection : null;
        const runtimeRole = pick(input, ["runtime-role", "runtime_role", "runtimeRole"], "");
        const originThreadId = pick(input, ["origin-thread-id", "origin_thread_id", "originThreadId"], "");
        const batchId = pick(input, ["batch-id", "batch_id", "batchId"], "");
        const sliceId = pick(input, ["slice-id", "slice_id", "sliceId"], "");
        const displayTitle = pick(input, ["display-title", "display_title", "displayTitle"], "");
        const contextMode = pick(input, ["context-mode", "context_mode", "contextMode"], ctx.config.defaultContextMode);
        const simulationProfile = input.simulation_profile && typeof input.simulation_profile === "object"
          ? input.simulation_profile
          : null;
        const saveRawEvidence = pickBool(input, ["save-raw-evidence", "save_raw_evidence", "saveRawEvidence"], false);
        // 0 表示等待 app-server 的权威终态；只有调用方显式给出 turn timeout 才启用超时。
        const turnTimeoutMs = pickNumber(input, ["turn-timeout-ms", "turn_timeout_ms", "turnTimeoutMs"], 0);
        // 0 是显式关闭，不能走 pickNumber 的空值回退。
        const stallSilenceRaw = pick(input, ["stall-silence-ms", "stall_silence_ms", "stallSilenceMs"], "");
        const stallSilenceMs = stallSilenceRaw === "" || stallSilenceRaw === null || stallSilenceRaw === undefined
          ? STALL_SILENCE_DEFAULT_MS
          : Math.max(0, Number(stallSilenceRaw) || 0);
        const budget = resolveSubmitBudget(input);
        const executionProfile = pick(input, ["execution-profile", "execution_profile", "executionProfile"], "standard");
        const resultMode = String(input.result_mode || "");
        const dispatchFile = pick(input, ["dispatch-file", "dispatch_file", "dispatchFile"], "");
        const taskText = readTaskText(input);

        ensureDir(dir);
        const workerTaskPackagePath = taskPackagePath ? files.taskPackage : null;
        if (workerTaskPackagePath) {
          // The prepared package was already hash-verified by the envelope loader.
          // Preserve its exact bytes inside the task-owned runtime root so an
          // isolated worker never needs read access to producer preparation storage.
          writeFileSync(workerTaskPackagePath, readFileSync(taskPackagePath));
        }
        const prompt = buildPrompt({ taskText, targetCwd, producerRoot });
        const task = {
          task_id: taskId,
          parent_task_id: parentTaskId,
          created_at: isoNow(),
          task_root: taskRoot,
          registry_root: registryRoot,
          producer_root: producerRoot,
          task_dir: dir,
          target_cwd: targetCwd,
          runner_path: runnerPath,
          runtime_role: runtimeRole,
          model,
          effort,
          selection,
          origin_thread_id: truncateText(originThreadId, 160),
          batch_id: truncateText(batchId, 120),
          slice_id: truncateText(sliceId, 120),
          display_title: truncateText(displayTitle, 240),
          context_mode: contextMode,
          result_mode: resultMode,
          simulation_profile: simulationProfile
            ? {
                simulation: true,
                role: String(simulationProfile.role || ""),
                persona: simulationProfile.persona && typeof simulationProfile.persona === "object"
                  ? simulationProfile.persona
                  : {},
              }
            : null,
          save_raw_evidence: saveRawEvidence,
          turn_timeout_ms: turnTimeoutMs,
          stall_silence_ms: stallSilenceMs,
          budget,
          execution_profile: executionProfile,
          dispatch_file: dispatchFile ? path.resolve(ctx.config.cwd, dispatchFile) : null,
          task_source_path: taskSource,
          task_package_path: taskPackagePath,
          worker_task_package_path: workerTaskPackagePath,
          write_claim_contract_version: writeClaimPath ? WRITE_CLAIM_CONTRACT_VERSION : null,
          write_claim_path: writeClaimPath,
          write_claim_paths: writeClaimPaths,
          write_domain_paths: writeDomainPaths,
          write_domain_delete_paths: writeDomainDeletePaths,
          write_domain_spec_path: files.writeDomain,
          prompt_path: files.prompt,
          report_path: files.report,
          handoff_path: files.handoff,
        };

        writeFileSync(files.prompt, prompt, "utf8");
        writeJson(files.writeDomain, {
          contract_version: PI_CHILD_WRITE_DOMAIN_PROFILE,
          task_id: taskId,
          paths: writeDomainPaths,
          delete_paths: writeDomainDeletePaths,
          case_insensitive: ctx.host.caseInsensitivePaths === true,
        });
        writeJson(files.task, task);
        writeInitialStatus(files, task);
        ensureDir(completionInboxDir(taskRoot));
        launchAttempted = true;
        const launched = launchTaskWorker({ registryRoot, taskRoot, taskId, dir, files });

        return {
          ok: true,
          task_id: taskId,
          state: "queued",
          task_dir: dir,
          status_path: files.status,
          handoff_path: files.handoff,
          report_path: files.report,
          completion_inbox_dir: completionInboxDir(taskRoot),
          model,
          effort,
          selection,
          model_source: "task_config",
          effort_source: "task_config",
          runtime_role: runtimeRole,
          origin_thread_id: task.origin_thread_id || null,
          batch_id: task.batch_id || null,
          slice_id: task.slice_id || null,
          display_title: task.display_title || null,
          task_source_path: taskSource,
          task_package_path: taskPackagePath,
          pid: launched.child.pid,
          revision: String(launched.status.rev),
          submitted_at: launched.status.created_at,
        };
      } catch (error) {
        const retainedWorker = error?.code === RETAINED_WORKER_ERROR_CODE;
        const rollbackComplete = error?.rollback_complete === true;
        const noWriterCanRemain = error?.no_writer_can_remain === true;
        if (
          writeClaimPath &&
          !retainedWorker &&
          (!launchAttempted || rollbackComplete || noWriterCanRemain)
        ) {
          rmSync(writeClaimPath, { force: true });
        }
        throw error;
      }
    });
  }

  function submitPreparedTask(dispatchFileValue = "") {
    const prepared = loadPreparedDispatch(dispatchFileValue);
    return submitTask({
      ...prepared.input,
      registry_root: ctx.config.registryRoot,
    });
  }

  return {
    buildPrompt,
    submitTask,
    submitPreparedTask,
  };
}
