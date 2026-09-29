import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readJson } from "../../_fs-utils.mjs";
import {
  ARTIFACT_ATTESTATION_VERSION,
  CROSS_REPO_ATTESTATION_VERSION,
  FINAL_OUTPUT_HEADINGS,
  normalizeBusinessWord,
} from ".././contracts.mjs";

export function createArtifacts(ctx, rt) {
  const writeJson = (...args) => rt.writeJson(...args);
  const isoNow = (...args) => rt.isoNow(...args);
  const normalizeWriteDomainPath = (...args) => rt.normalizeWriteDomainPath(...args);
  const objectOrEmpty = (...args) => rt.objectOrEmpty(...args);
  const taskPackageOutputs = (...args) => rt.taskPackageOutputs(...args);

  // runtime task_dir 缺 report.md / handoff.md，但 durable 产物已按 task package 约定路径存在时，
  // 合成一份指向 durable 路径的 runtime 指针文件，而不是把已完成任务标记为 failed。
  function synthesizeArtifactPointer(runtimePath, durablePath, kind) {
    if (existsSync(runtimePath)) {
      return false;
    }
    const label = kind === "handoff" ? "verdict: done" : `# ${kind} pointer`;
    const body =
      kind === "handoff"
        ? [
            label,
            "summary: durable artifact written outside runtime task_dir; see durable_path below.",
            "files_read_or_changed:",
            `  - ${durablePath}`,
            "evidence_paths:",
            `  - ${durablePath}`,
            "blockers:",
            "  - none",
            `durable_path: ${durablePath}`,
            "",
          ].join("\n")
        : [
            label,
            "",
            "contract_state: artifact_path_mismatch",
            `durable_path: ${durablePath}`,
            "",
            "This runtime file is a pointer only. The actual business report was written to the durable path above.",
            "",
          ].join("\n");
    writeFileSync(runtimePath, body, "utf8");
    return true;
  }

  function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function sectionLines(text, heading) {
    const pattern = new RegExp(`(^|\\r?\\n)${escapeRegex(heading)}\\s*\\r?\\n(?<content>[\\s\\S]*?)(?=\\r?\\n##\\s|$)`, "m");
    const match = String(text || "").match(pattern);
    return (match?.groups?.content ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function finalTextOutputContractOk(text) {
    const body = String(text || "");
    const lines = body.split(/\r?\n/);
    const firstNonEmptyLine = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
    const missing = FINAL_OUTPUT_HEADINGS.filter((heading) => !body.includes(heading));
    const conclusionFirstLine = sectionLines(body, "## 结论")[0]?.trim() ?? "";
    const conclusionStatusOk = /^任务状态\s*[:：]\s*(completed|partial|blocked|failed)\s*$/i.test(
      conclusionFirstLine,
    );
    const headingPositions = FINAL_OUTPUT_HEADINGS.map((heading) => ({
      heading,
      index: body.indexOf(heading),
    }));
    const headingsInOrder = headingPositions
      .filter((entry) => entry.index >= 0)
      .every((entry, index, entries) => index === 0 || entry.index > entries[index - 1].index);
    const duplicateHeadings = FINAL_OUTPUT_HEADINGS.filter((heading) => {
      const matches = body.match(new RegExp(escapeRegex(heading), "g")) ?? [];
      return matches.length > 1;
    });
    return (
      missing.length === 0 &&
      firstNonEmptyLine === "## 结论" &&
      conclusionStatusOk &&
      headingsInOrder &&
      duplicateHeadings.length === 0
    );
  }

  function synthesizeArtifactsFromChildFinal(files, finalPath, finalText, task) {
    if (!existsSync(finalPath) || !finalTextOutputContractOk(finalText)) {
      return [];
    }
    const written = [];
    if (!existsSync(files.report)) {
      const body = [
        "# child-final report",
        "",
        "contract_state: child_final_synthesized",
        `child_final_path: ${finalPath}`,
        "",
        "The child turn produced a complete final message but could not write runtime report.md itself.",
        "The async wrapper synthesized this report from child-final.md so read-only observation tasks remain collectable.",
        "",
        finalText.trim(),
        "",
      ].join("\n");
      writeFileSync(files.report, body, "utf8");
      written.push("report");
    }
    if (!existsSync(files.handoff)) {
      const taskId = task.task_id || path.basename(task.task_dir || path.dirname(files.handoff));
      const statusLine = sectionLines(finalText, "## 结论")[0]?.trim() ?? "任务状态：partial";
      const verdict = statusLine.match(/^任务状态\s*[:：]\s*(completed|partial|blocked|failed)\s*$/i)?.[1] ?? "partial";
      const body = [
        `verdict: ${verdict === "completed" ? "done" : verdict}`,
        "summary: child-final.md contains the complete child response; runtime handoff synthesized by async wrapper.",
        "files_read_or_changed:",
        `  - ${finalPath}`,
        "evidence_paths:",
        `  - ${finalPath}`,
        "blockers:",
        "  - parent review required because report/handoff were synthesized outside the child turn",
        `task_id: ${taskId}`,
        `child_final_path: ${finalPath}`,
        "",
      ].join("\n");
      writeFileSync(files.handoff, body, "utf8");
      written.push("handoff");
    }
    return written;
  }

  // 契约状态：运输层与产物路径是否满足预期。artifact_path_mismatch 时 runtime 报告缺失，
  // 但 task package 声明的 durable 产物已存在，属于路径契约漂移而非任务失败。
  function classifyContractState(rawDone, missingOutputs, businessOutputs) {
    if (!rawDone) {
      return "invalid_final";
    }
    if (!missingOutputs.length) {
      return "ok";
    }
    const missingReport = missingOutputs.includes("report");
    const missingHandoff = missingOutputs.includes("handoff");
    const durableReportOk = !missingReport || Boolean(businessOutputs.business_report_path);
    const durableHandoffOk = !missingHandoff || Boolean(businessOutputs.business_handoff_path);
    if (durableReportOk && durableHandoffOk) {
      return "artifact_path_mismatch";
    }
    return "missing_required_output";
  }

  // 业务状态：child 内部 task 分析结果（analyzeTaskResult 产出），与运输/契约状态正交。
  // 返回 { state, raw }：state 为规范词，raw 为归一发生时的原词（未归一则 null）。
  function classifyBusinessState(childResult) {
    const task = objectOrEmpty(childResult?.task);
    const rawWord =
      typeof task.status === "string" && task.status.trim() ? task.status.trim() : null;
    // run-child 归一 任务状态 行时把原词记在 agentDeclaredStatusRaw；task.status 已规范时用它回填原词。
    const agentRaw =
      typeof task.agentDeclaredStatusRaw === "string" && task.agentDeclaredStatusRaw.trim()
        ? task.agentDeclaredStatusRaw.trim()
        : null;
    const withRaw = (state) => {
      if (rawWord && rawWord.toLowerCase() !== state) {
        return { state, raw: rawWord };
      }
      if (agentRaw && agentRaw.toLowerCase() !== state) {
        return { state, raw: agentRaw };
      }
      return { state, raw: null };
    };
    if (task.failure_type === "task_partial" || task.status === "partial") {
      return withRaw("partial");
    }
    if (task.status === "blocked" || task.failure_type === "task_blocked" || task.failure_type === "blocked_by_policy") {
      return withRaw("blocked");
    }
    if (typeof task.status === "string" && task.status.startsWith("completed_with")) {
      return withRaw(task.status === "completed_with_recorded_failures" ? "completed" : "completed_with_uncertainty");
    }
    if (task.status === "completed") {
      return withRaw("completed");
    }
    const normalized = normalizeBusinessWord(task.status);
    if (normalized) {
      return withRaw(normalized);
    }
    if (task.status) {
      return withRaw("failed");
    }
    return { state: "unknown", raw: null };
  }

  // A3 salvage 指针化：非 ok 终态不合成聚合报告，只列 task_dir 内实际存在的诊断原件路径，
  // 主代理直接读原件排障。salvage 证据不改变 business_state 判定。
  function collectSalvageEvidencePaths(files) {
    const candidates = [
      path.join(files.dir, "child-final.md"),
      files.childResult,
      files.childLive,
      files.childEvents,
      files.report,
      files.handoff,
    ];
    return candidates.filter((candidate) => candidate && existsSync(candidate));
  }

  function resultAttestationScope(task) {
    const targetIsCrossRepo = (
      normalizeWriteDomainPath(task.producer_root, task.producer_root)
      !== normalizeWriteDomainPath(task.target_cwd, task.target_cwd)
    );
    if (targetIsCrossRepo && task.result_mode === "real_rerun") return "cross_repo";
    if (!targetIsCrossRepo && !task.result_mode) return "same_repo";
    if (["simulated_planning", "read_only_audit"].includes(task.result_mode)) return "artifact";
    return null;
  }

  function resultAttestationRequired(task) {
    return resultAttestationScope(task) !== null;
  }

  function writeResultAttestation(files, task, outcome) {
    const scope = resultAttestationScope(task);
    if (!scope) return null;
    const childResult = outcome.child_result && typeof outcome.child_result === "object"
      ? outcome.child_result
      : {};
    const childLive = readJson(files.childLive, {});
    const toolCounts = Array.isArray(childLive.tool_call_counts) ? childLive.tool_call_counts : [];
    const toolCallCount = toolCounts.reduce((sum, item) => sum + (Number(item?.count) || 0), 0);
    const toolNames = toolCounts
      .filter((item) => (Number(item?.count) || 0) > 0)
      .map((item) => String(item?.key || ""))
      .filter(Boolean);
    const turnStarted = Boolean(childResult?.turn?.id && childResult?.turn?.startAck === true);
    // runner 不再按回执给回合打 status:turn.completed 是运输事实(回合按 pi 状态自然结束);
    // 旧 runner 的 turn.status 兼容保留。
    const turnStatus = String(childResult?.turn?.status || "");
    const turnCompleted = childResult?.turn?.completed === true || ["completed", "done"].includes(turnStatus.toLowerCase());
    const missing = [];
    if (!turnStarted) missing.push("turn_start_ack");
    if (!turnCompleted) missing.push("turn_completed");
    if (scope === "cross_repo" && toolCallCount < 1) missing.push("tool_call");
    const businessOutputs = taskPackageOutputs(task);
    if (scope !== "cross_repo") {
      if (!existsSync(files.report)) missing.push("runtime_report");
      if (!existsSync(files.handoff)) missing.push("runtime_handoff");
      if (businessOutputs.business_report_path && !existsSync(businessOutputs.business_report_path)) {
        missing.push("business_report");
      }
      if (businessOutputs.business_handoff_path && !existsSync(businessOutputs.business_handoff_path)) {
        missing.push("business_handoff");
      }
    }
    const artifactFiles = [...new Set([
      files.childResult,
      files.childEvents,
      files.report,
      files.handoff,
      businessOutputs.business_report_path,
      businessOutputs.business_handoff_path,
    ].filter((file) => file && existsSync(file)))];
    const verified = missing.length === 0;
    const attestation = {
      contract_version: scope === "cross_repo"
        ? CROSS_REPO_ATTESTATION_VERSION
        : ARTIFACT_ATTESTATION_VERSION,
      scope,
      task_id: task.task_id,
      producer_root: task.producer_root,
      target_cwd: task.target_cwd,
      result_mode: task.result_mode || "same_repo",
      spawned_cwd: task.target_cwd,
      turn: {
        id: childResult?.turn?.id ?? null,
        start_ack: childResult?.turn?.startAck === true,
        status: turnStatus || null,
      },
      tool_call_count: toolCallCount,
      tool_names: toolNames,
      verified,
      missing,
      summary: verified
        ? scope === "cross_repo"
          ? "wrapper recorded cross_repo artifact paths from a completed target-cwd turn with at least one tool call"
          : scope === "same_repo"
            ? "wrapper recorded same_repo artifact paths from a completed target-cwd turn"
            : `wrapper recorded ${task.result_mode} artifact paths from a completed target-cwd turn`
        : `wrapper could not attest: ${missing.join(", ")}`,
      artifacts: artifactFiles.map((file) => ({ path: file })),
      generated_at: isoNow(),
    };
    writeJson(files.attestation, attestation);
    return attestation;
  }

  return {
    synthesizeArtifactPointer,
    escapeRegex,
    sectionLines,
    finalTextOutputContractOk,
    synthesizeArtifactsFromChildFinal,
    classifyContractState,
    classifyBusinessState,
    collectSalvageEvidencePaths,
    resultAttestationScope,
    resultAttestationRequired,
    writeResultAttestation,
  };
}
