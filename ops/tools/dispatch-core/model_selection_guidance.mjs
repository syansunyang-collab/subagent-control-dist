// list 与模板共用的日常选型说明；具体模型与档位由当前配置投影。
export const MODEL_SELECTION_GUIDANCE = Object.freeze([
  "pick 与 model 至多给一个，都不给时用本任务类型的有效默认推荐行；effort 可显式给出。",
  "只给 model 时先看有效默认行，再按顺序找本任务类型适用的同模型推荐行，沿用该行档位与范围；找不到时必须显式给出 effort。",
  "effort 必须在模型可选档位内，授权不能解除。越出所在行 [min–max] 需授权 effort_range，模型不在本角色任何推荐行里需授权 outside_pool："
    + "authorization={quote: 用户本轮原话, overrides: [...]}，只对本次 model + effort 生效。",
]);

/** Receipt-friendly selection; the frozen snapshot itself remains available in JSON results. */
export function selectionSummary(selection) {
  if (!selection) return "未解析";
  const requested = selection.requested || {};
  const source = requested.pick ? `pick:${requested.pick}` : requested.model ? `model:${requested.model}` : `默认:${selection.pick}`;
  const applied = (selection.authorization?.applied_overrides || []).map((item) => item.kind).join("、") || "无";
  return `${selection.resolved_model}@${selection.resolved_effort} · ${source} · 授权解除:${applied}`;
}
