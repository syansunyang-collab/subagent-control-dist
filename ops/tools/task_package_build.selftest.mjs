#!/usr/bin/env node
// task_package_build --self-test 的机械用例集（ops/tools/task_package_build_selftest.py 的移植），
// 经 node ops/tools/task_package_build.mjs --self-test 调用。Python 侧无 checks 字典：
// 用例逐条断言，失败即抛 ToolError；本移植保持同一结构（selfTest() 成功时无返回值）。
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ToolError } from "./dispatch-core/_tool_common.mjs";
import {
  ROOT,
  buildAndWriteOutput,
  buildPackage,
  normRepoPath,
  routeProfiles,
  sampleSeed,
} from "./dispatch-core/task_package_build.mjs";

function withTempDir(prefix, body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** try { fn() } except ToolError: pass / else: raise ToolError(failMessage) */
function expectToolError(fn, failMessage) {
  try {
    fn();
  } catch (error) {
    if (error?.name === "ToolError") return;
    throw error;
  }
  throw new ToolError(failMessage);
}

/**
 * try { fn() } except ToolError as exc: if substring not in str(exc): raise
 * else: raise ToolError(failMessage)
 */
function expectToolErrorContains(fn, substring, failMessage) {
  try {
    fn();
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    if (!String(error.message).includes(substring)) throw error;
    return;
  }
  throw new ToolError(failMessage);
}

/** try { body() } except ToolError as exc: raise ToolError(`${prefix}: ${exc}`) */
function expectPasses(body, prefix) {
  try {
    body();
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    throw new ToolError(`${prefix}: ${error.message}`);
  }
}

export function selfTest() {
  const seeds = Object.keys(routeProfiles()).sort().map((routeId) => sampleSeed(routeId));
  for (const seed of seeds) {
    const pkg = buildPackage(seed);
    const taskPackage = pkg.task_package;
    if (!Object.hasOwn(pkg, "task_package")) throw new ToolError("self-test package missing root");
    if (!taskPackage.agent.required_files.includes("ops/agent-prompts/_common.md")) {
      throw new ToolError("self-test package missing common prompt");
    }
    const resolvedFilePath = String(taskPackage.expected_output?.resolved_file_path ?? "");
    if (!resolvedFilePath.startsWith(String(ROOT))) {
      throw new ToolError("self-test package missing repository-root resolved_file_path");
    }
    if (taskPackage.runtime_context?.output_root !== String(ROOT)) {
      throw new ToolError("self-test package missing runtime_context.output_root");
    }
  }

  const legacy = sampleSeed("verify-agent__code-verification");
  legacy.expected_output.path = legacy.expected_output.file_path;
  delete legacy.expected_output.file_path;
  legacy.handoff_contract.final_response_required = true;
  legacy.tool_contract.network_allowed = true;
  const normalized = buildPackage(legacy).task_package;
  if (normalized.expected_output.file_path !== legacy.expected_output.path ||
      normalized.runtime_context.network_needed !== "yes" ||
      normalized.handoff_contract.require_final_handoff !== true) {
    throw new ToolError("self-test alias/network normalization failed");
  }

  const outputRel = "notes/manifests/task-package-build-self-test-temp.json";
  const outputPath = path.join(ROOT, outputRel);
  if (existsSync(outputPath)) throw new ToolError(`self-test output path already exists: ${outputRel}`);
  try {
    const outputPackage = buildAndWriteOutput(sampleSeed("verify-agent__code-verification"), outputRel);
    const stored = JSON.parse(readFileSync(outputPath, "utf8"));
    if (stored.task_package.package_id !== outputPackage.task_package.package_id) {
      throw new ToolError("--output self-test stored package id mismatch");
    }
  } finally {
    if (existsSync(outputPath)) unlinkSync(outputPath);
  }

  expectToolError(() => {
    const bad = sampleSeed("verify-agent__prompt-bloat-inspection");
    delete bad.scope;
    buildPackage(bad);
  }, "self-test expected missing scope to fail");

  expectPasses(() => {
    const seed = sampleSeed("verify-agent__code-verification");
    seed.runtime_context = { network_needed: "no" };
    buildPackage(seed);
  }, "self-test expected omitted fixed consent to pass");

  expectToolError(() => {
    const bad = sampleSeed("explorer-agent__codebase-scan");
    bad.expected_output = { ...bad.expected_output, mode: "message", file_path: null };
    buildPackage(bad);
  }, "self-test expected invalid output mode to fail");

  const parentFields = sampleSeed("verify-agent__code-verification");
  parentFields.handoff_contract.parent_consume_action = "accept";
  parentFields.ownership.unlock_conditions = ["accepted"];
  const projected = buildPackage(parentFields).task_package;
  if (Object.hasOwn(projected.handoff_contract, "parent_consume_action") || Object.hasOwn(projected.ownership, "unlock_conditions")) {
    throw new ToolError("self-test expected parent lifecycle fields to be stripped");
  }

  expectToolError(() => {
    const bad = sampleSeed("verify-agent__code-verification");
    bad.scope = { ...bad.scope, read: ["../outside-repository.txt"] };
    const built = buildPackage(bad);
    normRepoPath(built.task_package.scope.read[0]);
  }, "self-test expected outside-repository path normalization to fail");

  expectToolErrorContains(
    () => {
      const bad = sampleSeed("explorer-agent__codebase-scan");
      const outsideOutput = String(path.join(path.dirname(ROOT), "outside-output.md"));
      bad.scope = { ...bad.scope, write: [outsideOutput] };
      bad.expected_output = { ...bad.expected_output, file_path: outsideOutput };
      buildPackage(bad);
    },
    "must resolve under repository root or runtime_context.target_repo",
    "self-test expected outside repository write path to fail",
  );

  expectPasses(() => {
    withTempDir("task-package-build-target-output-", (dir) => {
      const target = path.resolve(dir);
      const good = sampleSeed("docs-agent__documentation-authoring");
      good.runtime_context = { ...good.runtime_context, target_repo: target };
      const targetDoc = path.join(target, "docs", "contract.md");
      good.scope = { ...good.scope, write: [...good.scope.write, targetDoc] };
      good.expected_output = { ...good.expected_output, file_path: targetDoc };
      const pkg = buildPackage(good).task_package;
      if (path.resolve(pkg.expected_output.resolved_file_path) !== path.resolve(targetDoc)) {
        throw new ToolError("self-test target_repo expected_output resolved path mismatch");
      }
    });
  }, "self-test expected target_repo expected_output to pass");

  expectPasses(() => {
    withTempDir("task-package-build-target-", (dir) => {
      const target = path.resolve(dir);
      const good = sampleSeed("executor-agent__scoped-execution");
      good.runtime_context = { ...good.runtime_context, target_repo: target };
      good.scope = { ...good.scope, write: [...good.scope.write, path.join(target, "PROJECT.md")] };
      buildPackage(good);
    });
  }, "self-test expected target_repo scope.write to pass");

  expectPasses(() => {
    const seed = sampleSeed("explorer-agent__codebase-scan");
    seed.runtime_context = { ...seed.runtime_context, output_root: String(path.dirname(ROOT)) };
    const body = buildPackage(seed).task_package;
    if (body.runtime_context.output_root !== String(ROOT)) throw new ToolError("compiler output_root mismatch");
  }, "self-test expected output_root to be derived");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  selfTest();
  process.stdout.write("task_package_build self-test: pass\n");
}
