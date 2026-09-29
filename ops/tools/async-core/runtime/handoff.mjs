import { existsSync } from "node:fs";
import path from "node:path";

export function createHandoff(ctx, rt) {
  const taskPackagePathFor = (...args) => rt.taskPackagePathFor(...args);
  const taskPackageOutputs = (...args) => rt.taskPackageOutputs(...args);

  // checker 定位、命令行与根环境三处共用一份实现：prompt 自检说明、runner 下发给 submit_task_result 的规格、终态复验。
  function resolveCheckerPath(roots) {
    const checkerPolicy = ctx.config.handoffCheckerPolicy;
    const bases = { ...roots, cwd: ctx.config.cwd };
    const candidates = (Array.isArray(checkerPolicy.candidates) ? checkerPolicy.candidates : [])
      .map((candidate) => {
        if (typeof candidate === "string") return path.resolve(ctx.config.cwd, candidate);
        if (!candidate || typeof candidate !== "object") return null;
        if (candidate.absolutePath) return path.resolve(String(candidate.absolutePath));
        const base = bases[candidate.base] || ctx.config.cwd;
        return candidate.relativePath ? path.resolve(base, String(candidate.relativePath)) : null;
      })
      .filter(Boolean);
    return { path: candidates.find((candidate) => existsSync(candidate)) || null, candidates };
  }

  function checkerCommandArgv(checkerPath, packagePath, handoffPath, format) {
    const checkerPolicy = ctx.config.handoffCheckerPolicy;
    return [
      checkerPolicy.command,
      ...(Array.isArray(checkerPolicy.commandArgsPrefix) ? checkerPolicy.commandArgsPrefix : []),
      checkerPath,
      "--task-package",
      packagePath,
      "--handoff-file",
      handoffPath,
      "--format",
      format,
    ].map((value) => String(value));
  }

  function checkerRootEnvironment(task, packagePath) {
    const rootEnvironmentKey = String(ctx.config.handoffCheckerPolicy.rootEnvironmentKey || "").trim();
    if (!rootEnvironmentKey) return {};
    const containsPath = (root, candidate) => {
      const relative = path.relative(path.resolve(root), path.resolve(candidate));
      return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    };
    const producerRoot = path.resolve(task.producer_root || ctx.config.cwd);
    const checkerRoot = !containsPath(producerRoot, packagePath) && containsPath(ctx.config.cwd, packagePath)
      ? ctx.config.cwd
      : producerRoot;
    return {
      [rootEnvironmentKey]: path.resolve(checkerRoot),
      SUBAGENT_PROJECT_ROOT: path.resolve(checkerRoot),
    };
  }

  // 下发给 child runner 的 handoff 自检规格：submit_task_result 提交后当场复验用的就是终态同一条命令。
  function handoffCheckSpec(task) {
    const outputs = taskPackageOutputs(task);
    const packagePath = outputs.task_package_path;
    if (!packagePath || !existsSync(packagePath) || !outputs.declared_handoff_path) return null;
    const checkerPath = resolveCheckerPath({ producer_root: task.producer_root, target_cwd: task.target_cwd }).path;
    if (!checkerPath) return null;
    return {
      argv: checkerCommandArgv(checkerPath, packagePath, outputs.declared_handoff_path, "json"),
      cwd: task.target_cwd || ctx.config.cwd,
      env: checkerRootEnvironment(task, packagePath),
    };
  }

  function handoffCheckResult(task, handoffPath, requested) {
    if (!requested) {
      return { checked: false, status: "not_requested", issues: [] };
    }
    const packagePath = taskPackagePathFor(task);
    if (!packagePath || !existsSync(packagePath)) {
      return { checked: false, status: "unavailable", issues: ["task_package_missing"] };
    }
    if (!handoffPath || !existsSync(handoffPath)) {
      return { checked: false, status: "unavailable", issues: ["handoff_missing"] };
    }
    const resolved = resolveCheckerPath({ producer_root: task.producer_root, target_cwd: task.target_cwd });
    const checkerPath = resolved.path;
    if (!checkerPath) {
      return {
        checked: false,
        status: "unavailable",
        issues: ["handoff_checker_missing"],
        checker_candidates: resolved.candidates,
      };
    }
    const checkerEnv = { ...ctx.config.childEnv, ...checkerRootEnvironment(task, packagePath) };
    const argv = checkerCommandArgv(checkerPath, packagePath, handoffPath, "json");
    const result = ctx.host.spawnSync(
      argv[0],
      argv.slice(1),
      { cwd: task.target_cwd || ctx.config.cwd, encoding: "utf8", windowsHide: true, env: checkerEnv },
    );
    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();
    if (!stdout) {
      return {
        checked: true,
        status: "error",
        exit_code: result.status,
        issues: ["handoff_check_no_output"],
        checker_path: checkerPath,
        stderr,
      };
    }
    try {
      const parsed = stdout ? JSON.parse(stdout) : {};
      return {
        checked: true,
        status: parsed.status || (result.status === 0 ? "pass" : "fail"),
        exit_code: result.status,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        mechanical_check: parsed.mechanical_check ?? null,
        handoff_fields_ok: parsed.handoff_fields_ok ?? null,
        business_gate_ok: parsed.business_gate_ok ?? null,
        expected_output_present: parsed.expected_output_present ?? null,
        required_sections_ok: parsed.required_sections_ok ?? null,
        references_exist: parsed.references_exist ?? null,
        checker_path: checkerPath,
        stderr,
      };
    } catch (error) {
      return {
        checked: true,
        status: "error",
        exit_code: result.status,
        issues: ["handoff_check_output_parse_failed"],
        error: error.message ?? String(error),
        checker_path: checkerPath,
        stderr,
      };
    }
  }

  function enforceTerminalHandoffContract(task, files, outcome) {
    const outputs = taskPackageOutputs(task);
    if (outcome.state !== "done" || outputs.handoff_check_required !== true) {
      return { outcome, check: { checked: false, status: "not_required", issues: [] } };
    }
    const handoffPath = outputs.business_handoff_path || (existsSync(files.handoff) ? files.handoff : null);
    const check = handoffCheckResult(task, handoffPath, true);
    if (check.status === "pass") return { outcome, check };
    return {
      outcome: {
        ...outcome,
        contract_state: "invalid_handoff",
        requires_parent_review: true,
        failure_type: "handoff_check_failed",
      },
      check,
    };
  }

  return {
    resolveCheckerPath,
    checkerCommandArgv,
    checkerRootEnvironment,
    handoffCheckSpec,
    handoffCheckResult,
    enforceTerminalHandoffContract,
  };
}
