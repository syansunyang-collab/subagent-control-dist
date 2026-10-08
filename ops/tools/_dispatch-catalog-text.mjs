// dispatch_prepare --list 的文本投影：只投影 projectCatalog 已算好的字段，不做选型判断。
// JSON 目录（--format json）字段相同；本文件服务主代理 list 查询的默认返回。
// 视觉取 Pi 目录详情的图像输入（projectCatalog 的 supports_vision）；不在 Pi 目录或取不到目录时为未知。
import path from "node:path";

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const visionText = (value) => (value === true ? "是" : value === false ? "否" : "未知");

function configSourceText(source = {}) {
  const roots = [];
  if (source.project_override && source.declaration_path) {
    roots.push(path.dirname(path.dirname(source.declaration_path)));
  }
  if (source.global_root && !roots.includes(source.global_root)) roots.push(source.global_root);
  const override = source.project_override && source.declared_keys?.length
    ? `（项目覆盖 ${source.declared_keys.join("/")}）`
    : "";
  return `配置来源：${roots.join(" + ") || "未知"}${override}`;
}

function capabilityLine(capability) {
  const phase = capability.dispatch_phase;
  const phaseText = !phase ? "阶段未声明"
    : phase.kind === "workflow" ? `流程内${phase.step ? ` ${phase.step}` : ""}`
      : "直派";
  return `  能力 ${capability.id} · ${phaseText} · 默认 ${capability.default_pick ?? "无"}`
    + `${capability.inherit_role_picks === false ? " · 只用专属推荐行" : ""}`;
}

function pickLine(pick) {
  return `  推荐 ${pick.id}${pick.capability ? ` [${pick.capability}]` : ""}${pick.when ? ` ${oneLine(pick.when)}` : ""}`
    + ` → ${pick.model}@${pick.effort} [${pick.effort_min}–${pick.effort_max}]${pick.default ? " · 默认" : ""}`;
}

/** 把 projectCatalog 投影渲染成逐行文本；按路由收窄已由 projectCatalog 完成。 */
export function renderCatalogText(catalog) {
  const lines = [configSourceText(catalog.config_source)];
  if (catalog.config_fingerprint) lines.push(`配置指纹：${catalog.config_fingerprint}`);
  if (catalog.warnings.length) {
    lines.push("警告");
    for (const item of catalog.warnings) lines.push(`  ${item.code} ${item.file} ${item.field}: ${oneLine(item.message)}`);
  }
  lines.push(catalog.model_scope === "all" ? "模型（完整 Pi 目录及配置引用）" : "模型");
  for (const model of catalog.models) {
    lines.push(`  ${model.model}${model.tag ? ` ${model.tag}` : ""} · 视觉 ${visionText(model.supports_vision)}`
      + ` · 档位 ${model.efforts.join("/")}${model.in_pi === false ? " · 不在 Pi 模型清单" : ""}`);
  }
  lines.push("角色");
  for (const role of catalog.roles) {
    lines.push(`${role.role}：${oneLine(role.description)}`);
    for (const item of role.capabilities) lines.push(capabilityLine(item));
    for (const pick of role.picks) lines.push(pickLine(pick));
  }
  return lines;
}
