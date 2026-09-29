import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readJson } from "../../_fs-utils.mjs";

export function createTaskPackage(ctx, rt) {
  const inferTaskPackagePath = (...args) => rt.inferTaskPackagePath(...args);
  const worker = (...args) => rt.worker(...args);

  function objectOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function declaredOutputPath(task, taskPackage, value) {
    const text = String(value ?? "").trim();
    if (!text || text === "null") {
      return null;
    }
    if (path.isAbsolute(text)) {
      return path.resolve(text);
    }
    const runtime = objectOrEmpty(taskPackage.runtime_context);
    const base = String(runtime.output_root || task.target_cwd || ctx.config.cwd);
    return path.resolve(base, text);
  }

  function firstExistingPath(paths) {
    for (const candidate of paths) {
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  function taskPackageFromData(data) {
    const envelope = objectOrEmpty(objectOrEmpty(data).task_package);
    if (Object.keys(envelope).length > 0) {
      return envelope;
    }
    const root = objectOrEmpty(data);
    if (root.package_id || root.expected_output || root.handoff_contract) {
      return root;
    }
    return null;
  }

  function taskPackageFromPrompt(promptPath) {
    if (!promptPath || !existsSync(promptPath)) {
      return null;
    }
    const text = readFileSync(promptPath, "utf8");
    const blocks = text.matchAll(/```json\s*([\s\S]*?)```/gi);
    for (const block of blocks) {
      try {
        const parsed = JSON.parse(block[1]);
        const taskPackage = taskPackageFromData(parsed);
        if (taskPackage) {
          return taskPackage;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  // prompt 自检说明、submit_task_result 的 --handoffCheck 规格与终态复验共用同一份 package 路径：
  // worker 固化副本（hash 已校验、不依赖 producer 准备目录）优先，其次 prepared 原件，最后按 task 文件推断。
  function taskPackagePathFor(task) {
    return [task.worker_task_package_path, task.task_package_path, inferTaskPackagePath(task.task_source_path)]
      .map((item) => String(item || ""))
      .find((item) => item && existsSync(item)) || task.task_package_path || null;
  }

  function loadTaskPackage(task) {
    const packagePath = taskPackagePathFor(task);
    if (packagePath && existsSync(packagePath)) {
      try {
        const data = readJson(packagePath, {});
        const taskPackage = taskPackageFromData(data);
        if (taskPackage) {
          return { source: "task_package_file", packagePath, taskPackage, error: null };
        }
        return {
          source: "task_package_file",
          packagePath,
          taskPackage: null,
          error: "task package JSON has no task package body",
        };
      } catch (error) {
        return {
          source: "task_package_file",
          packagePath,
          taskPackage: null,
          error: error.message ?? String(error),
        };
      }
    }
    const inlinePackage = taskPackageFromPrompt(task.prompt_path);
    if (inlinePackage) {
      return { source: "prompt_json", packagePath: packagePath ?? null, taskPackage: inlinePackage, error: null };
    }
    return { source: "missing", packagePath: packagePath ?? null, taskPackage: null, error: null };
  }

  function taskPackageOutputs(task) {
    const loaded = loadTaskPackage(task);
    if (!loaded.taskPackage) {
      return {
        task_package_source: loaded.source,
        task_package_path: loaded.packagePath,
        declared_handoff_path: null,
        declared_report_path: null,
        business_handoff_path: null,
        business_report_path: null,
        handoff_check_required: false,
        error: loaded.error,
      };
    }

    const taskPackage = loaded.taskPackage;
    const expected = objectOrEmpty(taskPackage.expected_output);
    const handoff = objectOrEmpty(taskPackage.handoff_contract);
    const reportCandidates = [
      declaredOutputPath(task, taskPackage, expected.resolved_file_path),
      declaredOutputPath(task, taskPackage, expected.file_path),
    ].filter(Boolean);
    const handoffCandidates = [
      declaredOutputPath(task, taskPackage, handoff.resolved_handoff_file),
      declaredOutputPath(task, taskPackage, handoff.handoff_file),
    ].filter(Boolean);
    return {
      task_package_source: loaded.source,
      task_package_path: loaded.packagePath,
      declared_handoff_path: handoffCandidates[0] ?? null,
      declared_report_path: reportCandidates[0] ?? null,
      business_handoff_path: firstExistingPath(handoffCandidates),
      business_report_path: firstExistingPath(reportCandidates),
      handoff_check_required: handoff.require_final_handoff === true,
      error: loaded.error,
    };
  }

  function parseHandoffSummary(text) {
    const summary = {};
    for (const key of ["package_id", "verdict", "summary"]) {
      const match = text.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "im"));
      if (match) {
        summary[key] = match[1].replace(/^['"]|['"]$/g, "");
      }
    }
    return summary;
  }

  function parseHandoffMechanicalState(text) {
    if (!String(text || "").trim()) {
      return { state: "missing", value: null };
    }
    const match = String(text).match(/^\s*mechanical_check:\s*(.+?)\s*$/im);
    if (!match) {
      return { state: "missing", value: null };
    }
    const value = match[1].replace(/^['"]|['"]$/g, "").trim();
    if (!value) {
      return { state: "unknown", value: null };
    }
    return {
      state: value.toLowerCase() === "pass" ? "pass" : "fail",
      value,
    };
  }

  function artifactResult(artifactManifest) {
    if (
      artifactManifest.durable_reports?.length ||
      artifactManifest.durable_handoffs?.length
    ) {
      return "durable_present";
    }
    if (artifactManifest.salvage_evidence_paths?.length) {
      return "salvage_present";
    }
    if (artifactManifest.runtime_report || artifactManifest.runtime_handoff) {
      return "runtime_present";
    }
    if (artifactManifest.child_final || artifactManifest.child_result) {
      return "runtime_trace_only";
    }
    return "missing";
  }

  return {
    objectOrEmpty,
    declaredOutputPath,
    firstExistingPath,
    taskPackageFromData,
    taskPackageFromPrompt,
    taskPackagePathFor,
    loadTaskPackage,
    taskPackageOutputs,
    parseHandoffSummary,
    parseHandoffMechanicalState,
    artifactResult,
  };
}
