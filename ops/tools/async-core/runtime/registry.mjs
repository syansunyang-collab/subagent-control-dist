import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { pick, readJson } from "../../_fs-utils.mjs";
import { CONTRACT_VERSION } from ".././contracts.mjs";

export function createRegistry(ctx, rt) {
  const writeJson = (...args) => rt.writeJson(...args);
  const isoNow = (...args) => rt.isoNow(...args);
  const worker = (...args) => rt.worker(...args);

  function safeTaskId(value = "") {
    const text = String(value).trim();
    if (text && /^[A-Za-z0-9_.-]{1,120}$/.test(text)) {
      return text;
    }
    const stamp = isoNow().replace(/[:.]/g, "-");
    const suffix = ctx.host.randomHex(4);
    return `${ctx.config.taskIdPrefix}-${stamp}-${suffix}`;
  }

  function resolveTaskRoot(input = {}) {
    return path.resolve(ctx.config.cwd, pick(input, ["task-root", "task_root", "taskRoot"], ctx.config.defaultTaskRoot));
  }

  function taskDir(taskRoot, taskId) {
    return path.join(taskRoot, taskId);
  }

  function taskFiles(dir) {
    return {
      dir,
      task: path.join(dir, "task.json"),
      prompt: path.join(dir, "task.md"),
      taskPackage: path.join(dir, "task-package.json"),
      status: path.join(dir, "status.json"),
      result: path.join(dir, "result.json"),
      report: path.join(dir, "report.md"),
      handoff: path.join(dir, "handoff.md"),
      workerStderr: path.join(dir, "worker.stderr.log"),
      childResult: path.join(dir, "child-task-result.json"),
      childLive: path.join(dir, "child-task-live.json"),
      childEvents: path.join(dir, "child-task-events.jsonl"),
      cancelRequest: path.join(dir, "cancel-request.json"),
      resultFull: path.join(dir, "result-full.json"),
      writeDomain: path.join(dir, "write-domain.json"),
      selection: path.join(dir, "selection.json"),
      attestation: path.join(dir, "real-run-attestation.json"),
    };
  }

  function registryFile(registryRoot, taskId) {
    const text = String(taskId ?? "").trim();
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(text)) {
      throw new Error("task_id is invalid");
    }
    return path.join(path.resolve(registryRoot), `${text}.json`);
  }

  function registerTaskLocation(registryRoot, taskRoot, taskId) {
    writeJson(registryFile(registryRoot, taskId), {
      contract_version: CONTRACT_VERSION,
      task_id: taskId,
      task_root: path.resolve(taskRoot),
      registered_at: isoNow(),
    });
  }

  function unregisterTaskLocation(registryRoot, taskId) {
    rmSync(registryFile(registryRoot, taskId), { force: true });
  }

  function locateTask(input = {}, taskId = "") {
    const explicitRoot = pick(input, ["task-root", "task_root", "taskRoot"], "");
    if (explicitRoot) {
      return { taskRoot: path.resolve(explicitRoot), source: "explicit" };
    }
    const registryRoot = path.resolve(
      pick(input, ["registry-root", "registry_root", "registryRoot"], ctx.config.registryRoot),
    );
    const recordFile = registryFile(registryRoot, taskId);
    const record = readJson(recordFile, null);
    // 查不到记录与记录损坏分开报：每个服务实例各有登记根，别家派的任务在这里没有记录不等于记录坏了。
    if (!existsSync(recordFile)) {
      throw new Error(
        `Task ${taskId} is not registered under ${registryRoot}; it may belong to another service instance `
        + "(each service keeps its own registry root) — query it from that service, or pass task_root explicitly on the CLI",
      );
    }
    if (
      record?.contract_version !== CONTRACT_VERSION ||
      record.task_id !== taskId ||
      typeof record.task_root !== "string" ||
      !path.isAbsolute(record.task_root)
    ) {
      throw new Error(`Invalid task registry record: ${taskId}`);
    }
    return { taskRoot: path.resolve(record.task_root), registryRoot, source: "registry" };
  }

  function loadTask(taskRoot, taskId, location = null) {
    const dir = taskDir(taskRoot, taskId);
    const files = taskFiles(dir);
    const task = readJson(files.task);
    if (!task) {
      throw new Error(`Unknown task_id: ${taskId}`);
    }
    if (
      task.task_id !== taskId ||
      path.resolve(String(task.task_root || "")) !== path.resolve(taskRoot) ||
      path.resolve(String(task.task_dir || "")) !== path.resolve(dir)
    ) {
      throw new Error(`Task record binding mismatch: ${taskId}`);
    }
    if (
      location?.source === "registry" &&
      path.resolve(String(task.registry_root || "")) !== path.resolve(location.registryRoot)
    ) {
      throw new Error(`Task registry binding mismatch: ${taskId}`);
    }
    return { dir, files, task };
  }

  function loadLocatedTask(input, taskId) {
    const location = locateTask(input, taskId);
    return { ...location, ...loadTask(location.taskRoot, taskId, location) };
  }

  return {
    safeTaskId,
    resolveTaskRoot,
    taskDir,
    taskFiles,
    registryFile,
    registerTaskLocation,
    unregisterTaskLocation,
    locateTask,
    loadTask,
    loadLocatedTask,
  };
}
