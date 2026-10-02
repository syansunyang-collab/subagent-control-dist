import path from "node:path";

import { ROOT } from "../_tool_common.mjs";
import { DISPATCH_CONTRACT_VERSION as PREPARED_DISPATCH_CONTRACT_VERSION } from "../prepared_dispatch.mjs";

export const PREFLIGHT_FILE_THRESHOLD = 400;
export const PREFLIGHT_BYTES_THRESHOLD = 10 * 1024 * 1024;
export const PREFLIGHT_LARGE_FILE_BYTES = 2 * 1024 * 1024;
export const PREFLIGHT_WALK_SKIP_DIRS = new Set([".git", ".runtime", "node_modules", "__pycache__", "tmp"]);
export const PREFLIGHT_WALK_SKIP_PATHS = [["ops", "dist"]];
export const PREFLIGHT_GIT_TIMEOUT_SECONDS = 15;
export const PREFLIGHT_STAT_FILE_CAP = 20000;
export const PREFLIGHT_BINARY_LIKE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".7z",
  ".dwg", ".dxf", ".step", ".stp", ".iges", ".igs",
  ".exe", ".dll", ".bin", ".dat", ".mp4", ".avi",
]);
export const ASYNC_MCP_SERVER_NAME = "asyncSubagent";
export const ASYNC_DISPATCH_CONTRACT_VERSION = PREPARED_DISPATCH_CONTRACT_VERSION;
export const CROSS_REPO_RESULT_MODES = new Set(["read_only_audit", "simulated_planning", "real_rerun"]);
export const ACCEPTANCE_SYNTHESIS_PROFILE = "acceptance_synthesis_v1";
// 裸 basename 哨兵：async 服务端把它解析为自身部署形态内的可信 runner
// （仓内=tools/ 源文件，部署槽=随 release 发布的 bundle）。
export const PI_ASYNC_RUNNER_SENTINEL = "run-pi-task.mjs";
// Resolve the user-level config only when a submit/preview readiness path asks for it;
// prepare-only must not touch the home directory or user MCP configuration.
export const GLOBAL_CONFIG_PATH = null;
export const PROJECT_ASYNC_TASK_ROOT = path.join(ROOT, ".runtime", "cockpit", "async_tasks");
