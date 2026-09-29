// 子代理资源的导入范围（ops/templates/worker-resources.json，version 2）与任务加载规则的语义真源。
//
// 加载与激活是两层：
// - 扩展「加载」= 进 pi 的 -e。加载后其钩子、提示词注入、模型提供方与工具注册全部生效。
// - 工具「激活」= 进 pi 的 -t。只决定哪些已注册工具可被调用；-xt 从最终注册表剔除 access = off 的工具，
//   覆盖任何扩展注册的同名工具。
// - skills 经 --skill 按路径加载；-ns 关闭自动发现。
//
// 导入范围给出资格：access 取 off / optional / default_on；本机已安装但未记录的资源按 off 处理。
// 键可含 *（不区分大小写的通配）；一个名字同时命中多个键时精确键优先，其次字面部分最长的键，同级冲突报错。
// 工具键只写具体名字。required_tools 是交卷通道的保留集，runner 只启用本次通道对应的那个，不能设为 off。
//
// worker 加载：
// - 扩展与用户级 skill：所有已安装的 default_on 项 + 角色（任务类型）白名单里 access = optional 的项；
//   白名单里 off、未记录或未安装的项只记 warning，不加载。同一作用域内同名只取第一份。
// - 项目级 skill 不受导入范围控制，按角色 project_skills（"none" / "all" / 名单）从 target_cwd 选用；
//   与已选用户级 skill 同名时跳过并记 warning。
// - 工具面：编译器把角色选择（角色白名单 ∪ default_on）经任务 tool_contract.allowed 收窄后写进任务包，
//   即最终工具面；runner 只取其中 optional / default_on 的项，command_job 只在最终面含 bash 时保留，
//   不再追加 default_on；空面（封闭卷宗）保持为空；最后追加本次交卷工具。
// 角色卡四个资源键都没写（如分身）时不受白名单管理；旧包缺 worker_resources 时 runner
// 只在可从当前角色 × 能力配置恢复白名单且工具合同有界时续跑，否则明确要求重新准备。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKER_RESOURCES_CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates/worker-resources.json");
export const IMPORT_ACCESS = Object.freeze(["off", "optional", "default_on"]);

// Pi 内置工具（pi_search_extension 以同名覆盖 grep / find）。
export const BUILTIN_TOOLS = Object.freeze(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
// 运行器自带扩展注册、不在本机安装清单里的工具：调研能力面两项与 command_job。
const RUNNER_TOOLS = Object.freeze(["research_search", "research_fetch", "command_job"]);
const PI_CLI = path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const PROBE_TIMEOUT_MS = 60000;
// Pi's loader runs factories to register tools without binding a session or emitting session_start.
// Module imports and factory bodies can still have side effects; discovery is not a security sandbox.
const PROBE_SCRIPT = `import { pathToFileURL } from "node:url";
const { loadExtensions } = await import(pathToFileURL(process.env.PI_TOOL_PROBE_LOADER).href);
const { extensions, errors } = await loadExtensions(JSON.parse(process.env.PI_TOOL_PROBE_EXTENSIONS), process.cwd());
if (errors.length) throw new Error(errors.map(({ path, error }) => path + ": " + error).join("; "));
console.log(JSON.stringify([...new Set(extensions.flatMap((extension) => [...extension.tools.keys()]))]));
`;
const probes = new Map();
const SECTIONS = Object.freeze(["tools", "extensions", "skills"]);
const ENTRY_KEYS = Object.freeze({ tools: ["access", "label", "group"], extensions: ["access", "label"], skills: ["access", "label"] });
const REMOVED_KEYS = Object.freeze({
  base_extensions: "改写为 extensions 中 access = \"default_on\" 的条目",
  main_only_extensions: "改写为 extensions 中 access = \"off\" 的条目",
  main_only_skills: "改写为 skills 中 access = \"off\" 的条目",
  force_excluded_tools: "改写为 tools 中 access = \"off\" 的条目",
});

function configError(code, file, field, message) {
  return Object.assign(new Error(`${file} ${field}：${message}`), { code, file, field });
}

function literalLength(key) {
  return key.replaceAll("*", "").length;
}

function matches(value, pattern) {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function packageJsonName(dir) {
  const file = path.join(dir, "package.json");
  if (!existsSync(file)) return null;
  const name = JSON.parse(readFileSync(file, "utf8")).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Stable name of a Pi extension or skill file, as role cards list it. */
export function resourceName(file) {
  const parts = String(file).replaceAll("\\", "/").split("/").filter(Boolean);
  const last = parts.length - 1;
  if (parts[last] === "SKILL.md") return parts[last - 1];
  const modules = parts.lastIndexOf("node_modules");
  if (modules >= 0 && modules < last) {
    return parts[modules + 1].startsWith("@") ? `${parts[modules + 1]}/${parts[modules + 2]}` : parts[modules + 1];
  }
  const local = parts.lastIndexOf("local-packages");
  if (local >= 0 && local < last) {
    const dir = parts.slice(0, local + 2).join("/");
    return packageJsonName(/^[A-Za-z]:$/.test(parts[0]) ? dir : `/${dir}`) ?? parts[local + 1];
  }
  const extensions = parts.lastIndexOf("extensions");
  if (extensions >= 0 && extensions === last - 1) return parts[last].replace(/\.[^.]+$/, "");
  if (extensions >= 0 && extensions < last) return parts[extensions + 1];
  return parts[last].replace(/\.[^.]+$/, "");
}

/** Read and validate the version 2 import scope; old keys fail with the field that replaces them. */
export function loadWorkerResourcesConfig(configPath = WORKER_RESOURCES_CONFIG) {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  for (const [key, hint] of Object.entries(REMOVED_KEYS)) {
    if (raw[key] !== undefined) throw configError("field_removed", configPath, key, `已删除，${hint}`);
  }
  if (raw.version !== 2) throw configError("value_invalid", configPath, "version", "必须为 2");
  const config = { configPath };
  for (const section of SECTIONS) {
    const entries = raw[section];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw configError("value_invalid", configPath, section, "必须存在且是对象；没有条目时写 {}");
    }
    for (const [key, entry] of Object.entries(entries)) {
      const field = `${section}.${key}`;
      if (section === "tools" && key.includes("*")) throw configError("value_invalid", configPath, field, "工具只写具体名字，不支持 *");
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw configError("value_invalid", configPath, field, "必须是对象");
      const unknown = Object.keys(entry).find((item) => !ENTRY_KEYS[section].includes(item));
      if (unknown) throw configError("field_unknown", configPath, `${field}.${unknown}`, `未知字段；可用字段：${ENTRY_KEYS[section].join("、")}`);
      if (!IMPORT_ACCESS.includes(entry.access)) throw configError("value_invalid", configPath, `${field}.access`, `必须是 ${IMPORT_ACCESS.join(" / ")} 之一`);
      for (const text of ["label", "group"]) {
        if (entry[text] !== undefined && typeof entry[text] !== "string") throw configError("value_invalid", configPath, `${field}.${text}`, "必须是字符串");
      }
    }
    config[section] = entries;
  }
  const required = raw.required_tools;
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !name.trim())) {
    throw configError("value_invalid", configPath, "required_tools", "必须是工具名数组");
  }
  for (const name of required) {
    if (config.tools[name]?.access === "off") throw configError("value_invalid", configPath, `tools.${name}.access`, "运行必需工具不能设为 off");
  }
  config.required_tools = [...required];
  return config;
}

/** The import-scope entry governing one resource name: exact key first, then the longest literal pattern. */
export function importEntry(config, section, name) {
  const hits = Object.keys(config[section]).filter((key) => matches(name, key));
  if (!hits.length) return null;
  const rank = (key) => (key.includes("*") ? literalLength(key) : Number.POSITIVE_INFINITY);
  const best = Math.max(...hits.map(rank));
  const top = hits.filter((key) => rank(key) === best);
  if (top.length > 1) {
    throw configError("value_invalid", config.configPath, section, `${name} 同时匹配 ${top.join("、")}；删去重复或写出更具体的键`);
  }
  return { key: top[0], ...config[section][top[0]] };
}

function accessOf(config, section, name) {
  if (section === "tools" && config.required_tools.includes(name)) return "default_on";
  return importEntry(config, section, name)?.access ?? "off";
}

/** Enabled user and project resources from Pi's package manager, without importing extensions or installing packages. */
export async function discoverWorkerResources({
  cwd = process.cwd(),
  agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"),
  piCli = PI_CLI,
} = {}) {
  const { DefaultPackageManager, SettingsManager } = await import(pathToFileURL(path.join(path.dirname(piCli), "index.js")).href);
  const settingsPath = path.join(agentDir, "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.inMemory(settings) });
  const missing = [];
  const resolved = await manager.resolve(async (source) => { missing.push(source); return "skip"; });
  const enabled = (type) => (resolved[type] || [])
    .filter((item) => item.enabled && ["user", "project"].includes(item.metadata?.scope))
    .map((item) => ({ name: resourceName(item.path), path: item.path, scope: item.metadata.scope }));
  return { settingsPath, extensions: enabled("extensions"), skills: enabled("skills"), missing };
}

/**
 * Pi's official extension loader registers tools in a child without starting a session. All installed extensions,
 * including off candidates, remain discoverable; module/factory side effects cannot be isolated by the loader.
 * Cache identity includes the target cwd because registration may depend on process.cwd().
 */
export function probeRegisteredTools({ extensions, piCli = PI_CLI, cacheFile, cwd = process.cwd() }) {
  const key = JSON.stringify(["registration-only/v1", path.resolve(cwd), ...[piCli, ...extensions.map((item) => item.path)].map((file) => [file, existsSync(file) ? statSync(file).mtimeMs : 0])]);
  const cached = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : null;
  if (cached?.key === key) return Promise.resolve(cached.tools);
  const id = `${cacheFile}\n${key}`;
  if (!probes.has(id)) {
    probes.set(id, runToolProbe(extensions, piCli, cwd).then((tools) => {
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ key, tools }));
      return tools;
    }).finally(() => probes.delete(id)));
  }
  return probes.get(id);
}

function runToolProbe(extensions, piCli, cwd) {
  const loader = path.join(path.dirname(piCli), "core", "extensions", "loader.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", PROBE_SCRIPT], {
      cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, PI_TOOL_PROBE_LOADER: loader, PI_TOOL_PROBE_EXTENSIONS: JSON.stringify(extensions.map((item) => item.path)) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Pi 扩展注册探测失败（exit ${code}）${stderr.trim() ? `：${stderr.trim().slice(-400)}` : ""}`));
        return;
      }
      try { resolve(JSON.parse(stdout.trim())); }
      catch (error) { reject(new Error(`Pi 工具注册表无法解析：${error.message}`)); }
    });
  });
}

function catalogEntries(config, section, installed) {
  const rows = installed.map(({ name, scope }) => {
    const entry = importEntry(config, section, name);
    return { key: entry?.key ?? null, name, access: entry?.access ?? "off", label: entry?.label ?? "", installed: true, scope };
  });
  for (const [key, entry] of Object.entries(config[section])) {
    if (!installed.some(({ name }) => matches(name, key))) {
      rows.push({ key, name: key, access: entry.access, label: entry.label ?? "", installed: false, scope: null });
    }
  }
  return rows;
}

/**
 * Import-scope catalog for Agent Panel and diagnostics. tools: builtins and runner tools, tools the installed
 * extensions register (probeTools), recorded names and required_tools; installed marks the registered ones.
 */
export async function resolveWorkerResourceCatalog({
  cwd = process.cwd(),
  agentDir,
  configPath = WORKER_RESOURCES_CONFIG,
  piCli = PI_CLI,
  toolCache = path.join(cwd, ".runtime", "cockpit", "worker-tool-probe.json"),
  probeTools = probeRegisteredTools,
} = {}) {
  const config = loadWorkerResourcesConfig(configPath);
  const found = await discoverWorkerResources({ cwd, agentDir, piCli });
  const diagnostics = found.missing.map((source) => ({ code: "not_installed", file: found.settingsPath, field: "packages", message: `已配置的 Pi 资源未安装：${source}` }));
  const known = new Set([...BUILTIN_TOOLS, ...RUNNER_TOOLS]);
  try {
    for (const name of await probeTools({ extensions: found.extensions, piCli, cacheFile: toolCache, cwd })) known.add(name);
  } catch (error) {
    diagnostics.push({ code: "tool_probe_failed", file: found.settingsPath, field: "extensions", message: `读取已装插件注册的工具失败，工具表只含内置工具：${error.message}` });
  }
  const toolNames = [...new Set([...known, ...Object.keys(config.tools), ...config.required_tools])].sort();
  return {
    configPath,
    settingsPath: found.settingsPath,
    tools: toolNames.map((name) => {
      const entry = config.tools[name];
      return {
        key: entry ? name : null,
        name,
        access: accessOf(config, "tools", name),
        label: entry?.label ?? "",
        group: entry?.group ?? "",
        installed: known.has(name) || config.required_tools.includes(name),
      };
    }),
    extensions: catalogEntries(config, "extensions", found.extensions),
    skills: catalogEntries(config, "skills", found.skills.filter((item) => item.scope === "user")),
    project_skills: found.skills.filter((item) => item.scope === "project").map(({ name, scope }) => ({ name, scope })),
    required_tools: config.required_tools,
    diagnostics,
  };
}

/** One task's extensions and skills from discovered resources (see header); warnings list what the whitelist could not load. */
export function selectTaskResources(config, installed, spec) {
  const warnings = [];
  const pick = (section, type, entries, names, { first = false } = {}) => {
    const chosen = entries.filter((item) => accessOf(config, section, item.name) === "default_on");
    for (const name of names) {
      const found = entries.filter((item) => item.name === name);
      const access = accessOf(config, section, name);
      if (access === "off") warnings.push({ type, name, reason: "off" });
      else if (!found.length) warnings.push({ type, name, reason: "not_installed" });
      else if (access === "optional") chosen.push(...found);
    }
    const seen = new Set();
    return chosen.filter((item) => {
      const key = first ? `${item.scope}:${item.name}` : item.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const userSkills = pick("skills", "skill", installed.skills.filter((item) => item.scope === "user"), spec.skills, { first: true });
  const projectSkills = installed.skills.filter((item) => item.scope === "project");
  const projectNames = spec.project_skills === "all" ? [...new Set(projectSkills.map((item) => item.name))]
    : Array.isArray(spec.project_skills) ? spec.project_skills : [];
  const chosenProject = [];
  for (const name of projectNames) {
    const found = projectSkills.find((item) => item.name === name);
    if (userSkills.some((item) => item.name === name)) warnings.push({ type: "project_skill", name, reason: "shadowed_by_user_skill" });
    else if (!found) warnings.push({ type: "project_skill", name, reason: "not_installed" });
    else chosenProject.push(found);
  }
  return {
    extensions: pick("extensions", "extension", installed.extensions, spec.extensions),
    skills: [...userSkills, ...chosenProject],
    warnings,
  };
}

/**
 * Pi -t list for one task (see header). allowed is the compiled final surface; null keeps Pi's configured tools.
 * dropped lists names whose import access is off or unrecorded.
 */
export function workerSpawnTools(allowed, config, submitTool = null) {
  if (allowed === null) return { tools: null, dropped: [] };
  const required = config.required_tools;
  const surface = allowed.filter((name) => !required.includes(name) && accessOf(config, "tools", name) !== "off");
  const tools = surface.includes("bash") ? surface : surface.filter((name) => name !== "command_job");
  return {
    tools: [...tools, ...(submitTool ? [submitTool] : [])],
    dropped: allowed.filter((name) => !required.includes(name) && !surface.includes(name)),
  };
}

/** default_on tools outside required_tools: the compiler adds them to every role selection before the task narrows it. */
export function defaultOnTools(config) {
  return Object.keys(config.tools).filter((name) => config.tools[name].access === "default_on" && !config.required_tools.includes(name));
}

/** -xt list: every recorded tool whose access is off. */
export function excludedTools(config) {
  return Object.keys(config.tools).filter((name) => config.tools[name].access === "off");
}

// basename gate survives esbuild inlining into run-pi-task.bundle.mjs.
if (path.basename(process.argv[1] || "") === "pi_worker_resources.mjs") {
  if (process.argv.slice(2).some((arg) => arg !== "--json")) {
    console.error("Usage: node ops/tools/pi_worker_resources.mjs --json");
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await resolveWorkerResourceCatalog(), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
