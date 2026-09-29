import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ensureDir, pick, readJson } from "../../_fs-utils.mjs";
import { WRITE_CLAIM_LOCK_STALE_MS, WRITE_CLAIM_LOCK_WAIT_MS, WRITE_CLAIM_STALE_MS, isTerminalState } from ".././contracts.mjs";
import {
  isUnconfirmedRetainedProcessTree,
} from "./shared.mjs";

export function createClaims(ctx, rt) {
  const sleepSync = (...args) => rt.sleepSync(...args);
  const isoNow = (...args) => rt.isoNow(...args);
  const isInside = (...args) => rt.isInside(...args);
  const safeTaskId = (...args) => rt.safeTaskId(...args);
  const taskDir = (...args) => rt.taskDir(...args);
  const taskFiles = (...args) => rt.taskFiles(...args);
  const registryFile = (...args) => rt.registryFile(...args);
  const loadTask = (...args) => rt.loadTask(...args);
  const taskPackageFromData = (...args) => rt.taskPackageFromData(...args);
  const taskPackagePathFor = (...args) => rt.taskPackagePathFor(...args);
  const processAlive = (...args) => rt.processAlive(...args);
  // Synchronous lifecycle transactions can re-enter their producer claim lock.
  const heldWriteClaimLocks = new Set();

  function producerRootForTask(input, taskRoot) {
    const explicit = pick(input, ["producer-root", "producer_root", "producerRoot"], "");
    if (explicit) {
      return path.resolve(ctx.config.cwd, explicit);
    }
    const resolvedTaskRoot = path.resolve(taskRoot);
    const cockpitRoot = path.dirname(resolvedTaskRoot);
    const runtimeRoot = path.dirname(cockpitRoot);
    const layout = ctx.config.defaultTaskRootLayout;
    if (
      path.basename(resolvedTaskRoot).toLowerCase() === String(layout.taskRootBasename).toLowerCase() &&
      path.basename(cockpitRoot).toLowerCase() === String(layout.cockpitBasename).toLowerCase() &&
      path.basename(runtimeRoot).toLowerCase() === String(layout.runtimeBasename).toLowerCase()
    ) {
      return path.dirname(runtimeRoot);
    }
    return path.resolve(ctx.config.cwd, pick(input, ["target-cwd", "target_cwd", "targetCwd"], ctx.config.cwd));
  }

  function writeClaimRootForProducer(producerRoot) {
    return path.join(path.resolve(producerRoot), ...ctx.config.writeClaimRootSegments);
  }

  function normalizeWriteDomainPath(value, baseDir) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      return null;
    }
    let normalized = path.normalize(path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw));
    try {
      const literalTail = [];
      let existingAncestor = normalized;
      while (!existsSync(existingAncestor)) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) {
          existingAncestor = null;
          break;
        }
        literalTail.unshift(path.basename(existingAncestor));
        existingAncestor = parent;
      }
      if (existingAncestor) {
        normalized = path.join(realpathSync.native(existingAncestor), ...literalTail);
      }
    } catch {
      // reparse/symlink 解析失败时保留字面绝对路径；不存在的尾段始终按字面追加。
    }
    normalized = path.normalize(path.resolve(normalized));
    return ctx.host.caseInsensitivePaths ? normalized.toLowerCase() : normalized;
  }

  // 绝对路径、进程级写域互斥；与 seed 相对路径冲突判定（_tool_common.path_conflict）语义不同，勿合并。
  function writeClaimPathsConflict(left, right) {
    if (left === right) {
      return true;
    }
    return isInside(left, right) || isInside(right, left);
  }

  function addDeclaredPaths(target, value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        addDeclaredPaths(target, item);
      }
    } else if (typeof value === "string" && value.trim()) {
      target.push(value.trim());
    }
  }

  function declaredWritePaths(taskPackagePath, {
    targetCwd,
    producerRoot,
    includeOutputs = true,
    includeWrites = true,
    includeDelete = true,
  }) {
    if (!taskPackagePath) {
      return [];
    }
    const taskPackage = taskPackageFromData(readJson(taskPackagePath, null));
    if (!taskPackage) {
      throw new Error(`cannot read task package write domain: ${taskPackagePath}`);
    }
    const outputRoot = path.resolve(
      String(
        taskPackage.runtime_context?.output_root ||
        taskPackage.runtime_context?.cwd ||
        targetCwd ||
        producerRoot,
      ),
    );
    const outputDeclared = [];
    if (includeOutputs) {
      addDeclaredPaths(
        outputDeclared,
        taskPackage.expected_output?.resolved_file_path || taskPackage.expected_output?.file_path,
      );
      addDeclaredPaths(
        outputDeclared,
        taskPackage.handoff_contract?.resolved_handoff_file || taskPackage.handoff_contract?.handoff_file,
      );
    }
    const outputPaths = outputDeclared
      .map((entry) => normalizeWriteDomainPath(entry, outputRoot))
      .filter(Boolean);
    const outputSet = new Set(outputPaths);
    const targetDeclared = [];
    if (includeWrites) {
      addDeclaredPaths(targetDeclared, taskPackage.scope?.write);
      addDeclaredPaths(targetDeclared, taskPackage.scope?.write_extra);
    }
    if (includeDelete) addDeclaredPaths(targetDeclared, taskPackage.scope?.delete);
    const targetPaths = targetDeclared
      .map((entry) => {
        const asProducerOutput = normalizeWriteDomainPath(entry, outputRoot);
        return outputSet.has(asProducerOutput)
          ? asProducerOutput
          : normalizeWriteDomainPath(entry, targetCwd);
      })
      .filter(Boolean);
    return [...new Set([...outputPaths, ...targetPaths])].sort();
  }

  function claimFilePath(claimRoot, taskId) {
    return path.join(claimRoot, `${safeTaskId(taskId)}.json`);
  }

  function claimRecordAgeMs(file, now = ctx.host.nowMs()) {
    try {
      return Math.max(0, now - statSync(file).mtimeMs);
    } catch {
      return 0;
    }
  }

  function claimTaskStatuses(record) {
    const taskId = String(record?.task_id || "");
    const roots = [];
    if (record?.task_root) {
      roots.push(path.resolve(String(record.task_root)));
    }
    if (record?.registry_root && taskId) {
      try {
        const registry = readJson(registryFile(record.registry_root, taskId), null);
        if (registry?.task_root) {
          roots.push(path.resolve(String(registry.task_root)));
        }
      } catch {
        // 无效注册记录不伪装成终态；只能走“注册表缺失且超时”判据。
      }
    }
    return roots.map((taskRoot) => readJson(taskFiles(taskDir(taskRoot, taskId)).status, null));
  }

  function claimTaskIsTerminal(record) {
    return claimTaskStatuses(record).some((status) => (
      (isTerminalState(status?.state) || status?.state === "paused") && !isUnconfirmedRetainedProcessTree(status)
    ));
  }

  function claimRegistryEntryExists(record) {
    if (!record?.registry_root || !record?.task_id) {
      return false;
    }
    try {
      return existsSync(registryFile(record.registry_root, record.task_id));
    } catch {
      return false;
    }
  }

  function reclaimStaleWriteClaims(claimRoot, staleMs = WRITE_CLAIM_STALE_MS) {
    if (!existsSync(claimRoot)) {
      return;
    }
    for (const name of readdirSync(claimRoot).filter((entry) => entry.endsWith(".json"))) {
      const file = path.join(claimRoot, name);
      const record = readJson(file, null);
      const unconfirmedRetained = claimTaskStatuses(record).some((status) => (
        isUnconfirmedRetainedProcessTree(status)
      ));
      const stale = !unconfirmedRetained && (
        claimTaskIsTerminal(record) ||
        (!claimRegistryEntryExists(record) && claimRecordAgeMs(file) >= staleMs)
      );
      if (!stale) {
        continue;
      }
      const tombstone = `${file}.stale.${ctx.host.pid}.${ctx.host.randomHex(4)}`;
      try {
        renameSync(file, tombstone);
      } catch (error) {
        if (["ENOENT", "EPERM", "EACCES", "EBUSY"].includes(error?.code)) {
          continue;
        }
        throw error;
      }
      rmSync(tombstone, { force: true });
    }
  }

  function writeClaimLockIsStale(lockFile, record, staleMs) {
    if (claimRecordAgeMs(lockFile) < staleMs) {
      return false;
    }
    if (record?.host && record.host !== ctx.host.hostname) {
      return false;
    }
    return !Number.isInteger(record?.pid) || !processAlive(record.pid);
  }

  function withWriteClaimLock(producerRoot, callback, {
    waitMs = WRITE_CLAIM_LOCK_WAIT_MS,
    lockStaleMs = WRITE_CLAIM_LOCK_STALE_MS,
    claimStaleMs = WRITE_CLAIM_STALE_MS,
  } = {}) {
    const claimRoot = writeClaimRootForProducer(producerRoot);
    if (heldWriteClaimLocks.has(claimRoot)) return callback(claimRoot);
    const lockFile = path.join(claimRoot, ".claims.lock");
    const deadline = ctx.host.nowMs() + Math.max(0, waitMs);
    const token = `${ctx.host.pid}-${ctx.host.randomHex(8)}`;
    ensureDir(claimRoot);
    while (true) {
      let fd = null;
      let created = false;
      try {
        fd = openSync(lockFile, "wx");
        created = true;
        writeFileSync(fd, JSON.stringify({
          pid: ctx.host.pid,
          host: ctx.host.hostname,
          token,
          acquired_at: isoNow(),
        }), "utf8");
        closeSync(fd);
        break;
      } catch (error) {
        if (fd !== null) {
          try { closeSync(fd); } catch {}
        }
        if (created) {
          rmSync(lockFile, { force: true });
        }
        if (error?.code !== "EEXIST") {
          throw error;
        }
        let record = {};
        try { record = readJson(lockFile, {}); } catch {}
        if (writeClaimLockIsStale(lockFile, record, lockStaleMs)) {
          const tombstone = `${lockFile}.stale.${ctx.host.pid}.${ctx.host.randomHex(4)}`;
          try {
            renameSync(lockFile, tombstone);
          } catch {
            continue;
          }
          rmSync(tombstone, { force: true });
          continue;
        }
        if (ctx.host.nowMs() >= deadline) {
          throw new Error(
            `write claim lock is busy (pid=${record?.pid ?? "unknown"}, acquired_at=${record?.acquired_at ?? "unknown"})`,
          );
        }
        sleepSync(10);
      }
    }
    try {
      heldWriteClaimLocks.add(claimRoot);
      reclaimStaleWriteClaims(claimRoot, claimStaleMs);
      return callback(claimRoot);
    } finally {
      heldWriteClaimLocks.delete(claimRoot);
      let current = {};
      try { current = readJson(lockFile, {}); } catch {}
      if (!existsSync(lockFile) || current.token === token) {
        rmSync(lockFile, { force: true });
      }
    }
  }

  function activeRegistryWriteDomains(registryRoot) {
    if (!existsSync(registryRoot)) {
      return [];
    }
    const active = [];
    for (const name of readdirSync(registryRoot).filter((entry) => entry.endsWith(".json"))) {
      const registry = readJson(path.join(registryRoot, name), null);
      if (!registry?.task_id || !registry?.task_root) {
        continue;
      }
      let loaded;
      try {
        loaded = loadTask(path.resolve(registry.task_root), String(registry.task_id));
      } catch {
        continue;
      }
      const status = readJson(loaded.files.status, {});
      if ((isTerminalState(status.state) || status.state === "paused") && !isUnconfirmedRetainedProcessTree(status)) {
        continue;
      }
      const stored = Array.isArray(loaded.task.write_claim_paths) ? loaded.task.write_claim_paths : [];
      const paths = stored.length
        ? stored
        : declaredWritePaths(taskPackagePathFor(loaded.task), {
            targetCwd: loaded.task.target_cwd,
            producerRoot: loaded.task.producer_root || producerRootForTask({}, registry.task_root),
          });
      if (paths.length) {
        active.push({
          task_id: String(registry.task_id), paths,
          can_delegate: !isTerminalState(status.state) && status.state !== "paused",
        });
      }
    }
    return active;
  }

  function assertWriteDomainAvailable(claimRoot, registryRoot, taskId, paths, parentTaskId = null) {
    if (!paths.length) {
      return;
    }
    const candidates = new Map();
    let activeParent = false;
    for (const name of readdirSync(claimRoot).filter((entry) => entry.endsWith(".json"))) {
      const record = readJson(path.join(claimRoot, name), null);
      if (record?.task_id && Array.isArray(record.paths) && record.task_id !== taskId) {
        candidates.set(String(record.task_id), record.paths);
        if (record.task_id === parentTaskId) {
          activeParent = claimTaskStatuses(record).some((status) => (
            status?.state && !isTerminalState(status.state) && status.state !== "paused"
          ));
        }
      }
    }
    for (const active of activeRegistryWriteDomains(registryRoot)) {
      if (active.task_id === parentTaskId && active.can_delegate) activeParent = true;
      if (active.task_id !== taskId && !candidates.has(active.task_id)) {
        candidates.set(active.task_id, active.paths);
      }
    }
    const conflicts = [];
    const overlaps = [];
    for (const [otherTaskId, otherPaths] of candidates) {
      const pairs = [];
      for (const left of paths) {
        // Only the direct active parent delegates contained paths; siblings remain exclusive.
        if (activeParent && otherTaskId === parentTaskId && otherPaths.some((right) => isInside(right, left))) {
          continue;
        }
        for (const right of otherPaths) {
          if (writeClaimPathsConflict(left, right)) pairs.push(`requested ${left} overlaps ${otherTaskId} claim ${right}`);
        }
      }
      if (pairs.length) {
        conflicts.push(otherTaskId);
        overlaps.push(...pairs);
      }
    }
    if (conflicts.length) {
      // 只报 task_id 的话调用方还得自己去翻两边的声明；重叠路径对直接给出，最多 5 组防爆长。
      const sample = overlaps.sort().slice(0, 5).join("; ");
      const omitted = overlaps.length - Math.min(overlaps.length, 5);
      throw new Error(
        `write claim conflict with task_id(s): ${conflicts.sort().join(", ")}`
        + `; overlapping paths: ${sample}${omitted ? ` (+${omitted} more)` : ""}`,
      );
    }
  }

  function releaseWriteClaimForTask(task) {
    if (!task?.write_claim_path || !task?.producer_root) {
      return false;
    }
    const expectedClaimPath = claimFilePath(writeClaimRootForProducer(task.producer_root), task.task_id);
    if (path.resolve(task.write_claim_path) !== path.resolve(expectedClaimPath)) {
      return false;
    }
    return withWriteClaimLock(task.producer_root, () => {
      const record = readJson(expectedClaimPath, null);
      if (!record || record.task_id !== task.task_id) {
        return false;
      }
      const status = readJson(taskFiles(task.task_dir).status, null);
      if (isUnconfirmedRetainedProcessTree(status) || (status && !isTerminalState(status.state) && status.state !== "paused")) {
        return false;
      }
      rmSync(expectedClaimPath, { force: true });
      return true;
    });
  }

  return {
    producerRootForTask,
    writeClaimRootForProducer,
    normalizeWriteDomainPath,
    writeClaimPathsConflict,
    addDeclaredPaths,
    declaredWritePaths,
    claimFilePath,
    claimRecordAgeMs,
    claimTaskStatuses,
    claimTaskIsTerminal,
    claimRegistryEntryExists,
    reclaimStaleWriteClaims,
    writeClaimLockIsStale,
    withWriteClaimLock,
    activeRegistryWriteDomains,
    assertWriteDomainAvailable,
    releaseWriteClaimForTask,
  };
}
