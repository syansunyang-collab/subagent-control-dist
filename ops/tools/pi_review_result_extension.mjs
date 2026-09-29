/**
 * Pi 子代理扩展:注册 submit_review_result 工具,让结构化审查结果在工具调用时当场校验、
 * 失败同回合修正重提交,替代"最终回复内联 JSON、事后解析、失败整单作废"的旧链路。
 *
 * 运行约定(由 run-pi-task.mjs 注入):
 * - PI_REVIEW_RESULT_PATH:校验通过后结果落盘路径(outDir/review-result.json,runner 事后收割)。
 * - PI_REVIEW_TASK_PACKAGE_PATH:任务包 JSON 文件,供能力级语义校验(coverage marker、
 *   capability contract)使用。未设置时只做通用校验。路径已设置但文件不可读或损坏时错误上抛,
 *   不把读失败洗成跳过能力校验。
 * - SUBAGENT_PROJECT_ROOT:任务目标工作区(runner 的 targetCwd),覆盖与读面授权按它解析相对路径。
 * 校验实现与 runner 收尾共用 validateReviewResultPayload 与 validateReviewResultScope,单一真源;
 * 收尾另查只有整轮结束后才有的事实(回合完成、必读材料实际加载)。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REVIEW_RESULT_V1_JSON_SCHEMA, ReviewPackageDefectError, validateReviewResultPayload, validateReviewResultScope } from "./review_result_synthesis.mjs";

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}

export default function (pi) {
  const resultPath = String(process.env.PI_REVIEW_RESULT_PATH || "").trim();
  if (!resultPath) return;
  const taskPackagePath = String(process.env.PI_REVIEW_TASK_PACKAGE_PATH || "").trim();

  pi.registerTool({
    name: "submit_review_result",
    label: "Submit Review Result",
    // 与 submit_task_result 同理：不设 promptSnippet 就不进系统提示词的工具清单。
    promptSnippet: "Submit the structured review result; this is how the review is delivered",
    promptGuidelines: ["When the review is done, deliver it by calling submit_review_result; submit_review_result is a tool call, not a shell command."],
    description: [
      "提交本次结构化审查的 review_result_v1 结果，这是结果的正式提交通道：参数即 schema，提交时当场校验；",
      "校验失败返回具体错误，修正后再提交一次。返回 ok:true 即交付完成；最终回复一句话写明 gate 与结论，",
      "不再内联 JSON 或重写报告正文。重复调用以最后一次成功提交为准。",
    ].join(""),
    parameters: REVIEW_RESULT_V1_JSON_SCHEMA,
    execute: async (_toolCallId, params) => {
      // pi 可能复用参数对象引用;校验会原地归一化,先深拷隔离。
      const candidate = JSON.parse(JSON.stringify(params ?? {}));
      const taskPackage = taskPackagePath ? JSON.parse(readFileSync(taskPackagePath, "utf8")) : null;
      let packageDefect = null;
      try {
        validateReviewResultPayload(candidate, taskPackage);
        if (taskPackage) validateReviewResultScope(taskPackage, candidate, process.env.SUBAGENT_PROJECT_ROOT || process.cwd());
      } catch (error) {
        if (error instanceof ReviewPackageDefectError) packageDefect = error.message;
        else return textResult({
          ok: false,
          error: String(error?.message ?? error),
          hint: "结果未保存。修正上述字段后再提交一次。",
        });
      }
      mkdirSync(path.dirname(resultPath), { recursive: true });
      writeFileSync(resultPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
      return textResult({
        ok: true,
        saved: true,
        gate: candidate.gate,
        findings_count: candidate.findings.length,
        ...(packageDefect ? { requires_parent_review: true, package_defect: packageDefect } : {}),
        note: packageDefect
          ? "结果已保存；任务包自身有缺陷（见 package_defect），与结果内容无关，父级会复核，无需再提交。最终回复一句话写明 gate、结论和该缺陷。"
          : "交付完成。最终回复一句话写明 gate 与结论即可，不再内联 JSON 或重写报告正文。",
      });
    },
  });
}
