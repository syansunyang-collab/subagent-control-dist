#!/usr/bin/env node
// review_evidence --self-test 的机械用例集（ops/tools/review_evidence_selftest.py 的移植），
// 经 node ops/tools/review_evidence.mjs --self-test 调用。Python 侧无 checks 字典：
// 用例逐条断言，失败即抛 ToolError；本移植保持同一结构（selfTest() 成功时无返回值）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import process from "node:process";

import { ROOT, ToolError } from "./dispatch-core/_tool_common.mjs";
import { PROFILE, SEMANTIC_INJECTION_TOKEN_LIMIT, SEMANTIC_PROFILE, buildEvidence, run, writeEvidenceFile } from "./dispatch-core/review_evidence.mjs";

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

export function selfTest() {
  const tmpParent = path.join(ROOT, "tmp");
  mkdirSync(tmpParent, { recursive: true });
  const repo = mkdtempSync(path.join(tmpParent, "review-evidence-self-test-"));
  try {
    run(["git", "init"], repo);
    run(["git", "config", "user.email", "self-test@example.invalid"], repo);
    run(["git", "config", "user.name", "self-test"], repo);
    writeFileSync(
      path.join(repo, "target.py"),
      "def target():\n    return 1\n\ndef recorder_lock():\n    return 'old'\n",
      "utf8",
    );
    run(["git", "add", "target.py"], repo);
    run(["git", "commit", "-m", "baseline"], repo);
    writeFileSync(
      path.join(repo, "target.py"),
      "def target():\n    return 2\n\ndef recorder_lock():\n    return 'new'\n",
      "utf8",
    );
    writeFileSync(path.join(repo, "unrelated.txt"), "must not leak", "utf8");

    const pkg = {
      package_id: "review-evidence-self-test",
      agent: { role: "verify-agent", capability: { name: "code-verification" } },
      goal: "verify target",
      scope: { read: ["target.py"], write: [], delete: [], out_of_scope: [] },
      runtime_context: { cwd: repo },
      tool_contract: { allowed: [] },
      extensions: {
        capability_contract: {
          verify: {
            verify_mode: "verification",
            review_goal: "target returns 2",
            affected_files: ["target.py"],
            changed_surfaces: ["target.py: target", "target.py: recorder_lock"],
            mechanical_checks: [
              { id: "prints-once", argv: [process.execPath, "-e", "console.log('once')"], cwd: "." },
              {
                id: "multiline-json",
                argv: [
                  process.execPath,
                  "-e",
                  "console.log(JSON.stringify({status:'ok',checks:{alpha:true,beta:true}}, null, 2))",
                ],
                cwd: ".",
              },
            ],
          },
        },
      },
    };

    const evidence = buildEvidence(pkg, { execute: true, root: repo, logRoot: path.join(repo, "logs") });
    const statusText = evidence.git.scoped_status.join("\n");
    if (!statusText.includes("target.py") || statusText.includes("unrelated.txt")) {
      throw new ToolError("self-test scoped git status leaked unrelated paths");
    }
    const jsonSummary = JSON.parse(evidence.mechanical_checks[1].output_tail);
    if (jsonSummary.status !== "ok" || !isDeepStrictEqual(jsonSummary.checks, { total: 2, failed: [] })) {
      throw new ToolError("self-test multiline JSON output summary lost structured observations");
    }
    if (evidence.profile !== PROFILE || !evidence.complete) {
      throw new ToolError("self-test expected evidence_only_v1 complete pack");
    }
    const excerpts = evidence.sources[0].excerpts ?? [];
    const excerptText = JSON.stringify(excerpts);
    if (!excerpts.length || !excerptText.includes("return 2") || !excerptText.includes("recorder_lock")) {
      throw new ToolError("self-test changed surface excerpt missing current implementation");
    }

    writeFileSync(path.join(repo, "rule-a.md"), "alpha\n", "utf8");
    writeFileSync(path.join(repo, "rule-b.md"), "beta\n", "utf8");
    const semanticPackage = {
      package_id: "semantic-review-self-test",
      agent: { role: "semantic-review-agent", capability: { name: "rule-quality-inspection" } },
      goal: "review rules",
      scope: { read: ["rule-a.md", "rule-b.md"], write: [], delete: [], out_of_scope: [] },
      runtime_context: { cwd: repo },
      extensions: { capability_contract: { rule_quality_inspection: { target_files: ["rule-a.md"] } } },
    };
    const semantic = buildEvidence(semanticPackage, { execute: true, root: repo, logRoot: path.join(repo, "semantic-logs") });
    if (semantic.profile !== SEMANTIC_PROFILE || semantic.material_mode !== "full") {
      throw new ToolError("self-test expected semantic full material mode");
    }
    if (!isDeepStrictEqual(new Set(semantic.sources.map((item) => item.path)), new Set(["rule-a.md", "rule-b.md"]))) {
      throw new ToolError("self-test semantic material omitted a scoped source");
    }
    if (!semantic.sources.every((item) => Object.hasOwn(item, "content"))) {
      throw new ToolError("self-test semantic full mode omitted source content");
    }

    writeFileSync(path.join(repo, "large.md"), "x".repeat(SEMANTIC_INJECTION_TOKEN_LIMIT * 3 + 1), "utf8");
    semanticPackage.scope.read = ["rule-a.md", "rule-b.md", "large.md"];
    const indexed = buildEvidence(semanticPackage, { execute: true, root: repo, logRoot: path.join(repo, "indexed-logs") });
    if (indexed.material_mode !== "index") {
      throw new ToolError("self-test semantic oversized material did not switch to complete index mode");
    }
    // 索引模式只送达声明目标正文：目标优先，非目标不预装。
    const indexedTarget = indexed.sources.find((item) => item.path === "rule-a.md");
    if (!indexedTarget || !Object.hasOwn(indexedTarget, "content")) {
      throw new ToolError("self-test semantic oversized index dropped the declared target body");
    }
    if (indexed.sources.some((item) => item.path !== "rule-a.md" && Object.hasOwn(item, "content"))) {
      throw new ToolError("self-test semantic oversized index preloaded non-target content");
    }

  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
