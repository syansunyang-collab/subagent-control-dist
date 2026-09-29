#!/usr/bin/env node
// ops/tools/dispatch_prepare.py 的 CLI 同形复刻：flag 集合、choices、默认值与 main() 分支顺序一致，
// 退出码经 dispatch-core/_tool_common.mjs 的 emit()。编排逻辑全在 dispatch-core/dispatch_prepare.mjs。
import process from "node:process";

import {
  ToolError,
  agentPanelLaunchText,
  asyncSubagentReadiness,
  attachAgentPanelLaunch,
  checkRouteCard,
  currentDispatchPhase,
  probePiChildModelCatalog,
  emit,
  isPyCaughtError,
  loadSeeds,
  normalizeDispatchAction,
  prepareBatchDispatch,
  prepareDispatch,
  renderTemplate,
  routesWithCards,
  selfTest,
  sliceMetadata,
} from "./dispatch-core/dispatch_prepare.mjs";

import { ROOT, modelConfigSources } from "./dispatch-core/_tool_common.mjs";
import { loadSelectionConfig, projectCatalog } from "./dispatch-core/model_selection.mjs";
import { selectionSummary } from "./dispatch-core/model_selection_guidance.mjs";
import { renderCatalogText } from "./_dispatch-catalog-text.mjs";

const PROGRAM = "dispatch_prepare.mjs";

// argparse 的 24 个参数：值参 20 个 + store_true 4 个。default 与 choices 逐条对齐 parse_args()。
const VALUE_FLAGS = {
  "--seed": { dest: "seed", default: null },
  "--seed-template": { dest: "seed_template", default: null },
  "--card-check": { dest: "card_check", default: null },
  "--route-id": { dest: "route_id", default: "" },
  "--sample-route": { dest: "sample_route", default: null },
  "--delivery": { dest: "delivery", default: "auto", choices: ["auto", "async-subagent"] },
  "--action": { dest: "action", default: "", choices: ["preview", "prepare", "submit"] },
  "--batch-id": { dest: "batch_id", default: "" },
  "--origin-id": { dest: "origin_id", default: "" },
  "--async-pick": { dest: "async_pick", default: "" },
  "--async-model": { dest: "async_model", default: "" },
  "--async-authorization": { dest: "async_authorization", default: "" },
  "--async-effort": { dest: "async_effort", default: "" },
  "--async-context-mode": { dest: "async_context_mode", default: "project-aware", choices: ["isolated", "project-aware"] },
  "--async-runner-path": { dest: "async_runner_path", default: "" },
  // 隐藏兼容参数：接受且只接受 pi，取值不参与任何解析。待 adapter 侧同步后删。
  "--async-task-root": { dest: "async_task_root", default: "" },
  "--async-target-cwd": { dest: "async_target_cwd", default: "" },
  "--async-execution-profile": { dest: "async_execution_profile", default: "", choices: ["standard", "simulation"] },
  "--async-stall-silence-ms": { dest: "async_stall_silence_ms", default: null, type: "int" },
  "--format": { dest: "format", default: "text", choices: ["text", "json"] },
  "--model-scope": { dest: "model_scope", default: "recommended", choices: ["recommended", "all"] },
};

const FLAG_TRUE = {
  "--seed-stdin": "seed_stdin",
  "--list": "list",
  "--allow-sample-pending": "allow_sample_pending",
  "--self-test": "self_test",
};

const USAGE = `usage: ${PROGRAM} [-h] [--seed SEED] [--seed-stdin] [--seed-template SEED_TEMPLATE]
                          [--card-check CARD_CHECK] [--list] [--route-id ROUTE_ID]
                          [--sample-route SAMPLE_ROUTE] [--delivery {auto,async-subagent}]
                          [--action {preview,prepare,submit}] [--batch-id BATCH_ID]
                          [--origin-id ORIGIN_ID] [--allow-sample-pending]
                          [--async-pick ASYNC_PICK] [--async-model ASYNC_MODEL]
                          [--async-effort ASYNC_EFFORT]
                          [--async-authorization ASYNC_AUTHORIZATION]
                          [--async-context-mode {isolated,project-aware}]
                          [--async-runner-path ASYNC_RUNNER_PATH]
                          [--async-task-root ASYNC_TASK_ROOT]
                          [--async-target-cwd ASYNC_TARGET_CWD]
                          [--async-execution-profile {standard,simulation}]
                          [--async-stall-silence-ms ASYNC_STALL_SILENCE_MS]
                          [--format {text,json}] [--model-scope {recommended,all}] [--self-test]`;

function argparseError(message) {
  process.stderr.write(`${USAGE}\n${PROGRAM}: error: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { seed_stdin: false, list: false, allow_sample_pending: false, self_test: false };
  for (const spec of Object.values(VALUE_FLAGS)) args[spec.dest] = spec.default;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "-h" || token === "--help") {
      process.stdout.write(`${USAGE}\n\n从 package_seed 构建子代理任务包并生成派发结果。\n`);
      process.exit(0);
    }
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq > 0 ? token.slice(0, eq) : token;
    const inlineValue = token.startsWith("--") && eq > 0 ? token.slice(eq + 1) : null;
    if (Object.hasOwn(FLAG_TRUE, name)) {
      if (inlineValue !== null) argparseError(`argument ${name}: ignored explicit argument '${inlineValue}'`);
      args[FLAG_TRUE[name]] = true;
      continue;
    }
    const spec = VALUE_FLAGS[name];
    if (!spec) argparseError(`unrecognized arguments: ${token}`);
    let value = inlineValue;
    if (value === null) {
      index += 1;
      if (index >= argv.length) argparseError(`argument ${name}: expected one argument`);
      value = String(argv[index]);
    }
    if (spec.choices && !spec.choices.includes(value)) {
      argparseError(`argument ${name}: invalid choice: '${value}' (choose from ${spec.choices.map((item) => `'${item}'`).join(", ")})`);
    }
    if (spec.type === "int") {
      if (!/^[+-]?\d+$/.test(value.trim())) argparseError(`argument ${name}: invalid int value: '${value}'`);
      args[spec.dest] = Number.parseInt(value.trim(), 10);
      continue;
    }
    args[spec.dest] = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.model_scope !== "recommended" && !args.list) throw new ToolError("--model-scope 仅用于 --list");
  if (args.self_test) {
    const data = await selfTest();
    const text = data.status === "ok"
      ? "dispatch_prepare self-test passed"
      : "dispatch_prepare self-test failed\n提示：自测部分断言读取活配置（route 卡 / agents toml），失败时先检查配置是否刚变更。";
    return emit(data, args.format, text);
  }
  if (args.seed_template) {
    process.stdout.write(`${renderTemplate(args.seed_template)}\n`);
    return 0;
  }
  if (args.card_check) {
    const targets = args.card_check === "all" ? routesWithCards() : [args.card_check];
    if (!targets.length) throw new ToolError("no route cards found");
    const results = {};
    for (const rid of targets) {
      try {
        checkRouteCard(rid);
        results[rid] = "pass";
      } catch (error) {
        if (!isPyCaughtError(error, new Set(["ToolError", "KeyError", "ValueError"]))) throw error;
        results[rid] = `fail: ${error.message}`;
      }
    }
    const failed = Object.entries(results).filter(([, value]) => value !== "pass");
    const data = { status: failed.length ? "failed" : "ok", results };
    const text = Object.entries(results).map(([rid, value]) => `${rid}: ${value}`).join("\n");
    return emit(data, args.format, text);
  }
  if (args.list) {
    // 默认精简到推荐与笔记；all 显式返回当前 Pi 目录，仍标明配置中不可用的模型。
    const config = loadSelectionConfig(modelConfigSources());
    const [role, capability = ""] = args.route_id ? args.route_id.split("__") : [];
    if (capability && !config.routes.some((route) => route.route_id === args.route_id)) {
      throw new ToolError(`未知路由：${args.route_id}；省略 route_id 查看全部路由`);
    }
    const probed = probePiChildModelCatalog(ROOT);
    if (args.model_scope === "all" && probed.status !== "ok") {
      throw new ToolError(`完整模型目录读取失败：${probed.error || probed.status}`);
    }
    const catalog = projectCatalog(config, {
      piModels: probed.status === "ok" ? probed.models : null,
      ...(role ? { role, capability } : {}),
    });
    const used = new Set(catalog.roles.flatMap((item) => item.picks.map((pick) => pick.model)));
    const projected = {
      ...catalog,
      model_scope: args.model_scope,
      model_catalog_source: probed.source,
      models: args.model_scope === "all" ? catalog.models
        : catalog.models.filter((item) => used.has(item.model) || config.notes.has(item.model)),
    };
    if (args.format === "json") process.stdout.write(`${JSON.stringify(projected)}\n`);
    else process.stdout.write(`${renderCatalogText(projected).join("\n")}\n`);
    return 0;
  }
  const effectiveAction = normalizeDispatchAction(args.action);
  if (args.sample_route && !args.allow_sample_pending && effectiveAction === "submit") {
    const sampleWouldSubmitAsync = args.delivery === "async-subagent"
      || (args.delivery === "auto" && asyncSubagentReadiness().status === "available");
    if (sampleWouldSubmitAsync) {
      throw new ToolError(
        "--sample-route with async delivery would submit a background task; "
        + "use --action preview to preview the sample or --allow-sample-pending for an intentional dispatch sample",
      );
    }
  }
  const seeds = loadSeeds(args);
  if (seeds.length === 1) {
    const [singleSliceId, singleTitle] = sliceMetadata(seeds[0], 0);
    const data = prepareDispatch(seeds[0], args.delivery, {
      action: effectiveAction,
      asyncPick: args.async_pick,
      asyncAuthorization: args.async_authorization,
      asyncModel: args.async_model,
      asyncEffort: args.async_effort,
      asyncContextMode: args.async_context_mode,
      asyncRunnerPath: args.async_runner_path,
      asyncTaskRoot: args.async_task_root,
      asyncTargetCwd: args.async_target_cwd,
      asyncExecutionProfile: args.async_execution_profile,
      asyncStallSilenceMs: args.async_stall_silence_ms,
      asyncBatchId: args.batch_id,
      asyncSliceId: args.batch_id ? singleSliceId : "",
      asyncDisplayTitle: singleTitle,
      originId: args.origin_id || null,
    });
    await attachAgentPanelLaunch(data, { dryRun: effectiveAction === "preview" });
    const payload = data.spawn_payload || `PREPARED_DISPATCH: ${data.descriptor_file}`;
    let text = `status=${data.status} action=${Object.hasOwn(data, "action") ? data.action : effectiveAction} delivery_mode=${data.delivery_mode} `
      + `agent_type=${data.agent_type} package_id=${data.package_id}\n${payload}`;
    const preflightWarning = data.scope_preflight.scope_preflight_warning;
    if (preflightWarning) text += `\n\n提示：${preflightWarning}`;
    const selected = data.async_preview?.selection || data.async_model_selection?.selection || data.selection;
    if (selected) {
      data.selection_summary = selectionSummary(selected);
      text += `\n选型：${data.selection_summary}`;
    }
    text += agentPanelLaunchText(data);
    return emit(data, args.format, text);
  }
  const data = prepareBatchDispatch(seeds, args.delivery, {
    batchId: args.batch_id,
    action: effectiveAction,
    asyncPick: args.async_pick,
    asyncAuthorization: args.async_authorization,
    asyncModel: args.async_model,
    asyncEffort: args.async_effort,
    asyncContextMode: args.async_context_mode,
    asyncRunnerPath: args.async_runner_path,
    asyncTaskRoot: args.async_task_root,
    asyncTargetCwd: args.async_target_cwd,
    asyncExecutionProfile: args.async_execution_profile,
    asyncStallSilenceMs: args.async_stall_silence_ms,
    originId: args.origin_id || null,
  });
  await attachAgentPanelLaunch(data, { dryRun: effectiveAction === "preview" });
  const dispatches = data.dispatches;
  for (const item of dispatches) {
    const selected = item.async_preview?.selection || item.async_model_selection?.selection || item.selection;
    if (selected) item.selection_summary = selectionSummary(selected);
  }
  const failedIndexes = data.failed_seed_indexes;
  const notSubmittedIndexes = data.not_submitted_seed_indexes;
  let text = dispatches.map((item, idx) => `[${idx + 1}/${dispatches.length}] status=${item.status} `
    + (item.status === "ok"
      ? `delivery_mode=${item.delivery_mode} agent_type=${item.agent_type} package_id=${item.package_id} 选型=${selectionSummary(item.async_preview?.selection || item.async_model_selection?.selection || item.selection)}\n`
        + `${item.spawn_payload || `PREPARED_DISPATCH: ${item.descriptor_file || ""}`}`
      : `seed_index=${item.seed_index} error=${item.error}`)).join("\n\n");
  if (failedIndexes.length) {
    text += `\n\n批量派发部分失败：batch_id=${data.batch_id}，失败 seed 序号 ${pyListRepr(failedIndexes)}；`
      + `未提交 seed 序号 ${notSubmittedIndexes.length ? pyListRepr(notSubmittedIndexes) : "(无)"}；`
      + `已提交 task_id：${data.committed_task_ids.length ? pyListRepr(data.committed_task_ids) : "(无)"}。`
      + "失败项和未提交项都不会自动重试，修正对应 seed 后单独重发。";
  } else if (effectiveAction === "preview") {
    text += `\n\n以上为 batch_id=${data.batch_id} 的 preview 预览：未提交 async 任务。`;
  } else if (effectiveAction === "prepare") {
    text += `\n\n批量 prepare 完成：batch_id=${data.batch_id}，已写入 prepared workspace；未提交 async 任务。`;
  } else {
    text += `\n\n批量派发完成：batch_id=${data.batch_id}，task_id=${pyListRepr(data.committed_task_ids)}。`;
  }
  const preflightWarnings = dispatches
    .map((item, idx) => [idx, (item.scope_preflight || {}).scope_preflight_warning])
    .filter(([, warning]) => warning)
    .map(([idx, warning]) => `[${idx + 1}/${dispatches.length}] ${warning}`);
  if (preflightWarnings.length) text += `\n\n提示：\n${preflightWarnings.join("\n")}`;
  text += agentPanelLaunchText(data);
  return emit(data, args.format, text);
}

/** Python f-string 里列表的 str()：['a', 'b'] 形态。 */
function pyListRepr(values) {
  return `[${values.map((item) => (typeof item === "string" ? `'${item}'` : String(item))).join(", ")}]`;
}

/** Emit top-level failures in the caller-selected stable CLI shape. */
function emitCliError(error) {
  const argv = process.argv;
  const jsonRequested = argv.some((arg, index) => arg === "--format=json"
    || (arg === "--format" && index + 1 < argv.length && argv[index + 1] === "json"));
  if (jsonRequested) {
    process.stdout.write(`${JSON.stringify({
      status: "error",
      stage: currentDispatchPhase(),
      message: String(error?.message ?? error),
    })}\n`);
  } else {
    process.stderr.write(`error: ${String(error?.message ?? error)}\n`);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (!isPyCaughtError(error, new Set(["ToolError", "KeyError", "OSError", "ValueError"]))) throw error;
  emitCliError(error);
  process.exitCode = 1;
}
