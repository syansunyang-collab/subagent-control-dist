import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { parse as parseToml } from "smol-toml";

import {
  ROOT,
  ToolError,
  homeDir,
  isAbsoluteLikePython,
  isRecord,
  pathlibJoin,
  rel,
  resolveLikePython,
} from "../_tool_common.mjs";
import { pyStr, pyStrip, pyTruthy } from "../_py.mjs";
import { ASYNC_MCP_SERVER_NAME } from "./constants.mjs";
import { deps } from "./deps.mjs";
import { caches } from "./state.mjs";

// ---- 用户级配置 ----

export function defaultRegistryRoot() {
  return path.join(homeDir(), ".subagent-control", "async_task_registry");
}

function configSource(_configPath) {
  return "global";
}

function configBase(configPath) {
  return path.dirname(String(configPath));
}

function resolveConfigPath(configPath, value) {
  const raw = String(value || ".");
  if (isAbsoluteLikePython(raw)) return resolveLikePython(raw);
  return resolveLikePython(pathlibJoin(configBase(configPath), raw));
}

export function _serverFromConfig(configPath) {
  const config = loadToml(configPath);
  const rawServers = isRecord(config.mcp_servers) ? config.mcp_servers : {};
  const serverName = ASYNC_MCP_SERVER_NAME;
  const server = rawServers[serverName];
  if (!isRecord(server)) return null;
  const args = Array.isArray(server.args) ? server.args : [];
  const env = isRecord(server.env) ? server.env : {};
  return {
    source: configSource(configPath),
    config_path: String(configPath),
    server_name: serverName,
    command: pyStr(pyTruthy(server.command) ? server.command : ""),
    args: args.map((item) => pyStr(item)),
    cwd: String(resolveConfigPath(configPath, pyStr(pyTruthy(server.cwd) ? server.cwd : "."))),
    env: Object.fromEntries(Object.entries(env).map(([key, value]) => [String(key), pyStr(value)])),
    approval_mode: pyStr(pyTruthy(server.default_tools_approval_mode) ? server.default_tools_approval_mode : ""),
  };
}

function asyncSubagentServerImpl() {
  // COCKPIT_GLOBAL_CONFIG:沙箱/测试用的用户级配置替身(绝对路径)。未设时行为与历来一致。
  const envConfig = pyStrip(String(process.env.COCKPIT_GLOBAL_CONFIG || ""));
  const globalConfig = deps.globalConfigPath || (envConfig || path.join(homeDir(), ".codex", "config.toml"));
  return _serverFromConfig(globalConfig);
}

export function asyncSubagentServer() {
  if (!caches.asyncSubagentServer.has("value")) {
    caches.asyncSubagentServer.set("value", deps.asyncSubagentServer());
  }
  return caches.asyncSubagentServer.get("value");
}

export function selectAsyncSubagentServer(projectServer, globalServer) {
  // Project registrations do not select the shared async service.
  return globalServer;
}

export function asyncServerScriptPath(server) {
  const cwd = resolveLikePython(pyStr(pyTruthy(server?.cwd) ? server.cwd : ROOT));
  for (const arg of (pyTruthy(server?.args) ? server.args : [])) {
    if (pyStr(arg).endsWith(".mjs")) {
      const candidate = pyStr(arg);
      return isAbsoluteLikePython(candidate) ? resolveLikePython(candidate) : resolveLikePython(pathlibJoin(cwd, candidate));
    }
  }
  return null;
}

function asyncSubagentEndpointImpl() {
  const server = asyncSubagentServer();
  return [server, server ? asyncServerScriptPath(server) : null];
}

export function asyncSubagentEndpoint() {
  if (!caches.asyncSubagentEndpoint.has("value")) {
    caches.asyncSubagentEndpoint.set("value", deps.asyncSubagentEndpoint());
  }
  return caches.asyncSubagentEndpoint.get("value");
}

export function asyncServerEnv(server) {
  return { ...process.env, ...(pyTruthy(server?.env) ? server.env : {}) };
}

export function loadToml(target) {
  let text;
  try {
    text = readFileSync(String(target), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new ToolError(`cannot parse toml: ${rel(target)}: ${error.message}`);
  }
  let data;
  try {
    data = parseToml(text);
  } catch (error) {
    throw new ToolError(`cannot parse toml: ${rel(target)}: ${error.message}`);
  }
  return isRecord(data) ? data : {};
}

export { asyncSubagentEndpointImpl, asyncSubagentServerImpl };
