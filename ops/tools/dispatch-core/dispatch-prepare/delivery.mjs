import {
  ToolError,
  isRecord,
  rel,
} from "../_tool_common.mjs";
import {
  pyGetItem,
  pyJsonLoads,
  pyRepr,
  pySpawnSync,
  pyStr,
  pyStrip,
  pyTruthy,
} from "../_py.mjs";
import { ASYNC_DISPATCH_CONTRACT_VERSION } from "./constants.mjs";
import { deps } from "./deps.mjs";
import { isFile, pySlice } from "./py-utils.mjs";
import { packagePathForTemp } from "./seed.mjs";
import { asyncServerEnv, asyncSubagentEndpoint } from "./server.mjs";
import { caches } from "./state.mjs";

// ---- 交付就绪 ----

export function resolveDeliveryWithReadiness(delivery, readiness) {
  if (delivery !== "auto" && delivery !== "async-subagent") return [delivery, { status: "not_checked", issues: [] }];
  if (pyGetItem(readiness, "status") === "available") return ["async-subagent", readiness];
  return ["unavailable", readiness];
}

function resolveDeliveryImpl(delivery) {
  if (delivery !== "auto" && delivery !== "async-subagent") return [delivery, { status: "not_checked", issues: [] }];
  return resolveDeliveryWithReadiness(delivery, asyncSubagentReadiness());
}

export function resolveDelivery(delivery) {
  return deps.resolveDelivery(delivery);
}

export function asyncDispatchContractStatus(buildInfo) {
  const current = pyStrip(pyStr(pyTruthy(buildInfo?.dispatch_contract_version) ? buildInfo.dispatch_contract_version : ""));
  const rawSupported = buildInfo?.supported_dispatch_contract_versions;
  let supported = Array.isArray(rawSupported)
    ? rawSupported.map((item) => pyStrip(pyStr(item))).filter((item) => item)
    : [];
  if (!supported.length && current) supported = [current];
  const compatible = supported.includes(ASYNC_DISPATCH_CONTRACT_VERSION);
  let issue = null;
  if (!current) {
    issue = "configured Async MCP build-info is missing dispatch_contract_version";
  } else if (!compatible) {
    issue = `configured Async MCP does not support ${ASYNC_DISPATCH_CONTRACT_VERSION} `
      + `(current=${current}, supported=${pyRepr(supported)}); run `
      + "npm --prefix ops run build:subagent and "
      + "python -B ops/tools/deploy_subagent_bundle.py --apply --format json";
  }
  return {
    current: current || null,
    supported,
    compatible: compatible && Boolean(current),
    issue,
  };
}

function asyncSubagentReadinessImpl() {
  const issues = [];
  const [server, toolPath] = asyncSubagentEndpoint();
  let buildInfo = {};
  let contractStatus = asyncDispatchContractStatus(buildInfo);
  if (!pyTruthy(server)) {
    issues.push(
      "mcp_servers.asyncSubagent is missing from the user-level config (~/.codex/config.toml); "
      + "project-level registration does not select the service; run "
      + "python -B ops/tools/deploy_subagent_bundle.py --apply to publish and register the server",
    );
  } else if (!pyTruthy(server.command)) {
    issues.push("mcp_servers.asyncSubagent.command is empty");
  } else if (server.approval_mode !== "approve") {
    issues.push("mcp_servers.asyncSubagent.default_tools_approval_mode must be approve");
  }
  if (pyTruthy(toolPath) && !isFile(toolPath)) {
    issues.push(`missing async tool: ${toolPath}`);
  } else if (!pyTruthy(toolPath)) {
    issues.push("mcp_servers.asyncSubagent args do not include an .mjs server script");
  }
  if (!issues.length) {
    try {
      buildInfo = deps.callAsyncInternalAdapter("build-info", {});
      contractStatus = asyncDispatchContractStatus(buildInfo);
      if (contractStatus.issue) issues.push(pyStr(contractStatus.issue));
    } catch (error) {
      if (error?.name !== "ToolError") throw error;
      issues.push(`cannot read configured Async MCP build-info: ${error.message}`);
    }
  }
  return {
    status: issues.length ? "unavailable" : "available",
    issues,
    server_source: pyTruthy(server) ? server.source : null,
    registration_policy: "MCP服务使用用户级注册；项目同名注册不参与选址。",
    config_path: pyTruthy(server) ? server.config_path : null,
    server_name: pyTruthy(server) ? server.server_name : null,
    tool_path: pyTruthy(toolPath) ? String(toolPath) : null,
    approval_mode: pyTruthy(server) ? server.approval_mode : null,
    build_id: pyStr(pyTruthy(buildInfo?.build_id) ? buildInfo.build_id : "") || null,
    dispatch_contract_version: contractStatus.current,
    supported_dispatch_contract_versions: contractStatus.supported,
  };
}

export function asyncSubagentReadiness() {
  if (!caches.asyncSubagentReadiness.has("value")) {
    caches.asyncSubagentReadiness.set("value", deps.asyncSubagentReadiness());
  }
  return caches.asyncSubagentReadiness.get("value");
}

// ---- 派发载荷 ----

export function renderDirectFileRefPayload(packagePath) {
  const packageRel = rel(packagePath);
  return [
    `DIRECT_TASK_PACKAGE_FILE: ${packageRel}`,
    "",
    "请先运行以下命令读取完整任务材料，然后只按任务材料执行：",
    `node ops/tools/subagent_preload.mjs render --package ${packageRel}`,
    "",
    "这一步只是读取 direct 启动材料；不要自行扫描 .runtime、notes 或仓库根目录寻找任务包。",
  ].join("\n");
}

export function _validTaskId(taskId) {
  return typeof taskId === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(taskId);
}

// 黄金跑测器把 Python 名转 camelCase 时 `_valid_task_id` → `ValidTaskId`；本别名只服务语料调用。
export { _validTaskId as ValidTaskId };

export function renderAsyncTaskPayload(packagePath, taskId) {
  const packageRel = rel(packagePath);
  return [
    `SUBAGENT_TASK_ID: ${taskId}`,
    `TASK_PACKAGE_FILE: ${packageRel}`,
    "",
    "异步子代理任务已提交；不要另走同步派发。",
    `无其他工作时等一次终态：subagent_wait({"task_id":"${taskId}","timeout_ms":60000})`,
    `终态收轻量回执：subagent_result({"task_id":"${taskId}"})`,
  ].join("\n");
}

function callAsyncInternalAdapterImpl(operation, args) {
  const [server, toolPath] = asyncSubagentEndpoint();
  if (!pyTruthy(server)) {
    throw new ToolError(
      "async subagent MCP server is missing from the user-level config (~/.codex/config.toml); "
      + "register it with python -B ops/tools/deploy_subagent_bundle.py --apply and re-check "
      + "build-info with --delivery auto, or dispatch through the Pi native dispatch_prepare tool, "
      + "which uses the session AsyncTaskService instead of this endpoint",
    );
  }
  if (!pyTruthy(toolPath) || !isFile(toolPath)) {
    throw new ToolError("configured async subagent MCP server script is unavailable");
  }
  const argv = [String(toolPath), "internal", operation];
  for (const [key, value] of Object.entries(args || {})) {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    const flag = `--${key.split("_").join("-")}`;
    if (Array.isArray(value)) argv.push(flag, value.map((item) => pyStr(item)).join(","));
    else if (typeof value === "boolean") {
      if (value) argv.push(flag);
    } else argv.push(flag, pyStr(value));
  }
  const completed = pySpawnSync(pyStr(pyGetItem(server, "command")), argv, {
    cwd: String(pyGetItem(server, "cwd")),
    env: asyncServerEnv(server),
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (completed.error) {
    if (completed.error.code === "ETIMEDOUT") {
      throw new ToolError("async subagent internal submit timed out before returning task_id");
    }
    throw new ToolError("node is not available for async subagent MCP dispatch");
  }
  if (completed.signal === "SIGTERM" && completed.status === null) {
    throw new ToolError("async subagent internal submit timed out before returning task_id");
  }
  const stdout = String(completed.stdout ?? "");
  const stderr = String(completed.stderr ?? "");
  if (completed.status !== 0) {
    throw new ToolError(`async subagent internal adapter failed: ${pySlice(pyStrip(stderr || stdout), 600)}`);
  }
  let response;
  try {
    response = pyJsonLoads(stdout);
  } catch (error) {
    if (error?.name !== "JSONDecodeError") throw error;
    throw new ToolError(`async subagent internal adapter returned invalid JSON: ${pySlice(stdout, 600)}`);
  }
  if (!isRecord(response) || response.ok === false) {
    throw new ToolError(`async subagent internal adapter failed: ${pyStr(response)}`);
  }
  return response;
}

export function callAsyncInternalAdapter(operation, args) {
  return deps.callAsyncInternalAdapter(operation, args);
}

export function prepareDirect(pkg) {
  const taskPackage = pyGetItem(pkg, "task_package");
  const packageId = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "");
  const agent = isRecord(taskPackage.agent) ? taskPackage.agent : {};
  const agentType = pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : (pyTruthy(agent.role) ? agent.role : ""));
  const packagePath = packagePathForTemp(pkg);
  return {
    status: "ok",
    delivery_mode: "direct_message",
    direct_payload_mode: "file_ref",
    package_id: packageId,
    agent_type: agentType,
    task_package_path: rel(packagePath),
    spawn_payload: renderDirectFileRefPayload(packagePath),
  };
}

export { asyncSubagentReadinessImpl, callAsyncInternalAdapterImpl, resolveDeliveryImpl };
