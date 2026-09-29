import { renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureDir, pick } from "../../_fs-utils.mjs";
import { CONTRACT_VERSION, TOKEN_BUDGETS } from ".././contracts.mjs";

export function createUtilities(ctx, rt) {
  const statusTask = (...args) => rt.statusTask(...args);
  const loadLocatedTask = (...args) => rt.loadLocatedTask(...args);

  function resolveSubmitBudget(input = {}) {
    const direct = input.budget && typeof input.budget === "object" ? input.budget : {};
    const elapsed =
      pickNumber(input, ["budget-max-elapsed-minutes", "budget_max_elapsed_minutes", "budgetMaxElapsedMinutes"], null) ??
      Number(direct.max_elapsed_minutes);
    const budget = {};
    if (Number.isFinite(elapsed) && elapsed > 0) {
      budget.max_elapsed_minutes = elapsed;
    }
    return budget;
  }

  function pickBool(input, keys, fallback = false) {
    for (const key of keys) {
      if (input[key] === undefined || input[key] === null) {
        continue;
      }
      const value = String(input[key]).toLowerCase();
      return value === "1" || value === "true" || value === "yes" || value === "on";
    }
    return fallback;
  }

  function pickNumber(input, keys, fallback = null) {
    const raw = pick(input, keys, "");
    if (!raw) {
      return fallback;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  function sleepSync(ms) {
    ctx.host.sleepSync(ms);
  }

  function renameWithRetry(tmp, file) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        renameSync(tmp, file);
        return;
      } catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt === 7) {
          throw error;
        }
        sleepSync(25 * (attempt + 1));
      }
    }
  }

  function writeJson(file, data) {
    ensureDir(path.dirname(file));
    const tmp = `${file}.${ctx.host.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameWithRetry(tmp, file);
  }

  function isoNow() {
    return ctx.host.nowIso();
  }

  function isInside(base, candidate) {
    const relative = path.relative(path.resolve(base), path.resolve(candidate));
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }

  function truncateText(value, max = 240) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
  }

  function truncateUtf8Text(value, maxBytes = 120) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    const limit = Math.max(Number(maxBytes) || 0, 0);
    if (Buffer.byteLength(text, "utf8") <= limit) return text;
    if (limit < Buffer.byteLength("…", "utf8")) return "";
    const contentBudget = limit - Buffer.byteLength("…", "utf8");
    let used = 0;
    let compact = "";
    for (const character of text) {
      const size = Buffer.byteLength(character, "utf8");
      if (used + size > contentBudget) break;
      compact += character;
      used += size;
    }
    return `${compact}…`;
  }

  function estimateTokens(value) {
    return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3);
  }

  // Submit already catches overflow and returns its committed minimal receipt.
  function assertTokenBudget(label, value, maxTokens) {
    const estimated = estimateTokens(value);
    if (estimated > maxTokens) {
      throw new Error(`${label} response exceeds ${maxTokens} token budget (estimated ${estimated})`);
    }
    return value;
  }

  // locator 沿用调用方已定位的 task_root / registry_root，不退回默认注册表重新查找。
  function boundedDisplay(label, value, maxTokens, locator = {}) {
    if (estimateTokens(value) <= maxTokens) return value;
    const receipt = { ...value };
    const omitted = ["token_budget"];
    const taskId = value.task_id || value.task?.task_id || value.tasks?.[0]?.task_id;
    try {
      const { files } = loadLocatedTask(locator, taskId);
      receipt.status_path = files.status;
      const fullPath = path.join(path.dirname(files.status), `display-${label.replace(/[^a-z0-9_-]/gi, "_")}.json`);
      writeJson(fullPath, value);
      receipt.full_evidence_path = fullPath;
    } catch (error) {
      receipt.diagnostics = [...(receipt.diagnostics || []),
        { step: "display_evidence", error: truncateUtf8Text(error?.message ?? error, 240) }];
    }
    const shrink = (item) => {
      const compact = { ...item };
      for (const key of ["next_step", "failure_summary", "error", "display_title"]) {
        if (typeof compact[key] === "string") {
          compact[key] = truncateUtf8Text(compact[key], 120);
          omitted.push(key);
        }
      }
      for (const key of ["stall", "artifacts", "provenance", "last_tool_call", "request", "progress"]) {
        if (compact[key] !== undefined) { delete compact[key]; omitted.push(key); }
      }
      return compact;
    };
    const compact = shrink(receipt);
    if (compact.task) compact.task = shrink(compact.task);
    if (compact.tasks) compact.tasks = compact.tasks.map(shrink);
    // Identity, control outcomes and real evidence paths win over a display-only budget.
    return markDisplayTruncated(compact, omitted);
  }

  function markDisplayTruncated(receipt, omitted) {
    const unique = [...new Set(omitted)];
    return unique.length === 0 ? receipt : { ...receipt, display_truncated: unique };
  }

  // 回执预算优先去掉完整副本中可查的重复路径与机械细节，保留业务摘要。
  // 完整副本不可读时仍保留真实产物路径；证明结论与身份不因展示预算被丢弃。
  function boundedResultReceipt(value, maxTokens = TOKEN_BUDGETS.result) {
    if (estimateTokens(value) <= maxTokens) return value;
    const originalSummary = typeof value?.handoff_summary?.summary === "string" ? value.handoff_summary.summary : "";
    const receipt = { ...value,
      handoff_summary: value.handoff_summary ? { ...value.handoff_summary } : null,
      mechanical_summary: value.mechanical_summary ? { ...value.mechanical_summary } : null,
      artifacts: value.artifacts ? { ...value.artifacts } : null,
      session: value.session ? { ...value.session } : null,
      attestation: value.attestation ? { ...value.attestation } : null,
    };
    const omitted = [];
    const withinBudget = (candidate) => estimateTokens(markDisplayTruncated(candidate, omitted)) <= maxTokens;
    const fullPath = receipt.artifacts?.full_result_path;
    if (fullPath && statSync(fullPath, { throwIfNoEntry: false })?.isFile()) {
      receipt.artifacts = { full_result_path: fullPath };
      omitted.push("artifacts.in_full_result");
    }
    // These display-only fields are recoverable from the full receipt (when present)
    // or derivable from retained outcome facts. They should not displace the handoff conclusion.
    if (receipt.mechanical_summary?.write_domain_covered_tools?.length) {
      receipt.mechanical_summary.write_domain_covered_tools = [];
      omitted.push("mechanical_summary.write_domain_covered_tools");
    }
    if (receipt.task_outcome?.summary) {
      receipt.task_outcome = { ...receipt.task_outcome, summary: "" };
      omitted.push("task_outcome.summary");
    }
    if (withinBudget(receipt)) return markDisplayTruncated(receipt, omitted);
    // 裁完后若仍有余量，把原摘要前缀放回短回执。预算上限不变，消费者不用再翻完整副本才看见失败原因。
    const finish = (candidate) => {
      const marked = markDisplayTruncated(candidate, omitted);
      if (!originalSummary || !marked.handoff_summary || marked.handoff_summary.summary === originalSummary) return marked;
      let budget = Math.max(0, (maxTokens - estimateTokens(marked)) * 3 - 6);
      while (budget > 0) {
        const restored = truncateUtf8Text(originalSummary, budget);
        if (!restored) break;
        const trial = { ...marked, handoff_summary: { ...marked.handoff_summary, summary: restored } };
        if (estimateTokens(trial) <= maxTokens) {
          if (!omitted.includes("handoff_summary.summary")) omitted.push("handoff_summary.summary");
          return markDisplayTruncated(trial, omitted);
        }
        budget = Math.floor(budget * 0.7);
      }
      return marked;
    };
    // 第一层：只裁可选文字，并登记被裁字段（短回执要能看出自己是被缩减过的）。
    for (const [name, owner, key] of [
      ["attestation.summary", receipt.attestation, "summary"],
      ["display_title", receipt, "display_title"],
    ]) {
      const excess = estimateTokens(markDisplayTruncated(receipt, omitted)) - maxTokens;
      if (excess <= 0) break;
      if (typeof owner?.[key] !== "string") continue;
      owner[key] = truncateUtf8Text(owner[key], Math.max(0, Buffer.byteLength(owner[key], "utf8") - excess * 3 - 3));
      omitted.push(name);
    }
    const droppable = [
      ["display_title", () => { receipt.display_title = null; }],
      ["attestation.summary", () => { if (receipt.attestation) receipt.attestation.summary = ""; }],
      ["task_outcome", () => { delete receipt.task_outcome; }],
      ["mechanical_summary.write_domain_covered_tools", () => { if (receipt.mechanical_summary) receipt.mechanical_summary.write_domain_covered_tools = []; }],
      ["mechanical_summary.handoff_check", () => { if (receipt.mechanical_summary) receipt.mechanical_summary.handoff_check = null; }],
      ["session.file", () => { if (receipt.session) receipt.session.file = null; }],
      ["batch_id", () => { receipt.batch_id = null; }],
      ["slice_id", () => { receipt.slice_id = null; }],
      ["handoff_summary.summary", () => { if (receipt.handoff_summary) receipt.handoff_summary.summary = ""; }],
    ];
    for (const [name, drop] of droppable) {
      if (withinBudget(receipt)) return finish(receipt);
      drop();
      omitted.push(name);
    }
    if (withinBudget(receipt)) return finish(receipt);
    // 最小集合：身份、终态、产物定位和证明结论。证明结论必须保留，否则下游会把结果重新判为不可用。
    const compact = {
      contract_version: receipt.contract_version,
      task_id: receipt.task_id,
      state: receipt.state,
      business_state: receipt.business_state,
      review_gate: receipt.review_gate,
      task_outcome: receipt.task_outcome,
      revision: receipt.revision,
      finished_at: receipt.finished_at,
      result_tracking_version: receipt.result_tracking_version,
      handoff_summary: { verdict: receipt.handoff_summary?.verdict ?? "unknown", summary: "" },
      artifacts: receipt.artifacts,
      attestation: receipt.attestation
        ? { result_mode: receipt.attestation.result_mode, verified: receipt.attestation.verified, summary: "" }
        : null,
    };
    omitted.push("mechanical_summary", "session", "batch_id", "slice_id", "display_title");
    if (withinBudget(compact)) return finish(compact);
    // 已落盘的完整副本是可消费定位；不存在副本时保留必要路径，即使超过展示预算。
    return finish(compact);
  }

  function buildSubmitReceipt(submitted) {
    const postSubmitFailures = [];
    let status = null;
    try {
      status = statusTask({
        task_root: submitted.task_dir ? path.dirname(submitted.task_dir) : undefined,
        task_id: submitted.task_id,
        registry_root: ctx.config.registryRoot,
      });
    } catch (error) {
      postSubmitFailures.push({
        step: "status_task",
        error: truncateUtf8Text(error?.message ?? String(error), 240),
      });
    }
    const modelDisplay = {
      model: status?.model ?? submitted.model ?? null,
      effort: status?.effort ?? submitted.effort ?? null,
      model_source: status?.model_source ?? submitted.model_source ?? "unknown",
      effort_source: status?.effort_source ?? submitted.effort_source ?? "unknown",
    };
    const receipt = {
      ...modelDisplay,
      contract_version: CONTRACT_VERSION,
      task_id: submitted.task_id,
      batch_id: submitted.batch_id ?? null,
      slice_id: submitted.slice_id ?? null,
      display_title: submitted.display_title ?? null,
      state: submitted.state,
      revision: String(status?.rev ?? submitted.revision ?? 0),
      submitted_at: status?.created_at ?? submitted.submitted_at ?? null,
      poll_after_ms: 1000,
      ...(postSubmitFailures.length > 0 ? { post_submit_failures: postSubmitFailures } : {}),
    };
    try {
      return assertTokenBudget("submit", receipt, TOKEN_BUDGETS.submit);
    } catch (error) {
      postSubmitFailures.push({
        step: "assert_token_budget",
        error: truncateUtf8Text(error?.message ?? String(error), 120),
      });
      // Keep the model selection, committed identity and durable timestamps authoritative,
      // and shrink diagnostics (UTF-8 bytes, then step names only) until the
      // fallback itself fits the submit budget.
      const minimal = {
        ...modelDisplay,
        contract_version: CONTRACT_VERSION,
        task_id: submitted.task_id,
        state: submitted.state,
        revision: String(status?.rev ?? submitted.revision ?? 0),
        submitted_at: status?.created_at ?? submitted.submitted_at ?? null,
        poll_after_ms: 1000,
      };
      const withDetails = {
        ...minimal,
        post_submit_failures: postSubmitFailures.map((item) => ({ step: item.step, error: truncateUtf8Text(item.error, 120) })),
      };
      if (estimateTokens(withDetails) <= TOKEN_BUDGETS.submit) return withDetails;
      return { ...minimal, post_submit_failures: postSubmitFailures.map((item) => ({ step: item.step })) };
    }
  }

  return {
    resolveSubmitBudget,
    pickBool,
    pickNumber,
    sleepSync,
    renameWithRetry,
    writeJson,
    isoNow,
    isInside,
    truncateText,
    truncateUtf8Text,
    estimateTokens,
    // Existing projection callers retain their API name; overflow is display-only.
    assertTokenBudget: boundedDisplay,
    boundedDisplay,
    markDisplayTruncated,
    boundedResultReceipt,
    buildSubmitReceipt,
  };
}
