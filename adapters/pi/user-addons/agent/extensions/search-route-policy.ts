import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GENERAL_SEARCH_TOOL = "web_search";
const CLAUDE_SEARCH_TOOL = "pi_claude_code_provider_web_search";
const MODE_ENV = "PI_CLAUDE_CODE_PROVIDER_WEB_SEARCH";

type SearchRouteMode = "auto" | "always" | "never";

function resolveMode(environment: NodeJS.ProcessEnv = process.env): {
  mode: SearchRouteMode;
  warning?: string;
} {
  const raw = environment[MODE_ENV]?.trim().toLowerCase();
  if (!raw || raw === "auto") return { mode: "auto" };
  if (raw === "always" || raw === "never") return { mode: raw };
  return {
    mode: "auto",
    warning: `${MODE_ENV} must be auto, always, or never; using auto`,
  };
}

export default function searchRoutePolicy(pi: ExtensionAPI) {
  const selection = resolveMode();
  let warned = false;

  const reconcile = (): boolean => {
    const active = pi.getActiveTools();
    if (!active.includes(CLAUDE_SEARCH_TOOL)) return false;
    if (selection.mode === "always") return false;
    if (selection.mode === "auto" && !active.includes(GENERAL_SEARCH_TOOL)) return false;

    // Preserve every other active tool and its order. This changes only the
    // model-visible search route; the Claude model provider remains untouched.
    pi.setActiveTools(active.filter((name) => name !== CLAUDE_SEARCH_TOOL));
    return true;
  };

  pi.on("session_start", (_event, ctx) => {
    if (selection.warning && !warned) {
      warned = true;
      ctx.ui.notify(`[search-route-policy] ${selection.warning}`, "warning");
    }
  });

  // Runs after every extension's session_start handler, including tools that
  // register dynamically during session startup.
  pi.on("resources_discover", () => {
    reconcile();
  });

  // Defends against a later extension re-enabling the duplicate route.
  pi.on("before_agent_start", () => {
    reconcile();
  });
}
