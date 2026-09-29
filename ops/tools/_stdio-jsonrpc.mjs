import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function stringArg(args, key, fallback = "") {
  const value = args[key];
  if (value === undefined || value === null || value === true) {
    return fallback;
  }
  const text = String(value);
  return text.length > 0 ? text : fallback;
}

export function numberArg(args, key, fallback) {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function boolArg(args, key, fallback = false) {
  if (args[key] === undefined) {
    return fallback;
  }
  const value = String(args[key]).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function notificationWaitFailureType(error) {
  const message = String(error?.message ?? error);
  if (message.includes("timeout waiting for notification")) {
    return "turn_timeout";
  }
  if (message.includes("process exited before response")) {
    return "app_server_exit";
  }
  return "turn_wait_failed";
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function stampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function defaultControlHome() {
  const base =
    process.env.LOCALAPPDATA ||
    process.env.XDG_STATE_HOME ||
    process.env.APPDATA ||
    process.env.TMPDIR ||
    process.cwd();
  return path.join(base, "SubagentControl", "subagent-control");
}

export function commandDisplay(spec) {
  return [spec.command, ...(spec.args ?? [])].map((part) => {
    const text = String(part);
    return /\s/.test(text) ? `"${text}"` : text;
  }).join(" ");
}

export function redactAuth(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactAuth(entry));
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret|key|password|credential|cookie|authorization|email/i.test(key)) {
      out[key] = entry ? "[redacted]" : entry;
    } else {
      out[key] = redactAuth(entry);
    }
  }
  return out;
}

export function redactText(text) {
  return String(text)
    .replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g, "[redacted-openai-key]")
    .replace(/__cf_chl_tk=[^&\s"'<>]+/gi, "__cf_chl_tk=[redacted]")
    .replace(/__cf_chl_rt_tk=[^&\s"'<>]+/gi, "__cf_chl_rt_tk=[redacted]")
    .replace(/cf_chl_rt_tk=[^&\s"'<>]+/gi, "cf_chl_rt_tk=[redacted]")
    .replace(/cf_clearance=[^&;\s"'<>]+/gi, "cf_clearance=[redacted]")
    .replace(/(["']?(?:session|jwt|token|challenge)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]")
    .replace(/([?&](?:md|mdrd|token|session|jwt|challenge)=[^&\s"'<>]{16,})/gi, (value) => {
      const key = value.split("=")[0];
      return `${key}=[redacted]`;
    })
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/"email"\s*:\s*"[^"]+"/gi, '"email":"[redacted]"')
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token":"[redacted]"')
    .replace(/"id_token"\s*:\s*"[^"]+"/gi, '"id_token":"[redacted]"');
}

export function redactRecord(record) {
  const next = { ...record };
  if (typeof next.line === "string") {
    try {
      next.line = JSON.stringify(redactAuth(JSON.parse(next.line)));
    } catch {
      next.line = redactText(next.line);
    }
  }
  return next;
}

export function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

export function summarizeError(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
    stack: error.stack ? String(error.stack).split(/\r?\n/).slice(0, 6) : [],
  };
}

export class LineJsonRpcClient {
  constructor(spec, options = {}) {
    this.spec = spec;
    this.jsonrpc = options.jsonrpc ?? false;
    this.cwd = options.cwd ?? process.cwd();
    this.defaultTimeoutMs = options.timeoutMs ?? 30000;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationWaiters = [];
    this.notifications = [];
    this.stderrLines = [];
    this.stdoutLines = [];
    this.stdoutRecords = [];
    this.stderrRecords = [];
    this.requests = [];
    this.child = null;
    this.exitInfo = null;
    this.env = options.env ?? {};
    this.startedAt = null;
    this.failOnMalformedJson = options.failOnMalformedJson ?? false;
    this.failOnStdoutClose = options.failOnStdoutClose ?? false;
    this.stdoutClosed = false;
    this.transportFailure = null;
    this.onNotification = typeof options.onNotification === "function" ? options.onNotification : null;
    this.onRequestUpdate = typeof options.onRequestUpdate === "function" ? options.onRequestUpdate : null;
  }

  start() {
    this.startedAt = new Date().toISOString();
    this.child = spawn(this.spec.command, this.spec.args, {
      cwd: this.cwd,
      shell: this.spec.shell,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env, NO_COLOR: "1" },
    });

    this.child.on("error", (error) => {
      this.exitInfo = { error: error.message, at: new Date().toISOString() };
      this.rejectAll(error);
    });

    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal, at: new Date().toISOString() };
      const error = this.failOnStdoutClose && code === 0
        ? new Error("stdout closed before response")
        : new Error(`process exited before response: code=${code} signal=${signal}`);
      if (this.failOnStdoutClose) {
        this.failTransport(error);
      } else {
        this.rejectAll(error);
      }
      // 子代理遗留的长驻孙进程会继承 stdio 管道,子进程退出后 close 永不触发,wrapper 被吊死。
      // 退出 10 秒后仍未 close 就强制销毁流,让读端收尾。
      const streams = [this.child.stdout, this.child.stderr].filter(Boolean);
      const reaper = setTimeout(() => {
        for (const stream of streams) {
          try {
            stream.destroy();
          } catch {
            /* stream already closed */
          }
        }
      }, 10000);
      reaper.unref?.();
    });

    const stdoutReader = readline.createInterface({ input: this.child.stdout });
    const handleStdoutClose = () => {
      if (this.stdoutClosed) {
        return;
      }
      this.stdoutClosed = true;
      if (this.failOnStdoutClose) {
        this.failTransport(new Error("stdout closed before response"));
      }
    };
    this.child.stdout.once("end", handleStdoutClose);
    this.child.stdout.once("close", handleStdoutClose);
    stdoutReader.on("line", (line) => {
      const record = { at: new Date().toISOString(), line };
      this.stdoutLines.push(line);
      this.stdoutRecords.push(record);
      this.handleLine(line);
    });
    stdoutReader.on("close", handleStdoutClose);

    readline.createInterface({ input: this.child.stderr }).on("line", (line) => {
      const record = { at: new Date().toISOString(), line };
      this.stderrLines.push(line);
      this.stderrRecords.push(record);
    });

    return this;
  }

  rejectAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.record.status = "aborted";
      entry.record.completedAt = new Date().toISOString();
      entry.record.error = summarizeError(error);
      entry.reject(error);
    }
    this.pending.clear();

    for (const waiter of this.notificationWaiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      if (waiter.reject) {
        waiter.reject(error);
      }
    }
    this.notificationWaiters = [];
  }

  failTransport(error) {
    if (!this.transportFailure) {
      this.transportFailure = error instanceof Error ? error : new Error(String(error));
    }
    this.rejectAll(this.transportFailure);
  }

  handleMalformedLine(_line, error) {
    if (!this.failOnMalformedJson) {
      return;
    }
    const transportError = new SyntaxError(`malformed JSON-RPC line: ${error?.message ?? String(error)}`);
    this.failTransport(transportError);
  }

  handleStructurallyInvalidLine(message) {
    if (!this.failOnMalformedJson) {
      return;
    }
    const preview = JSON.stringify(message).slice(0, 120);
    this.failTransport(new TypeError(`structurally invalid JSON-RPC message: ${preview}`));
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleMalformedLine(line, error);
      return;
    }

    // JSON 语法合法但结构非法的包（null/标量/数组/无 id 无 method 的对象）不得进入响应或
    // 通知分发：非严格模式与畸形 JSON 同语义忽略，严格模式立即判运输失败。
    const isPlainObject = message !== null && typeof message === "object" && !Array.isArray(message);
    if (
      !isPlainObject ||
      (!Object.prototype.hasOwnProperty.call(message, "id") && typeof message.method !== "string")
    ) {
      this.handleStructurallyInvalidLine(message);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const key = String(message.id);
      const entry = this.pending.get(key);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(key);
        entry.record.completedAt = new Date().toISOString();
        entry.record.durationMs = Date.now() - entry.startedMs;
        entry.record.status = message.error ? "error" : "ok";
        entry.record.error = redactAuth(message.error ?? null);
        entry.record.resultKeys =
          message.result && typeof message.result === "object" ? Object.keys(message.result) : [];
        this.emitRequestUpdate(entry.record);
        entry.resolve(message);
      }
      return;
    }

    this.notifications.push(message);
    this.emitNotification(message);
    const remaining = [];
    for (const waiter of this.notificationWaiters) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        remaining.push(waiter);
      }
    }
    this.notificationWaiters = remaining;
  }

  request(method, params, options = {}) {
    if (this.transportFailure) {
      return Promise.reject(this.transportFailure);
    }
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error("process is not writable"));
    }

    const id = this.nextId;
    this.nextId += 1;

    const payload = this.jsonrpc ? { jsonrpc: "2.0", id, method } : { id, method };
    if (params !== undefined) {
      payload.params = params;
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const startedMs = Date.now();
    const record = {
      id,
      method,
      startedAt: new Date(startedMs).toISOString(),
      timeoutMs,
      status: "pending",
    };
    if (options.recordParams) {
      record.params = redactAuth(params);
    }
    this.requests.push(record);
    this.emitRequestUpdate(record);

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        record.status = "timeout";
        record.completedAt = new Date().toISOString();
        record.durationMs = Date.now() - startedMs;
        record.recentNotifications = this.notifications.slice(-10).map((message) => message.method ?? null);
        this.emitRequestUpdate(record);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer, record, startedMs });
    });

    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  emitNotification(message) {
    if (!this.onNotification) {
      return;
    }
    try {
      this.onNotification(message, this);
    } catch {
      // Telemetry callbacks must not disturb the JSON-RPC transport.
    }
  }

  emitRequestUpdate(record) {
    if (!this.onRequestUpdate) {
      return;
    }
    try {
      this.onRequestUpdate(record, this);
    } catch {
      // Telemetry callbacks must not disturb the JSON-RPC transport.
    }
  }

  notify(method, params = {}) {
    if (this.transportFailure) {
      throw this.transportFailure;
    }
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("process is not writable");
    }
    const payload = this.jsonrpc ? { jsonrpc: "2.0", method, params } : { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  waitForNotification(predicate, options = {}) {
    if (this.transportFailure) {
      return Promise.reject(this.transportFailure);
    }
    for (const message of this.notifications) {
      if (predicate(message)) {
        return Promise.resolve(message);
      }
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return new Promise((resolve, reject) => {
        this.notificationWaiters.push({ predicate, resolve, reject, timer: null });
      });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.notificationWaiters = this.notificationWaiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error("timeout waiting for notification"));
      }, timeoutMs);
      this.notificationWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  notificationCounts() {
    return countBy(this.notifications, (message) => message.method ?? "<unknown>");
  }

  rawResponseItemCounts() {
    return countBy(
      this.notifications.filter((message) => message.method === "rawResponseItem/completed"),
      (message) => `${message.params?.item?.type ?? "unknown"},${message.params?.item?.role ?? "none"}`,
    );
  }

  stderrSummary(limit = 8, lineLimit = 500) {
    return {
      count: this.stderrLines.length,
      head: this.stderrLines.slice(0, limit).map((line) => line.slice(0, lineLimit)),
      tail: this.stderrLines.slice(-limit).map((line) => line.slice(0, lineLimit)),
    };
  }

  stdoutSummary(limit = 8, lineLimit = 500) {
    return {
      count: this.stdoutLines.length,
      head: this.stdoutLines.slice(0, limit).map((line) => line.slice(0, lineLimit)),
      tail: this.stdoutLines.slice(-limit).map((line) => line.slice(0, lineLimit)),
    };
  }

  saveEvidence(outDir, prefix = "stdio-jsonrpc", options = {}) {
    if (!outDir) {
      return null;
    }
    ensureDir(outDir);
    const includeRaw = options.includeRaw ?? true;
    const paths = {
      stdout: path.join(outDir, `${prefix}.stdout.json`),
      stderr: path.join(outDir, `${prefix}.stderr.json`),
      notifications: path.join(outDir, `${prefix}.notifications.json`),
      requests: path.join(outDir, `${prefix}.requests.json`),
      summary: path.join(outDir, `${prefix}.summary.json`),
    };
    if (includeRaw) {
      writeFileSync(paths.stdout, JSON.stringify(this.stdoutRecords.map(redactRecord), null, 2), "utf8");
      writeFileSync(paths.stderr, JSON.stringify(this.stderrRecords.map(redactRecord), null, 2), "utf8");
      writeFileSync(paths.notifications, JSON.stringify(redactAuth(this.notifications), null, 2), "utf8");
      writeFileSync(paths.requests, JSON.stringify(redactAuth(this.requests), null, 2), "utf8");
    } else {
      writeFileSync(paths.stdout, JSON.stringify(this.stdoutSummary(), null, 2), "utf8");
      writeFileSync(paths.stderr, JSON.stringify(this.stderrSummary(), null, 2), "utf8");
      writeFileSync(paths.notifications, JSON.stringify({
        raw_saved: false,
        count: this.notifications.length,
        notificationCounts: this.notificationCounts(),
        rawResponseItemCounts: this.rawResponseItemCounts(),
      }, null, 2), "utf8");
      writeFileSync(paths.requests, JSON.stringify({
        raw_saved: false,
        count: this.requests.length,
        methods: countBy(this.requests, (record) => record.method ?? "<unknown>"),
        statuses: countBy(this.requests, (record) => record.status ?? "<unknown>"),
      }, null, 2), "utf8");
    }
    writeFileSync(
      paths.summary,
      JSON.stringify(
        {
          command: commandDisplay(this.spec),
          cwd: this.cwd,
          raw_saved: includeRaw,
          startedAt: this.startedAt,
          exitInfo: this.exitInfo,
          requestCount: this.requests.length,
          notificationCounts: this.notificationCounts(),
          rawResponseItemCounts: this.rawResponseItemCounts(),
          stderr: this.stderrSummary(),
        },
        null,
        2,
      ),
      "utf8",
    );
    return paths;
  }

  stop() {
    if (!this.child) {
      return { requested: false, reason: "not_started", exitInfo: this.exitInfo };
    }
    // 只在子进程仍存活时整树收割(taskkill /T);已退出的 pid 可能被系统复用,严禁再杀。
    const alive = this.child.exitCode === null && this.child.signalCode === null && !this.child.killed;
    const treeKill = alive
      ? killProcessTree(this.child.pid)
      : { requested: false, reason: this.child.killed ? "already_killed" : "child_exited" };
    if (this.child.killed) {
      return { requested: false, reason: "already_killed", treeKill, exitInfo: this.exitInfo };
    }
    try {
      this.child.kill();
      return { requested: true, reason: "kill_sent", treeKill, exitInfo: this.exitInfo };
    } catch (error) {
      return { requested: false, reason: "kill_failed", treeKill, error: error.message, exitInfo: this.exitInfo };
    }
  }
}

export function killProcessTree(pid) {
  // 子代理在 turn 里起的长驻进程(测试服务器等)会吊死 worker 的进程树等待;
  // Windows 上 child.kill() 只杀直接子进程,这里对仍存活的子进程整树收割。
  if (!pid || process.platform !== "win32") {
    return { requested: false, reason: "not_applicable" };
  }
  try {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 15000,
      encoding: "utf8",
    });
    return { requested: true, exitCode: result.status ?? null };
  } catch (error) {
    return { requested: false, reason: "taskkill_failed", error: error.message };
  }
}
