import { writeFileSync } from "node:fs";
import { BUILTIN_OVERRIDE_TOOLS, readWorkerTask, configureResearchSession } from "./pi_research_tools.mjs";

// Observe the real child registry. Research isolation is a tool surface, not OS permissions.
// The runner passes its final -t list; empty means the worker keeps Pi's configured tools.
const runnerToolSurface = () => (process.env.PI_WORKER_TOOL_SURFACE ? JSON.parse(process.env.PI_WORKER_TOOL_SURFACE) : null);

export default function workerTools(pi, { readTask = readWorkerTask, load, surface = runnerToolSurface() } = {}) {
  let research;
  let identityError;
  const snapshot = () => {
    const output = process.env.PI_WORKER_TOOLS_PATH;
    if (!output) return;
    const active = new Set(pi.getActiveTools());
    writeFileSync(output, JSON.stringify({
      source: "child_runtime",
      tools: pi.getAllTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        sourceInfo: tool.sourceInfo,
        active: active.has(tool.name),
      })),
    }, null, 2));
  };
  pi.on("session_start", () => {
    let task;
    try { task = readTask(); }
    catch (error) { identityError = error.message; }
    if (!identityError && process.env.PI_WORKER_INHERIT_TOOLS === "1" && !Array.isArray(task?.tool_contract?.allowed)) {
      // Pi defaults to four built-ins. Enable the other installed built-ins without hardcoding their names.
      const builtins = pi.getAllTools().filter((tool) => tool.sourceInfo?.source === "builtin").map((tool) => tool.name);
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...builtins])]);
    }
    // 覆盖生效时注册表里已无内置 grep / find；覆盖失败时内置版仍在，这里不让它进入活动工具。
    const replaced = pi.getAllTools()
      .filter((tool) => tool.sourceInfo?.source === "builtin" && BUILTIN_OVERRIDE_TOOLS.includes(tool.name))
      .map((tool) => tool.name);
    if (replaced.length) pi.setActiveTools(pi.getActiveTools().filter((name) => !replaced.includes(name)));
    if (!identityError) research = configureResearchSession(pi, task, { load, surface });
    snapshot();
  });
  pi.on("before_agent_start", () => {
    research?.enforce();
    snapshot();
    const warning = identityError;
    if (warning) return { message: { customType: "research-configuration", content: warning, display: true } };
  });
  pi.on("turn_start", () => research?.enforce());
  pi.on("session_shutdown", () => research?.clear());
  pi.on("tool_call", (event) => {
    if (identityError) return { block: true, reason: identityError };
    if (research && !research.allowed(event.toolName)) {
      return { block: true, reason: "Tool outside this research surface or task allowlist; use the authorized research/local tools, or return needs_owner for missing capability." };
    }
    if (event.toolName === "web_search" && event.input) event.input.workflow = "none";
    if (event.toolName === "visual_explainer" && event.input) event.input.open = false;
  });
}
