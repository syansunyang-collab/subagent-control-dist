// dispatch-core：ops/tools/subagent_preload.py 的 JS 复刻。读取必读文件、渲染任务材料、解析角色 developer_instructions。
// 契约见 notes/context/py-to-js-migration-plan.md「契约冻结」；导出名为 Python 函数名的 camelCase，位置参数同序。
//
// 异常映射表（Python → JS）：
//   ToolError                      → ToolError，消息逐字相同（本模块全部 ToolError 分支均已复刻）。
//   KeyError（readRequiredFiles 直接下标 package["agent"]["required_files"]）
//                                  → pyError("KeyError", "'agent'") / pyError("KeyError", "'required_files'")，message 为键的 Python repr。
//   TypeError（对 None 取下标）     → pyError("TypeError", "'NoneType' object is not subscriptable")。
//   UnicodeDecodeError（读必读文件）→ pyError("UnicodeDecodeError", ...)，message 不逐字复刻（Python 带字节偏移，JS 拿不到）。
//   json.JSONDecodeError           → 已在 Python 内转成 ToolError；行号由 jsonErrorLine 推算，V8 不给位置时退化为 1。
//   AttributeError（package 非 dict 时 .get）→ JS 原生 TypeError；Python 侧同为未防护分支，无 ToolError 语义。
import { opendirSync, statSync } from "node:fs";
import path from "node:path";

import {
  ROOT,
  RUNTIME_ROOT,
  ToolError,
  isRecord,
  isSameOrInside,
  loadJson,
  loadRoleConfig,
  pyError,
  rel,
  resolveLikePython,
} from "./_tool_common.mjs";
import { pyGetItem, pyOr, pyReadText, pyStr, pyStrip, pyTypeName } from "./_py.mjs";

// 与 review_evidence.SEMANTIC_INJECTION_TOKEN_LIMIT 对齐：合法 full 包约 200_000*3 字节。
// 再留一倍余量。超过则不把证据全文读进预装。不从 review_evidence 导入，避免循环依赖。
export const REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET = 200_000 * 4;

// json.JSONDecodeError.lineno 的近似：V8 给出行号或位置时精确，否则退化为 1。
function jsonErrorLine(text, error) {
  const message = String(error?.message ?? "");
  const line = /\(line (\d+) column \d+\)/.exec(message);
  if (line) return Number(line[1]);
  const position = /position (\d+)/.exec(message);
  if (position) return text.slice(0, Number(position[1])).split("\n").length;
  return 1;
}

function orNull(value) {
  return value === undefined ? null : value;
}

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

// ---- 移植主体 ----

// 与 _tool_common.repoPath 同名不同义：本模块自带必读文件专用的错误文案。
export function repoPath(value) {
  const raw = pyStrip(pyStr(pyOr(value, "")));
  if (!raw) throw new ToolError("empty required_files path");
  const projectReal = resolveLikePython(ROOT);
  const lexical = path.resolve(ROOT, raw);
  const lexicalRelative = path.relative(projectReal, lexical);
  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw new ToolError(`required file escapes repository: ${raw}`);
  }
  const resolved = resolveLikePython(lexical);
  const relative = path.relative(projectReal, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    // 项目内声明挂载（CR-RESOURCES 只读链接）指向共享包：读面放行，写面仍由 realpath 写域守卫拒绝。
    if (!isSameOrInside(resolved, RUNTIME_ROOT)) {
      throw new ToolError(`required file escapes repository: ${raw}`);
    }
  }
  if (!isFile(resolved)) throw new ToolError(`required file not found: ${raw}`);
  return resolved;
}

export function packageFromData(data) {
  if (!isRecord(data)) throw pyError("AttributeError", `'${pyTypeName(data)}' object has no attribute 'get'`);
  const pkg = Object.hasOwn(data, "task_package") ? data.task_package : data;
  if (!isRecord(pkg)) throw new ToolError("task_package root is not an object");
  const agent = pkg.agent;
  if (!isRecord(agent)) throw new ToolError("task_package.agent is missing or not an object");
  const requiredFiles = agent.required_files;
  if (!Array.isArray(requiredFiles) || !requiredFiles.every((item) => typeof item === "string")) {
    throw new ToolError("task_package.agent.required_files must be a string list");
  }
  const role = pyStrip(pyStr(pyOr(agent.role, agent.runtime_role, "")));
  if (!role) throw new ToolError("task_package.agent.role is missing");
  return pkg;
}

export function loadPackage(file) {
  return packageFromData(loadJson(file));
}

export function readRequiredFiles(pkg) {
  const files = [];
  for (const item of pyGetItem(pyGetItem(pkg, "agent"), "required_files")) {
    const target = resolveLikePython(path.resolve(RUNTIME_ROOT, item));
    if (!isSameOrInside(target, RUNTIME_ROOT)) throw new ToolError(`required prompt escapes runtime: ${item}`);
    files.push({ path: item, content: pyReadText(target) });
  }
  return files;
}

// 从 ops/agents/<runtime-role>.toml 解析 developer_instructions。
export function roleDeveloperInstructions(pkg) {
  const agent = isRecord(pkg?.agent) ? pkg.agent : {};
  const role = pyStrip(pyStr(pyOr(agent.runtime_role, agent.role, "")));
  const roleConfig = loadRoleConfig(role, { globalDefault: true });
  const rolePath = path.join(RUNTIME_ROOT, "ops", "agents", `${role}.toml`);
  const instructions = pyStrip(pyStr(pyOr(roleConfig.developer_instructions, "")));
  if (!instructions) throw new ToolError(`runtime role has no developer_instructions: ${role}`);
  return { path: rel(rolePath), content: instructions };
}

export function reviewEvidenceSupport(pkg) {
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const reference = isRecord(extensions.review_evidence) ? extensions.review_evidence : {};
  const rawPath = reference.path;
  if (typeof rawPath !== "string" || !pyStrip(rawPath)) return null;
  const target = repoPath(rawPath);
  try {
    const info = statSync(target);
    if (info.isFile() && info.size > REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET) {
      return {
        path: rawPath,
        heading: "机械证据包",
        content: `${JSON.stringify({
          schema_version: 1,
          injection_bounded: true,
          omitted: true,
          complete: false,
          path: rawPath,
          bytes: info.size,
          byte_budget: REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET,
          reason: "review evidence exceeds injection byte budget and was not preloaded",
          read_authorization: "unchanged",
        })}\n`,
      };
    }
  } catch {
    // stat 失败时沿用下面的读取错误。
  }
  let content;
  try {
    content = pyReadText(target);
  } catch (error) {
    if (error?.name === "UnicodeDecodeError") throw new ToolError(`review evidence is not valid UTF-8: ${rawPath}`);
    throw error;
  }
  let evidence;
  try {
    evidence = JSON.parse(content);
  } catch (error) {
    throw new ToolError(`review evidence is not valid JSON: ${rawPath}:${jsonErrorLine(content, error)}`);
  }
  if (!isRecord(evidence)) throw new ToolError(`review evidence JSON root must be an object: ${rawPath}`);
  return { path: rawPath, content, heading: "机械证据包" };
}

export function reviewCoverageFiles(pkg) {
  const agent = isRecord(pkg?.agent) ? pkg.agent : {};
  const capability = isRecord(agent.capability) ? agent.capability : {};
  const capabilityName = pyStr(pyOr(capability.name, "")).replaceAll("-", "_");
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const contracts = isRecord(extensions.capability_contract) ? extensions.capability_contract : {};
  const review = isRecord(extensions.review_execution) ? extensions.review_execution : {};
  const contractSlot = pyStrip(pyStr(pyOr(review.contract_slot, "")));
  const direct = contractSlot ? contracts[contractSlot] : contracts[capabilityName];
  const candidates = Object.values(contracts).filter((value) => isRecord(value));
  const contract = isRecord(direct) ? direct : (!contractSlot && candidates.length === 1 ? candidates[0] : {});
  const rawFiles = Array.isArray(contract.target_files) ? contract.target_files : contract.affected_files;
  const coverageFiles = Array.isArray(rawFiles) ? rawFiles : [];
  return coverageFiles.filter((item) => pyStrip(pyStr(item))).map((item) => pyStr(item));
}

const STRUCTURED_PROFILES = new Set(["evidence_only_v1", "semantic_review_v2", "acceptance_synthesis_v1"]);

export function outputTemplateFor(pkg) {
  const extensions = isRecord(pkg) && isRecord(pkg.extensions) ? pkg.extensions : {};
  const review = isRecord(extensions.review_execution) ? extensions.review_execution : {};
  const hasCoverageFiles = reviewCoverageFiles(pkg).length > 0;
  const reviewedExample = hasCoverageFiles ? '["$target_files"]' : '["<exact path from task_package.scope.read>"]';
  const coverageHint = hasCoverageFiles
    ? "完整覆盖能力合同投影的文件集合时使用 `$target_files`；部分覆盖使用精确路径并返回 needs_owner。"
    : "从 task_package.scope.read 精确列出实际消费路径；未消费路径进入 not_reviewed 并返回 needs_owner。";
  const semanticReview = review.profile === "semantic_review_v2";
  const actualReadsField = semanticReview ? ',"actual_reads":["<实际消费的授权路径>"]' : "";
  const actualReadsHint = semanticReview
    ? "`scope.read` 是读取授权，不是全文消费义务。按本次目标核对 target_files 中的审查对象与必要上下游；`actual_reads` 列实际消费的精确路径，确已全部消费时可简写 `$scope_read`。未读的非目标授权材料不构成缺口；缺少完成目标所需证据时才记录 evidence_gaps 并返回 needs_owner。"
    : "";
  return (
    "结构化结果用 `submit_review_result` 工具提交（工具当场校验，返回错误时修正后再提交）；" +
    "返回 ok:true 即交付完成，最终回复一句话写明 gate 与结论。\n" +
    "工具不可用时，最终回复按六节写，并在 `## 事实与证据` 放一个 `json review_result_v1` 代码块：\n" +
    '{"schema_version":1,"gate":"pass | fail | needs_owner","summary":"一句结论",' +
    `"findings":[],"evidence_gaps":[],"scope":{"reviewed":${reviewedExample},"not_reviewed":[]${actualReadsField}},"output":{}}\n` +
    `${coverageHint}${actualReadsHint}最终只返回结构化结果；报告正文和 FINAL_HANDOFF 由 runner 机械生成。\n`
  );
}

export function structuredReview(pkg) {
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const review = isRecord(extensions.review_execution) ? extensions.review_execution : {};
  return STRUCTURED_PROFILES.has(review.profile);
}

export function reviewPackageProjection(pkg) {
  if (!structuredReview(pkg)) return pkg;
  const runtime = isRecord(pkg?.runtime_context) ? pkg.runtime_context : {};
  const agent = isRecord(pkg?.agent) ? pkg.agent : {};
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  // Python dict.get 缺键给 None；JS 缺键是 undefined，会在 JSON 序列化时整键消失，必须归一为 null。
  return {
    version: orNull(pkg.version),
    package_id: orNull(pkg.package_id),
    agent: {
      role: orNull(agent.role),
      runtime_role: orNull(agent.runtime_role),
      capability: orNull(agent.capability),
      required_files: orNull(agent.required_files),
    },
    goal: orNull(pkg.goal),
    scope: orNull(pkg.scope),
    tool_contract: orNull(pkg.tool_contract),
    expected_output: orNull(pkg.expected_output),
    runtime_context: {
      cwd: orNull(runtime.cwd),
      output_root: orNull(runtime.output_root),
      target_repo: orNull(runtime.target_repo),
    },
    extensions: {
      ...(isRecord(extensions.model_config) ? { model_config: extensions.model_config } : {}),
      capability_contract: orNull(extensions.capability_contract),
      review_execution: orNull(extensions.review_execution),
      review_evidence: orNull(extensions.review_evidence),
    },
    handoff_contract: orNull(pkg.handoff_contract),
  };
}

// Walk incrementally so a directory scope does not first allocate a full recursive index.
function* scopeFiles(target, missingPaths) {
  if (isFile(target)) {
    yield target;
    return;
  }
  let directory;
  try {
    directory = opendirSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    missingPaths.push(target);
    return;
  }
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) yield* scopeFiles(child, missingPaths);
      else if (isFile(child)) yield child;
    }
  } finally {
    directory.closeSync();
  }
}

export function runtimeMaterial(pkg, requiredFiles) {
  const agent = isRecord(pkg) ? pkg.agent : {};
  const capability = isRecord(agent) ? agent.capability : {};
  const commonPath = "ops/agent-prompts/_common.md";
  const capabilityPath = isRecord(capability) ? pyStr(pyOr(capability.file, "")) : "";
  const byPath = new Map(requiredFiles.map((item) => [item.path, item.content]));
  const compactReview = structuredReview(pkg);
  const supportFiles = requiredFiles.filter((item) => item.path !== commonPath && item.path !== capabilityPath);
  const evidence = reviewEvidenceSupport(pkg);
  if (evidence !== null) supportFiles.push(evidence);
  const omittedScopeFiles = [];
  if (inlinesScopeRead(pkg)) {
    // 文件与目录共用全文字节预算；超预算仅列路径与大小，保留读取授权。
    let remaining = REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET;
    const base = pyStr(pyOr(pkg.runtime_context?.target_repo, ROOT));
    for (const item of filledList(pkg.scope?.read)) {
      const target = path.resolve(base, pyStr(item));
      const missingPaths = [];
      for (const file of scopeFiles(target, missingPaths)) {
        const shown = path.relative(base, file).replaceAll("\\", "/");
        const bytes = statSync(file).size;
        if (bytes > remaining) {
          omittedScopeFiles.push({ path: shown, bytes });
          continue;
        }
        remaining -= bytes;
        supportFiles.push({ path: shown, heading: `卷宗：${shown}`, content: pyReadText(file) });
      }
      for (const missing of missingPaths) {
        omittedScopeFiles.push({ path: path.relative(base, missing).replaceAll("\\", "/"), missing: true });
      }
    }
  }
  return {
    schema_version: 3,
    task_package: reviewPackageProjection(pkg),
    common_prompt: {
      path: commonPath,
      content: byPath.has(commonPath) ? byPath.get(commonPath) : "",
    },
    capability_prompt: {
      path: capabilityPath,
      content: byPath.has(capabilityPath) ? byPath.get(capabilityPath) : "",
    },
    support_files: supportFiles,
    omitted_scope_files: omittedScopeFiles,
    output_template: compactReview ? { format: "review_result_v1", content: outputTemplateFor(pkg) } : null,
  };
}

// Python 侧 required_paths 是 set；两种容器都接受。
function contains(collection, value) {
  if (collection instanceof Set) return collection.has(value);
  if (Array.isArray(collection)) return collection.includes(value);
  return false;
}

export function renderedMaterialBody(item, requiredPaths) {
  const content = pyStr(pyOr(item?.content, ""));
  const itemPath = pyStr(pyOr(item?.path, ""));
  if (!contains(requiredPaths, itemPath)) return [content];
  const marker = JSON.stringify({ path: itemPath });
  return [
    `<!-- subagent-required-material:start ${marker} -->`,
    content,
    "<!-- subagent-required-material:end -->",
  ];
}

function jsonBlock(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

// 工具清单不含 read 时，在字节预算内注入 scope.read 全文；结构化审查由审查证据链承载。
function inlinesScopeRead(pkg) {
  const allowed = isRecord(pkg?.tool_contract) ? pkg.tool_contract.allowed : null;
  return Array.isArray(allowed) && !allowed.some((name) => pyStrip(pyStr(name)) === "read") && !structuredReview(pkg);
}

function filledList(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && pyStrip(pyStr(item)) !== "") : [];
}

// 任务卡：把子代理执行要用的字段展开成中文；调度与审计字段留在任务包文件里。
export function renderTaskCard(pkg, packagePath = "", omittedScopeFiles = []) {
  const scope = isRecord(pkg?.scope) ? pkg.scope : {};
  const extensions = isRecord(pkg?.extensions) ? pkg.extensions : {};
  const expected = isRecord(pkg?.expected_output) ? pkg.expected_output : {};
  const tools = isRecord(pkg?.tool_contract) ? pkg.tool_contract : {};
  const alignment = isRecord(pkg?.alignment) ? pkg.alignment : {};
  const goal = pyStrip(pyStr(pyOr(pkg?.goal, "")));
  const lines = ["## 任务卡", ""];
  lines.push(packagePath
    ? `任务包 \`${pyStr(pkg?.package_id)}\`；完整 JSON 在 \`${packagePath}\`，能力规则里的 \`task_package.*\` 字段都在其中。`
    : `任务包 \`${pyStr(pkg?.package_id)}\`。`);
  lines.push("", "### 目标", goal);
  const inputs = isRecord(pkg?.inputs)
    ? Object.fromEntries(Object.entries(pkg.inputs).filter(([key, value]) => !(key === "question" && pyStrip(pyStr(value)) === goal)))
    : {};
  if (Object.keys(inputs).length) lines.push("", "### 输入", jsonBlock(inputs));
  const readLabel = inlinesScopeRead(pkg)
    ? (omittedScopeFiles.length ? "必读（部分全文已在上文「卷宗」各节，未内联项见下）" : "必读（全文已在上文「卷宗」各节）")
    : "必读";
  const scopeRows = [[readLabel, scope.read],["可写", scope.write], ["可删", scope.delete], ["不做", scope.out_of_scope]]
    .map(([label, value]) => [label, filledList(value)])
    .filter(([, items]) => items.length);
  lines.push("", "### 范围", ...(scopeRows.length
    ? scopeRows.map(([label, items]) => `- ${label}：${items.map((item) => `\`${pyStr(item)}\``).join("、")}`)
    : ["- 未声明"]));
  const budgetOmissions = omittedScopeFiles.filter((item) => !item.missing);
  const missingOmissions = omittedScopeFiles.filter((item) => item.missing);
  if (budgetOmissions.length) {
    lines.push(`- 未内联（卷宗全文预算 ${REVIEW_EVIDENCE_INJECTION_BYTE_BUDGET} 字节）：`,
      ...budgetOmissions.map((item) => `  - \`${item.path}\`：${item.bytes} 字节`));
  }
  if (missingOmissions.length) {
    lines.push("- 缺失的必读路径（未内联）：",
      ...missingOmissions.map((item) => `  - \`${item.path}\``));
  }
  const facts = filledList(pkg?.known_facts);
  if (facts.length) lines.push("", "### 已知事实", ...facts.map((item) => `- ${pyStr(item)}`));
  if (isRecord(extensions.capability_contract) && Object.keys(extensions.capability_contract).length) {
    lines.push("", "### 能力合同", jsonBlock(extensions.capability_contract));
  }
  for (const [key, label] of [["review_execution", "审查执行"], ["review_evidence", "审查证据"]]) {
    if (isRecord(extensions[key]) && Object.keys(extensions[key]).length) lines.push("", `### ${label}`, jsonBlock(extensions[key]));
  }
  const outputRows = [];
  const reportPath = pyStr(pyOr(expected.resolved_file_path, expected.file_path, ""));
  if (reportPath) outputRows.push(`- 报告：\`${reportPath}\``);
  const sections = filledList(expected.required_sections);
  if (sections.length) outputRows.push(`- 报告章节：${sections.map((item) => pyStr(item)).join("、")}`);
  const gate = pyStrip(pyStr(pyOr(expected.business_gate, "")));
  if (gate) outputRows.push(`- 业务门：\`${gate}\``);
  if (outputRows.length) lines.push("", "### 产物", ...outputRows);
  const toolRows = [];
  // 角色白名单编译出的 allowed 与模型可见工具清单重复，只在种子显式收窄时列出。
  const declaredOnly = !isRecord(pkg?.worker_resources) || Array.isArray(pkg.worker_resources.declared_tools);
  if (Array.isArray(tools.allowed) && declaredOnly) toolRows.push(`- 只用：${tools.allowed.length ? tools.allowed.join("、") : "无"}`);
  const forbidden = filledList(tools.forbidden);
  if (forbidden.length) toolRows.push(`- 禁用：${forbidden.map((item) => pyStr(item)).join("、")}`);
  toolRows.push(`- 联网：${tools.network_allowed === true ? "允许" : "不允许"}；安装依赖：${tools.install_allowed === true ? "允许" : "不允许"}`);
  lines.push("", "### 工具", ...toolRows);
  if (isRecord(alignment.guard) && alignment.guard.required === true) lines.push("", "### 对齐守卫", jsonBlock(alignment));
  const stops = filledList(pkg?.stop_conditions);
  if (stops.length) lines.push("", "### 停止条件", ...stops.map((item) => `- ${pyStr(item)}`));
  return lines.join("\n");
}

export function renderFullTaskMaterial(material, packagePath = "") {
  const pkg = material?.task_package;
  const common = isRecord(material?.common_prompt) ? material.common_prompt : {};
  const capability = isRecord(material?.capability_prompt) ? material.capability_prompt : {};
  const output = isRecord(material?.output_template) ? material.output_template : {};
  const supportFiles = Array.isArray(material?.support_files) ? material.support_files : [];
  const agent = isRecord(pkg) && isRecord(pkg.agent) ? pkg.agent : {};
  const required = Array.isArray(agent.required_files) ? agent.required_files : [];
  const requiredPaths = new Set(required.map((item) => pyStr(item)));
  const goal = pyStrip(pyStr(pyOr(pkg?.goal, "")));
  const headline = goal.split("\n")[0];

  const parts = [
    `本次任务：${headline}`,
    "完整任务卡在本文末尾的「任务卡」一节。先读下面的规则，再按任务卡执行。",
    "",
    "## 公共规则",
    ...renderedMaterialBody(common, requiredPaths),
    "",
    "## 能力规则",
    ...renderedMaterialBody(capability, requiredPaths),
  ];
  for (const item of supportFiles) {
    if (!isRecord(item)) continue;
    const content = item.content;
    if (typeof content === "string" && content) {
      parts.push("", `## ${pyStr(pyOr(item.heading, "补充材料"))}`, ...renderedMaterialBody(item, requiredPaths));
    }
  }
  parts.push("", renderTaskCard(pkg, packagePath, material.omitted_scope_files ?? []));
  if (output.content) parts.push("", "## 结构化结果", pyStr(output.content));
  return pyStrip(parts.join("\n"));
}

export function renderDirectTaskMaterial(pkg, packagePath = "") {
  const requiredFiles = readRequiredFiles(pkg);
  const material = runtimeMaterial(pkg, requiredFiles);
  return renderFullTaskMaterial(material, packagePath);
}

export function renderTaskMaterialFile(packagePath) {
  return renderDirectTaskMaterial(loadPackage(packagePath), path.resolve(packagePath));
}
