// 全局默认角色/模型配置与项目显式覆盖的统一来源解析。
//
// 父进程选型（dispatch_prepare / Pi 适配器）与子进程档位校验（run-pi-task）读同一解析结果：
//   1. 项目显式覆盖：<projectRoot>/.pi/control-plane-model-config.json 逐资产声明
//      agents_dir / model_notes。声明存在但无效或指向缺失路径时给出具体错误，
//      不静默回落到全局默认。
//   2. 全局默认：运行包运行根 <root>/ops/agents、<root>/ops/model-notes.toml。候选根由调用方按既有优先级显式给出。
//
// 无项目声明时，项目内的旧 ops 副本不参与解析：陈旧的角色配置与模型笔记不会改变全局默认。
// 本模块只做来源解析与声明校验（node:fs / node:path），不解析 TOML、不读业务内容。
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export const MODEL_CONFIG_DECLARATION_SEGMENTS = Object.freeze([".pi", "control-plane-model-config.json"]);
export const MODEL_CONFIG_SCHEMA_VERSION = 1;

// 可被项目显式覆盖的资产；relative 是全局默认下相对运行根的固定位置。
export const MODEL_CONFIG_ASSETS = Object.freeze({
  agents_dir: Object.freeze({ kind: "dir", relative: Object.freeze(["ops", "agents"]) }),
  model_notes: Object.freeze({ kind: "file", relative: Object.freeze(["ops", "model-notes.toml"]) }),
});
export const MODEL_CONFIG_ASSET_KEYS = Object.freeze(Object.keys(MODEL_CONFIG_ASSETS));
// 全局默认完整：角色目录与模型笔记都在。
export const MODEL_CONFIG_REQUIRED_KEYS = Object.freeze(["agents_dir", "model_notes"]);

export class ModelConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelConfigError";
    this.code = "MODEL_CONFIG_INVALID";
  }
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(String(left));
  const normalizedRight = path.resolve(String(right));
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function isInsideProject(target, projectRoot) {
  const normalizedTarget = process.platform === "win32"
    ? path.resolve(target).toLocaleLowerCase("en-US")
    : path.resolve(target);
  const normalizedRoot = process.platform === "win32"
    ? path.resolve(projectRoot).toLocaleLowerCase("en-US")
    : path.resolve(projectRoot);
  if (normalizedTarget === normalizedRoot) return true;
  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function assetExists(target, key) {
  return MODEL_CONFIG_ASSETS[key].kind === "dir" ? isDirectory(target) : isFile(target);
}

/** 全局默认资产路径：<root>/ops/agents 等固定位置。 */
export function globalModelConfigAssetPath(root, key) {
  if (!MODEL_CONFIG_ASSETS[key]) throw new ModelConfigError(`未知的模型配置资产：${key}`);
  return path.join(path.resolve(String(root)), ...MODEL_CONFIG_ASSETS[key].relative);
}

/** 全局默认完整性：返回缺失的资产名；空数组表示完整。 */
export function inspectGlobalModelConfig(root) {
  const resolved = path.resolve(String(root));
  const missing = MODEL_CONFIG_REQUIRED_KEYS.filter((key) => !assetExists(globalModelConfigAssetPath(resolved, key), key));
  return { root: resolved, complete: missing.length === 0, missing };
}

/**
 * 按调用方给出的候选顺序解析全局默认运行根。
 * roots 每项形如 `{ root, source }`（也接受裸路径字符串）；顺序即优先级，重复根只算第一个。
 */
export function resolveGlobalModelConfigRoot({ roots = [] } = {}) {
  const inspected = [];
  for (const entry of roots) {
    const raw = typeof entry === "string" ? entry : entry?.root;
    if (!text(raw)) continue;
    const source = typeof entry === "string" ? "runtime_root" : String(entry?.source || "runtime_root");
    const inspection = inspectGlobalModelConfig(raw);
    if (inspection.complete) return { root: inspection.root, source };
    if (inspected.some((item) => samePath(item.root, inspection.root))) continue;
    inspected.push({ root: inspection.root, source, missing: inspection.missing });
  }
  const detail = inspected.length
    ? inspected.map((item) => `${item.root}（${item.source}）缺少 ${item.missing.join(", ")}`).join("；")
    : "没有可用的候选运行根";
  throw new ModelConfigError(
    `全局角色/模型配置不完整：${detail}。`
    + "请部署带 ops/agents 与 ops/model-notes.toml 的运行包。",
  );
}

/** 项目显式覆盖声明的固定位置。 */
export function modelConfigDeclarationPath(projectRoot) {
  return path.join(path.resolve(String(projectRoot)), ...MODEL_CONFIG_DECLARATION_SEGMENTS);
}

function declarationPathValue(declaration, key, declarationPath) {
  const value = declaration[key];
  if (!text(value)) {
    throw new ModelConfigError(`模型配置声明 ${key} 必须是非空字符串：${declarationPath}`);
  }
  const raw = value.trim();
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith("\\\\")) {
    throw new ModelConfigError(`模型配置声明 ${key} 必须是项目内相对路径：${declarationPath}：${raw}`);
  }
  const segments = raw.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new ModelConfigError(`模型配置声明 ${key} 不得越出项目根：${declarationPath}：${raw}`);
  }
  return segments.join("/");
}

/**
 * 读取项目显式覆盖声明。文件不存在返回 { exists: false }；存在但无效（非普通文件、坏 JSON、
 * schema 不符、未知字段、未选择资产、路径非法或指向缺失资产）一律抛 ModelConfigError。
 */
export function readModelConfigDeclaration(projectRoot) {
  const declarationPath = modelConfigDeclarationPath(projectRoot);
  if (!existsSync(declarationPath)) {
    return { path: declarationPath, exists: false, overrides: {}, declared_keys: [] };
  }
  if (!isFile(declarationPath)) {
    throw new ModelConfigError(`模型配置声明必须是普通文件：${declarationPath}`);
  }
  let raw;
  try {
    raw = readFileSync(declarationPath, "utf8");
  } catch (error) {
    throw new ModelConfigError(`模型配置声明不可读：${declarationPath}：${error?.message ?? error}`);
  }
  let declaration;
  try {
    declaration = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ModelConfigError(`模型配置声明不是有效 JSON：${declarationPath}：${error?.message ?? error}`);
  }
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    throw new ModelConfigError(`模型配置声明必须是 JSON 对象：${declarationPath}`);
  }
  if (declaration.schema_version !== MODEL_CONFIG_SCHEMA_VERSION) {
    throw new ModelConfigError(
      `模型配置声明 schema_version 必须为 ${MODEL_CONFIG_SCHEMA_VERSION}：${declarationPath}`,
    );
  }
  const unknown = Object.keys(declaration).filter((key) => key !== "schema_version" && !MODEL_CONFIG_ASSETS[key]);
  if (unknown.length > 0) {
    throw new ModelConfigError(
      `模型配置声明含未知字段 ${unknown.join(", ")}：${declarationPath}；`
      + `可用字段：${MODEL_CONFIG_ASSET_KEYS.join(", ")}`,
    );
  }
  const declaredKeys = MODEL_CONFIG_ASSET_KEYS.filter((key) => declaration[key] !== undefined);
  if (declaredKeys.length === 0) {
    throw new ModelConfigError(
      `模型配置声明未选择任何资产：${declarationPath}；至少声明 ${MODEL_CONFIG_ASSET_KEYS.join(" / ")} 之一`,
    );
  }
  const project = path.resolve(String(projectRoot));
  const overrides = {};
  for (const key of declaredKeys) {
    const relative = declarationPathValue(declaration, key, declarationPath);
    const resolved = path.resolve(project, ...relative.split("/"));
    if (!isInsideProject(resolved, project)) {
      throw new ModelConfigError(`模型配置声明 ${key} 越出项目根：${declarationPath}：${relative}`);
    }
    if (!assetExists(resolved, key)) {
      throw new ModelConfigError(
        `模型配置声明 ${key} 指向的${MODEL_CONFIG_ASSETS[key].kind === "dir" ? "目录" : "文件"}不存在：`
        + `${declarationPath}：${relative}`,
      );
    }
    overrides[key] = resolved;
  }
  return { path: declarationPath, exists: true, overrides, declared_keys: declaredKeys };
}

/**
 * 统一来源解析：全局默认运行根 + 项目显式覆盖，返回父子两端共用的资产路径。
 * 无声明时全部资产来自全局默认；有声明时逐资产以声明为准。
 */
export function resolveModelConfigSources({ roots = [], projectRoot } = {}) {
  if (!text(projectRoot)) {
    throw new ModelConfigError("解析模型配置来源需要项目根");
  }
  const global = resolveGlobalModelConfigRoot({ roots });
  const declaration = readModelConfigDeclaration(projectRoot);
  const assets = {};
  const sources = {};
  for (const key of MODEL_CONFIG_ASSET_KEYS) {
    const declared = declaration.overrides[key];
    assets[key] = declared ?? globalModelConfigAssetPath(global.root, key);
    sources[key] = declared ? "project_declaration" : "global_default";
  }
  return {
    global_root: global.root,
    global_source: global.source,
    declaration_path: declaration.path,
    project_override: Object.keys(declaration.overrides).length > 0,
    declared_keys: declaration.declared_keys,
    agents_dir: assets.agents_dir,
    model_notes: assets.model_notes,
    sources,
    /** 角色 TOML 路径；角色名只做路径拼接，合法性由调用方既有的角色名校验负责。 */
    roleConfigPath(role) {
      const name = `${String(role ?? "").trim()}.toml`;
      const selected = path.join(assets.agents_dir, name);
      return declaration.overrides.agents_dir && !existsSync(selected)
        ? path.join(global.root, "ops", "agents", name)
        : selected;
    },
    /** 来源诊断：父进程选型与 runner 验收共用同一份字段。 */
    describe() {
      return {
        global_root: global.root,
        global_source: global.source,
        declaration_path: declaration.path,
        project_override: Object.keys(declaration.overrides).length > 0,
        declared_keys: [...declaration.declared_keys],
        agents_dir: assets.agents_dir,
        model_notes: assets.model_notes,
        sources: { ...sources },
      };
    },
  };
}
