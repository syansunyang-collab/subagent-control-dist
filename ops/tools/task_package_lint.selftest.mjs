#!/usr/bin/env node
// task_package_lint --self-test 的机械用例集（ops/tools/task_package_lint_selftest.py 的移植），
// 经 node ops/tools/task_package_lint.mjs --self-test 调用。Python 侧无 checks 字典：
// 用例逐条断言，失败即抛 ToolError；本移植保持同一结构（selfTest() 成功时无返回值）。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT, ToolError } from "./dispatch-core/_tool_common.mjs";
import { buildPackage, sampleSeed } from "./dispatch-core/task_package_build.mjs";
import { lintPackage, routeProfiles } from "./dispatch-core/task_package_lint.mjs";

function withTempDir(prefix, body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

export function selfTest() {
  const seeds = Object.keys(routeProfiles()).sort().map((routeId) => sampleSeed(routeId));
  for (const seed of seeds) {
    const issues = lintPackage(buildPackage(seed));
    if (issues.length) throw new ToolError(`self-test lint unexpectedly failed: ${issues.join("; ")}`);
  }

  const rounds = sampleSeed("plan-checker__requirement-granularity-review");
  rounds.extensions.capability_contract.requirement_granularity_review = {
    review_mode: "all_surfaces", review_round: 9, surface_rounds: {},
  };
  if (lintPackage(buildPackage(rounds)).length) {
    throw new ToolError("self-test expected business rounds to reach the reviewer");
  }

  const badAgent = buildPackage(seeds[3]);
  badAgent.task_package.agent.required_files = [];
  if (!lintPackage(badAgent).length) throw new ToolError("self-test expected missing route required_files to fail");

  const badScope = buildPackage(seeds[2]);
  badScope.task_package.scope.read = ["../outside-repository.txt"];
  if (!lintPackage(badScope).length) throw new ToolError("self-test expected outside repository read path to fail");

  const fallbackPackage = buildPackage(sampleSeed("executor-agent__scoped-execution"));
  fallbackPackage.task_package.extensions.capability_contract = {
    executor: {
      scoped: {
        operation_type: "source_clone_only",
        no_install: true,
        network_allowed: false,
        no_runtime_execution: true,
        ref_resolution: { if_missing: "fallback_default_branch", fallback_ref: null },
      },
    },
  };
  let fallbackIssues = lintPackage(fallbackPackage);
  if (!fallbackIssues.some((issue) => issue.includes("fallback_ref must be a non-empty string"))) {
    throw new ToolError("self-test expected missing fallback_ref to fail");
  }
  fallbackPackage.task_package.extensions.capability_contract.executor.scoped.ref_resolution.fallback_ref = "main";
  if (lintPackage(fallbackPackage).some((issue) => issue.includes("fallback_ref"))) {
    throw new ToolError("self-test expected explicit fallback_ref to pass");
  }
  fallbackPackage.task_package.extensions.capability_contract.executor.scoped.ref_resolution.if_missing = "needs_owner";
  if (lintPackage(fallbackPackage).some((issue) => issue.includes("fallback_ref"))) {
    throw new ToolError("self-test expected inactive fallback_ref to be ignored");
  }

  withTempDir("task-package-target-repo-", (target) => {
    mkdirSync(path.join(target, "src"), { recursive: true });
    writeFileSync(path.join(target, "src", "app.py"), "print('ok')\n", "utf8");

    const externalScope = buildPackage(sampleSeed("explorer-agent__codebase-scan"));
    const externalPkg = externalScope.task_package;
    externalPkg.runtime_context.target_repo = target;
    externalPkg.scope.read = ["src/", target];
    externalPkg.scope.write = ["notes/explorer/external.md", "notes/handoffs/external.yaml"];
    externalPkg.scope.delete = ["tmp/delete-me.txt"];
    externalPkg.expected_output.file_path = "notes/explorer/external.md";
    externalPkg.expected_output.resolved_file_path = String(path.resolve(path.join(ROOT, "notes/explorer/external.md")));
    externalPkg.handoff_contract.handoff_file_required = true;
    externalPkg.handoff_contract.handoff_file = "notes/handoffs/external.yaml";
    externalPkg.handoff_contract.resolved_handoff_file = String(path.resolve(path.join(ROOT, "notes/handoffs/external.yaml")));
    let issues = lintPackage(externalScope);
    if (issues.length) throw new ToolError(`self-test expected target_repo scope to pass: ${issues.join("; ")}`);

    withTempDir("task-package-external-sdk-", (sdk) => {
      const file = path.join(sdk, "model-runtime.d.ts");
      writeFileSync(file, "export interface ModelRuntime {}\n", "utf8");
      const realFile = realpathSync.native(file);
      symlinkSync(sdk, path.join(target, "sdk"), process.platform === "win32" ? "junction" : "dir");
      const junctionScope = structuredClone(externalScope);
      junctionScope.task_package.scope.read = ["sdk/model-runtime.d.ts"];
      const rejected = lintPackage(junctionScope);
      if (!rejected.some((issue) => issue.includes("outside target_repo scope") &&
          issue.includes(JSON.stringify(realFile)) && issue.includes("scope.read") && issue.includes("retry preview"))) {
        throw new ToolError(`self-test expected relative junction read rejection with real path retry: ${rejected.join("; ")}`);
      }
      junctionScope.task_package.scope.read = [realFile];
      const accepted = lintPackage(junctionScope);
      if (accepted.length) throw new ToolError(`self-test expected real absolute external read to pass: ${accepted.join("; ")}`);
      for (const key of ["write", "delete"]) {
        const outside = structuredClone(junctionScope);
        outside.task_package.scope[key].push(realFile);
        const denied = lintPackage(outside);
        if (!denied.some((issue) => issue.includes("outside repository scope")) ||
            denied.some((issue) => issue.includes("retry preview"))) {
          throw new ToolError(`self-test expected external ${key} rejection without read retry: ${denied.join("; ")}`);
        }
      }
    });

    const externalWriteScope = buildPackage(sampleSeed("executor-agent__scoped-execution"));
    const externalWritePkg = externalWriteScope.task_package;
    externalWritePkg.runtime_context.target_repo = path.join(target, "new-target");
    externalWritePkg.runtime_context.target_repo_create_allowed = true;
    externalWritePkg.scope.write.push(path.join(target, "new-target", "PROJECT.md"));
    issues = lintPackage(externalWriteScope);
    if (issues.length) throw new ToolError(`self-test expected creatable target_repo write scope to pass: ${issues.join("; ")}`);

    const externalOutside = buildPackage(sampleSeed("explorer-agent__codebase-scan"));
    externalOutside.task_package.runtime_context.target_repo = target;
    externalOutside.task_package.scope.read = ["../outside-target-repo.txt"];
    if (!lintPackage(externalOutside).some((issue) => issue.includes("outside target_repo scope"))) {
      throw new ToolError("self-test expected outside target_repo read path to fail");
    }

    const externalDeleteOutside = buildPackage(sampleSeed("explorer-agent__codebase-scan"));
    externalDeleteOutside.task_package.runtime_context.target_repo = target;
    externalDeleteOutside.task_package.scope.delete = ["../outside-target-repo.txt"];
    if (!lintPackage(externalDeleteOutside).some((issue) => issue.includes("outside repository scope"))) {
      throw new ToolError("self-test expected outside repository delete path to fail");
    }

    const missingTarget = buildPackage(sampleSeed("explorer-agent__codebase-scan"));
    missingTarget.task_package.runtime_context.target_repo = path.join(target, "missing");
    if (!lintPackage(missingTarget).some((issue) => issue.includes("runtime_context.target_repo not found"))) {
      throw new ToolError("self-test expected missing target_repo to fail");
    }

    const externalExpected = buildPackage(sampleSeed("docs-agent__documentation-authoring"));
    externalExpected.task_package.runtime_context.target_repo = target;
    const targetDoc = path.join(target, "docs", "contract.md");
    externalExpected.task_package.scope.write.push(targetDoc);
    externalExpected.task_package.expected_output.file_path = targetDoc;
    externalExpected.task_package.expected_output.resolved_file_path = targetDoc;
    issues = lintPackage(externalExpected);
    if (issues.length) throw new ToolError(`self-test expected target_repo expected_output lint to pass: ${issues.join("; ")}`);
  });

  const badSections = buildPackage(seeds[2]);
  badSections.task_package.expected_output.mode = "message";
  if (!lintPackage(badSections).length) throw new ToolError("self-test expected invalid expected_output.mode to fail");

  const badVerdicts = buildPackage(seeds[2]);
  badVerdicts.task_package.handoff_contract.accept_verdicts = ["accept"];
  if (!lintPackage(badVerdicts).length) throw new ToolError("self-test expected invalid accept_verdicts to fail");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  selfTest();
  process.stdout.write("task_package_lint self-test: pass\n");
}
