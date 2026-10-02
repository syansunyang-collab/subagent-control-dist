import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ROOT,
  ToolError,
  ids,
  isRecord,
  normalizeConflictPath,
  pathConflict,
  readStdinText,
} from "../_tool_common.mjs";
import { pyGetItem, pyJsonLoads, pyStr, pyStrip, pyTruthy } from "../_py.mjs";
import { expandSeed } from "../seed_minimal.mjs";
import { parseSeed, sampleSeed } from "../task_package_build.mjs";
import { lintPackage } from "../task_package_lint.mjs";
import { jsonDumpsCompact, pySlice, sortedStrings } from "./py-utils.mjs";

export function seedBudget(seed) {
  const raw = seed?.budget;
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) throw new ToolError("seed.budget must be an object with max_elapsed_minutes");
  const out = {};
  // 预算只有墙钟时限；旧种子里的 max_tool_calls 不再解析（空转熔断与时限覆盖失控场景）。
  for (const key of ["max_elapsed_minutes"]) {
    if (Object.hasOwn(raw, key) && raw[key] !== null && raw[key] !== undefined) {
      const value = raw[key];
      if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
        throw new ToolError(`seed.budget.${key} must be a positive number`);
      }
      out[key] = value;
    }
  }
  return out;
}

// ---- 写冲突 ----

export function conflictPaths(value) {
  if (typeof value === "string") return pyStrip(value) ? [value] : [];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && pyStrip(item)).map(String);
  return [];
}

export function seedWriteConflictPaths(seed) {
  const scope = isRecord(seed?.scope) ? seed.scope : {};
  const expected = isRecord(seed?.expected_output) ? seed.expected_output : {};
  const handoff = isRecord(seed?.handoff_contract) ? seed.handoff_contract : {};
  const concurrency = isRecord(seed?.concurrency_contract) ? seed.concurrency_contract : {};
  const conflictKeys = isRecord(concurrency.conflict_keys) ? concurrency.conflict_keys : {};
  const rawPaths = [];
  rawPaths.push(...conflictPaths(scope.write));
  rawPaths.push(...conflictPaths(scope.write_extra));
  rawPaths.push(...conflictPaths(scope.delete));
  rawPaths.push(...conflictPaths(conflictKeys.write));
  rawPaths.push(...conflictPaths(conflictKeys.delete));
  rawPaths.push(...conflictPaths(conflictKeys.output));
  for (const key of ["file_path", "path", "resolved_file_path"]) {
    rawPaths.push(...conflictPaths(expected[key]));
  }
  rawPaths.push(...conflictPaths(handoff.handoff_file));
  rawPaths.push(...conflictPaths(handoff.resolved_handoff_file));
  const normalized = new Set();
  for (const item of rawPaths) {
    const value = normalizeConflictPath(item);
    if (value) normalized.add(value);
  }
  return sortedStrings(normalized);
}

export function batchWriteConflicts(seeds) {
  const rows = seeds.map((seed, idx) => ({
    seed_index: idx + 1,
    route_id: pyStr(pyTruthy(seed?.route_id) ? seed.route_id : ""),
    write_paths: seedWriteConflictPaths(seed),
  }));
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    const left = rows[leftIndex];
    for (const right of rows.slice(leftIndex + 1)) {
      const hits = [];
      for (const leftPath of left.write_paths) {
        for (const rightPath of right.write_paths) {
          if (pathConflict(leftPath, rightPath)) hits.push({ left: leftPath, right: rightPath });
        }
      }
      if (hits.length) {
        conflicts.push({
          left_seed_index: left.seed_index,
          right_seed_index: right.seed_index,
          left_route_id: left.route_id,
          right_route_id: right.route_id,
          conflicts: hits,
        });
      }
    }
  }
  return conflicts;
}

// ---- seed 输入 ----

export function readSeedFileText(target) {
  let rawBytes;
  try {
    rawBytes = readFileSync(String(target));
  } catch (error) {
    const detail = systemErrorText(error);
    throw new ToolError(`cannot read --seed file: ${target}: ${detail}`);
  }
  const stripped = rawBytes.length >= 3 && rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf
    ? rawBytes.subarray(3)
    : rawBytes;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stripped);
  } catch {
    // utf-8-sig 失败，回退 utf-16（Python 的 utf-16 需要 BOM 判定字节序）。
  }
  if (rawBytes.length >= 2 && rawBytes[0] === 0xff && rawBytes[1] === 0xfe && rawBytes.length % 2 === 0) {
    return rawBytes.subarray(2).toString("utf16le");
  }
  if (rawBytes.length >= 2 && rawBytes[0] === 0xfe && rawBytes[1] === 0xff && rawBytes.length % 2 === 0) {
    const swapped = Buffer.from(rawBytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  throw new ToolError(`--seed file invalid encoding; expected UTF-8 (with or without BOM) or UTF-16: ${target}`);
}

/** Python OSError 的 strerror（拿不到时退回消息全文）。 */
function systemErrorText(error) {
  const map = {
    ENOENT: "No such file or directory",
    EACCES: "Permission denied",
    EISDIR: "Is a directory",
    ENOTDIR: "Not a directory",
    EPERM: "Operation not permitted",
    EMFILE: "Too many open files",
  };
  return map[error?.code] || String(error?.message ?? error);
}

export function expandDispatchSeed(seed) {
  const expanded = expandSeed(parseSeed(JSON.stringify(seed)));
  for (const key of ["slice_id", "slug", "title"]) {
    const value = seed?.[key];
    if (value !== null && value !== undefined && value !== "") expanded[key] = value;
  }
  return expanded;
}

export function loadSeeds(args) {
  const sources = [Boolean(pyTruthy(args?.seed)), Boolean(pyTruthy(args?.seed_stdin)), Boolean(pyTruthy(args?.sample_route))];
  if (sources.filter(Boolean).length !== 1) {
    throw new ToolError("provide exactly one of --seed, --seed-stdin or --sample-route");
  }
  if (pyTruthy(args.sample_route)) return [sampleSeed(args.sample_route)];
  const raw = pyTruthy(args.seed_stdin) ? readStdinText("--seed-stdin") : readSeedFileText(args.seed);
  let data;
  try {
    data = pyJsonLoads(raw);
  } catch (error) {
    if (error?.name === "JSONDecodeError") throw new ToolError(`seed JSON invalid: ${error.message}`);
    throw error;
  }
  if (Array.isArray(data)) {
    if (!data.length) throw new ToolError("seed array is empty");
    return data.map((item) => expandDispatchSeed(item));
  }
  return [expandDispatchSeed(data)];
}

export function lintOrFail(pkg) {
  // 此入口消费本编译链的buildPackage产物；独立lintPackage默认保留全检。
  const issues = lintPackage(pkg, { compiled: true });
  if (issues.length) throw new ToolError(`task package lint failed: ${issues.join("; ")}`);
}

export function packagePathForTemp(pkg) {
  const taskPackage = pyGetItem(pkg, "task_package");
  const packageId = pyStr(pyTruthy(taskPackage.package_id) ? taskPackage.package_id : "package");
  const safe = pySlice(
    Array.from(packageId).map((ch) => (/[\p{L}\p{N}]/u.test(ch) || "._-".includes(ch) ? ch : "-")).join(""),
    120,
  );
  const target = path.join(ROOT, "tmp", "dispatch_prepare", `${safe}-${ids.uuidHex()}.task-package.json`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${jsonDumpsCompact(pkg)}\n`, "utf8");
  return target;
}
