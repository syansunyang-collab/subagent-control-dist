// 分身选型桥：pick（或省略）走共享解析器；显式 model + effort 保持现有例外，只校验档位在该模型可选档位内。
import { readFileSync } from "node:fs";
import { resolveModelConfigSources } from "./model_config.mjs";
import { loadSelectionConfig, modelEfforts, resolveSelection } from "./dispatch-core/model_selection.mjs";

const choices = ["luna_xhigh", "luna_max", "sol_high"];

function finish(payload, code = 0) {
  process.stdout.write(JSON.stringify(payload));
  process.exitCode = code;
}

function explicitChoice(config, model, effort) {
  const efforts = modelEfforts(config, model);
  if (!efforts.includes(effort)) throw new Error(`${effort} 不在 ${model} 的可选档位（${efforts.join("/")}）内`);
  return {
    requested: { pick: null, model, effort },
    pick: null,
    config_source: config.config_source,
    resolved_model: model,
    resolved_effort: effort,
    effort_source: "explicit",
    efforts,
  };
}

try {
  const request = JSON.parse(readFileSync(0, "utf8") || "{}");
  const runtimeRoot = process.env.SUBAGENT_RUNTIME_ROOT;
  const projectRoot = process.env.SUBAGENT_PROJECT_ROOT;
  if (!runtimeRoot || !projectRoot) {
    finish({ error: { code: "config_invalid", message: "Trusted runtime and project roots are required", alternatives: choices } }, 1);
  } else if (request.pick && request.model) {
    finish({ error: { code: "selection_invalid", message: "Choose pick or model, not both", alternatives: choices } }, 1);
  } else if (request.model ? !request.effort : (request.effort && !request.pick)) {
    finish({ error: { code: "selection_invalid", message: "model and effort must be given together; effort alone needs a pick", alternatives: choices } }, 1);
  } else {
    const sources = resolveModelConfigSources({ roots: [{ root: runtimeRoot, source: "runtime_root" }], projectRoot });
    const config = loadSelectionConfig(sources);
    const choice = request.model
      ? explicitChoice(config, request.model, request.effort)
      : resolveSelection(config, { role: "delegate-work", capability: "delegate_work", pick: request.pick, effort: request.effort });
    const slash = choice.resolved_model.indexOf("/");
    if (slash <= 0 || slash === choice.resolved_model.length - 1) {
      finish({ error: { code: "selection_invalid", message: `Model is not provider/id: ${choice.resolved_model}`, alternatives: choices } }, 1);
    } else {
      const selection = {
        provider: choice.resolved_model.slice(0, slash),
        model_id: choice.resolved_model.slice(slash + 1),
        effort: choice.resolved_effort,
        provenance: Object.fromEntries(["requested", "pick", "config_source", "effort_source", "efforts"].map((key) => [key, choice[key]])),
      };
      finish({ selection, alternatives: choices });
    }
  }
} catch (error) {
  // 配置文件错误带 file（model_selection）或是来源声明错误（model_config）；其余是本次请求的选型错误。
  const code = error?.file || error?.name === "ModelConfigError" ? "config_invalid" : "selection_invalid";
  finish({ error: { code, message: String(error?.message ?? error), alternatives: choices } }, 1);
}
