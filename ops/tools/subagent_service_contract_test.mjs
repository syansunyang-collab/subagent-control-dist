#!/usr/bin/env node
// 测试对象是 subagent_service.mjs 的服务合同(MCP 工具面、注册表、CAS、dispatch 信封与 fleet 命令),不覆盖 run-pi-task runner 内部逻辑。
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureDir } from "./_fs-utils.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const contractTestDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(path.dirname(contractTestDir));
const serverArgIndex = process.argv.indexOf("--server");
const source = serverArgIndex >= 0
  ? path.resolve(process.argv[serverArgIndex + 1] || "")
  : path.join(contractTestDir, "subagent_service.mjs");
if (!existsSync(source)) {
  throw new Error(`MCP server does not exist: ${source}`);
}
const serverModule = await import(pathToFileURL(source).href);
const sourceFacadePath = path.resolve(contractTestDir, "subagent_service.mjs");
const distFacadePath = path.resolve(repoRoot, "ops", "dist", "subagent_service.bundle.mjs");
const sourceFacadeModule = source === sourceFacadePath
  ? serverModule
  : await import(pathToFileURL(sourceFacadePath).href);
const distFacadeModule = source === distFacadePath
  ? serverModule
  : await import(pathToFileURL(distFacadePath).href);
const EXPECTED_FACADE_EXPORTS = Object.freeze([
  "CONTRACT_VERSION",
  "DISPATCH_ENVELOPE_VERSION",
  "PUBLIC_TOOL_NAMES",
  "SUPPORTED_DISPATCH_ENVELOPE_VERSIONS",
  "WRITE_CLAIM_CONTRACT_VERSION",
  "isTrustedRunnerPath",
  "registerFleetTools",
  "registerPublicTools",
  "resolveSubagentCoreOptions",
  "resolveTrustedRunnerPath",
]);
// 发布 bundle 另导出 createAsyncTaskCore，供面板从发布槽加载 Core（build_subagent_bundle.mjs）。
const EXPECTED_DIST_FACADE_EXPORTS = Object.freeze([...EXPECTED_FACADE_EXPORTS, "createAsyncTaskCore"].sort());
const exportNames = (module) => Object.keys(module).sort();
const {
  CONTRACT_VERSION,
  DISPATCH_ENVELOPE_VERSION,
  PUBLIC_TOOL_NAMES,
  SUPPORTED_DISPATCH_ENVELOPE_VERSIONS,
  resolveSubagentCoreOptions,
  resolveTrustedRunnerPath,
  isTrustedRunnerPath,
} = serverModule;
const serverDir = path.dirname(source);

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolverOptions(overrides = {}) {
  return resolveSubagentCoreOptions({
    entryPath: source,
    cwd: repoRoot,
    home: os.homedir(),
    env: { ...process.env, SUBAGENT_ALLOW_CUSTOM_RUNNER: "0", ...(overrides.env || {}) },
    ...overrides,
  });
}


function snapshot(files) {
  return Object.fromEntries(files.map((file) => [file, existsSync(file) ? readFileSync(file) : null]));
}

function sameSnapshot(left, right) {
  return Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([file, content]) => Object.hasOwn(right, file)
      && (content === null ? right[file] === null : Buffer.isBuffer(right[file]) && content.equals(right[file])));
}

function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3);
}

function hasBannedKey(value, banned) {
  if (Array.isArray(value)) {
    return value.some((item) => hasBannedKey(item, banned));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(([key, item]) => banned.has(key) || hasBannedKey(item, banned));
}

function structured(result, label) {
  if (result?.isError || !result?.structuredContent) {
    throw new Error(`${label} failed: ${JSON.stringify(result)}`);
  }
  return result.structuredContent;
}

function makeDispatch(root, name, model, options = {}) {
  const preparedDir = path.join(root, "tmp", "dispatch_prepare");
  const taskFile = path.join(preparedDir, `${name}.task.md`);
  const dispatchFile = path.join(preparedDir, `${name}.dispatch.json`);
  const taskRoot = path.join(root, ".runtime", "async_tasks");
  ensureDir(preparedDir);
  writeFileSync(taskFile, `contract test ${name}\n`, "utf8");
  writeJson(dispatchFile, {
    contract_version: DISPATCH_ENVELOPE_VERSION,
    producer_root: root,
    target_cwd: options.targetCwd || root,
    task_file: taskFile,
    task_root: taskRoot,
    runner_path: options.runnerPath || path.join(root, "ops", "tools", "run-pi-task.mjs"),
    runtime_role: "contract-test",
    model,
    effort: "low",
    origin_thread_id: "contract-thread",
    context_mode: "isolated",
    execution_profile: options.executionProfile || "standard",
    result_mode: options.resultMode || null,
    simulation: null,
    budget: {},
  });
  return { dispatchFile, taskRoot };
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // 回执与 diagnostic 的 token 预算随绝对路径长度变化；假仓放在定长临时目录，结果不随检出位置（主仓 / worktree）漂移。
  const root = mkdtempSync(path.join(os.tmpdir(), "amc-"));
  const registryRoot = path.join(root, "registry");
  const runner = path.join(root, "ops", "tools", "run-pi-task.mjs");
  ensureDir(path.dirname(runner));
  writeFileSync(
    runner,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const args=process.argv.slice(2);",
      "const pick=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:''};",
      "const out=pick('--outDir'); const model=pick('--model');",
      "mkdirSync(out,{recursive:true});",
      "if(model==='contract-slow'){await new Promise((r)=>setTimeout(r,2500));}else{await new Promise((r)=>setTimeout(r,120));}",
      "writeFileSync(path.join(out,'report.md'),'# contract report\\n\\ncompact result test.\\n','utf8');",
      "writeFileSync(path.join(out,'handoff.md'),'verdict: completed\\nsummary: compact contract result.\\nmechanical_check: pass\\n','utf8');",
      "writeFileSync(path.join(out,'child-final.md'),'## 结论\\n任务状态：completed\\n\\n## 事实与证据\\nreport.md\\n\\n## 已检查内容\\ncontract\\n\\n## 失败检查\\nnone\\n\\n## 不确定项\\nnone\\n\\n## 边界\\ncontract test\\n','utf8');",
      "const noTool=model==='contract-no-tool';",
      "writeFileSync(path.join(out,'child-task-live.json'),JSON.stringify({rev:1,status:'done',phase:'completed',updated_at:new Date().toISOString(),last_event_at:new Date().toISOString(),tool_call_counts:noTool?[]:[{key:'shell_command',count:1}]},null,2),'utf8');",
      "writeFileSync(path.join(out,'child-task-events.jsonl'),noTool?'':JSON.stringify({type:'tool_call',name:'shell_command',status:'completed'})+'\\n','utf8');",
      "writeFileSync(path.join(out,'child-task-result.json'),JSON.stringify({ok:true,status:'done',turn:{id:'turn-contract',startAck:true,status:'completed'},orchestration:{ok:true,status:'completed'},task:{ok:true,status:'completed'}},null,2),'utf8');",
    ].join("\n"),
    "utf8",
  );

  const completedDispatch = makeDispatch(root, "completed", "contract-fast");
  const cancelDispatch = makeDispatch(root, "cancel", "contract-slow");
  const missingOriginDispatch = makeDispatch(root, "missing-origin", "contract-fast");
  const missingOriginEnvelope = JSON.parse(readFileSync(missingOriginDispatch.dispatchFile, "utf8"));
  delete missingOriginEnvelope.origin_thread_id;
  writeJson(missingOriginDispatch.dispatchFile, missingOriginEnvelope);
  const legacyDispatch = makeDispatch(root, "legacy-v1", "contract-fast");
  const legacyEnvelope = JSON.parse(readFileSync(legacyDispatch.dispatchFile, "utf8"));
  legacyEnvelope.contract_version = "async-dispatch/v1";
  delete legacyEnvelope.origin_thread_id;
  writeJson(legacyDispatch.dispatchFile, legacyEnvelope);
  const secondProducerRoot = path.join(root, "second-producer");
  const secondProducerDispatch = makeDispatch(secondProducerRoot, "second-producer", "contract-fast", {
    runnerPath: runner,
  });
  const crossRepoTarget = path.join(root, "target-repo");
  ensureDir(crossRepoTarget);
  const realRerunDispatch = makeDispatch(root, "real-rerun", "contract-fast", {
    runnerPath: runner,
    targetCwd: crossRepoTarget,
    resultMode: "real_rerun",
  });
  const unattestedRerunDispatch = makeDispatch(root, "real-rerun-no-tool", "contract-no-tool", {
    runnerPath: runner,
    targetCwd: crossRepoTarget,
    resultMode: "real_rerun",
  });
  const missingResultModeDispatch = makeDispatch(root, "missing-result-mode", "contract-fast", {
    runnerPath: runner,
    targetCwd: crossRepoTarget,
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [source, "mcp"],
    cwd: repoRoot,
    // 合同测试的 stub runner 位于临时假仓（服务目录之外），需显式开测试豁免；生产槽不设此变量。
    env: { ...process.env, SUBAGENT_REGISTRY_ROOT: registryRoot, SUBAGENT_ALLOW_CUSTOM_RUNNER: "1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "async-mcp-contract-test", version: "1.0.0" });
  const checks = {};
  checks.direct_file_comparison = sameSnapshot({ a: Buffer.from("x"), b: null }, { a: Buffer.from("x"), b: null })
    && !sameSnapshot({ a: Buffer.from("x") }, { a: Buffer.from("y") })
    && !sameSnapshot({ a: null }, { a: Buffer.alloc(0) });
  const skips = {};
  const metrics = {};
  let cleanupError = "";
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    checks.selected_facade_export_set_exact = (
      JSON.stringify(exportNames(serverModule))
        === JSON.stringify(source === distFacadePath ? EXPECTED_DIST_FACADE_EXPORTS : EXPECTED_FACADE_EXPORTS)
    );
    checks.source_facade_export_set_exact = (
      JSON.stringify(exportNames(sourceFacadeModule)) === JSON.stringify(EXPECTED_FACADE_EXPORTS)
    );
    checks.dist_facade_export_set_exact = (
      JSON.stringify(exportNames(distFacadeModule)) === JSON.stringify(EXPECTED_DIST_FACADE_EXPORTS)
    );
    checks.public_tool_surface_matches_runtime_source = (
      JSON.stringify(names) === JSON.stringify(PUBLIC_TOOL_NAMES)
    );
    checks.schemas_and_annotations_present = listed.tools.every(
      (tool) => tool.inputSchema && tool.annotations?.openWorldHint === false
        // subagent_prepare 只回文本：带 structuredContent 时 Claude Code 会丢掉正文。
        && (tool.name === "subagent_prepare" ? !tool.outputSchema : tool.outputSchema),
    );
    const listedByName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
    const pauseTool = listedByName.subagent_pause;
    const pauseRequired = pauseTool?.inputSchema?.required ?? [];
    checks.pause_tool_registered_with_cancel_cas = Boolean(pauseTool)
      && JSON.stringify(pauseRequired) === JSON.stringify(["task_id", "expected_revision", "reason"])
      && pauseTool.inputSchema?.properties?.task_root?.type === "string"
      && pauseTool.annotations?.destructiveHint === false
      && pauseTool.description.includes("协作暂停")
      && pauseTool.description.includes("不自动强杀");
    checks.resume_description_covers_paused_and_new_instruction = (
      listedByName.subagent_resume?.description?.includes("paused")
      && listedByName.subagent_resume?.description?.includes("新的继续指令")
      && JSON.stringify(listedByName.subagent_resume?.inputSchema?.required ?? []) === JSON.stringify(["task_id", "expected_revision"])
    );
    checks.cancel_parameters_unchanged = (
      JSON.stringify(listedByName.subagent_cancel?.inputSchema?.required ?? []) === JSON.stringify(["task_id", "expected_revision", "reason"])
      && !Object.hasOwn(listedByName.subagent_cancel?.inputSchema?.properties ?? {}, "task_root")
    );
    checks.submit_and_cancel_are_explicitly_non_idempotent = (
      listedByName.subagent_submit_prepared?.annotations?.idempotentHint === false
      && listedByName.subagent_cancel?.annotations?.idempotentHint === false
    );
    checks.read_annotations_match_contract = listed.tools
      .filter((tool) => ["subagent_wait", "subagent_get", "subagent_result"].includes(tool.name))
      .every((tool) => tool.annotations?.readOnlyHint === true);
    checks.public_v1_schemas_omit_origin_thread_id = (
      !Object.hasOwn(listedByName.subagent_submit_prepared?.outputSchema?.properties ?? {}, "origin_thread_id") &&
      !Object.hasOwn(
        listedByName.subagent_get?.outputSchema?.properties?.tasks?.items?.properties ?? {},
        "origin_thread_id",
      ) &&
      !Object.hasOwn(listedByName.subagent_result?.outputSchema?.properties ?? {}, "origin_thread_id")
    );
    const fleetToolNames = ["fleet_start", "fleet_status", "fleet_wait", "fleet_review", "fleet_cancel"];
    checks.public_tool_surface_carries_fleet_tools = fleetToolNames.every((name) => PUBLIC_TOOL_NAMES.includes(name));
    checks.fleet_tool_schemas_are_published = fleetToolNames.every((name) => (
      listedByName[name]?.inputSchema?.additionalProperties === false
      && listedByName[name]?.outputSchema?.properties?.ok?.type === "boolean"
    ))
      && listedByName.fleet_start.inputSchema.required.includes("manifest_path")
      && listedByName.fleet_status.inputSchema.required.includes("run_id")
      && listedByName.fleet_wait.inputSchema.properties.wait_ms.type === "integer"
      && JSON.stringify(listedByName.fleet_review.inputSchema.properties.decision.enum)
        === JSON.stringify(["accept", "block", "requeue"]);
    checks.dispatch_contract_current_is_v2 = DISPATCH_ENVELOPE_VERSION === "async-dispatch/v2";
    checks.dispatch_contract_keeps_v1_compatibility = (
      SUPPORTED_DISPATCH_ENVELOPE_VERSIONS.includes("async-dispatch/v1") &&
      SUPPORTED_DISPATCH_ENVELOPE_VERSIONS.includes(DISPATCH_ENVELOPE_VERSION)
    );
    const serverInfo = structured(await client.callTool({
      name: "subagent_server_info",
      arguments: {},
    }), "server info");
    checks.server_info_matches_public_schema = serverInfo.server_name === "async-subagent"
      && serverInfo.contract_version === CONTRACT_VERSION
      && serverInfo.dispatch_contract_version === DISPATCH_ENVELOPE_VERSION
      && JSON.stringify(serverInfo.tools) === JSON.stringify(PUBLIC_TOOL_NAMES)
      && !Object.hasOwn(serverInfo, "write_claim_contract_version")
      && serverInfo.tools.includes("subagent_pause");
    const pauseReceipt = structured(await client.callTool({
      name: "subagent_pause",
      arguments: {
        task_id: "task_pause_contract_stub",
        expected_revision: "1",
        reason: "user_requested",
      },
    }), "pause stub");
    checks.pause_call_returns_reason_and_next_step = pauseReceipt.accepted === false
      && typeof pauseReceipt.reason === "string"
      && pauseReceipt.reason.length > 0
      && pauseReceipt.state === "unknown"
      && pauseReceipt.revision === ""
      && typeof pauseReceipt.next_step === "string"
      && pauseReceipt.next_step.includes("subagent_get")
      && pauseReceipt.next_step.includes("具体原因");
    const cliEnvironment = { ...process.env, SUBAGENT_ALLOW_CUSTOM_RUNNER: "0" };
    // 缺省 task_root 挂在仓内 .runtime；父进程继承的 SUBAGENT_TASK_ROOT 不能把缺省值带到发布侧任务根。
    delete cliEnvironment.SUBAGENT_TASK_ROOT;
    const cli = spawnSync(process.execPath, [source], {
      cwd: repoRoot,
      env: cliEnvironment,
      encoding: "utf8",
      windowsHide: true,
    });
    const cliPayload = cli.status === 0 ? JSON.parse(String(cli.stdout || "{}")) : {};
    // 期望值独立硬编码,不从被测的 resolveSubagentCoreOptions 反算,缺省漂移才判得出来。
    // 两条路径按 CLI 的落点本地拼装:task_root 挂 spawn 时的 cwd,child_runner 是入口同目录的 pi runner
    // (--server 指到 bundle 时同目录的 runner 也是 bundle 版)。
    const expectedCliDefaults = {
      task_root: path.join(repoRoot, ".runtime", "cockpit", "async_tasks"),
      child_runner: path.join(
        path.dirname(source),
        path.basename(source).includes(".bundle.") ? "run-pi-task.bundle.mjs" : "run-pi-task.mjs",
      ),
      model: "openai-codex/gpt-6.1-sol",
      effort: "max",
      context_mode: "isolated",
    };
    checks.cli_defaults_object_is_exact = cli.status === 0
      && JSON.stringify(cliPayload.defaults) === JSON.stringify(expectedCliDefaults);

    const missingOriginBefore = existsSync(missingOriginDispatch.taskRoot)
      ? readdirSync(missingOriginDispatch.taskRoot).length
      : 0;
    const missingOrigin = await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: missingOriginDispatch.dispatchFile },
    });
    const missingOriginAfter = existsSync(missingOriginDispatch.taskRoot)
      ? readdirSync(missingOriginDispatch.taskRoot).length
      : 0;
    checks.v2_missing_origin_is_rejected_before_task_creation = (
      missingOrigin.isError === true && missingOriginBefore === missingOriginAfter
    );

    const legacySubmit = structured(await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: legacyDispatch.dispatchFile },
    }), "legacy v1 submit");
    const legacyTask = JSON.parse(readFileSync(
      path.join(legacyDispatch.taskRoot, legacySubmit.task_id, "task.json"),
      "utf8",
    ));
    checks.v1_without_origin_remains_accepted = legacyTask.origin_thread_id === "";
    await client.callTool({
      name: "subagent_wait",
      arguments: { task_id: legacySubmit.task_id, timeout_ms: 5000 },
    });
    const legacySubmitAgain = structured(await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: legacyDispatch.dispatchFile },
    }), "legacy v1 repeated submit");
    checks.v1_same_descriptor_remains_non_idempotent = legacySubmit.task_id !== legacySubmitAgain.task_id;
    await client.callTool({
      name: "subagent_wait",
      arguments: { task_id: legacySubmitAgain.task_id, timeout_ms: 5000 },
    });
    const legacyResultPath = path.join(legacyDispatch.taskRoot, legacySubmit.task_id, "result.json");
    const legacyCachedResult = JSON.parse(readFileSync(legacyResultPath, "utf8"));
    writeJson(legacyResultPath, { ...legacyCachedResult, origin_thread_id: "legacy-only-field" });
    const legacyResult = structured(await client.callTool({
      name: "subagent_result",
      arguments: { task_id: legacySubmit.task_id },
    }), "legacy cached result");
    checks.cached_legacy_result_strips_origin_thread_id = !Object.hasOwn(legacyResult, "origin_thread_id");
    // 回归（工具病 20260912-mcp-result-tracking-schema）：Core 收据自带的 result_tracking_version
    // 必须穿过 subagent_result 闭 schema 原样返回；往缓存收据塞未知键仍被输出校验拒收。
    checks.result_tracking_version_passes_result_schema = (
      typeof legacyCachedResult.result_tracking_version === "string"
      && legacyResult.result_tracking_version === legacyCachedResult.result_tracking_version
    );
    const legacyResultFileText = readFileSync(legacyResultPath, "utf8");
    writeJson(legacyResultPath, { ...JSON.parse(legacyResultFileText), unexpected_field: true });
    try {
      const unknownKeyResult = await client.callTool({
        name: "subagent_result",
        arguments: { task_id: legacySubmit.task_id },
      });
      checks.result_schema_still_rejects_unknown_keys = unknownKeyResult.isError === true;
    } finally {
      writeFileSync(legacyResultPath, legacyResultFileText, "utf8");
    }

    let started = performance.now();
    const submit = structured(await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: completedDispatch.dispatchFile },
    }), "submit");
    metrics.submit = {
      wall_ms: Math.round((performance.now() - started) * 1000) / 1000,
      bytes: Buffer.byteLength(JSON.stringify(submit), "utf8"),
      estimated_tokens: estimateTokens(submit),
    };
    const taskId = submit.task_id;
    const submittedTask = JSON.parse(readFileSync(
      path.join(completedDispatch.taskRoot, taskId, "task.json"),
      "utf8",
    ));
    checks.v2_origin_is_preserved = submittedTask.origin_thread_id === "contract-thread";
    checks.submit_budget = estimateTokens(submit) <= 250;
    started = performance.now();
    const wait = structured(await client.callTool({
      name: "subagent_wait",
      arguments: { task_id: taskId, timeout_ms: 5000 },
    }), "wait");
    metrics.wait_to_completion = {
      wall_ms: Math.round((performance.now() - started) * 1000) / 1000,
      bytes: Buffer.byteLength(JSON.stringify(wait), "utf8"),
      estimated_tokens: estimateTokens(wait),
    };
    checks.wait_completed_and_bounded = wait.event === "completion" && estimateTokens(wait) <= 300;
    started = performance.now();
    const get = structured(await client.callTool({
      name: "subagent_get",
      arguments: { task_ids: [taskId], detail: "compact" },
    }), "get");
    metrics.get_one = {
      wall_ms: Math.round((performance.now() - started) * 1000) / 1000,
      bytes: Buffer.byteLength(JSON.stringify(get), "utf8"),
      estimated_tokens: estimateTokens(get),
    };
    started = performance.now();
    const result = structured(await client.callTool({
      name: "subagent_result",
      arguments: { task_id: taskId },
    }), "result");
    metrics.result = {
      wall_ms: Math.round((performance.now() - started) * 1000) / 1000,
      bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      estimated_tokens: estimateTokens(result),
    };
    checks.get_budget = get.tasks.length === 1 && estimateTokens(get.tasks[0]) <= 250;
    checks.result_budget = estimateTokens(result) <= 700;
    checks.public_v1_responses_omit_origin_thread_id = (
      !Object.hasOwn(submit, "origin_thread_id") &&
      (!wait.task || !Object.hasOwn(wait.task, "origin_thread_id")) &&
      get.tasks.every((task) => !Object.hasOwn(task, "origin_thread_id")) &&
      !Object.hasOwn(result, "origin_thread_id")
    );
    checks.public_dto_has_no_runtime_ledger = !hasBannedKey(
      { submit, wait, get, result },
      new Set(["pid", "child_pid", "attempts", "task_root", "task_dir", "tool_call_counts", "notification_counts", "raw_response_item_counts", "handoff", "report"]),
    );
    checks.result_uses_summary_and_pointers = result.handoff_summary?.summary === "compact contract result."
      && typeof result.artifacts?.report_path === "string"
      && typeof result.artifacts?.attestation_path === "string"
      && result.attestation?.result_mode === "same_repo"
      && result.attestation?.verified === true
      && result.report === undefined
      && result.handoff === undefined;

    const missingResultModeBefore = existsSync(missingResultModeDispatch.taskRoot)
      ? readdirSync(missingResultModeDispatch.taskRoot).length
      : 0;
    const missingResultMode = await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: missingResultModeDispatch.dispatchFile },
    });
    const missingResultModeAfter = existsSync(missingResultModeDispatch.taskRoot)
      ? readdirSync(missingResultModeDispatch.taskRoot).length
      : 0;
    checks.cross_repo_result_mode_is_required_before_task_creation = (
      missingResultMode.isError === true && missingResultModeBefore === missingResultModeAfter
    );

    const secondProducerSubmit = structured(await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: secondProducerDispatch.dispatchFile },
    }), "second producer submit");
    await client.callTool({
      name: "subagent_wait",
      arguments: { task_id: secondProducerSubmit.task_id, timeout_ms: 5000 },
    });
    const secondProducerResult = structured(await client.callTool({
      name: "subagent_result",
      arguments: { task_id: secondProducerSubmit.task_id },
    }), "second producer result");
    checks.shared_server_isolates_two_producer_roots = (
      secondProducerResult.state === "done"
      && secondProducerSubmit.task_id !== taskId
      && existsSync(path.join(secondProducerDispatch.taskRoot, secondProducerSubmit.task_id, "task.json"))
      && !existsSync(path.join(completedDispatch.taskRoot, secondProducerSubmit.task_id, "task.json"))
    );

    const realRerunSubmit = structured(await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: realRerunDispatch.dispatchFile },
    }), "real rerun submit");
    await client.callTool({
      name: "subagent_wait",
      arguments: { task_id: realRerunSubmit.task_id, timeout_ms: 5000 },
    });
    const realRerunResult = structured(await client.callTool({
      name: "subagent_result",
      arguments: { task_id: realRerunSubmit.task_id },
    }), "real rerun result");
    checks.real_rerun_emits_wrapper_attestation = (
      realRerunResult.state === "done"
      && realRerunResult.attestation?.result_mode === "real_rerun"
      && realRerunResult.attestation?.verified === true
      && typeof realRerunResult.artifacts?.attestation_path === "string"
      && existsSync(realRerunResult.artifacts.attestation_path)
    );

    const unattestedRerunSubmit = structured(await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: unattestedRerunDispatch.dispatchFile },
    }), "unattested rerun submit");
    await client.callTool({
      name: "subagent_wait",
      arguments: { task_id: unattestedRerunSubmit.task_id, timeout_ms: 5000 },
    });
    const unattestedRerunResult = structured(await client.callTool({
      name: "subagent_result",
      arguments: { task_id: unattestedRerunSubmit.task_id },
    }), "unattested rerun result");
    checks.real_rerun_without_tool_evidence_fails_closed = (
      unattestedRerunResult.state === "failed"
      && unattestedRerunResult.mechanical_summary?.contract_state === "cross_repo_attestation_failed"
      && unattestedRerunResult.attestation?.verified === false
      && unattestedRerunResult.review_gate === "needs_parent_review"
    );
    started = performance.now();
    const getTen = structured(await client.callTool({
      name: "subagent_get",
      arguments: { task_ids: Array(10).fill(taskId), detail: "compact" },
    }), "get ten");
    metrics.get_ten = {
      wall_ms: Math.round((performance.now() - started) * 1000) / 1000,
      bytes: Buffer.byteLength(JSON.stringify(getTen), "utf8"),
      estimated_tokens: estimateTokens(getTen),
    };

    const taskDir = path.join(completedDispatch.taskRoot, taskId);
    const guardedFiles = [
      path.join(taskDir, "status.json"),
      path.join(taskDir, "result.json"),
      path.join(taskDir, "report.md"),
      path.join(taskDir, "handoff.md"),
      path.join(path.dirname(completedDispatch.taskRoot), "async_inbox", `${taskId}.json`),
    ];
    const before = snapshot(guardedFiles);
    await client.callTool({ name: "subagent_get", arguments: { task_ids: [taskId], detail: "diagnostic" } });
    await client.callTool({ name: "subagent_wait", arguments: { task_id: taskId, after_revision: result.revision, timeout_ms: 0 } });
    await client.callTool({ name: "subagent_result", arguments: { task_id: taskId } });
    const after = snapshot(guardedFiles);
    checks.read_tools_are_file_pure = sameSnapshot(before, after);

    // 回归：写域越界任务的紧凑投影带 write_domain_violation_count，get/wait 的严格 schema 必须放行。
    const statusPath = path.join(taskDir, "status.json");
    const originalStatus = readFileSync(statusPath, "utf8");
    const violated = { ...JSON.parse(originalStatus), write_domain_scope_compliant: false, write_domain_violation_count: 2 };
    writeFileSync(statusPath, `${JSON.stringify(violated, null, 2)}\n`, "utf8");
    try {
      const violatedGet = await client.callTool({ name: "subagent_get", arguments: { task_ids: [taskId], detail: "compact" } });
      const violatedWait = await client.callTool({ name: "subagent_wait", arguments: { task_id: taskId, timeout_ms: 0 } });
      checks.write_domain_violation_count_passes_compact_schema = violatedGet.isError !== true
        && violatedWait.isError !== true
        && violatedGet.structuredContent?.tasks?.[0]?.write_domain_violation_count === 2
        && violatedWait.structuredContent?.task?.write_domain_violation_count === 2;
    } finally {
      writeFileSync(statusPath, originalStatus, "utf8");
    }

    // 回归：编译器拒收 seed 时，错误文案带编译器 message，不被 stderr 的 [dispatch-phase] 心跳行顶掉。
    const rejectedDispatch = await client.callTool({
      name: "subagent_dispatch",
      arguments: {
        project_root: repoRoot,
        seed: {
          route_id: "contract-fixture-missing-route",
          title: "contract dispatch rejection",
          goal: "never runs",
          scope: { read: ["AGENTS.md"] },
        },
      },
    });
    const rejectedText = (rejectedDispatch.content || []).map((item) => item.text || "").join("\n");
    checks.dispatch_rejection_carries_compiler_message = rejectedDispatch.isError === true
      && rejectedText.includes("contract-fixture-missing-route")
      && !rejectedText.includes("[dispatch-phase]");

    const invalid = await client.callTool({
      name: "subagent_get",
      arguments: { task_ids: [taskId], task_root: root },
    });
    checks.unknown_public_input_rejected = invalid.isError === true;
    const legacyPrepared = await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { task_file: completedDispatch.dispatchFile },
    });
    checks.legacy_prepared_submit_rejected = legacyPrepared.isError === true;
    const diagnosticOverflow = await client.callTool({
      name: "subagent_get",
      arguments: { task_ids: Array(6).fill(taskId), detail: "diagnostic" },
    });
    const diagnosticFive = await client.callTool({
      name: "subagent_get",
      arguments: { task_ids: Array(5).fill(taskId), detail: "diagnostic" },
    });
    const diagnosticFiveValue = diagnosticFive.isError ? null : structured(diagnosticFive, "diagnostic five");
    checks.diagnostic_total_budget_is_guarded = diagnosticOverflow.isError === true
      && diagnosticFiveValue?.tasks?.length === 5
      && diagnosticFiveValue.tasks.every((task) => (
        Object.hasOwn(task, "live_phase")
        && Object.hasOwn(task, "last_tool_call")
        && task.diagnostic_paths?.events === "child-task-events.jsonl"
      ));

    const pureTaskId = "contract-pure-wait";
    const pureTaskRoot = path.join(root, ".runtime", "pure", "tasks");
    const pureTaskDir = path.join(pureTaskRoot, pureTaskId);
    const pureInbox = path.join(path.dirname(pureTaskRoot), "async_inbox");
    writeJson(path.join(pureTaskDir, "task.json"), {
      task_id: pureTaskId,
      task_root: pureTaskRoot,
      task_dir: pureTaskDir,
      registry_root: registryRoot,
    });
    writeJson(path.join(pureTaskDir, "status.json"), {
      task_id: pureTaskId,
      state: "running",
      rev: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    writeJson(path.join(registryRoot, `${pureTaskId}.json`), {
      contract_version: CONTRACT_VERSION,
      task_id: pureTaskId,
      task_root: pureTaskRoot,
      registered_at: new Date().toISOString(),
    });
    const pureFiles = [path.join(pureTaskDir, "task.json"), path.join(pureTaskDir, "status.json")];
    const pureBefore = snapshot(pureFiles);
    const pureWait = structured(await client.callTool({
      name: "subagent_wait",
      arguments: { task_id: pureTaskId, timeout_ms: 10 },
    }), "pure wait");
    checks.active_wait_timeout_is_file_pure = pureWait.event === "timeout"
      && !existsSync(pureInbox)
      && sameSnapshot(pureBefore, snapshot(pureFiles));

    const tamperedTaskId = "contract-tampered-registry";
    const tamperedTaskRoot = path.join(root, ".runtime", "tampered", "tasks");
    const tamperedTaskDir = path.join(tamperedTaskRoot, tamperedTaskId);
    const tamperedRegistryFile = path.join(registryRoot, `${tamperedTaskId}.json`);
    writeJson(path.join(tamperedTaskDir, "task.json"), {
      task_id: tamperedTaskId,
      task_root: tamperedTaskRoot,
      task_dir: tamperedTaskDir,
      registry_root: registryRoot,
    });
    writeJson(path.join(tamperedTaskDir, "status.json"), {
      task_id: tamperedTaskId,
      state: "running",
      rev: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    writeJson(tamperedRegistryFile, {
      contract_version: "wrong-contract",
      task_id: tamperedTaskId,
      task_root: tamperedTaskRoot,
    });
    const wrongContractGet = await client.callTool({
      name: "subagent_get",
      arguments: { task_ids: [tamperedTaskId] },
    });
    checks.registry_contract_is_validated = wrongContractGet.isError === true;
    writeJson(tamperedRegistryFile, {
      contract_version: CONTRACT_VERSION,
      task_id: tamperedTaskId,
      task_root: tamperedTaskRoot,
    });
    writeJson(path.join(tamperedTaskDir, "task.json"), {
      task_id: "different-task",
      task_root: tamperedTaskRoot,
      task_dir: tamperedTaskDir,
      registry_root: registryRoot,
    });
    const wrongTaskGet = await client.callTool({
      name: "subagent_get",
      arguments: { task_ids: [tamperedTaskId] },
    });
    writeJson(path.join(tamperedTaskDir, "task.json"), {
      task_id: tamperedTaskId,
      task_root: tamperedTaskRoot,
      task_dir: tamperedTaskDir,
      registry_root: path.join(root, "wrong-registry"),
    });
    const wrongRegistryCancel = await client.callTool({
      name: "subagent_cancel",
      arguments: { task_id: tamperedTaskId, expected_revision: "1", reason: "user_requested" },
    });
    checks.registry_task_binding_is_validated = wrongTaskGet.isError === true && wrongRegistryCancel.isError === true;

    const simulationDispatch = makeDispatch(root, "simulation", "contract-fast");
    const simulationEnvelope = JSON.parse(readFileSync(simulationDispatch.dispatchFile, "utf8"));
    simulationEnvelope.execution_profile = "simulation";
    simulationEnvelope.result_mode = "simulated_planning";
    simulationEnvelope.simulation = {
      role: "target-reviewer",
      persona: { instructions: "simulation persona", boundaries: ["read only"] },
    };
    writeJson(simulationDispatch.dispatchFile, simulationEnvelope);
    const simulationSubmit = structured(await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: simulationDispatch.dispatchFile },
    }), "simulation submit");
    const simulationTask = JSON.parse(readFileSync(
      path.join(simulationDispatch.taskRoot, simulationSubmit.task_id, "task.json"),
      "utf8",
    ));
    checks.simulation_is_prepared_profile_not_public_tool = simulationTask.execution_profile === "simulation"
      && simulationTask.simulation_profile?.role === "target-reviewer"
      && simulationTask.simulation_profile?.persona?.instructions === "simulation persona"
      && !names.includes("subagent_submit_simulation");
    await client.callTool({
      name: "subagent_wait",
      arguments: { task_id: simulationSubmit.task_id, timeout_ms: 5000 },
    });

    const slowSubmit = structured(await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: cancelDispatch.dispatchFile },
    }), "slow submit");
    await delay(700);
    const slowGet = structured(await client.callTool({
      name: "subagent_get",
      arguments: { task_ids: [slowSubmit.task_id] },
    }), "slow get");
    const staleCancel = structured(await client.callTool({
      name: "subagent_cancel",
      arguments: { task_id: slowSubmit.task_id, expected_revision: "0", reason: "user_requested" },
    }), "stale cancel");
    const currentRevision = slowGet.tasks[0].revision;
    const acceptedCancel = structured(await client.callTool({
      name: "subagent_cancel",
      arguments: { task_id: slowSubmit.task_id, expected_revision: currentRevision, reason: "contract test stop" },
    }), "accepted cancel");
    let cancelTerminal = acceptedCancel;
    if (acceptedCancel.state === "cancel_requested") {
      cancelTerminal = structured(await client.callTool({
        name: "subagent_wait",
        arguments: { task_id: slowSubmit.task_id, timeout_ms: 5000 },
      }), "cancel convergence wait");
    }
    const cancelTerminalState = cancelTerminal.task?.state ?? cancelTerminal.state;
    checks.cancel_has_cas = staleCancel.accepted === false && staleCancel.reason === "revision_conflict";
    checks.cancel_revision_conflict_carries_next_step = /revision/.test(String(staleCancel.next_step ?? ""));
    checks.cancel_current_revision_is_processed = (
      acceptedCancel.accepted === true
      && acceptedCancel.reason === "cancellation_accepted"
      && ["cancel_requested", "cancelled"].includes(acceptedCancel.state)
      && ["done", "failed", "cancelled"].includes(cancelTerminalState)
    ) || (
      acceptedCancel.accepted === false
      && acceptedCancel.state === "cancel_requested"
      && (
        ["done", "failed", "cancelled"].includes(cancelTerminalState)
        || (
          acceptedCancel.reason === "process_tree_termination_unconfirmed"
          && cancelTerminalState === "cancel_requested"
        )
      )
    );
    checks.cancel_budget = estimateTokens(acceptedCancel) <= 200;

    const actualResolverOptions = resolverOptions();
    const bundledTarget = path.basename(source).includes(".bundle.");
    const piSiblingName = bundledTarget ? "run-pi-task.bundle.mjs" : "run-pi-task.mjs";
    checks.pi_sentinel_resolves_to_server_sibling = (
      resolveTrustedRunnerPath(actualResolverOptions, "run-pi-task.mjs") === path.join(serverDir, piSiblingName)
    );
    checks.empty_runner_candidate_preserves_configured_default = (
      resolveTrustedRunnerPath(actualResolverOptions, "") === actualResolverOptions.defaultRunnerPath
    );
    const absentConfiguredChecker = path.join(root, "missing-configured-checker.mjs");
    const absentCheckerOptions = resolverOptions({ checkerPath: absentConfiguredChecker });
    const checkerCandidates = absentCheckerOptions.handoffCheckerPolicy.candidates;
    checks.checker_candidate_order_and_unavailable_diagnostics = (
      checkerCandidates.length === 5
      && checkerCandidates[0]?.absolutePath === path.join(serverDir, "subagent_handoff_check.bundle.mjs")
      && checkerCandidates[1]?.base === "producer_root"
      && checkerCandidates[2]?.base === "target_cwd"
      && checkerCandidates[3]?.absolutePath === absentConfiguredChecker
      && checkerCandidates[4]?.base === "cwd"
    );
    const configuredPiPath = path.join(serverDir, piSiblingName);
    const configuredPiOptions = resolverOptions({
      env: {
        ...process.env,
        SUBAGENT_CHILD_RUNNER: configuredPiPath,
        SUBAGENT_ALLOW_CUSTOM_RUNNER: "0",
      },
    });
    checks.configured_pi_default_infers_pi_metadata = (
      configuredPiOptions.defaultRunnerPath === configuredPiPath
      && Object.keys(configuredPiOptions.runnerCatalog).join(",") === "pi"
      && configuredPiOptions.defaultRunnerEntry.executor === "pi"
      && configuredPiOptions.defaultRunnerEntry.defaultModel === "openai-codex/gpt-6.1-sol"
      && configuredPiOptions.defaultRunnerEntry.defaultEffort === "max"
      && configuredPiOptions.defaultModel === "openai-codex/gpt-6.1-sol"
      && configuredPiOptions.defaultEffort === "max"
      && resolveTrustedRunnerPath(configuredPiOptions, "") === configuredPiPath
    );
    checks.worker_entry_identity_matches_target = actualResolverOptions.workerEntrypoint === source;
    checks.custom_runner_trust_boundary = (
      isTrustedRunnerPath(actualResolverOptions, path.join(serverDir, piSiblingName)) === true &&
      isTrustedRunnerPath(actualResolverOptions, runner) === false
    );

    const deploymentDir = path.join(root, "renamed-deployment");
    ensureDir(deploymentDir);
    const copiedEntry = path.join(deploymentDir, bundledTarget ? "renamed-server.bundle.mjs" : "renamed-server.mjs");
    copyFileSync(source, copiedEntry);
    const copiedPiRunner = path.join(deploymentDir, piSiblingName);
    writeFileSync(copiedPiRunner, "export {};\\n", "utf8");
    const deploymentOptions = resolverOptions({ entryPath: copiedEntry });
    checks.renamed_deployment_worker_identity = deploymentOptions.workerEntrypoint === copiedEntry;
    checks.renamed_deployment_sibling_identity = (
      resolveTrustedRunnerPath(deploymentOptions, "run-pi-task.mjs") === copiedPiRunner
      && isTrustedRunnerPath(deploymentOptions, copiedPiRunner) === true
    );

    const externalDir = path.join(root, "external-runner");
    ensureDir(externalDir);
    const externalPiRunner = path.join(externalDir, "run-pi-task.mjs");
    const unknownRunner = path.join(externalDir, "custom-async-runner.mjs");
    writeFileSync(externalPiRunner, "export {};\\n", "utf8");
    writeFileSync(unknownRunner, "export {};\\n", "utf8");
    const externalCatalogOptions = resolverOptions({
      runnerCatalog: {
        pi: {
          executor: "pi",
          basename: "run-pi-task.mjs",
          aliases: ["run-pi-task.bundle.mjs"],
          path: externalPiRunner,
          defaultModel: "external-model",
          defaultEffort: "external-effort",
        },
      },
      defaultRunnerPath: externalPiRunner,
      defaultRunnerKey: "pi",
      env: { ...process.env, SUBAGENT_ALLOW_CUSTOM_RUNNER: "0" },
    });
    const externalPiOptions = resolverOptions({
      env: { ...process.env, SUBAGENT_CHILD_RUNNER: externalPiRunner, SUBAGENT_ALLOW_CUSTOM_RUNNER: "0" },
    });
    const unknownRunnerOptions = resolverOptions({
      env: { ...process.env, SUBAGENT_CHILD_RUNNER: unknownRunner, SUBAGENT_ALLOW_CUSTOM_RUNNER: "0" },
    });
    checks.external_pi_basename_infers_pi_metadata = (
      externalPiOptions.defaultRunnerPath === externalPiRunner
      && externalPiOptions.defaultRunnerEntry.executor === "pi"
      && externalPiOptions.defaultRunnerEntry.defaultModel === "openai-codex/gpt-6.1-sol"
      && externalPiOptions.defaultRunnerEntry.defaultEffort === "max"
      && externalPiOptions.defaultModel === "openai-codex/gpt-6.1-sol"
      && externalPiOptions.defaultEffort === "max"
      && isTrustedRunnerPath(externalPiOptions, externalPiRunner) === false
    );
    checks.unknown_custom_runner_uses_default_runner_defaults = (
      unknownRunnerOptions.defaultRunnerPath === unknownRunner
      && unknownRunnerOptions.defaultRunnerEntry.executor === "pi"
      && unknownRunnerOptions.defaultModel === "openai-codex/gpt-6.1-sol"
      && unknownRunnerOptions.defaultEffort === "max"
    );
    checks.external_catalog_runner_is_not_trusted = (
      externalCatalogOptions.runnerCatalog.pi.path === externalPiRunner
      && isTrustedRunnerPath(externalCatalogOptions, externalPiRunner) === false
    );

    const symlinkTarget = path.join(externalDir, "symlink-target");
    ensureDir(symlinkTarget);
    const symlinkPath = path.join(deploymentDir, "runner-link");
    let symlinkError = "";
    try {
      symlinkSync(symlinkTarget, symlinkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      symlinkError = error?.message || String(error);
    }
    if (!symlinkError) {
      const symlinkRunner = path.join(symlinkTarget, piSiblingName);
      writeFileSync(symlinkRunner, "export {};\\n", "utf8");
      checks.symlink_escape_runner_is_not_trusted = (
        isTrustedRunnerPath(deploymentOptions, path.join(symlinkPath, piSiblingName)) === false
      );
    } else {
      checks.symlink_escape_runner_is_not_trusted = true;
      skips.symlink_escape_runner_is_not_trusted = {
        capability: "symlink_or_junction",
        reason: symlinkError,
      };
    }
    const piDispatch = makeDispatch(root, "pi-defaults", "", { runnerPath: runner });
    const piEnvelope = JSON.parse(readFileSync(piDispatch.dispatchFile, "utf8"));
    piEnvelope.effort = "";
    writeJson(piDispatch.dispatchFile, piEnvelope);
    const piSubmit = structured(await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: piDispatch.dispatchFile },
    }), "pi submit");
    const piTask = JSON.parse(readFileSync(
      path.join(piDispatch.taskRoot, piSubmit.task_id, "task.json"),
      "utf8",
    ));
    checks.pi_runner_gets_pi_default_model_effort = (
      piTask.model === "openai-codex/gpt-6.1-sol" && piTask.effort === "max"
    );
    await client.callTool({
      name: "subagent_wait",
      arguments: { task_id: piSubmit.task_id, timeout_ms: 5000 },
    });
    const evilRunner = path.join(root, "ops", "tools", "evil-task.mjs");
    writeFileSync(evilRunner, "// non-whitelisted runner stub\n", "utf8");
    const evilDispatch = makeDispatch(root, "evil-runner", "contract-fast", { runnerPath: evilRunner });
    const evilSubmit = await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: evilDispatch.dispatchFile },
    });
    checks.non_whitelisted_runner_rejected = evilSubmit.isError === true;

    const registryFailureDispatch = makeDispatch(root, "registry-failure", "contract-fast");
    const registryFailureTaskRoot = path.join(root, ".runtime", "registry-failure-tasks");
    const registryFailureEnvelope = JSON.parse(readFileSync(registryFailureDispatch.dispatchFile, "utf8"));
    registryFailureEnvelope.task_root = registryFailureTaskRoot;
    writeJson(registryFailureDispatch.dispatchFile, registryFailureEnvelope);
    rmSync(registryRoot, { recursive: true, force: true });
    writeFileSync(registryRoot, "registry path intentionally blocked\n", "utf8");
    const registryFailure = await client.callTool({
      name: "subagent_submit_prepared",
      arguments: { dispatch_file: registryFailureDispatch.dispatchFile },
    });
    checks.registry_failure_is_atomic = registryFailure.isError === true
      && (!existsSync(registryFailureTaskRoot) || readdirSync(registryFailureTaskRoot).length === 0);

    // 纯 command 节点 DAG：跑通 fleet 工具面而不发生任何模型调用。
    const fleetManifestDir = path.join(repoRoot, "tmp", "fleet-contract-test");
    const fleetRunId = `fleet-contract-${process.pid}-${Date.now()}`;
    const fleetManifest = path.join(fleetManifestDir, `${fleetRunId}.json`);
    writeJson(fleetManifest, {
      schema_version: 2,
      run_id: fleetRunId,
      budget: { max_nodes_total: 4, max_running_total: 1, max_submitted_per_tick: 1 },
      nodes: [{
        id: "mechanical-step",
        kind: "command",
        command: {
          argv: [process.execPath, "-e", "setTimeout(() => console.log('fleet contract command node'), 1500)"],
          timeout_seconds: 60,
        },
      }],
    });
    const fleetStarted = structured(await client.callTool({
      name: "fleet_start",
      arguments: { project_root: repoRoot, manifest_path: fleetManifest, run_id: fleetRunId },
    }), "fleet start");
    checks.fleet_start_validates_manifest_and_launches_driver = fleetStarted.ok === true
      && fleetStarted.run_id === fleetRunId
      && fleetStarted.node_count === 1
      && Number.isInteger(fleetStarted.driver_pid);
    const fleetStatus = structured(await client.callTool({
      name: "fleet_status",
      arguments: { project_root: repoRoot, run_id: fleetRunId },
    }), "fleet status");
    checks.fleet_status_returns_bounded_summary = fleetStatus.ok === true
      && fleetStatus.run_id === fleetRunId
      && typeof fleetStatus.summary?.run_state === "string"
      && !Object.hasOwn(fleetStatus, "state");
    const fleetWaited = structured(await client.callTool({
      name: "fleet_wait",
      arguments: { project_root: repoRoot, run_id: fleetRunId, wait_ms: 30000 },
    }), "fleet wait");
    checks.fleet_wait_blocks_until_the_run_settles = fleetWaited.ok === true
      && fleetWaited.settled === true
      && fleetWaited.driver_status === "completed"
      && fleetWaited.counts?.done === 1
      && fleetWaited.summary?.run_state === "completed";
    const fleetMissing = structured(await client.callTool({
      name: "fleet_status",
      arguments: { project_root: repoRoot, run_id: "fleet-contract-absent-run" },
    }), "fleet status on a missing run");
    checks.fleet_failures_are_structured_not_thrown = fleetMissing.ok === false
      && fleetMissing.error?.kind === "scheduler_failed"
      && typeof fleetMissing.error?.message === "string";
    metrics.fleet_command_dag = {
      wall_ms: fleetWaited.waited_ms,
      driver_status: fleetWaited.driver_status,
      counts: fleetWaited.counts,
    };
    rmSync(path.join(repoRoot, String(fleetStarted.state_root), fleetRunId), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
    rmSync(fleetManifestDir, { recursive: true, force: true });

  } finally {
    await client.close().catch(() => {});
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      cleanupError = error?.message ?? String(error);
    }
  }
  checks.cleanup_succeeded = !cleanupError;
  const ok = Object.values(checks).every(Boolean);
  process.stdout.write(`${JSON.stringify({
    status: ok ? "ok" : "failed",
    checks,
    skips,
    metrics,
    errors: cleanupError ? [cleanupError] : [],
  }, null, 2)}\n`);
  if (!ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
