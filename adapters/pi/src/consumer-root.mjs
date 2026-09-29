// 消费运行根读取接口：CR-ROOTS-v1 / CR-PACKAGE-v1 / CR-CONSUMER-v1 的装配面实现。
// 职责：读取项目 marker，校验受信发布槽与包 inventory，解析已声明入口；不解析项目业务。
// 设计约束：marker 不是授权凭证；项目 marker 不能定义或扩大受信根清单；
// 无效 marker 一律 fail closed，缺失 marker 才走既有精确白名单开发分支。
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const CONSUMER_MARKER_SEGMENTS = Object.freeze([".pi", "control-plane-consumer.json"]);
export const CONSUMER_INVENTORY_FILE = "consumer-release-manifest.json";
export const CONSUMER_PACKAGE_ID = "subagent-control";
export const CONSUMER_MARKER_SCHEMA_VERSION = 1;
export const CONSUMER_PACKAGE_SCHEMA_VERSION = 1;
export const CONSUMER_RESOURCE_MODES = Object.freeze(["links", "projection"]);
export const DEFAULT_CONSUMER_RELEASE_PARENT = path.join(
  os.homedir(),
  ".subagent-control",
  "releases",
  "consumer",
);

export class RootContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RootContractError";
    this.code = String(code);
  }
}

export function rootContractError(code, message) {
  return new RootContractError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// realpath 归一；路径尚不存在时按“已存在最长前缀 realpath + 字面尾段”解析，与写域守卫同口径。
export function resolveRealPath(value) {
  const absolute = path.resolve(String(value));
  const literalTail = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    literalTail.unshift(path.basename(current));
    current = parent;
  }
  try {
    const real = realpathSync.native(current);
    return literalTail.length ? path.join(real, ...literalTail) : real;
  } catch {
    return absolute;
  }
}

export function compareRootPath(value) {
  const resolved = resolveRealPath(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

// 项目根本身只做词法归一：会话已按真实路径归一，保留调用方口径，不把盘符/大小写再写回。
export function resolveProjectRoot(value) {
  return path.resolve(String(value));
}

export function sameRootPath(left, right) {
  if (left == null || right == null) return false;
  return compareRootPath(left) === compareRootPath(right);
}

// 严格位于父目录内（不等于父目录本身）。
export function isStrictlyInside(child, parent) {
  const normalizedChild = compareRootPath(child);
  const normalizedParent = compareRootPath(parent);
  if (normalizedChild === normalizedParent) return false;
  return normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

function requireNonEmptyString(value, label, code) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw rootContractError(code, `${label} must be a non-empty string`);
  return text;
}

function requireAbsolutePath(value, label, code) {
  const text = requireNonEmptyString(value, label, code);
  if (!path.isAbsolute(text)) throw rootContractError(code, `${label} must be an absolute path: ${text}`);
  return text;
}

// 包相对路径：拒绝绝对路径、盘符、UNC 与父目录逃逸。
export function assertRelativePackagePath(value, label, code = "invalid_runtime_declaration") {
  const text = requireNonEmptyString(value, label, code);
  if (path.isAbsolute(text) || /^[A-Za-z]:/.test(text) || text.startsWith("\\\\")) {
    throw rootContractError(code, `${label} must be package-relative: ${text}`);
  }
  const normalized = text.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) throw rootContractError(code, `${label} is empty: ${text}`);
  if (segments.some((segment) => segment === "..")) {
    throw rootContractError(code, `${label} escapes the package root: ${text}`);
  }
  return segments.join("/");
}

export function parseJsonObject(text, label, code) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw rootContractError(code, `${label} is not valid JSON: ${error?.message ?? error}`);
  }
  if (!isRecord(data)) throw rootContractError(code, `${label} must contain a JSON object`);
  return data;
}

export function readJsonObjectFile(file, label, code) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw rootContractError(code, `${label} is unreadable: ${file}: ${error?.message ?? error}`);
  }
  return parseJsonObject(text.replace(/^\uFEFF/, ""), label, code);
}

// ---- 受信发布父目录 ----

// 受信根只来自：内置生产默认、全局部署配置 consumer_release_roots、装配调用显式选项。
// project marker 不参与此清单。
export function resolveTrustedReleaseRoots({ home = os.homedir(), config = {}, options = {} } = {}) {
  const declared = [];
  const defaultRoot = path.join(home, ".subagent-control", "releases", "consumer");
  declared.push({ root: defaultRoot, source: "default" });
  for (const [source, values] of [
    ["config.consumer_release_roots", config?.consumer_release_roots],
    ["options.consumer_release_roots", options?.consumer_release_roots ?? options?.consumerReleaseRoots],
  ]) {
    if (values === undefined || values === null) continue;
    if (!Array.isArray(values)) {
      throw rootContractError("invalid_consumer_release_roots", `${source} must be an array of absolute paths`);
    }
    for (const value of values) {
      declared.push({
        root: requireAbsolutePath(value, `${source} entry`, "invalid_consumer_release_roots"),
        source,
      });
    }
  }
  const seen = new Map();
  for (const entry of declared) {
    const resolved = resolveRealPath(entry.root);
    const key = compareRootPath(resolved);
    if (!seen.has(key)) seen.set(key, { root: resolved, sources: [entry.source] });
    else seen.get(key).sources.push(entry.source);
  }
  return [...seen.values()];
}

// ---- marker ----

export function consumerMarkerPath(projectRoot) {
  return path.join(projectRoot, ...CONSUMER_MARKER_SEGMENTS);
}

export function readConsumerMarker(projectRoot) {
  const markerPath = consumerMarkerPath(projectRoot);
  if (!existsSync(markerPath)) return { path: markerPath, exists: false, marker: null };
  let info;
  try {
    info = lstatSync(markerPath);
  } catch (error) {
    throw rootContractError("invalid_consumer_marker", `consumer marker is unreadable: ${markerPath}: ${error?.message ?? error}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw rootContractError("invalid_consumer_marker", `consumer marker must be a regular file: ${markerPath}`);
  }
  const marker = readJsonObjectFile(markerPath, "consumer marker", "invalid_consumer_marker");
  return { path: markerPath, exists: true, marker };
}

function assertManagedPaths(managedPaths, markerPath) {
  if (managedPaths === undefined || managedPaths === null) return;
  if (!Array.isArray(managedPaths)) {
    throw rootContractError("invalid_consumer_marker", `${markerPath}: managed_paths must be an array`);
  }
  for (const [index, entry] of managedPaths.entries()) {
    if (!isRecord(entry)) {
      throw rootContractError("invalid_consumer_marker", `${markerPath}: managed_paths[${index}] must be an object`);
    }
    // 项目内相对路径，不得逃逸项目根。
    assertRelativePackagePath(entry.path, `${markerPath}: managed_paths[${index}].path`, "invalid_consumer_marker");
    if (entry.kind !== undefined && !["link", "file"].includes(String(entry.kind))) {
      throw rootContractError("invalid_consumer_marker", `${markerPath}: managed_paths[${index}].kind must be link or file`);
    }
  }
}

export function assertConsumerMarkerShape(marker, markerPath) {
  if (marker.schema_version !== CONSUMER_MARKER_SCHEMA_VERSION) {
    throw rootContractError(
      "invalid_consumer_marker",
      `${markerPath}: schema_version must be ${CONSUMER_MARKER_SCHEMA_VERSION}`,
    );
  }
  if (String(marker.mode ?? "") !== "consumer") {
    throw rootContractError("invalid_consumer_marker", `${markerPath}: mode must be consumer`);
  }
  requireAbsolutePath(marker.project_root, `${markerPath}: project_root`, "invalid_consumer_marker");
  requireAbsolutePath(marker.runtime_root, `${markerPath}: runtime_root`, "invalid_consumer_marker");
  requireNonEmptyString(marker.build_id, `${markerPath}: build_id`, "invalid_consumer_marker");
  requireNonEmptyString(marker.install_id, `${markerPath}: install_id`, "invalid_consumer_marker");
  if (marker.resource_mode !== undefined && !CONSUMER_RESOURCE_MODES.includes(String(marker.resource_mode))) {
    throw rootContractError(
      "invalid_consumer_marker",
      `${markerPath}: resource_mode must be one of ${CONSUMER_RESOURCE_MODES.join(", ")}`,
    );
  }
  assertManagedPaths(marker.managed_paths, markerPath);
  return marker;
}

// ---- 运行包 inventory ----

export function assertInventoryShape(inventory, inventoryPath) {
  if (inventory.schema_version !== CONSUMER_PACKAGE_SCHEMA_VERSION) {
    throw rootContractError(
      "invalid_runtime_inventory",
      `${inventoryPath}: schema_version must be ${CONSUMER_PACKAGE_SCHEMA_VERSION}`,
    );
  }
  if (String(inventory.package_id ?? "") !== CONSUMER_PACKAGE_ID) {
    throw rootContractError("inventory_identity_mismatch", `${inventoryPath}: package_id must be ${CONSUMER_PACKAGE_ID}`);
  }
  requireNonEmptyString(inventory.build_id, `${inventoryPath}: build_id`, "invalid_runtime_inventory");
  if (!Array.isArray(inventory.files) || inventory.files.length === 0) {
    throw rootContractError("invalid_runtime_inventory", `${inventoryPath}: files must be a non-empty array`);
  }
  for (const [index, entry] of inventory.files.entries()) {
    if (!isRecord(entry)) {
      throw rootContractError("invalid_runtime_inventory", `${inventoryPath}: files[${index}] must be an object`);
    }
    assertRelativePackagePath(entry.target, `${inventoryPath}: files[${index}].target`, "invalid_runtime_inventory");
  }
  if (!isRecord(inventory.entrypoints)) {
    throw rootContractError("invalid_runtime_inventory", `${inventoryPath}: entrypoints must be an object`);
  }
  const names = Object.keys(inventory.entrypoints);
  if (names.length === 0) {
    throw rootContractError("invalid_runtime_inventory", `${inventoryPath}: entrypoints must not be empty`);
  }
  for (const name of names) {
    assertRelativePackagePath(
      inventory.entrypoints[name],
      `${inventoryPath}: entrypoints.${name}`,
      "invalid_runtime_inventory",
    );
  }
  for (const field of ["resource_mounts", "skills"]) {
    if (!Array.isArray(inventory[field])) {
      throw rootContractError("invalid_runtime_inventory", `${inventoryPath}: ${field} must be an array`);
    }
  }
  return inventory;
}

export function runtimeInventoryPath(runtimeRoot) {
  return path.join(runtimeRoot, CONSUMER_INVENTORY_FILE);
}

export function readRuntimeInventory(runtimeRoot) {
  const inventoryPath = runtimeInventoryPath(runtimeRoot);
  if (!existsSync(inventoryPath)) {
    throw rootContractError("missing_runtime_inventory", `runtime inventory is missing: ${inventoryPath}`);
  }
  return assertInventoryShape(
    readJsonObjectFile(inventoryPath, "runtime inventory", "invalid_runtime_inventory"),
    inventoryPath,
  );
}

// ---- 会话根合同 ----

// 校验 marker + inventory + 受信槽，返回可用的 runtimeRoot / entrypoints 读取面。
export function validateConsumerContract({ projectRoot, marker, markerPath, trustedRoots }) {
  const file = markerPath ?? consumerMarkerPath(projectRoot);
  assertConsumerMarkerShape(marker, file);
  const markerProjectRoot = resolveRealPath(marker.project_root);
  if (!sameRootPath(markerProjectRoot, projectRoot)) {
    throw rootContractError(
      "consumer_project_mismatch",
      `${file}: project_root does not match the current session cwd`,
    );
  }
  const runtimeRoot = resolveRealPath(marker.runtime_root);
  let runtimeInfo = null;
  try {
    runtimeInfo = statSync(runtimeRoot);
  } catch {
    runtimeInfo = null;
  }
  if (!runtimeInfo || !runtimeInfo.isDirectory()) {
    throw rootContractError("untrusted_runtime_root", `${file}: runtime_root is not an existing directory: ${marker.runtime_root}`);
  }
  const trusted = (trustedRoots ?? []).some((entry) => isStrictlyInside(runtimeRoot, entry.root));
  if (!trusted) {
    const parents = (trustedRoots ?? []).map((entry) => entry.root).join(", ") || "(none)";
    throw rootContractError(
      "untrusted_runtime_root",
      `${file}: runtime_root is not inside a trusted release parent (${parents})`,
    );
  }
  const inventory = readRuntimeInventory(runtimeRoot);
  if (String(inventory.build_id) !== String(marker.build_id)) {
    throw rootContractError(
      "inventory_identity_mismatch",
      `${file}: marker build_id ${marker.build_id} does not match inventory build_id ${inventory.build_id}`,
    );
  }
  return {
    markerPath: file,
    marker,
    runtimeRoot,
    inventory,
    entrypoints: { ...inventory.entrypoints },
    files: inventory.files.map((entry) => String(entry.target).replace(/\\/g, "/")),
  };
}

// 会话装配入口：marker 存在 = 消费模式（无效即 fail closed）；缺失 = 既有开发分支。
export function resolveSessionRootContract({ cwd, config = {}, options = {}, devRuntimeRoot = null } = {}) {
  if (cwd === null || cwd === undefined || String(cwd).trim() === "") {
    throw rootContractError("missing_project_root", "session project root is required to resolve the root contract");
  }
  const projectRoot = resolveProjectRoot(cwd);
  const { exists, marker, path: markerPath } = readConsumerMarker(projectRoot);
  if (exists) {
    const trustedRoots = resolveTrustedReleaseRoots({ config, options });
    const contract = validateConsumerContract({ projectRoot, marker, markerPath, trustedRoots });
    if (config.consumer_runtime_policy === "published") {
      const runtimeRoot = resolveRealPath(requireAbsolutePath(devRuntimeRoot, "published runtime root", "missing_runtime_root"));
      const manifestPath = path.join(runtimeRoot, "ops", "templates", "consumer-release-manifest.json");
      const inventory = assertInventoryShape(readJsonObjectFile(manifestPath, "published runtime inventory", "invalid_runtime_inventory"), manifestPath);
      return {
        mode: "consumer", projectRoot, runtimeRoot,
        runtimeBuildId: String(config.build_id), followsPublished: true,
        inventory, entrypoints: { ...inventory.entrypoints },
        files: inventory.files.map((entry) => String(entry.target)),
        marker: contract.marker, markerPath: contract.markerPath,
      };
    }
    return {
      mode: "consumer",
      runtimeBuildId: String(marker.build_id),
      projectRoot,
      runtimeRoot: contract.runtimeRoot,
      inventory: contract.inventory,
      entrypoints: contract.entrypoints,
      files: contract.files,
      marker: contract.marker,
      markerPath: contract.markerPath,
    };
  }
  const allowAnyProject = config?.allow_any_project === true;
  const allowed = new Set((config?.allowed_projects || []).map((value) => compareRootPath(value)));
  if (!allowAnyProject && !allowed.has(compareRootPath(projectRoot))) {
    return { mode: "excluded", projectRoot, runtimeRoot: null, inventory: null, entrypoints: null, marker: null };
  }
  return {
    mode: "development",
    runtimeBuildId: String(config.build_id ?? ""),
    projectRoot,
    runtimeRoot: devRuntimeRoot ? resolveRealPath(devRuntimeRoot) : null,
    inventory: null,
    entrypoints: null,
    files: null,
    marker: null,
  };
}

// ---- 入口解析 ----

function resolveManifestPath({ runtimeRoot, relativePath, declaration }) {
  const asset = path.join(runtimeRoot, ...relativePath.split("/"));
  if (!existsSync(asset)) {
    throw rootContractError(
      "missing_runtime_asset",
      `runtime asset ${relativePath} is not present in ${runtimeRoot}`,
    );
  }
  if (!isStrictlyInside(asset, runtimeRoot) && !sameRootPath(path.dirname(asset), runtimeRoot)) {
    throw rootContractError("invalid_runtime_asset", `runtime asset escapes the package root: ${relativePath}`);
  }
  return asset;
}

// consumer 模式只认已声明入口（entrypoints 优先，其次 files 清单）；开发模式才允许约定源码路径。
export function resolveDeclaredEntrypoint({
  name,
  runtimeRoot,
  manifest = null,
  defaults = [],
  devFallbacks = [],
} = {}) {
  if (!runtimeRoot) {
    throw rootContractError("missing_runtime_root", `runtime root is required to resolve entrypoint ${name}`);
  }
  const entrypoints = manifest?.entrypoints ?? null;
  const declaredFiles = Array.isArray(manifest?.files) ? manifest.files : null;
  const relative = entrypoints ? entrypoints[name] : null;
  if (relative) {
    return resolveManifestPath({ runtimeRoot, relativePath: String(relative).replace(/\\/g, "/"), declaration: name });
  }
  for (const candidate of defaults) {
    const normalized = assertRelativePackagePath(candidate, `default entry ${name}`);
    const declared = entrypoints
      ? Object.values(entrypoints).some((value) => String(value).replace(/\\/g, "/") === normalized)
        || (declaredFiles ? declaredFiles.includes(normalized) : false)
      : true;
    if (!declared) continue;
    const asset = path.join(runtimeRoot, ...normalized.split("/"));
    if (existsSync(asset)) return asset;
  }
  for (const candidate of devFallbacks) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  if (entrypoints) {
    throw rootContractError(
      "missing_runtime_entrypoint",
      `runtime package does not declare entrypoint ${name}; consumer mode never guesses from project cwd`,
    );
  }
  throw rootContractError(
    "missing_runtime_asset",
    `runtime entrypoint ${name} was not found under ${runtimeRoot}`,
  );
}

// 同一制品可能以破折号或驼峰命名登记；按候选名逐个匹配已声明入口，再退回约定默认。
export function resolveDeclaredEntrypointByNames({ names, ...rest } = {}) {
  const list = Array.isArray(names) ? names.map(String).filter(Boolean) : [];
  if (list.length === 0) {
    throw rootContractError("missing_runtime_entrypoint", "entrypoint name candidates must not be empty");
  }
  const entrypoints = rest.manifest?.entrypoints ?? null;
  if (entrypoints) {
    for (const name of list) {
      if (entrypoints[name]) return resolveDeclaredEntrypoint({ name, ...rest });
    }
  }
  return resolveDeclaredEntrypoint({ name: list[0], ...rest });
}

// 供父会话写域守卫复用：目标（含尚不存在的尾段）是否落在只读运行包内。
export function isInsideRuntimeRoot(target, runtimeRoot) {
  if (!target || !runtimeRoot) return false;
  return sameRootPath(target, runtimeRoot) || isStrictlyInside(target, runtimeRoot);
}
