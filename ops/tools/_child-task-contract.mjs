// _child-task-contract.mjs — 子代理执行体的运输无关合同层。
//
// 这里只放「不依赖任何 RPC 协议」的 durable 合同:输出标题合同、任务状态归一、
// 终态判定、收口计划、模拟画像、交接模板填充、live 落盘节流。运输层(app-server / ACP / 其它)
// 各自留在对应 runner 里。本模块不 import 任何 runner,只 import 已共享的 _stdio-jsonrpc.mjs。
//
// 参数化纪律:所有运行态(runtime 显示名、outDir、contextMode、childCwd、
// targetCwd、artifactsDir、模板路径等)一律由调用方显式传入或经工厂注入,模块内不含 provider 专名。
//
// 调用纪律:
//   - parseSimulationProfile 会对非法 JSON 抛错,调用方必须包 try/catch,把错误延后到 result 对象与
//     outDir 都就绪之后,再走 failEarly(result, "invalid_sim_profile", ...) 优雅落盘;禁止在模块顶层
//     直调,否则非法 --simProfileJson 会让进程崩溃且不产出 child-task-result.json。
//   - makeLiveWriter 产出的 writeLive 是超集版:支持 force_record_event 强制记事件、event_extra 合并进
//     事件行、token_usage 无来源时整体删字段。
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { ensureDir, redactText } from "./_stdio-jsonrpc.mjs";

export const LIVE_FLUSH_INTERVAL_MS = 5000;

export const requiredHeadings = [
  "## 结论",
  "## 事实与证据",
  "## 已检查内容",
  "## 失败检查",
  "## 不确定项",
  "## 边界",
];

// 任务状态词表同义归一。词汇真源在 async-core/contracts.mjs(BUSINESS_STATE_SYNONYMS);此处内置同表副本,
// 归一大小写不敏感、中英同表。任务状态行只表达 completed|partial|blocked|failed 四态,同义词映射进这四态。
export const TASK_STATUS_CANON = ["completed", "partial", "blocked", "failed"];
export const TASK_STATUS_SYNONYMS = {
  done: "completed",
  complete: "completed",
  success: "completed",
  succeeded: "completed",
  完成: "completed",
  成功: "completed",
  已完成: "completed",
  partially_completed: "partial",
  partial_success: "partial",
  部分完成: "partial",
  部分: "partial",
  stuck: "blocked",
  受阻: "blocked",
  阻塞: "blocked",
  被阻塞: "blocked",
  error: "failed",
  failure: "failed",
  失败: "failed",
  出错: "failed",
};

// runtime 显示名派生的三处称谓;runtimeName 为空时退回中性词,不带任何执行体专名。
function runtimeLabels(runtimeName) {
  const name = String(runtimeName ?? "").trim();
  return {
    agent: name ? `子 ${name}` : "子代理",
    child: name ? `child ${name}` : "子执行体",
    tools: name ? `${name} runtime` : "执行器 runtime",
  };
}

export function literalReplaceAll(text, needle, value) {
  return String(text).replaceAll(needle, () => String(value));
}

export function applyTemplateReplacements(template, replacements) {
  let rendered = String(template);
  for (const [needle, value] of Object.entries(replacements)) {
    if (needle === "{{GOAL}}") continue;
    rendered = literalReplaceAll(rendered, needle, value);
  }
  return literalReplaceAll(rendered, "{{GOAL}}", replacements["{{GOAL}}"] ?? "");
}

export function normalizeTaskStatus(word) {
  const raw = String(word ?? "").trim();
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();
  if (TASK_STATUS_CANON.includes(lower)) {
    return lower;
  }
  if (Object.prototype.hasOwnProperty.call(TASK_STATUS_SYNONYMS, raw)) {
    return TASK_STATUS_SYNONYMS[raw];
  }
  if (Object.prototype.hasOwnProperty.call(TASK_STATUS_SYNONYMS, lower)) {
    return TASK_STATUS_SYNONYMS[lower];
  }
  return null;
}

// 解析「任务状态:<词>」单行;词归一到规范四态,返回 { canonical, raw } 或 null(无法归一)。
export function matchTaskStatusLine(line) {
  const match = String(line || "").match(/^任务状态\s*[:：]\s*(.+?)\s*$/);
  if (!match) {
    return null;
  }
  const raw = match[1].trim();
  const canonical = normalizeTaskStatus(raw);
  return canonical ? { canonical, raw } : null;
}

export function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sectionText(text, heading) {
  const body = String(text);
  const pattern = new RegExp(`(^|\\r?\\n)${escapeRegex(heading)}\\s*\\r?\\n(?<content>[\\s\\S]*?)(?=\\r?\\n##\\s|$)`, "m");
  return pattern.exec(body)?.groups?.content?.trim() ?? "";
}

export function sectionLines(text, heading) {
  const content = sectionText(text, heading);
  if (!content) {
    return [];
  }
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

// 返回 { canonical, raw } 或 null。canonical 为归一后的规范四态,raw 为原词(用于终态记录 business_state_raw)。
export function parseTaskStatus(text) {
  const firstConclusionLine = sectionLines(text, "## 结论")[0]?.trim() ?? "";
  return matchTaskStatusLine(firstConclusionLine);
}

export function sectionHasMeaningfulContent(text, heading) {
  const content = sectionText(text, heading)
    .replace(/^[-*]\s*/gm, "")
    .replace(/\s+/g, "")
    .replace(/[。.!！；;]+$/g, "")
    .trim();
  if (!content) {
    return false;
  }
  return !(
    /^(无|暂无|没有|无未成功检查|无失败检查|无不确定项|没有不确定项|不适用|none|n\/a)$/i.test(content) ||
    /^(无|没有)(任何)?会改变(本任务)?(gate|verdict|结论|下一步动作)?的?(不确定项|证据缺口|未决事实)$/i.test(content)
  );
}

export function analyzeTaskResult(text, options = {}) {
  const body = String(text);
  const parsedStatus = parseTaskStatus(body);
  const explicitStatus = parsedStatus?.canonical ?? null;
  // 归一发生时(原词与规范词不同)记录原词,供 wrapper 落 business_state_raw。
  const explicitStatusRaw =
    parsedStatus && parsedStatus.raw && parsedStatus.raw.toLowerCase() !== parsedStatus.canonical
      ? parsedStatus.raw
      : null;
  const blockedPatterns = [
    /blocked by policy/i,
    /rejected:\s*blocked/i,
    /被策略拦截/,
    /被.*拦截/,
    /权限不足/,
    /权限.*不足/,
    /无法执行/,
    /无法完成/,
    /无法判定/,
    /无法确认/,
    /没能拿到/,
    /未能拿到/,
    /命令.*失败/,
  ];
  const blockedSignals = blockedPatterns
    .filter((pattern) => pattern.test(body))
    .map((pattern) => pattern.source);
  // 机械信号门(可选,不提供时行为与历来一致):失败/受阻的判定优先看运输层实测证据,不靠
  // 全文正则猜测。命中只出现在业务叙述段(审查、测试设计类任务职业性讨论失败属正常内容)
  // 且机械信号干净时,压制该命中——不降级、不触发 review;命中出现在自报段(失败检查)时,
  // 无论机械信号如何都照旧处理,自报段写失败词就是该人看。被压制的命中保留在
  // sections.diagnosticSignals.suppressedBlockedSignals 供调用方按需回显。
  const mechanicalSignals = options.mechanicalSignals;
  const selfReportHeadings = options.selfReportHeadings ?? ["## 失败检查"];
  let effectiveBlockedSignals = blockedSignals;
  let suppressedBlockedSignals = [];
  // verdictBasis:受阻判定的依据来源,让主代理 review 时不必反推判定路径。
  // clean=无任何命中;text_heuristic=无机械信号时的全文正则(历来路径);self_report=自报段命中;
  // mechanical_evidence=业务段命中且机械信号脏;suppressed_text_hits=业务段命中被机械信号压制。
  let verdictBasis = blockedSignals.length === 0 ? "clean" : "text_heuristic";
  if (mechanicalSignals && blockedSignals.length > 0) {
    const selfReportText = selfReportHeadings.map((heading) => sectionText(body, heading)).join("\n");
    const selfReportHits = blockedPatterns
      .filter((pattern) => pattern.test(selfReportText))
      .map((pattern) => pattern.source);
    const mechanicalDirty =
      (mechanicalSignals.deniedPermissions ?? 0) > 0 ||
      (mechanicalSignals.failedToolCalls ?? 0) > 0 ||
      (mechanicalSignals.errorTurns ?? 0) > 0;
    if (selfReportHits.length > 0) {
      effectiveBlockedSignals = selfReportHits;
      verdictBasis = "self_report";
    } else if (!mechanicalDirty) {
      suppressedBlockedSignals = blockedSignals;
      effectiveBlockedSignals = [];
      verdictBasis = "suppressed_text_hits";
    } else {
      verdictBasis = "mechanical_evidence";
    }
  }
  const rescuePatterns = [
    /替代.*(成功|完成|拿到|获取|确认)/,
    /(成功|完成|拿到|获取|确认).*替代/,
    /救场.*(成功|完成|已完成)/,
    /不需要升级权限/,
    /不影响.*结论/,
  ];
  const rescueSignals = rescuePatterns
    .filter((pattern) => pattern.test(body))
    .map((pattern) => pattern.source);
  const failureSectionHasContent = sectionHasMeaningfulContent(body, "## 失败检查");
  const uncertaintySectionHasContent = sectionHasMeaningfulContent(body, "## 不确定项");
  const warnings = [];
  let ok = explicitStatus === "completed";
  let failureType = "none";
  let status = explicitStatus ?? "missing";
  if (!explicitStatus) {
    ok = false;
    failureType = "task_status_missing";
  } else if (explicitStatus === "partial") {
    ok = false;
    failureType = "task_partial";
  } else if (explicitStatus === "blocked") {
    ok = false;
    failureType = "task_blocked";
  } else if (explicitStatus === "failed") {
    ok = false;
    failureType = "task_failed";
  }
  if (effectiveBlockedSignals.length > 0 && explicitStatus !== "completed" && !ok) {
    failureType = "blocked_by_policy";
  }
  if (explicitStatus === "completed" && effectiveBlockedSignals.length > 0) {
    if (rescueSignals.length > 0 || failureSectionHasContent) {
      status = "completed_with_recorded_failures";
      warnings.push("子任务声明 completed,但文本包含失败或受阻信号;已按失败检查/救场说明记录为带失败记录的完成。");
    } else {
      ok = false;
      status = "completed_with_unresolved_failures";
      failureType = "completed_with_unresolved_failures";
      warnings.push("子任务声明 completed,但存在未解释的失败或受阻信号。");
    }
  }
  if (explicitStatus === "completed" && uncertaintySectionHasContent) {
    if (status === "completed") {
      status = "completed_with_uncertainty";
    }
    warnings.push("子任务完成,但仍记录不确定项;主会话需要判断不确定项是否影响用户目标。");
  }
  return {
    ok,
    status,
    agentDeclaredStatus: explicitStatus,
    agentDeclaredStatusRaw: explicitStatusRaw,
    controllerClassifiedStatus: status,
    requiresParentReview:
      !ok ||
      warnings.length > 0 ||
      effectiveBlockedSignals.length > 0 ||
      uncertaintySectionHasContent,
    failure_type: failureType,
    verdictBasis,
    blockedSignals: effectiveBlockedSignals,
    rescueSignals,
    warnings,
    sections: {
      failureSectionHasContent,
      uncertaintySectionHasContent,
      diagnosticSignals: { rescueSignals, blockedSignals, suppressedBlockedSignals },
    },
  };
}

// gate=fail/needs_owner 时 ok 保持 true 是有意语义:ok 表达「运输与合同履行完成」(子代理交付了
// 产物),业务不利结论经 status(failed/partial)+requiresParentReview 传播——async-core 的
// reviewGate() 对 business_state∈{failed,partial} 与 requires_parent_review 两道都拦,节点必进
// needs_parent_review 停车(2026-08-25 取证:runtime.mjs parentConsumptionSummary/reviewGate)。
// 不要把 ok:true 当 bug 改成 false:那会把「评审不利」错误合并进「运输失败」通道。
export function applyReviewGate(task, synthesis) {
  if (!synthesis?.applied || !["pass", "fail", "needs_owner"].includes(synthesis.gate)) {
    return task;
  }
  if (synthesis.gate === "pass") {
    return {
      ...task,
      ok: true,
      status: "completed",
      controllerClassifiedStatus: "completed",
      requiresParentReview: false,
      failure_type: "none",
      warnings: [],
      reviewGate: "pass",
    };
  }
  const status = synthesis.gate === "fail" ? "failed" : "partial";
  return {
    ...task,
    ok: true,
    status,
    controllerClassifiedStatus: status,
    requiresParentReview: true,
    failure_type: "none",
    warnings: [],
    reviewGate: synthesis.gate,
  };
}

// options.conclusionStatusRequired=false:structured review 轨的豁免——业务终态真源是
// review gate(applyReviewGate),结论下的“任务状态:”行是 FINAL_HANDOFF 旧链路约定,提示
// 模板从未教过;缺失只记 warning,不进 ok 硬闸,否则 runner 终态与 wrapper 收口分裂
//(工具病 20260901-structured-review-runner-verdict-split-on-conclusion-status)。
export function headingStatus(text, headings = requiredHeadings, { conclusionStatusRequired = true } = {}) {
  const body = String(text);
  const lines = body.split(/\r?\n/);
  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  const missing = headings.filter((heading) => !body.includes(heading));
  const conclusionIsFirst = firstNonEmptyLine === headings[0];
  const conclusionFirstLine = sectionLines(body, headings[0])[0]?.trim() ?? "";
  const conclusionStatusOk = matchTaskStatusLine(conclusionFirstLine) !== null;
  const headingPositions = headings.map((heading) => ({
    heading,
    index: body.indexOf(heading),
  }));
  const headingsInOrder = headingPositions
    .filter((entry) => entry.index >= 0)
    .every((entry, index, entries) => index === 0 || entry.index > entries[index - 1].index);
  const duplicateHeadings = headings.filter((heading) => {
    const matches = body.match(new RegExp(escapeRegex(heading), "g")) ?? [];
    return matches.length > 1;
  });
  const warnings = [];
  if (!conclusionIsFirst) {
    warnings.push(`child-final.md 首个非空行必须是 ${headings[0]},不能有游离前言。`);
  }
  if (!conclusionStatusOk) {
    warnings.push(`${headings[0]} 后第一行必须是 任务状态:completed|partial|blocked|failed。`);
  }
  if (!headingsInOrder) {
    warnings.push("输出标题顺序必须与 Output Contract 一致。");
  }
  if (duplicateHeadings.length > 0) {
    warnings.push(`输出标题不能重复:${duplicateHeadings.join(", ")}`);
  }
  return {
    required: headings,
    missing,
    firstNonEmptyLine,
    conclusionIsFirst,
    conclusionStatusOk,
    headingsInOrder,
    duplicateHeadings,
    warnings,
    ok:
      missing.length === 0 &&
      conclusionIsFirst &&
      (conclusionStatusOk || !conclusionStatusRequired) &&
      headingsInOrder &&
      duplicateHeadings.length === 0,
  };
}

export function normalizeFinalText(text) {
  return redactText(text).trim();
}

// 非法 JSON 会抛错;调用方必须按模块头的调用纪律包 try/catch 并延后到 failEarly 落盘。
export function parseSimulationProfile(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("simProfileJson must encode one structured object");
  }
  return parsed;
}

export function simulationProfilePrompt(profile) {
  return [
    "# 目标仓子代理模拟",
    `以目标仓子代理画像运行,用于跨仓改动验收前的模拟。角色:${profile.role || "(未命名)"}。`,
    "目标仓子代理设定如下(约束行为风格与操作边界;任务目标以下方任务材料为准):",
    "",
    JSON.stringify(profile.persona, null, 2),
    "",
    "---",
    "以下是本次任务材料:",
  ].join("\n");
}

// context:{ contextMode, childCwd, targetCwd, artifactsDir, outDir, scratchDir, runtimeName, taskReminder }。
// 模板只含运行环境、交付与末尾复述；任务、规则与工具授权都在 {{GOAL}} 的任务材料里。
export function fillTemplate(template, taskText, context = {}) {
  const {
    contextMode = "isolated",
    childCwd = "",
    targetCwd = "",
    artifactsDir = "",
    outDir = "",
    scratchDir = "",
    runtimeName = "",
    taskReminder = "",
  } = context;
  const labels = runtimeLabels(runtimeName);
  const writeTargets = `- 写入去处：业务改动只写任务卡 scope.write 列出的路径；脚本、夹具、日志写普通产物目录:${artifactsDir}`
    + (scratchDir ? `；临时文件写临时目录:${scratchDir}（bash 与后台命令的 TEMP/TMP 已指向这里，任务结束清空）` : "")
    + "。这些目录里可自由新建和删除，其它位置的写入会被拦下或记为越界。";
  const runtimeContext = contextMode === "project-aware"
    ? [
        "- 上下文模式:project-aware。",
        `- ${labels.child} 当前工作目录:${childCwd}`,
        `- 任务目标工作区:${targetCwd}`,
        "- 当前工作目录就是任务目标工作区；runner 关闭自动 context-file 发现，只执行启动材料显式注入的项目规则和任务材料。",
        "- 目标工作区中的 AGENTS.md 或项目配置只有被任务材料显式注入或列入授权读面时才作为可见事实。",
        writeTargets,
      ]
    : [
        "- 上下文模式:isolated。",
        `- ${labels.child} 当前工作目录:${childCwd}`,
        `- 任务目标工作区:${targetCwd}`,
        "- 当前工作目录是隔离运行目录,不代表任务目标。",
        "- 不应自动把目标工作区 AGENTS.md 当作运行指令;如任务要求读取目标规则,只能把它作为事实材料引用。",
        writeTargets,
      ];
  return applyTemplateReplacements(template, {
    "{{GOAL}}": taskText,
    "{{RUNTIME_CONTEXT}}": runtimeContext.join("\n"),
    "{{EVIDENCE_DIR}}": outDir,
    "{{ARTIFACTS_DIR}}": artifactsDir,
    "{{TASK_REMINDER}}": taskReminder,
  });
}

// ---------- 观测降采样 ----------

// events.jsonl 只保留 tool-call、phase 变化、终态、以及 force_record_event 指定的关键事件(权限应答);
// live.json 落盘节流到「phase 变化 / 距上次落盘 ≥ intervalMs coalesce / 终态」三条件之一。
export function classifyLiveWrite(frame, elapsedMs, intervalMs) {
  const phaseChanged = frame.nextPhase !== frame.prevPhase;
  const isToolCall = frame.nextPhase === "tool_call";
  const status = String(frame.status ?? "");
  const isTerminal =
    frame.event === "finished" || status === "completed" || status === "failed" || status === "cancelled";
  return {
    phaseChanged,
    isTerminal,
    recordEvent: phaseChanged || isToolCall || isTerminal,
    flushLive: phaseChanged || isTerminal || elapsedMs >= intervalMs,
  };
}

// live 落盘器工厂。返回对象上的 state 是当前快照的可写引用(供调用方直接补 token_usage 等运行态字段),
// writeLive(patch) 走节流纪律;patch.force_record_event=true 强制记事件行,patch.event_extra 合并进事件行。
export function makeLiveWriter({
  outDir,
  livePath,
  eventsPath,
  initialState = {},
  flushIntervalMs = LIVE_FLUSH_INTERVAL_MS,
} = {}) {
  let lastLiveFlushMs = 0;
  let snapshotDeferred = false;
  let liveState = { ...initialState };
  return {
    get state() {
      return liveState;
    },
    writeLive(patch = {}) {
      ensureDir(outDir);
      const now = new Date().toISOString();
      const prevPhase = liveState.phase;
      liveState = {
        ...liveState,
        ...patch,
        rev: Number(liveState.rev ?? 0) + 1,
        updated_at: now,
        last_event_at: patch.last_event_at ?? now,
      };
      const decision = classifyLiveWrite(
        { prevPhase, nextPhase: liveState.phase, event: patch.event, status: liveState.status },
        Date.now() - lastLiveFlushMs,
        flushIntervalMs,
      );
      const recordEvent = patch.force_record_event === true || decision.recordEvent;
      if (recordEvent) {
        appendFileSync(
          eventsPath,
          `${JSON.stringify({
            at: now,
            rev: liveState.rev,
            status: liveState.status,
            phase: liveState.phase,
            event: patch.event ?? null,
            last_notification_method: liveState.last_notification_method,
            last_tool_call: liveState.last_tool_call,
            ...(patch.event_extra ?? {}),
          })}\n`,
          "utf8",
        );
      }
      if (decision.flushLive) {
        // token_usage 没有来源时整体省略字段。
        if (liveState.token_usage === undefined) {
          delete liveState.token_usage;
        }
        // Readers see the previous or the next complete snapshot, never a truncated file.
        const tempPath = `${livePath}.${process.pid}.${liveState.rev}.tmp`;
        try {
          writeFileSync(tempPath, JSON.stringify(liveState, null, 2), { encoding: "utf8", flag: "wx" });
          // Windows readers can briefly hold the destination open; keep the old snapshot on failure.
          for (let attempt = 0; ; attempt++) {
            try { renameSync(tempPath, livePath); break; }
            catch (error) {
              if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
              if (attempt === 7) {
                if (!snapshotDeferred) {
                  appendFileSync(eventsPath, `${JSON.stringify({
                    at: new Date().toISOString(), rev: liveState.rev,
                    event: "live_snapshot_deferred", error_code: error.code,
                    error: error.message,
                  })}\n`, "utf8");
                }
                snapshotDeferred = true;
                lastLiveFlushMs = Date.now();
                return;
              }
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
            }
          }
        } finally {
          rmSync(tempPath, { force: true });
        }
        if (snapshotDeferred) {
          appendFileSync(eventsPath, `${JSON.stringify({
            at: new Date().toISOString(), rev: liveState.rev,
            event: "live_snapshot_resumed",
          })}\n`, "utf8");
          snapshotDeferred = false;
        }
        lastLiveFlushMs = Date.now();
      }
    },
  };
}

// stdout 接管道时在 POSIX 上是异步写(node 文档「A note on process I/O」),console.log 之后立即
// exit() 会截断输出。fd 1 在那种模式下是 non-blocking,writeSync 可能只写一半或抛 EAGAIN,故按
// 已写字节数续写。
export function writeStdoutSync(text) {
  const buffer = Buffer.from(text, "utf8");
  let written = 0;
  while (written < buffer.length) {
    try {
      written += writeSync(1, buffer, written, buffer.length - written);
    } catch (error) {
      if (error?.code !== "EAGAIN") {
        throw error;
      }
    }
  }
}

// 早退落盘器工厂:把 result 标成 failed、写 child-task-result.json、打印后以 exit 1 结束进程。
export function makeFailEarly({ outDir, resultPath = path.join(outDir, "child-task-result.json") } = {}) {
  return function failEarly(result, failureType, message) {
    result.ok = false;
    result.status = "failed";
    result.failure_type = failureType;
    result.error = message;
    ensureDir(outDir);
    result.outputPath = resultPath;
    writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
    // 调用方在模块顶层顺序执行,失败后必须立刻终止,这里的 exit() 换不成 exitCode;
    // 父进程要解析这份失败快照,所以先同步写满 fd 1 再退出。
    writeStdoutSync(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(1);
  };
}

export function readTaskText({ taskFile = "", task = "" } = {}) {
  if (taskFile) {
    return readFileSync(taskFile, "utf8").trim();
  }
  return String(task ?? "").trim();
}

// 终态两级优先级:运输失败 > 业务任务状态。正文六节格式(headingStatus)只是观测事实,
// 不进终态:报告与 handoff 的格式真源是 Core 侧 checker,runner 不因缺节判失败、不追加收口轮。
// 顶层 status：运行失败为 failed；运行正常时取业务状态（completed / partial / blocked / failed），
// 不把 partial 与业务 failed 折成 blocked。review gate 的 fail / needs_owner 保持 task.ok=true
// （见 applyReviewGate），顶层 status 仍投影其业务状态。运行与业务的区分看 orchestration.ok 与 failure_type。
const INCOMPLETE_BUSINESS_STATUSES = new Set(["partial", "blocked", "failed"]);
export function classifyFinalResult(orchestration, task) {
  const orchestrationOk = orchestration?.ok === true;
  const taskOk = task?.ok === true;
  const incomplete = INCOMPLETE_BUSINESS_STATUSES.has(task?.status);
  return {
    ok: orchestrationOk && taskOk,
    status: !orchestrationOk ? "failed" : incomplete ? task.status : taskOk ? "completed" : "blocked",
    failure_type: !orchestrationOk
      ? orchestration?.failure_type ?? "unknown"
      : task?.failure_type ?? "unknown",
  };
}

// ---------- self-test ----------

if (
  process.argv[1] &&
  path.basename(process.argv[1]).toLowerCase() === "_child-task-contract.mjs" &&
  process.argv.includes("--self-test")
) {
  // 说明符走变量:esbuild 只内联字面量动态 import,变量形式把自测代码挡在 run-pi-task 运行时 bundle
  // 之外(打包产物的 argv[1] basename 不匹配,本分支在 bundle 里不会触发)。
  const selfTestModule = "./_child-task-contract.selftest.mjs";
  // 不能用 top-level await:伴生模块静态 import 本模块,await 会让两边互等成 unsettled TLA(退出码 13)。
  import(selfTestModule).then((module) => {
    module.selfTest();
    console.log("CONTRACT_SELF_TEST_OK");
  }).catch((error) => {
    console.error(`CONTRACT_SELF_TEST_FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
