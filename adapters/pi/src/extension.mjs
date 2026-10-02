import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isFastPayload } from "../../../ops/tools/pi_fast_mode.mjs";
import { summarizeTaskOutcome } from "../../../ops/tools/task-outcome.mjs";
import { createFleetCore } from "../../../ops/tools/fleet-tools-core.mjs";
import { installDelegateWork } from "./delegate-work-extension.mjs";
import { workBranchBinding } from "./delegate-work-core.mjs";
import { resolveSubagentCoreOptions } from "../../../ops/tools/subagent_runtime.mjs";
import {
  resolveDeclaredEntrypointByNames,
  resolveProjectRoot,
  resolveRealPath,
  rootContractError,
} from "./consumer-root.mjs";
import { createSubagentLifecycleTools } from "./async-tools.mjs";
import { PAUSE_NOTICE_EVENT, STALL_NOTICE_EVENT, createCompletionWatcher, pauseNoticeFrom, readCompletionNotice } from "./completion-watcher.mjs";
import { CompletionDelivery, terminalFingerprint } from "./completion-delivery.mjs";
import { createAgentPanelEnsurer, createDispatchPrepareTool } from "./dispatch-prepare-tool.mjs";
import { createContextCompaction } from "./context-compaction.mjs";
import { createControlResourceLoader } from "./control-resource-loader.mjs";
import { createFleetCompletionWatcher, FLEET_COMPLETION_NOTICE_EVENT } from "./fleet-completion-watcher.mjs";
import { createFleetTools } from "./fleet-tools.mjs";
import { registerSessionLiveness } from "./session-liveness.mjs";
import { createPiAsyncService, isTerminalTransportState, normalizeTaskState, resultTrackingVersion } from "./async-service.mjs";

function sessionIdFrom(ctx) {
  const value = typeof ctx?.sessionManager?.getSessionId === "function"
    ? ctx.sessionManager.getSessionId()
    : ctx?.sessionId;
  return String(value || "pi-session");
}

function sessionFileFrom(ctx) {
  const value = typeof ctx?.sessionManager?.getSessionFile === "function"
    ? ctx.sessionManager.getSessionFile()
    : ctx?.sessionFile;
  return String(value || "");
}

const TRACKING_ENTRY_TYPE = "subagent-control-tracking";
// 已提示过的观察故障指纹（task_id:error）：同一来源同一任务同一故障不再重复刷屏。
const RECOVERY_ENTRY_TYPE = "subagent-recovery-notified";

function normalizedIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))];
}

function trackingEntries(ctx) {
  const manager = ctx?.sessionManager;
  if (typeof manager?.getBranch === "function") return manager.getBranch();
  if (typeof manager?.getEntries === "function") return manager.getEntries();
  return [];
}

function restoredTracking(ctx) {
  const activeTasks = new Set();
  const activeRuns = new Set();
  for (const entry of trackingEntries(ctx)) {
    if (entry?.type === "custom_message" && entry.customType === "subagent-completion") {
      for (const notice of entry.details?.notices ?? [entry.details]) {
        // 结果读取可自行解除的失败不销账：重载后仍要跟踪，故障解除时才能补投结果。
        if (notice?.task_id && notice.event !== PAUSE_NOTICE_EVENT && notice.result_retryable !== true) {
          activeTasks.delete(notice.task_id);
        }
      }
    }
    if (entry?.type !== "custom" || entry.customType !== TRACKING_ENTRY_TYPE) continue;
    const data = entry.data ?? {};
    const target = data.target === "fleet" ? activeRuns : activeTasks;
    for (const id of normalizedIds(data.ids)) {
      if (data.action === "complete") target.delete(id);
      if (data.action === "track") target.add(id);
    }
  }
  return { taskIds: [...activeTasks], runIds: [...activeRuns] };
}

function recordTracking(pi, target, action, ids) {
  const normalized = normalizedIds(ids);
  if (normalized.length === 0 || typeof pi?.appendEntry !== "function") return;
  pi.appendEntry(TRACKING_ENTRY_TYPE, { target, action, ids: normalized });
}

function recoveryFaultKey(item) {
  return `${String(item?.task_id ?? "")}:${String(item?.error ?? "")}`;
}

function restoredRecoveryFaults(ctx) {
  const faults = new Set();
  for (const entry of trackingEntries(ctx)) {
    if (entry?.type !== "custom" || entry.customType !== RECOVERY_ENTRY_TYPE) continue;
    for (const fault of normalizedIds(entry.data?.faults)) faults.add(fault);
  }
  return faults;
}

function recordRecoveryFaults(pi, faults) {
  const normalized = normalizedIds(faults);
  if (normalized.length === 0 || typeof pi?.appendEntry !== "function") return;
  pi.appendEntry(RECOVERY_ENTRY_TYPE, { faults: normalized });
}

async function sendCompletionMessage(pi, customType, content, details, { triggerTurn = true } = {}) {
  if (typeof pi?.sendMessage !== "function") {
    throw new Error("Pi completion wakeup requires pi.sendMessage");
  }
  await pi.sendMessage({ customType, content, display: true, details }, {
    deliverAs: "followUp",
    triggerTurn,
  });
}

export function taskCompletionText(notice) {
  const reason = typeof notice.result_error === "string" && notice.result_error.trim()
    ? notice.result_error.trim().slice(0, 200)
    : null;
  const retryable = notice.result_available === false && notice.result_retryable === true;
  // 状态已知与结果读取失败分开说：先报已知终态，再单独给读取失败原因和合法下一步。
  const next = notice.result_available
    ? "此 task_id + revision 尚未消费时调用 subagent_result；已消费则复用现有结论。"
    : retryable
      ? "任务状态已知，只是正式 result 这次没读出来；系统仍在跟踪这个 task，读取恢复后会自动补投一次通知。此 task_id + revision 尚未消费时调用 subagent_result，已消费则复用现有结论；现在也可用 subagent_get(detail=diagnostic) 查看现场和已保存的报告、证明路径，不要据此重派任务。"
      : "正式 result 尚不可用；此 task_id + revision 尚未消费时调用 subagent_get 读取失败摘要，已消费则复用现有结论。";
  return [
    "[子代理终态通知]",
    `task_id=${notice.task_id}`,
    `revision=${notice.revision}`,
    `transport_state=${notice.transport_state}`,
    `business_state=${notice.business_state ?? "unknown"}`,
    ...(notice.task_outcome ? [`outcome=${notice.task_outcome.summary || summarizeTaskOutcome(notice.task_outcome)}`] : []),
    `result_available=${notice.result_available}`,
    ...(notice.result_available === false ? [
      `result_retryable=${retryable}`,
      ...(reason ? [`result_error=${reason}`] : []),
    ] : []),
    ...(typeof notice.failure_summary === "string" && notice.failure_summary.trim()
      ? [`failure_summary=${notice.failure_summary.trim()}`] : []),
    next,
  ].join("\n");
}

function taskStallText(notice) {
  const stall = notice.stall ?? {};
  return [
    "[子代理静默疑似卡死]",
    `task_id=${notice.task_id}`,
    `revision=${notice.revision}`,
    `silent_seconds=${stall.silent_seconds ?? "unknown"} threshold_seconds=${stall.threshold_seconds ?? "unknown"}`,
    `last_event_at=${stall.last_event_at ?? "none"} phase=${stall.live_phase ?? "unknown"} last_tool=${stall.last_tool ?? "none"}`,
    "任务仍在运行，通知未触发取消或重派。用 subagent_get(detail=diagnostic) 查看当前现场和已有产物，由主代理结合任务目标决定下一步；静默恢复后本通知失效。",
  ].join("\n");
}

function taskPauseText(notice) {
  const mode = notice.resume_mode ?? "unknown";
  const session = notice.session_file ?? "none";
  const continueStep = mode === "start"
    ? "resume_mode=start：恢复会启动这个尚未开始的原任务。用subagent_get取得当前revision后调用subagent_resume。"
    : mode === "session"
      ? "resume_mode=session：恢复会装载session_file指向的原会话。用subagent_get取得当前revision后调用subagent_resume。"
      : "subagent_get 未给出 resume_mode。先读取当前 revision 和 resume_mode，再决定是否调用 subagent_resume。";
  const resumableLine = `resumable=${notice.resumable ?? "unknown"} session_file=${session}`;
  return [
    "[子代理已暂停]",
    `task_id=${notice.task_id}`,
    `revision=${notice.revision}`,
    "transport_state=paused",
    `business_state=${notice.business_state ?? "none"}`,
    "执行已停止；业务状态以正式结果为准。",
    resumableLine,
    `resume_mode=${mode}`,
    continueStep,
    "用户明确暂停后，必须先有新的继续指令，再调用 subagent_resume。",
    "终止使用独立的subagent_cancel动作；本次暂停不授权强杀。",
    ...(typeof notice.next_step === "string" && notice.next_step.trim() ? [`next_step=${notice.next_step.trim()}`] : []),
  ].join("\n");
}

function noticeDetails(notices) {
  return notices.length === 1 ? notices[0] : { notices };
}

// 暂停提醒和终态提醒共用同一投递缓冲，只是各自的消息类型和文案不同。
async function sendNoticeBatch(pi, notices) {
  const onlyPauses = notices.every(notice => notice?.event === PAUSE_NOTICE_EVENT);
  await sendCompletionMessage(pi, onlyPauses ? "subagent-pause" : "subagent-completion",
    notices.map(notice => notice?.event === PAUSE_NOTICE_EVENT ? taskPauseText(notice) : taskCompletionText(notice)).join("\n\n"),
    noticeDetails(notices));
}

function taskRecoveryText(recovery) {
  const tasks = Array.isArray(recovery?.tasks) ? recovery.tasks : [];
  const errors = Array.isArray(recovery?.observation_errors) ? recovery.observation_errors : [];
  return [
    "[子代理会话恢复提示]",
    `session_id=${recovery?.session_id ?? "unknown"}`,
    `unfinished_count=${tasks.length}`,
    ...tasks.map((task) => (
      `task_id=${task.task_id} revision=${task.revision ?? "unknown"} state=${task.transport_state ?? "unknown"}`
    )),
    ...(errors.length ? [
      `observation_error_count=${errors.length}`,
      ...errors.slice(0, 20).map(item => `task_id=${item.task_id} observation_error=${String(item.error).slice(0, 500)}`),
      ...(errors.length > 20 ? [`omitted_observation_errors=${errors.length - 20}`] : []),
      "查询失败项状态未知，登记仍保留。核对原服务或用显式task_root查询；其他任务继续观察，不据查询失败取消或重派。",
    ] : []),
    ...(tasks.some((task) => task.transport_state === "paused") ? [
      "state=paused 的任务是执行停止，不是业务完成或失败。不要读取失败摘要。继续需要用户新指令后的 subagent_resume；终止需要用户明确要求后的 subagent_cancel。",
    ] : []),
    "以上仅为当前 logical session 已登记任务的观察结果。用 subagent_get(detail=diagnostic) 查看现场；主代理根据事实决定继续等待、请求取消、恢复或重派，系统不会自动处置。",
  ].join("\n");
}

function fleetCompletionText(notice) {
  return [
    notice.error ? "[Fleet 观察失败]" : notice.driver_status === "needs_parent_review" ? "[Fleet 待处理通知]" : "[Fleet 终态通知]",
    `run_id=${notice.run_id}`,
    `driver_status=${notice.driver_status ?? "unknown"}`,
    ...(notice.counts ? [`counts=${JSON.stringify(notice.counts)}`] : []),
    ...(notice.error ? [`error=${notice.error.message ?? String(notice.error)}`] : []),
    "若记录能确认本次通知对应的状态已读取并处理，复用结论；状态有新进展或无法确认时调用 fleet_status，needs_parent_review 时按证据使用 fleet_review 裁决。",
  ].join("\n");
}

export function resolveDefaultCoreOptions({
  runtimeRoot = null,
  projectRoot,
  mode = null,
  manifest = null,
  cwd = undefined,
  home = os.homedir(),
  env = process.env,
} = {}) {
  const controlRoot = runtimeRoot
    ? resolveRealPath(runtimeRoot)
    : path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const resolvedProjectRoot = projectRoot !== undefined ? projectRoot : cwd;
  if (resolvedProjectRoot === null) {
    throw rootContractError("missing_project_root", "resolveDefaultCoreOptions requires an explicit project root");
  }
  if (resolvedProjectRoot === undefined && (mode === "consumer" || manifest)) {
    throw rootContractError("missing_project_root", "consumer assembly requires an explicit project root");
  }
  // 开发/测试兼容：未显式给根时按调用进程目录；仅限非消费装配。
  const project = resolveProjectRoot(resolvedProjectRoot === undefined ? process.cwd() : resolvedProjectRoot);
  // 开发模式（无消费 marker）允许在运行包里找约定 dist 制品；缺失时保留既有「部署不完整」报错。
  const resolveEntry = (names, relative) => {
    try {
      return resolveDeclaredEntrypointByNames({
        names,
        runtimeRoot: controlRoot,
        manifest,
        defaults: [relative],
      });
    } catch (error) {
      if (manifest === null && error?.code === "missing_runtime_asset") return path.join(controlRoot, ...relative.split("/"));
      throw error;
    }
  };
  const entryPath = resolveEntry(["subagent_service", "subagentService"], "ops/dist/subagent_service.bundle.mjs");
  const checkerPath = resolveEntry(["subagent_handoff_check", "subagentHandoffCheck"], "ops/dist/subagent_handoff_check.bundle.mjs");
  const runnerPath = resolveEntry(["run-pi-task", "runPiTask", "runner"], "ops/dist/run-pi-task.bundle.mjs");
  const requiredPaths = [
    entryPath,
    runnerPath,
    path.join(controlRoot, "ops", "dist", "subagent_service.manifest.json"),
    checkerPath,
    path.join(controlRoot, "ops", "templates", "handoff-prompt-template.md"),
    path.join(controlRoot, "ops", "templates", "review-evidence-prompt-template.md"),
  ];
  const missing = requiredPaths.filter((candidate) => !existsSync(candidate));
  if (missing.length > 0) {
    throw new Error(`Pi async deployment is incomplete: ${missing.map((candidate) => path.relative(controlRoot, candidate)).join(", ")}`);
  }
  const environment = { ...env };
  return resolveSubagentCoreOptions({
    entryPath,
    cwd: project,
    home,
    env: environment,
    childEnv: environment,
    checkerPath,
    defaultRunnerPath: runnerPath,
    registryRoot: path.join(project, ".runtime", "cockpit", "async-registry"),
    defaultTaskRoot: path.join(project, ".runtime", "cockpit", "async_tasks"),
  });
}

function createProjectAsyncService(options = {}) {
  const { runtimeRoot = null, projectRoot, mode = null, manifest = null, ...rest } = options;
  return createPiAsyncService({
    ...rest,
    ...(rest.core ? {} : {
      coreOptions: rest.coreOptions
        ?? resolveDefaultCoreOptions({ runtimeRoot, projectRoot, mode, manifest, cwd: rest.cwd }),
    }),
    registryRef: rest.registryRef ?? "project-async-task-registry",
  });
}

function createContextHook(pi, contextOptions = {}) {
  const compaction = typeof contextOptions.compaction?.compactContext === "function"
    ? contextOptions.compaction
    : createContextCompaction(contextOptions.compaction ?? contextOptions);
  const resourceLoader = contextOptions.resourceLoader
    ?? createControlResourceLoader(contextOptions.loaderOptions ?? {});
  return async (event, ctx) => {
    if (typeof contextOptions.getResources !== "function") return undefined;
    const preparation = event?.preparation ?? {};
    const sessionId = sessionIdFrom(ctx);
    const contextResources = await contextOptions.getResources({
      event,
      ctx,
      loader: resourceLoader,
      sessionId,
    });
    if (!contextResources) return undefined;
    const result = await compaction.compactContext({
      sessionId,
      messages: preparation.messagesToSummarize ?? [],
      contextResources,
      thresholdBytes: contextOptions.thresholdBytes,
    });
    return {
      compaction: {
        summary: result.summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: result,
      },
    };
  };
}

export default function controlDelegateExtension(pi, {
  asyncService = null,
  asyncServiceOptions = null,
  enableDefaultAsync = true,
  enableNativeDispatch = true,
  dispatchCompiler = null,
  enableAgentPanelLaunch = true,
  agentPanelEnsurer = null,
  enableCompletionWatcher = true,
  enableFleetCompletionWatcher = true,
  onCompletionNotice = null,
  onFleetCompletionNotice = null,
  fleetCore = null,
  // 装配入口显式注入的双根；controlRoot/cwd 仅作兼容别名，库层不回落常驻宿主 process.cwd。
  runtimeRoot = null,
  projectRoot = null,
  mode = null,
  manifest = null,
  fleetWatcherWaitMs = 60_000,
  fleetNoticeRetryBaseMs = 250,
  fleetNoticeRetryMaxMs = 5_000,
  contextOptions = null,
  delegateWorkOptions = {},
  enableDelegateWork = true,
} = {}) {
  const durableAsyncService = asyncService
    ?? (enableDefaultAsync
      ? createProjectAsyncService(
        runtimeRoot
          ? { ...(asyncServiceOptions ?? {}), runtimeRoot, projectRoot, mode, manifest }
          : (asyncServiceOptions ?? {}),
      )
      : null);
  const resolvedFleetCore = fleetCore
    ?? (runtimeRoot ? createFleetCore({ runtimeRoot, projectRoot, mode, manifest, cwd: projectRoot }) : createFleetCore());
  const deliveredRecoveryKeys = new Set();
  const notifiedRecoveryFaults = new Set();
  let sessionContext = null;
  let sessionFast = false;
  let branchBinding = null;
  let livenessLease = null;
  const releaseSessionLiveness = () => {
    const release = livenessLease;
    livenessLease = null;
    if (typeof release === "function") release();
  };
  const completionDelivery = new CompletionDelivery({
    isIdle: () => Boolean(sessionContext) && (sessionContext.isIdle?.() ?? true),
    refresh: async notice => {
      const current = normalizeTaskState(await durableAsyncService.get({ task_id: notice.task_id }));
      if (String(current.revision) !== String(notice.revision)) return null;
      if (notice.event === PAUSE_NOTICE_EVENT) {
        // 暂停已被恢复或推翻：旧提醒作废，任务仍由观察器继续跟踪。
        return current.transport_state === "paused" ? pauseNoticeFrom(current, notice.session_id) : null;
      }
      if (!isTerminalTransportState(current.transport_state)) return null;
      return readCompletionNotice(durableAsyncService, current, notice.session_id);
    },
    send: notices => sendNoticeBatch(pi, notices),
    onRead: read => pi.appendEntry?.(TRACKING_ENTRY_TYPE, {
      target: "task", action: "read", ids: [read.task_id], revision: read.revision, kind: read.kind,
      result_tracking_version: read.result_tracking_version ?? null,
      terminal_fingerprint: read.terminal_fingerprint ?? null,
    }),
    onConsumed: notice => {
      // 已读的可重试状态不是最终结果消费，重载后仍须继续观察。
      if (notice.result_retryable !== true) recordTracking(pi, "task", "complete", [notice.task_id]);
    },
    onStale: notice => completionWatcher?.trackTaskIds([notice.task_id]),
  });
  const observeReads = tool => {
    const kind = tool.name === "subagent_result" ? "result"
      : ["subagent_get", "subagent_wait"].includes(tool.name) ? "state" : null;
    if (!kind) return tool;
    return { ...tool, async execute(...args) {
      const generation = completionDelivery.generation;
      const response = await tool.execute(...args);
      const state = response?.details;
      if (generation === completionDelivery.generation && !response?.isError
        && isTerminalTransportState(state?.transport_state)) {
        try {
          completionDelivery.rememberRead({
            task_id: state.task_id,
            revision: state.revision,
            kind,
            result_tracking_version: resultTrackingVersion(state),
            terminal_fingerprint: terminalFingerprint(state),
          });
        } catch (error) {
          // 登记失败不撤回有效工具结果；保留未读提醒供后续处理。
          completionDelivery.lastError = error;
        }
      } else if (generation === completionDelivery.generation && !response?.isError
        && kind === "state" && state?.transport_state === "paused") {
        try {
          completionDelivery.rememberRead({
            task_id: state.task_id,
            revision: state.revision,
            kind: "pause",
          });
        } catch (error) {
          completionDelivery.lastError = error;
        }
      }
      return response;
    } };
  };

  const deliverTaskNotice = async (notice) => {
    if (branchBinding && !branchBinding.active) return;
    if (notice?.event === PAUSE_NOTICE_EVENT) {
      // 暂停提醒同样走投递缓冲：忙时不唤醒、失败可重试、重载后按已投递记录去重。
      // 投递成功只登记「通知已到过」，不写 read；只有公开读取才让提醒失效。
      if (typeof onCompletionNotice === "function") {
        if (completionDelivery.consumedPause(notice)) return;
        await onCompletionNotice(notice);
        return;
      }
      completionDelivery.enqueue(notice);
      return;
    }
    if (notice?.event === STALL_NOTICE_EVENT) {
      // 只叫醒，不销账：任务仍在跟踪，终态通知照常投递。
      if (typeof onCompletionNotice === "function") await onCompletionNotice(notice);
      else await sendCompletionMessage(pi, "subagent-stall", taskStallText(notice), notice);
      return;
    }
    if (typeof onCompletionNotice === "function") {
      await onCompletionNotice(notice);
      if (notice.result_retryable !== true) recordTracking(pi, "task", "complete", [notice.task_id]);
    } else completionDelivery.enqueue(notice);
  };
  const deliverFleetNotice = async (notice) => {
    if (branchBinding && !branchBinding.active) return;
    if (typeof onFleetCompletionNotice === "function") await onFleetCompletionNotice(notice);
    else await sendCompletionMessage(pi, "fleet-completion", fleetCompletionText(notice), notice);
    if (notice.event === FLEET_COMPLETION_NOTICE_EVENT && notice.driver_status !== "needs_parent_review"
      && (!notice.watch_generation || notice.watch_generation === fleetCompletionWatcher?.watchGeneration(notice.run_id))) {
      recordTracking(pi, "fleet", "complete", [notice.run_id]);
    }
  };

  const deliverRecoveryNotice = async (recovery) => {
    if (branchBinding) return; // Inherited work is context, not this branch's managed activity.
    const taskIds = (Array.isArray(recovery?.tasks) ? recovery.tasks : [])
      .map((task) => String(task?.task_id ?? ""))
      .filter(Boolean)
      .sort();
    // 同一来源（本会话分支）已提示过的同一故障不再重复刷屏；故障变化或解除后仍会提示。
    const freshErrors = (recovery?.observation_errors ?? []).filter(item => !notifiedRecoveryFaults.has(recoveryFaultKey(item)));
    const errors = freshErrors.map(item => [item.task_id, item.error]).sort();
    if (taskIds.length === 0 && errors.length === 0) return;
    const key = JSON.stringify([recovery?.session_id ?? "pi-session", taskIds, errors]);
    if (deliveredRecoveryKeys.has(key)) return;
    // 恢复提示只是现场观察，不开新一轮：它在 session_start 里发出，若在此触发回合，
    // 尚未跑到 session_start 的扩展（如上下文裁剪）会以空状态参与这一轮请求。
    await sendCompletionMessage(pi, "subagent-recovery", taskRecoveryText({ ...recovery, observation_errors: freshErrors }), recovery, { triggerTurn: false });
    deliveredRecoveryKeys.add(key);
    try {
      const freshFaults = freshErrors.map(recoveryFaultKey);
      recordRecoveryFaults(pi, freshFaults);
      for (const fault of freshFaults) notifiedRecoveryFaults.add(fault);
    } catch (error) {
      // 去重登记失败不撤回已投递的提醒，也不阻断后续恢复提示。
      completionDelivery.lastError = error;
    }
  };

  const completionWatcher = durableAsyncService && enableCompletionWatcher
    ? createCompletionWatcher({
      service: durableAsyncService,
      reconcileInput: asyncServiceOptions?.reconcileInput ?? { task_ids: [] },
      onNotice: deliverTaskNotice,
      onRecovery: deliverRecoveryNotice,
    })
    : null;
  const fleetCompletionWatcher = enableFleetCompletionWatcher
    ? createFleetCompletionWatcher({
      fleet: resolvedFleetCore,
      onNotice: deliverFleetNotice,
      isIdle: () => Boolean(sessionContext) && (sessionContext.isIdle?.() ?? true),
      onRead: read => {
        pi.appendEntry?.(TRACKING_ENTRY_TYPE, { target: "fleet", action: "read", ids: [read.run_id], ...read });
        if (["completed", "failed", "blocked", "cancelled"].includes(read.driver_status)) {
          recordTracking(pi, "fleet", "complete", [read.run_id]);
        }
      },
      waitMs: fleetWatcherWaitMs,
      noticeRetryBaseMs: fleetNoticeRetryBaseMs,
      noticeRetryMaxMs: fleetNoticeRetryMaxMs,
    })
    : null;

  const lifecycleTools = durableAsyncService
    ? createSubagentLifecycleTools({
      service: durableAsyncService,
      onResumed: async (result) => {
        completionDelivery.invalidateTask(result.task_id);
        const receipt = await handleSubmitted({ task_ids: [result.task_id] });
        try {
          recordTracking(pi, "task", "invalidate_reads", [result.task_id]);
        } catch (error) {
          receipt.post_submit_failures = [...(receipt.post_submit_failures ?? []), {
            step: "resume_read_invalidation", error: String(error?.message ?? error),
          }];
        }
        return receipt;
      },
    })
    : [];
  const ensureAgentPanel = enableAgentPanelLaunch
    ? (agentPanelEnsurer
      ?? (runtimeRoot
        ? createAgentPanelEnsurer({ runtimeRoot, projectRoot, mode, manifest, cwd: projectRoot })
        : createAgentPanelEnsurer()))
    : null;
  const handleSubmitted = async (submission) => {
    branchBinding?.trackTasks(submission.task_ids ?? []);
    // The durable submit receipt is authoritative. Every convenience action runs
    // independently so none can hide an already-committed task id.
    const postSubmitFailures = [];
    const recordFailure = (step, error) => {
      postSubmitFailures.push({
        step,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    try {
      recordTracking(pi, "task", "track", submission.task_ids);
    } catch (error) {
      recordFailure("record_tracking", error);
    }
    if (completionWatcher) {
      try {
        await completionWatcher.trackTaskIds(submission.task_ids);
      } catch (error) {
        recordFailure("completion_watcher", error);
      }
    }
    let agentPanelLaunch;
    if (ensureAgentPanel) {
      try {
        agentPanelLaunch = await ensureAgentPanel(submission);
      } catch (error) {
        recordFailure("agent_panel_launch", error);
      }
    }
    return {
      ...(agentPanelLaunch ? { agent_panel_launch: agentPanelLaunch } : {}),
      ...(postSubmitFailures.length > 0 ? { post_submit_failures: postSubmitFailures } : {}),
    };
  };
  const handleFleetStarted = async ({ run_id }) => {
    branchBinding?.trackFleet(run_id);
    recordTracking(pi, "fleet", "track", [run_id]);
    const watch = fleetCompletionWatcher
      ? fleetCompletionWatcher.trackRunIds([run_id])
      : { added: [], watched: [] };
    return {
      completion_watch: {
        status: fleetCompletionWatcher ? "watching" : "disabled",
        run_ids: watch.added,
      },
    };
  };
  // 派发出去的 task 与 Fleet run 是脱离当前 agent run 的独立进程；本会话对它们的唯一责任是
  // 活着等终态并投递通知。宿主空闲回收只看 agent run 是否在跑，看不到这些在途工作。
  const hasDetachedWork = () => Boolean(
    completionWatcher?.watchedTaskIds?.size
    || fleetCompletionWatcher?.watchedRunIds?.size
    || completionDelivery?.pending?.size
    || delegateWork?.core?.list().some(work => ["starting", "running", "pausing", "finalizing"].includes(work.state)),
  );

  const startSession = async (_event, ctx) => {
    releaseSessionLiveness();
    sessionContext = ctx ?? {};
    sessionFast = false;
    branchBinding = workBranchBinding(sessionIdFrom(ctx)) ?? null;
    branchBinding?.attachServices({ asyncService: durableAsyncService, fleetCore: resolvedFleetCore });
    completionDelivery.reset();
    // 恢复提示去重按本分支的持久记录重建：重载后同一故障不再重复刷屏。
    notifiedRecoveryFaults.clear();
    for (const fault of restoredRecoveryFaults(ctx)) notifiedRecoveryFaults.add(fault);
    const fleetReads = [];
    for (const entry of trackingEntries(ctx)) {
      if (entry?.type === "custom_message" && ["subagent-pause", "subagent-completion"].includes(entry.customType)) {
        // 已落盘的暂停提醒是「已投递」的持久记录：重载后不重复提醒，但它不是已读。
        for (const notice of entry.details?.notices ?? [entry.details]) {
          if (notice?.task_id && notice.event === PAUSE_NOTICE_EVENT) completionDelivery.rememberNotified(notice);
        }
      }
      if (entry?.type !== "custom" || entry.customType !== TRACKING_ENTRY_TYPE) continue;
      const data = entry.data ?? {};
      if (data.target === "fleet") {
        if (data.action === "read") fleetReads.push(data);
        continue;
      }
      for (const task_id of normalizedIds(data.ids)) {
        if (data.action === "invalidate_reads") completionDelivery.invalidateTask(task_id);
        if (data.action === "read") completionDelivery.rememberRead({
          task_id, revision: data.revision, kind: data.kind,
          result_tracking_version: data.result_tracking_version ?? null,
          terminal_fingerprint: data.terminal_fingerprint ?? null,
        }, false);
      }
    }
    const restored = branchBinding
      ? { taskIds: branchBinding.taskIds, runIds: branchBinding.runIds }
      : restoredTracking(ctx);
    if (completionWatcher) {
      await completionWatcher.resetSession({
        sessionId: sessionIdFrom(ctx),
        taskIds: restored.taskIds,
      });
      await completionWatcher.start();
    }
    if (fleetCompletionWatcher) {
      await fleetCompletionWatcher.resetSession({ runIds: restored.runIds, reads: fleetReads });
      fleetCompletionWatcher.start();
    }
    livenessLease = registerSessionLiveness({
      name: "subagent-control",
      sessionId: sessionIdFrom(ctx),
      sessionFile: sessionFileFrom(ctx),
      isActive: hasDetachedWork,
    });
  };

  // 生命周期工具注册即常驻：会话中途增删活动工具会改变下一轮的工具定义与系统提示词工具清单，
  // 服务端提示缓存从改动处整段失效（09-25 主会话诊断：派发后轮首只命中约 1 万 token）。
  const delegateWork = enableDelegateWork ? installDelegateWork(pi, {
    runtimeRoot, projectRoot, mode, manifest, ...delegateWorkOptions,
  }) : null;

  pi.on("before_provider_request", (event) => {
    sessionFast = isFastPayload(event.payload);
    return undefined;
  });
  pi.on("session_start", startSession);
  pi.on("agent_settled", () => completionDelivery.schedule());
  pi.on("message_end", (event, ctx) => {
    const message = event?.message;
    if (message?.role !== "custom") return;
    if (message.customType !== "subagent-completion" && message.customType !== "subagent-pause") return;
    const notices = message.details?.notices ?? [message.details];
    completionDelivery.acknowledge(notices.filter(notice => notice?.session_id === sessionIdFrom(ctx)));
  });

  if (durableAsyncService && enableNativeDispatch) {
    pi.registerTool(createDispatchPrepareTool({
      service: durableAsyncService,
      ...(dispatchCompiler ? { compiler: dispatchCompiler } : {}),
      onSubmitted: handleSubmitted,
      currentFast: () => sessionFast,
    }));
  }
  for (const lifecycleTool of lifecycleTools) {
    const observed = observeReads(lifecycleTool);
    pi.registerTool(delegateWork ? delegateWork.wrapControl(observed) : observed);
  }
  for (const fleetTool of createFleetTools({ core: resolvedFleetCore, onRunStarted: handleFleetStarted })) {
    pi.registerTool(fleetTool);
  }

  if (contextOptions) pi.on("session_before_compact", createContextHook(pi, contextOptions));

  pi.on("session_shutdown", async () => {
    releaseSessionLiveness();
    sessionContext = null;
    completionDelivery.stop();
    await completionWatcher?.stop();
    fleetCompletionWatcher?.stop();
  });

  return {
    asyncService: durableAsyncService,
    completionDelivery,
    completionWatcher,
    fleetCompletionWatcher,
    delegateWork,
    // 由 session_start 内部装配本扩展的调用方用它显式补跑一次启动逻辑。
    startSession,
  };
}
