import { ToolError, isRecord, loadRoleConfig } from "../_tool_common.mjs";
import { pyStr, pyStrip, pyTruthy } from "../_py.mjs";
import { resolveWorkerResources } from "../model_selection.mjs";
import { profileFor } from "../seed_minimal.mjs";
import { conditionalRequiredFiles } from "../task_package_profiles.mjs";
import { defaultOnTools } from "../../pi_worker_resources.mjs";
import { deps } from "./deps.mjs";

export function taskToolAllowlist(taskPackage) {
  const contract = isRecord(taskPackage?.tool_contract) ? taskPackage.tool_contract : {};
  const allowed = contract.allowed;
  if (allowed === null || allowed === undefined) return null;
  if (!Array.isArray(allowed) || allowed.some((item) => typeof item !== "string" || !pyStrip(item))) {
    throw new ToolError("task_package.tool_contract.allowed must be null or an array of non-empty Pi tool names");
  }
  return [...new Set(allowed.map((item) => pyStrip(item)))];
}

/**
 * Compile the role × capability worker whitelist into the task package. The role selection is the role tools
 * plus the default_on tools of the import scope; tool_contract.allowed becomes that selection, or the seed list
 * narrowed to it. The result is the final tool surface: the runner only adds the delivery tool.
 * task_package.worker_resources records the extensions / skills / project_skills the runner loads.
 */
export function applyRoleWorkerResources(taskPackage, config, imports) {
  const agent = isRecord(taskPackage.agent) ? taskPackage.agent : {};
  const role = pyStr(pyTruthy(agent.runtime_role) ? agent.runtime_role : (pyTruthy(agent.role) ? agent.role : ""));
  const capability = isRecord(agent.capability) ? pyStrip(pyStr(pyTruthy(agent.capability.name) ? agent.capability.name : "")) : "";
  const whitelist = resolveWorkerResources(config, role, capability);
  if (whitelist === null) return;
  const declared = taskToolAllowlist(taskPackage);
  const selection = [...new Set([...whitelist.tools, ...defaultOnTools(imports)])];
  taskPackage.tool_contract.allowed = declared === null ? selection : declared.filter((name) => selection.includes(name));
  taskPackage.worker_resources = {
    extensions: whitelist.extensions,
    skills: whitelist.skills,
    project_skills: whitelist.project_skills,
    declared_tools: declared,
    source: { role, capability },
  };
}

export function reviewExecutionProfile(taskPackage) {
  const extensions = isRecord(taskPackage?.extensions) ? taskPackage.extensions : {};
  const review = isRecord(extensions.review_execution) ? extensions.review_execution : {};
  return pyStr(pyTruthy(review.profile) ? review.profile : "");
}

/** Project capability-selected prompt layers from the route profile. */
export function projectConditionalRequiredFiles(taskPackage) {
  const agent = isRecord(taskPackage?.agent) ? taskPackage.agent : {};
  const capability = isRecord(agent.capability) ? agent.capability : {};
  const routeId = `${pyStr(Object.hasOwn(agent, "role") ? agent.role : "")}__${pyStr(Object.hasOwn(capability, "name") ? capability.name : "")}`;
  agent.required_files = conditionalRequiredFiles(taskPackage, profileFor(routeId));
  return null;
}

function agentConfigEntryImpl(agentType) {
  return loadRoleConfig(agentType);
}

export function agentConfigEntry(agentType) {
  return deps.agentConfigEntry(agentType);
}

export { agentConfigEntryImpl };
