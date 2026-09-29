#!/usr/bin/env node
// 盯子代理运行态，每个需要主代理醒来的事件输出一行：完成/失败/取消、服务商重试、卡住、fleet 状态与待审节点。
// 常驻：node ops/tools/async_watch.mjs（交给 Claude Code 的 Monitor，到期重新挂）
// 等指定任务：node ops/tools/async_watch.mjs --tasks <id,...> --fleets <run,...> --until-done（后台 Bash，结束或需处置后退出）
// 常驻模式把进度写进 .runtime/cockpit/async_watch.cursor.json；重挂时从上次进度接着报，两次监听之间的事件不丢。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const TERMINAL = new Set(["done", "failed", "cancelled"]);
const FLEET_TERMINAL = new Set(["completed", "failed", "cancelled", "needs_parent_review", "blocked", "paused"]);

function parseArgs(argv) {
  const args = { project: process.cwd(), tasks: [], fleets: [], untilDone: false, interval: 5, stallMinutes: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--until-done") args.untilDone = true;
    else if (flag === "--project") args.project = argv[++i];
    else if (flag === "--tasks") args.tasks = argv[++i].split(",").filter(Boolean);
    else if (flag === "--fleets") args.fleets = argv[++i].split(",").filter(Boolean);
    else if (flag === "--interval") args.interval = Number(argv[++i]);
    else if (flag === "--stall-minutes") args.stallMinutes = Number(argv[++i]);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (args.untilDone && !args.tasks.length && !args.fleets.length) throw new Error("--until-done needs --tasks or --fleets");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const cockpit = path.join(path.resolve(args.project), ".runtime", "cockpit");
const tasksRoot = path.join(cockpit, "async_tasks");
const inboxRoot = path.join(cockpit, "async_inbox");
const fleetRoot = path.join(cockpit, "fleet_runs");
const cursorFile = path.join(cockpit, "async_watch.cursor.json");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    // 另一进程正在原子替换时会短暂读不到或读到半截，下一轮再读。
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function list(dir) {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function clip(text, size = 160) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > size ? `${value.slice(0, size)}…` : value;
}

function emit(line) {
  process.stdout.write(`${line}\n`);
}

const wanted = new Set(args.tasks);
const watchAll = !args.untilDone;
const cursor = watchAll ? readJson(cursorFile) : null;
const resumeAt = cursor ? Date.parse(cursor.at) : Infinity;
// 上次监听之后才落下的通知留给首轮报告，其余视为已读。
const seenInbox = new Map(watchAll ? list(inboxRoot).filter((name) => statSync(path.join(inboxRoot, name)).mtimeMs <= resumeAt)
  .map((name) => [name, JSON.stringify(readJson(path.join(inboxRoot, name)))]) : []);
const knownDirs = new Set(list(tasksRoot));
const tracked = new Map(); // task_id -> { title, retryKey, stallKey }
const fleets = new Map(Object.entries(cursor?.fleets || {})); // run_id -> { state, review, failed }

function track(taskId) {
  if (tracked.has(taskId)) return;
  const status = readJson(path.join(tasksRoot, taskId, "status.json"));
  if (!status || TERMINAL.has(status.state)) return;
  tracked.set(taskId, { title: status.display_title || taskId, retryKey: null, stallKey: null });
}

// 起点：已在跑的任务纳入跟踪，历史终态与已有通知不重复报。
for (const taskId of knownDirs) if (watchAll || wanted.has(taskId)) track(taskId);
for (const taskId of wanted) track(taskId);

function taskLabel(taskId) {
  return tracked.get(taskId)?.title || readJson(path.join(tasksRoot, taskId, "status.json"))?.display_title || taskId;
}

function scanInbox() {
  for (const name of list(inboxRoot)) {
    const notice = readJson(path.join(inboxRoot, name));
    if (!notice) continue;
    const version = JSON.stringify(notice);
    if (seenInbox.get(name) === version) continue;
    const taskId = notice.task_id;
    if (!watchAll && !wanted.has(taskId)) continue;
    const status = readJson(path.join(tasksRoot, taskId, "status.json")) || {};
    if (notice.type === "attention" && String(status.rev) !== String(notice.revision)) continue;
    seenInbox.set(name, version);
    const who = `${taskLabel(taskId)} · ${status.model || "?"}@${status.effort || "?"}`;
    if (name.endsWith(".stall.json") || notice.type === "stall") {
      emit(`静默告警 ${who} · ${clip(notice.reason || notice.summary)} · ${taskId}`);
      track(taskId);
      continue;
    }
    if (notice.type === "attention") {
      emit(`待处理 ${who} · ${notice.state} · ${clip(notice.reason)} · ${clip(notice.next_action)} · ${taskId}`);
    } else if (notice.state === "cancelled" || notice.failure_type === "cancelled") {
      emit(`取消 ${who} · ${clip(notice.cancel_reason)} · ${taskId}`);
    } else if (notice.state === "failed" || (notice.failure_type && notice.failure_type !== "none")) {
      emit(`失败 ${who} · failure=${notice.failure_type} · ${clip(notice.latest_model_error || notice.error)} · ${taskId}`);
    } else {
      const review = notice.requires_parent_review ? " · 待主代理审阅" : "";
      emit(`完成 ${who} · business=${notice.business_state}${review} · 报告 ${notice.business_report_path || notice.report_path} · ${taskId}`);
    }
    tracked.delete(taskId);
    wanted.delete(taskId);
  }
}

function scanNewTasks() {
  for (const taskId of watchAll ? list(tasksRoot) : wanted) track(taskId);
}

function scanRunning() {
  for (const [taskId, info] of tracked) {
    const live = readJson(path.join(tasksRoot, taskId, "child-task-live.json"));
    const status = readJson(path.join(tasksRoot, taskId, "status.json"));
    if (live && (live.event === "auto_retry_start" || live.event === "auto_retry_end")) {
      const detail = live.event_extra?.detail || {};
      const key = `${live.event}:${detail.attempt}:${live.rev}`;
      if (key !== info.retryKey) {
        info.retryKey = key;
        if (live.event === "auto_retry_start") {
          emit(`服务商重试 ${info.title} · 第 ${detail.attempt}/${detail.maxAttempts} 次 · ${clip(detail.errorMessage)} · ${taskId}`);
        } else if (detail.success === false) {
          emit(`重试放弃 ${info.title} · ${clip(detail.errorMessage)} · ${taskId}`);
        }
      }
    }
    // status.stall 只在有人查询任务时才计算，这里按 live 的最后事件时间自己判断静默。
    const lastEventAt = Date.parse(live?.last_event_at || "");
    const silentMinutes = (Date.now() - lastEventAt) / 60000;
    if (status?.state === "running" && silentMinutes >= args.stallMinutes) {
      if (info.stallKey !== live.last_event_at) {
        info.stallKey = live.last_event_at;
        emit(`卡住 ${info.title} · 静默 ${Math.round(silentMinutes)} 分钟 · 最后阶段 ${live.phase} · 最后工具 ${live.last_tool_call?.name || "?"} · ${taskId}`);
      }
    }
  }
}

function scanFleets() {
  const runs = watchAll ? list(fleetRoot) : args.fleets;
  for (const runId of runs) {
    const state = readJson(path.join(fleetRoot, runId, "state.json"));
    if (!state) continue;
    const nodes = Array.isArray(state.nodes) ? state.nodes : [];
    const review = nodes.filter((node) => node.state === "needs_parent_review").map((node) => node.id).sort().join(",");
    const failed = nodes.filter((node) => node.state === "failed").map((node) => node.id).sort().join(",");
    const previous = fleets.get(runId);
    const driver = readJson(path.join(fleetRoot, runId, "driver.json"));
    const parked = Boolean(driver && driver.status !== "running" && driver.finished_at);
    const current = { state: state.run_state, review, failed,
      driver: driver?.status || null, parked, error: driver?.error || null };
    fleets.set(runId, current);
    // 常驻模式下启动时已存在的 fleet 只建基线；显式点名的 fleet 首次读取就报一次。
    if (!previous && watchAll && !parked && !FLEET_TERMINAL.has(current.state)) continue;
    if (previous && JSON.stringify(previous) === JSON.stringify(current)) continue;
    const parts = [`编队 ${runId} · ${current.state}`];
    if (parked || ["needs_parent_review", "blocked", "paused"].includes(current.state)) {
      parts.push(`待处理 driver=${current.driver || "?"}${current.error ? ` · ${clip(current.error)}` : ""}`);
    }
    if (review) parts.push(`待审 ${review}`);
    if (failed) parts.push(`失败节点 ${failed}`);
    emit(parts.join(" · "));
  }
}

function done() {
  if (!args.untilDone) return false;
  const tasksDone = [...wanted].every((taskId) => {
    const status = readJson(path.join(tasksRoot, taskId, "status.json"));
    return status && TERMINAL.has(status.state) && seenInbox.has(`${taskId}.json`);
  });
  const fleetsDone = args.fleets.every((runId) => {
    const fleet = fleets.get(runId);
    return FLEET_TERMINAL.has(fleet?.state) || fleet?.parked;
  });
  return tasksDone && fleetsDone;
}

function tick() {
  const at = new Date().toISOString();
  scanNewTasks();
  scanInbox();
  scanRunning();
  scanFleets();
  if (watchAll) writeFileSync(cursorFile, `${JSON.stringify({ at, fleets: Object.fromEntries(fleets) })}\n`);
  if (done()) {
    emit("监听结束：任务已结束或待处理");
    process.exit(0);
  }
}

emit(`开始监听 ${cockpit} · 跟踪中 ${tracked.size} 个任务${cursor ? ` · 接续 ${cursor.at}` : ""}`);
tick();
setInterval(tick, args.interval * 1000);
