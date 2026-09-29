import { createHash, randomBytes } from "node:crypto";
import { appendFile, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { Worker } from "node:worker_threads";

import {
  AGGREGATION_WORKER_ENTRY,
  CONFIG_WORKER_ENTRY,
  EXPECTED_CONTRACT_VERSION,
  LOOPBACK_HOST,
  PanelError,
  createAsyncTaskService,
  derivePort,
  resolveAsyncCorePath,
  resolveControlRepoPath,
  resolvePanelPaths,
  resolvePanelRoot,
  resolvePanelStateRoot,
  resolveRegistryRoot,
  validateControlRepo,
} from "./async-core.mjs";
import { createConfigStore, publishedRuntimeRoot } from "./config-store.mjs";
import { createSelectionStore } from "./selection-store.mjs";
import { PanelProjection, ensurePanelLogDirectory } from "./projection.mjs";

export const PANEL_TOKEN_HEADER = "x-panel-token";
const PANEL_TOKEN_PLACEHOLDER = "__PANEL_TOKEN__";

const STATIC_CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
});

function staticContentType(filePath) {
  return STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function staticFilePath(webRoot, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new PanelError("STATIC_PATH_INVALID", "静态资源路径编码无效", { status: 400, scope: "local" });
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const root = path.resolve(webRoot);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PanelError("STATIC_PATH_INVALID", "静态资源路径越界", { status: 400, scope: "local" });
  }
  return candidate;
}

function serveStatic(webRoot, pathname, response, panelToken = null) {
  const filePath = staticFilePath(webRoot, pathname);
  let stats;
  try {
    stats = statSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new PanelError("STATIC_READ_FAILED", "静态资源不可读", { status: 503, scope: "global" });
  }
  if (!stats.isFile()) return false;

  let body = readFileSync(filePath);
  // 每进程令牌只注入 index.html，供前端在变更请求上回带（loopback CSRF 防线）。
  if (panelToken && path.basename(filePath) === "index.html") {
    body = Buffer.from(body.toString("utf8").replaceAll(PANEL_TOKEN_PLACEHOLDER, panelToken), "utf8");
  }
  response.writeHead(200, {
    "content-type": staticContentType(filePath),
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
  return true;
}

function jsonResponse(response, status, body) {
  const payload = JSON.stringify(body);
  // 轮询降噪：200 的 GET 响应带弱 ETag，内容未变时回 304 空体——网络与前端解析归零。
  // response.req 是 Node http 自带的请求引用，调用点无需透传。
  const request = response.req;
  if (status === 200 && request && (request.method || "GET") === "GET") {
    const etag = `W/"${createHash("sha1").update(payload).digest("base64url")}"`;
    // no-cache（可存但必须回源验证）与 ETag 配套；no-store 会否定验证器的意义
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { etag, "cache-control": "no-cache" });
      response.end();
      return;
    }
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-cache",
      etag,
    });
    response.end(payload);
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function errorBody(error, contractVersion = EXPECTED_CONTRACT_VERSION) {
  return {
    ok: false,
    contract_version: contractVersion,
    error: {
      code: error.code || "SERVER_ERROR",
      message: error.message || "服务错误",
      scope: error.scope || "global",
      details: error.details || null,
    },
  };
}

function pathParts(url) {
  return url.pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw new PanelError("PATH_INVALID", "请求路径编码无效", { status: 400, scope: "local" });
    }
  });
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 128 * 1024) {
      throw new PanelError("REQUEST_TOO_LARGE", "请求体过大", { status: 413, scope: "local" });
    }
    chunks.push(chunk);
  }
  if (!length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object_required");
    return value;
  } catch {
    throw new PanelError("REQUEST_JSON_INVALID", "请求体必须是 JSON 对象", { status: 400, scope: "local" });
  }
}

function requestQuery(requestUrl) {
  return Object.fromEntries(requestUrl.searchParams.entries());
}

// GET 数据路由的查询合同是闭集：未知键与非法值一律 400，不静默吞错回全量
// （sol 体检：非法 scope/limit 曾静默落回默认全量）。键表与 projection.matchesTask 同源。
const FILTER_QUERY_KEYS = Object.freeze([
  "state", "role", "model", "keyword", "q",
  "scope", "range", "thread_id", "thread", "project_path", "project",
]);
const SCOPE_VALUES = new Set([
  "all", "thread", "this-thread", "current-thread",
  "project", "this-project", "current-project",
]);

function assertQuery(query, allowedKeys) {
  for (const key of Object.keys(query)) {
    if (!allowedKeys.includes(key)) {
      throw new PanelError("QUERY_PARAM_UNKNOWN", `查询参数不被支持：${key}`, { status: 400, scope: "local" });
    }
  }
  if (query.scope !== undefined || query.range !== undefined) {
    const scope = String(query.scope ?? query.range).trim().toLowerCase();
    if (!SCOPE_VALUES.has(scope)) {
      throw new PanelError("QUERY_SCOPE_INVALID", `scope 不在允许集内：${scope}`, { status: 400, scope: "local" });
    }
    // 配套上下文缺失时 matchesTask 会对全量任务判否——静默空集与静默全量同病，一律 400
    // （opus 复核 F5）
    if (["thread", "this-thread", "current-thread"].includes(scope)
      && !String(query.thread_id ?? query.thread ?? "").trim()) {
      throw new PanelError("QUERY_SCOPE_CONTEXT_MISSING", "scope=thread 必须携带非空 thread_id", { status: 400, scope: "local" });
    }
    if (["project", "this-project", "current-project"].includes(scope)
      && !String(query.project_path ?? query.project ?? "").trim()) {
      throw new PanelError("QUERY_SCOPE_CONTEXT_MISSING", "scope=project 必须携带非空 project_path", { status: 400, scope: "local" });
    }
  }
  if (query.limit !== undefined && !/^[1-9][0-9]{0,5}$/.test(String(query.limit))) {
    throw new PanelError("QUERY_LIMIT_INVALID", "limit 必须是正整数", { status: 400, scope: "local" });
  }
}

function writeSafeLog(logFile, fields = {}) {
  // Only completed requests are logged. Async append keeps health's constant-time
  // response path free of filesystem waits while preserving one duration per line.
  if (!Number.isFinite(fields.durationMs)) return;
  const allowed = {
    timestamp: new Date().toISOString(),
    durationMs: Math.max(0, Math.round(fields.durationMs)),
  };
  for (const key of ["task_id", "run_id", "path", "status"]) {
    if (fields[key] !== undefined && fields[key] !== null) allowed[key] = String(fields[key]);
  }
  appendFile(logFile, `${JSON.stringify(allowed)}\n`, "utf8", () => {
    // Logging is diagnostic only; a log failure must not turn a request into a data failure.
  });
}

export class PanelWorker {
  constructor(workerData, entry = AGGREGATION_WORKER_ENTRY) {
    this.worker = new Worker(new URL(entry, import.meta.url), { workerData });
    this.failure = null;
    this.nextId = 1;
    this.pending = new Map();
    this.worker.on("message", ({ id, result, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (error) {
        request.reject(new PanelError(error.code, error.message, error));
      } else {
        request.resolve(result);
      }
    });
    this.worker.on("error", (error) => this.#rejectAll(error));
    this.worker.on("exit", (code) => {
      this.#rejectAll(new PanelError("PANEL_WORKER_EXITED", `面板数据线程已退出（${code}），请重新打开面板`, { scope: "local" }));
    });
  }

  call(method, ...args) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, method, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async close() {
    this.#rejectAll(new Error("aggregation worker stopped"));
    await this.worker.terminate();
  }

  #rejectAll(error) {
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

// 变更请求三重护栏：Host 必须是本机 loopback、跨源 Origin 拒绝、必须回带本进程令牌。
// loopback 服务挡不住浏览器里任意网页向 127.0.0.1 发 fetch，令牌是这条口子的锁。
function guardMutation(config, request) {
  const host = String(request.headers.host || "").toLowerCase();
  const expectedHost = `${LOOPBACK_HOST}:${config.actualPort ?? config.port}`;
  if (host !== expectedHost) {
    throw new PanelError("MUTATION_HOST_REJECTED", `变更请求的 Host 不是 ${expectedHost}；请通过 http://${expectedHost}/ 打开面板（localhost 写法不被接受）`, { status: 403, scope: "local" });
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== config.resolvedLoopbackUrl) {
    throw new PanelError("MUTATION_ORIGIN_REJECTED", "变更请求来源跨域", { status: 403, scope: "local" });
  }
  if (request.headers[PANEL_TOKEN_HEADER] !== config.panelToken) {
    throw new PanelError("MUTATION_TOKEN_REJECTED", "变更请求缺少有效面板令牌", { status: 403, scope: "local" });
  }
}

function configOutcomeStatus(outcome) {
  if (outcome.state === "saved") return 200;
  if (outcome.state === "revision_conflict") return 409;
  if (outcome.state === "validation_error") return 422;
  return 500;
}

function sameProjectPath(left, right) {
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  return process.platform === "win32"
    ? a.toLocaleLowerCase("en-US") === b.toLocaleLowerCase("en-US")
    : a === b;
}

function readAllowedProjects(runtimeRoot, fallbackRoot, panelStateRoot) {
  const file = path.join(path.resolve(String(runtimeRoot || fallbackRoot)), "deployment.json");
  try {
    const payload = JSON.parse(readFileSync(file, "utf8"));
    const listed = Array.isArray(payload?.allowed_projects) ? payload.allowed_projects : [];
    const resolved = listed.map((item) => path.resolve(String(item))).filter(Boolean);
    if (payload.allow_any_project === true) {
      resolved.push(path.resolve(String(fallbackRoot)));
      const directory = path.join(panelStateRoot, "projects");
      if (existsSync(directory)) {
        for (const name of readdirSync(directory).filter((item) => item.endsWith(".json"))) {
          try {
            const project = JSON.parse(readFileSync(path.join(directory, name), "utf8")).project_root;
            if (typeof project === "string" && path.isAbsolute(project)) resolved.push(path.resolve(project));
          } catch { /* 忽略损坏的展示用项目条目；不读取或复制任务状态。 */ }
        }
      }
      return resolved.filter((item, index) => resolved.findIndex((other) => sameProjectPath(item, other)) === index);
    }
    if (resolved.length) return resolved;
  } catch {
    /* 无部署清单时只用启动仓 */
  }
  return [path.resolve(String(fallbackRoot))];
}

function projectAvailability(projectPath) {
  const cockpit = path.join(projectPath, ".runtime", "cockpit");
  return existsSync(projectPath) && existsSync(cockpit);
}

async function routeHandler(projection, projectionWorker, configStore, config, request, response) {
  const requestUrl = new URL(request.url || "/", `http://${LOOPBACK_HOST}`);
  const project = (method, ...args) => projectionWorker
    ? projectionWorker.call(method, ...args)
    : projection[method](...args);
  const parts = pathParts(requestUrl);
  const query = requestQuery(requestUrl);
  const method = request.method || "GET";
  const logFields = { path: requestUrl.pathname };

  if (method === "GET" && requestUrl.pathname === "/api/health") {
    assertQuery(query, []);
    // Liveness is cached at startup/recovery: this branch performs no repository
    // stat, task scan, or synchronous log write and therefore stays constant-time.
    if (config.healthError) {
      jsonResponse(response, config.healthError.status || 503, errorBody(config.healthError, config.contractVersion));
      return;
    }
    jsonResponse(response, 200, {
      ok: true,
      contract_version: config.contractVersion,
      connection_state: "connected",
      host: LOOPBACK_HOST,
      port: config.actualPort ?? config.port,
      resolved_loopback_url: config.resolvedLoopbackUrl,
      // panel_root 是稳定实例身份（面板资产根）；control_repo_path 只展示当前监控仓，切仓会变。
      panel_root: config.panelRoot,
      control_repo_path: config.controlRepoPath,
    });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/snapshot") {
    assertQuery(query, FILTER_QUERY_KEYS);
    writeSafeLog(config.logFile, logFields);
    jsonResponse(response, 200, await project("snapshot", query));
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/history") {
    assertQuery(query, FILTER_QUERY_KEYS);
    writeSafeLog(config.logFile, logFields);
    jsonResponse(response, 200, await project("history", query));
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/tasks") {
    assertQuery(query, FILTER_QUERY_KEYS);
    writeSafeLog(config.logFile, logFields);
    jsonResponse(response, 200, await project("tasks", query));
    return;
  }

  if (method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "tasks" && parts[2] && parts[3] === "events") {
    assertQuery(query, []);
    logFields.task_id = parts[2];
    writeSafeLog(config.logFile, logFields);
    const events = await project("taskEvents", parts[2]);
    jsonResponse(response, 200, {
      ok: true,
      contract_version: config.contractVersion,
      section: "task_events",
      section_state: events.state,
      task_id: parts[2],
      events: events.events,
    });
    return;
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "tasks" && parts[2]) {
    assertQuery(query, []);
    logFields.task_id = parts[2];
    writeSafeLog(config.logFile, logFields);
    jsonResponse(response, 200, await project("taskDetail", parts[2]));
    return;
  }

  // 变更路由必须精确匹配段数：多余尾段曾被放行并真实执行写操作（sol 体检高危项）
  if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "tasks" && parts[2] && parts[3] === "cancel") {
    guardMutation(config, request);
    return readBody(request).then((body) => {
      logFields.task_id = parts[2];
      writeSafeLog(config.logFile, logFields);
      // 只有字段缺失才取默认：falsey 的显式非法值（false/0/""）必须进白名单被 400，
      // 不能被 || 洗成合法默认伪造审计语义（sol 复核 F-06）
      const outcome = projection.cancel(parts[2], body.expected_revision, body.reason === undefined ? "user_requested" : body.reason);
      const status = outcome.accepted === false
        ? (outcome.reason === "revision_conflict" ? 409 : 422)
        : 200;
      jsonResponse(response, status, {
        ok: status < 400,
        contract_version: config.contractVersion,
        task_id: parts[2],
        cancel: outcome,
      });
    });
  }

  if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "tasks" && parts[2] && parts[3] === "review-ack") {
    guardMutation(config, request);
    return readBody(request).then((body) => {
      logFields.task_id = parts[2];
      writeSafeLog(config.logFile, logFields);
      const outcome = projection.ackReview(parts[2], body.expected_revision, body.note);
      const status = outcome.accepted === false
        ? (outcome.reason === "revision_conflict" ? 409 : 422)
        : 200;
      jsonResponse(response, status, {
        ok: status < 400,
        contract_version: config.contractVersion,
        task_id: parts[2],
        ack: outcome,
      });
    });
  }

  if (method === "GET" && requestUrl.pathname === "/api/fleet") {
    assertQuery(query, []);
    writeSafeLog(config.logFile, logFields);
    jsonResponse(response, 200, await project("fleet"));
    return;
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "fleet" && parts[2]) {
    assertQuery(query, []);
    logFields.run_id = parts[2];
    writeSafeLog(config.logFile, logFields);
    jsonResponse(response, 200, await project("fleetDetail", parts[2]));
    return;
  }

  // 运行级结束：精确四段，复用 fleet_cancel。多余尾段不进入写操作。
  if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "fleet" && parts[2] && parts[3] === "end") {
    guardMutation(config, request);
    return readBody(request).then(async (body) => {
      logFields.run_id = parts[2];
      writeSafeLog(config.logFile, logFields);
      const outcome = await projection.endFleet(parts[2], body.reason === undefined ? "user_requested" : body.reason);
      jsonResponse(response, 200, {
        ok: true,
        contract_version: config.contractVersion,
        run_id: parts[2],
        end: outcome,
      });
    });
  }

  if (method === "GET" && ["/api/reviews", "/api/review-queue"].includes(requestUrl.pathname)) {
    assertQuery(query, FILTER_QUERY_KEYS);
    writeSafeLog(config.logFile, logFields);
    // fleet 只投影一次：tasks 与 reviews 复用同一份 runs（sol 体检：此前每请求扫两遍）
    const fleet = await project("fleet");
    const tasks = await project("tasks", query, fleet.runs);
    jsonResponse(response, 200, await project("reviews", tasks.tasks, fleet.runs));
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/notifications") {
    assertQuery(query, ["limit"]);
    writeSafeLog(config.logFile, logFields);
    jsonResponse(response, 200, await project("notifications", query));
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/config") {
    assertQuery(query, []);
    jsonResponse(response, 200, { ok: true, contract_version: config.contractVersion, section: "config", config: await configStore.call("configState", config.controlRepoPath) });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/selection") {
    assertQuery(query, []);
    jsonResponse(response, 200, { ok: true, contract_version: config.contractVersion,
      selection: await configStore.call("selectionState", config.controlRepoPath) });
    return;
  }

  if (method === "PUT" && requestUrl.pathname === "/api/selection") {
    guardMutation(config, request);
    const outcome = await configStore.call("saveSelection", await readBody(request), config.controlRepoPath);
    const status = configOutcomeStatus(outcome);
    jsonResponse(response, status, { ok: status === 200, contract_version: config.contractVersion,
      ...(status === 200 ? outcome : { outcome }) });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/sync") {
    guardMutation(config, request);
    await readBody(request);
    jsonResponse(response, 200, { ok: true, contract_version: config.contractVersion,
      ...await configStore.call("sync") });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/config/resources") {
    assertQuery(query, []);
    jsonResponse(response, 200, { ok: true, resource_catalog: await configStore.call("resourceCatalog", config.controlRepoPath) });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/config/catalogs") {
    assertQuery(query, ["refresh"]);
    if (query.refresh !== undefined && query.refresh !== "1") throw new PanelError("QUERY_REFRESH_INVALID", "refresh 只支持 1", { status: 400, scope: "local" });
    jsonResponse(response, 200, { ok: true, catalogs: await configStore.call("refreshCatalogs", { force: query.refresh === "1" }) });
    return;
  }

  // 恢复连接时只更新同源进程令牌，不重载文档；跨源网页无法读取此响应。
  if (method === "GET" && requestUrl.pathname === "/api/session") {
    assertQuery(query, []);
    if (request.headers.host !== `${LOOPBACK_HOST}:${config.actualPort}`
      || (request.headers.origin && request.headers.origin !== config.resolvedLoopbackUrl)
      || request.headers["sec-fetch-site"] === "cross-site") {
      throw new PanelError("SESSION_ORIGIN_REJECTED", "请从面板同源页面读取连接身份", { status: 403, scope: "local" });
    }
    response.setHeader("cache-control", "no-store");
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ panel_token: config.panelToken }));
    return;
  }

  if (method === "PUT" && parts.length === 4 && parts[0] === "api" && parts[1] === "config" && parts[2] === "roles" && parts[3]) {
    guardMutation(config, request);
    return readBody(request).then(async (body) => {
      const outcome = await configStore.call("saveRole", parts[3], body, config.controlRepoPath);
      jsonResponse(response, configOutcomeStatus(outcome), {
        ok: outcome.state === "saved",
        contract_version: config.contractVersion,
        section: "config",
        role: parts[3],
        outcome,
      });
    });
  }

  if (method === "PUT" && requestUrl.pathname === "/api/config/imports") {
    guardMutation(config, request);
    const outcome = await configStore.call("saveImports", await readBody(request));
    jsonResponse(response, configOutcomeStatus(outcome), { ok: outcome.state === "saved", contract_version: config.contractVersion, section: "config", outcome });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/projects") {
    assertQuery(query, []);
    jsonResponse(response, 200, {
      ok: true,
      contract_version: config.contractVersion,
      monitor_root: config.controlRepoPath,
      projects: config.allowedProjects.map((projectPath) => ({
        path: projectPath,
        label: path.basename(projectPath),
        available: projectAvailability(projectPath),
        selected: sameProjectPath(projectPath, config.controlRepoPath),
      })),
    });
    return;
  }

  if (method === "PUT" && requestUrl.pathname === "/api/monitor-root") {
    guardMutation(config, request);
    return readBody(request).then(async (body) => {
      const next = path.resolve(String(body.path || ""));
      if (!config.allowedProjects.some((item) => sameProjectPath(item, next))) {
        throw new PanelError("MONITOR_ROOT_NOT_ALLOWED", "监控根不在允许的项目列表内", { status: 403, details: { path: next } });
      }
      await config.switchMonitorRoot(next);
      jsonResponse(response, 200, {
        ok: true,
        contract_version: config.contractVersion,
        monitor_root: config.controlRepoPath,
      });
    });
  }

  if (method === "GET" && !requestUrl.pathname.startsWith("/api/")) {
    writeSafeLog(config.logFile, logFields);
    if (serveStatic(config.webRoot, requestUrl.pathname, response, config.panelToken)) return;
  }

  jsonResponse(response, 404, {
    ok: false,
    contract_version: config.contractVersion,
    error: { code: "NOT_FOUND", message: "接口不存在", scope: "local", details: null },
  });
}

export async function createPanelServer(options = {}) {
  const panelRoot = resolvePanelRoot(options.panelRoot);
  const panelStateRoot = resolvePanelStateRoot(options.panelStateRoot);
  const webRoot = path.join(panelRoot, "src", "web");
  const controlRepoPath = resolveControlRepoPath(options.controlRepoPath);
  const paths = resolvePanelPaths(controlRepoPath);
  let validationError = null;
  try {
    validateControlRepo(controlRepoPath);
  } catch (error) {
    validationError = error;
  }
  // async-core 实现来自独立运行资产根（发布槽）；监控仓只提供项目 cockpit 数据。
  const asyncCorePath = resolveAsyncCorePath({
    asyncCorePath: options.asyncCorePath,
    runtimeAssetRoot: options.runtimeRoot ?? options.runtimeAssetRoot,
  });
  const registryRoot = resolveRegistryRoot({ paths, registryRoot: options.registryRoot });
  let core = null;
  let service = null;
  // A missing runtime must remain recoverable by polling. A missing control
  // repository has no trustworthy async-core path, so keep only the shell up
  // and expose a global blocker through the loopback API.
  if (!validationError || validationError.code === "CONTROL_RUNTIME_INVALID") {
    ({ core, service } = await createAsyncTaskService({
      paths,
      asyncCorePath,
      asyncCoreModule: options.asyncCoreModule,
      registryRoot,
      overrides: options.asyncCoreOverrides,
    }));
  }
  const contractVersion = core?.CONTRACT_VERSION ?? EXPECTED_CONTRACT_VERSION;
  const projection = new PanelProjection({ paths, service, contractVersion });
  projection.fleetCancelEnv = options.fleetCancelEnv || null;
  projection.fleetCancelTimeoutMs = Number(options.fleetCancelTimeoutMs) > 0 ? Number(options.fleetCancelTimeoutMs) : null;
  // 在线恢复（AC-09）：控制仓路径由不可用变为可用时，节流重试重建 AsyncTaskService，
  // 页面轮询即可恢复，不需要重启服务进程。恢复失败保持全局阻断并带结构化错误。
  let lastRecoveryAttempt = 0;
  let recovering = false;
  async function maybeRecover() {
    if (projection.service || recovering) return;
    const now = Date.now();
    if (now - lastRecoveryAttempt < 5000) return;
    lastRecoveryAttempt = now;
    recovering = true;
    try {
      validateControlRepo(controlRepoPath);
      const rebuilt = await createAsyncTaskService({
        paths,
        asyncCorePath,
        registryRoot,
        overrides: options.asyncCoreOverrides,
      });
      projection.service = rebuilt.service;
      config.healthError = null;
    } catch {
      // 恢复失败：维持现状，下一次轮询再试。
    } finally {
      recovering = false;
    }
  }
  const logRoot = ensurePanelLogDirectory(panelStateRoot);
  const logFile = path.join(logRoot, "server.jsonl");
  const requestedPort = options.port === undefined ? derivePort(panelRoot) : Number(options.port);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new PanelError("PORT_INVALID", "loopback 端口无效", { status: 500 });
  }
  const config = {
    panelRoot,
    panelStateRoot,
    webRoot,
    controlRepoPath,
    paths,
    asyncCorePath,
    registryRoot,
    contractVersion,
    port: requestedPort,
    actualPort: requestedPort,
    host: LOOPBACK_HOST,
    resolvedLoopbackUrl: `http://${LOOPBACK_HOST}:${requestedPort}`,
    logRoot,
    logFile,
    panelToken: randomBytes(16).toString("hex"),
    healthError: validationError || (service ? null : new PanelError("PANEL_SERVICE_UNAVAILABLE", "面板服务不可用")),
    allowedProjects: [],
    switchMonitorRoot: async () => {},
  };
  const projectionWorkerData = service
    && options.aggregateInWorker !== false
    && !options.asyncCoreModule
    && !options.asyncCoreOverrides
    ? {
      paths,
      asyncCorePath,
      registryRoot,
      delayMs: Math.max(0, Number(options.aggregationDelayMs) || 0),
    }
    : null;
  let projectionWorker = null;
  const configOptions = {
    controlRoot: controlRepoPath,
    browser: options.browser === true,
    runtimeRoot: options.runtimeRoot,
    homeDir: options.configHomeDir,
    pythonCommand: options.configPythonCommand,
    piCommand: options.configPiCommand,
    piProbeTimeoutMs: options.configPiProbeTimeoutMs,
    faultInjector: options.configFaultInjector,
    syncFaultInjector: options.configSyncFaultInjector,
    selectionFaultInjector: options.selectionFaultInjector,
  };
  const runtimeRootForProjects = path.resolve(String(
    options.runtimeRoot || process.env.SUBAGENT_RUNTIME_ROOT || publishedRuntimeRoot(),
  ));
  Object.defineProperty(config, "allowedProjects", {
    enumerable: true,
    get: () => (Array.isArray(options.allowedProjects) && options.allowedProjects.length
      ? options.allowedProjects.map((item) => path.resolve(String(item)))
      : readAllowedProjects(runtimeRootForProjects, controlRepoPath, panelStateRoot)),
  });
  config.switchMonitorRoot = async (next) => {
    const newPaths = validateControlRepo(next);
    // 注册表跟随新项目的 cockpit；显式注入/部署级环境变量仍优先。
    const nextRegistryRoot = resolveRegistryRoot({ paths: newPaths, registryRoot: options.registryRoot });
    const rebuilt = await createAsyncTaskService({
      paths: newPaths,
      asyncCorePath,
      asyncCoreModule: options.asyncCoreModule,
      registryRoot: nextRegistryRoot,
      overrides: options.asyncCoreOverrides,
    });
    projection.paths = newPaths;
    projection.service = rebuilt.service;
    config.controlRepoPath = next;
    config.paths = newPaths;
    config.registryRoot = nextRegistryRoot;
    config.healthError = null;
    if (projectionWorker) {
      await projectionWorker.close();
      projectionWorker = new PanelWorker({
        paths: newPaths,
        asyncCorePath,
        registryRoot: nextRegistryRoot,
        delayMs: Math.max(0, Number(options.aggregationDelayMs) || 0),
      });
    }
  };
  // 函数探针只供单元测试注入；生产与子进程集成测试始终走隔离线程。
  const localConfigStore = options.configPiModelProbe
    ? createConfigStore({ ...configOptions, piModelProbe: options.configPiModelProbe, piModelScope: options.configPiModelScope,
      workerResourceCatalog: options.configWorkerResourceCatalog }) : null;
  const localSelectionStore = localConfigStore ? createSelectionStore({ ...configOptions, faultInjector: options.selectionFaultInjector }) : null;
  let configWorker = null;
  let writeTail = Promise.resolve();
  const writeMethods = new Set(["saveRole", "saveImports", "saveSelection", "sync"]);
  const configStore = { call: (method, ...args) => {
    if (!localConfigStore) {
      configWorker ??= new PanelWorker(configOptions, CONFIG_WORKER_ENTRY);
      return configWorker.call(method, ...args);
    }
    const invoke = () => method === "selectionState"
      ? localSelectionStore.selectionState({ catalogs: localConfigStore.catalogs() }, ...args)
      : method === "saveSelection"
        ? localSelectionStore.saveSelection(args[0], { catalogs: localConfigStore.catalogs() }, args[1])
        : method === "sync" ? localSelectionStore.sync() : localConfigStore[method](...args);
    if (!writeMethods.has(method)) return invoke();
    const queued = writeTail.then(invoke);
    writeTail = queued.catch(() => {});
    return queued;
  } };
  const server = http.createServer((request, response) => {
    const startedAt = performance.now();
    response.once("finish", () => {
      writeSafeLog(logFile, {
        path: new URL(request.url || "/", `http://${LOOPBACK_HOST}`).pathname,
        durationMs: performance.now() - startedAt,
        status: response.statusCode,
      });
      if (stopping) server.closeIdleConnections();
    });
    const isHealth = (request.method || "GET") === "GET"
      && new URL(request.url || "/", `http://${LOOPBACK_HOST}`).pathname === "/api/health";
    Promise.resolve()
      .then(() => (isHealth ? null : maybeRecover()))
      .then(() => routeHandler(projection, projectionWorker, configStore, config, request, response))
      .catch((error) => {
        const panelError = error instanceof PanelError
          ? error
          : new PanelError("SERVER_ERROR", "服务处理失败", { details: null });
        if (!response.headersSent) jsonResponse(response, panelError.status || 500, errorBody(panelError, contractVersion));
        writeSafeLog(logFile, { path: request.url || "/" });
      });
  });
  // Node 默认 keepAliveTimeout=5s 与前端 5s 轮询同频：每轮请求都可能撞上服务端
  // 正在关闭空闲连接的瞬间，偶发 ECONNRESET 在前端表现为「连接已阻断」闪现。
  // 拉长到远离轮询周期，连接在整个会话期间持续复用。headersTimeout 必须大于
  // keepAliveTimeout，否则空闲连接会先被 headers 计时器误杀。
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.config = config;
  server.projection = projection;
  server.start = () => new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(new PanelError("LOOPBACK_BIND_FAILED", `loopback 服务启动失败：${error.message}`, { details: null }));
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      config.actualPort = typeof address === "object" && address ? address.port : requestedPort;
      config.resolvedLoopbackUrl = `http://${LOOPBACK_HOST}:${config.actualPort}`;
      if (projectionWorkerData && !projectionWorker) {
        projectionWorker = new PanelWorker(projectionWorkerData);
      }
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, LOOPBACK_HOST);
  });
  let stopping = null;
  server.stop = () => stopping ??= (async () => {
    const httpClosed = server.listening
      ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      : Promise.resolve();
    // 先取消目录查询，让在途响应结束，再退出隔离线程和 HTTP 服务。
    if (localConfigStore) {
      await writeTail;
      await localConfigStore.close();
    }
    if (configWorker) {
      try { if (!configWorker.failure) await configWorker.call("close"); }
      finally { await configWorker.close(); }
    }
    if (projectionWorker) await projectionWorker.close();
    server.closeIdleConnections();
    await httpClosed;
  })();
  return server;
}

export async function startServer(options = {}) {
  const server = await createPanelServer(options);
  await server.start();
  return server;
}

// 端口被占时探测占用者：同面板资产根的健康面板服务在跑则幂等收敛（打印 ready 后退出 0），
// 让壳、派发自动拉起、开发预览等多个拉起方天然共享单例，不再互相抢端口。
// 实例身份是稳定面板资产根（panel_root）+ 契约版本 + 端口；监控仓可切换，不作为身份。
async function probeExistingService(port, panelRoot, expectedContractVersion = EXPECTED_CONTRACT_VERSION) {
  try {
    const response = await fetch(`http://${LOOPBACK_HOST}:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body?.ok) return null;
    if (body.contract_version !== expectedContractVersion) return null;
    const reportedPanelRoot = String(body.panel_root || "").trim();
    if (!reportedPanelRoot || !sameProjectPath(reportedPanelRoot, panelRoot)) return null;
    if (String(body.resolved_loopback_url || "") !== `http://${LOOPBACK_HOST}:${port}`) return null;
    return body;
  } catch {
    return null;
  }
}

export async function runCli(options = {}) {
  let server;
  try {
    server = await startServer(options);
  } catch (error) {
    if (error?.code === "LOOPBACK_BIND_FAILED") {
      const panelRoot = resolvePanelRoot(options.panelRoot);
      const port = Number.isInteger(options.port) ? options.port : derivePort(panelRoot);
      const existing = await probeExistingService(port, panelRoot);
      if (existing) {
        console.log(JSON.stringify({
          ready: true,
          attached: true,
          contract_version: existing.contract_version,
          resolved_loopback_url: existing.resolved_loopback_url,
          // 当前监控仓仅作展示：跨仓切换后同资产根的附着保持可用。
          control_repo_path: existing.control_repo_path ?? null,
        }));
        process.exit(0);
      }
    }
    throw error;
  }
  console.log(JSON.stringify({
    ready: true,
    contract_version: server.config.contractVersion,
    resolved_loopback_url: server.config.resolvedLoopbackUrl,
  }));
  const stop = () => server.stop().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}

export { EXPECTED_CONTRACT_VERSION, LOOPBACK_HOST };
