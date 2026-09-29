// ops/tools/pi_worker_tools_extension.mjs
import { writeFileSync } from "node:fs";

// ops/tools/pi_research_tools.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
function readWorkerTask(env = process.env, read = readFileSync) {
  const file = env.PI_WORKER_TASK_PACKAGE_PATH;
  if (!file) return null;
  const parsed = JSON.parse(read(file, "utf8"));
  const task = parsed.task_package ?? parsed;
  if (!task?.package_id || !(task.agent?.runtime_role || task.agent?.role)) throw new Error("Worker task identity missing; restore the task package before retrying.");
  return task;
}
var RESEARCH_CAPABILITIES = ["external-research", "wheel-discovery"];
function usesResearchSurface(task) {
  return task?.agent?.role === "research-agent" && (!task.agent.runtime_role || task.agent.runtime_role === "research-agent") && RESEARCH_CAPABILITIES.includes(task.agent.capability?.name);
}
var RESEARCH_TOOLS = ["research_search", "research_fetch"];
var BUILTIN_OVERRIDE_TOOLS = ["grep", "find"];
var LOCAL_TOOLS = /* @__PURE__ */ new Set(["submit_task_result", "submit_review_result", "command_job", "lsp_diagnostics", "lsp_fix"]);
function researchToolAllowed(name, task, allTools, surface = null) {
  if (task.tool_contract?.forbidden?.includes(name)) return false;
  if (Array.isArray(surface) && !surface.includes(name)) return false;
  return RESEARCH_TOOLS.includes(name) || LOCAL_TOOLS.has(name) || BUILTIN_OVERRIDE_TOOLS.includes(name) || allTools.some((t) => t.name === name && t.sourceInfo?.source === "builtin");
}
function pluginLoader(allTools, { cli = process.argv[1], requireFrom = createRequire } = {}) {
  const source = allTools.find((t) => t.name === "web_search")?.sourceInfo?.path;
  if (!source || path.basename(path.dirname(source)) !== "pi-web-access") {
    throw new Error("Configured pi-web-access source is unavailable; restore the worker plugin configuration and retry.");
  }
  const runtimeRequire = requireFrom(path.resolve(cli));
  const { createJiti } = runtimeRequire("jiti");
  const runtimeLoader = createJiti(path.resolve(cli));
  const alias = Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"].map((name) => [name, runtimeLoader.esmResolve(name)]));
  const jiti = createJiti(source, { fsCache: false, moduleCache: true, alias });
  return (name) => jiti.import(path.join(path.dirname(source), name));
}
var str = (description) => ({ type: "string", minLength: 1, description });
var pageFields = {
  responseId: str("Read a cached response from this session instead of making a network request."),
  offset: { type: "integer", minimum: 0, description: "Zero-based character offset in the cached serialized source material; default 0." },
  limit: { type: "integer", minimum: 1, maximum: 12e3, description: "Maximum characters returned; default 12000." }
};
var schema = (properties) => ({ type: "object", properties, additionalProperties: false });
function createResearchTools({ load, networkAllowed = true } = {}) {
  const cache = /* @__PURE__ */ new Map();
  let cacheChars = 0;
  function page(id, offset = 0, limit = 12e3) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 12e3) throw new Error("Use offset >= 0 and limit between 1 and 12000.");
    const text = cache.get(id);
    if (text === void 0) throw new Error("Cached response unavailable (expired or new session); repeat the original authorized request.");
    if (offset > text.length) throw new Error(`Offset exceeds totalChars=${text.length}; use an offset within this response.`);
    const end = Math.min(offset + limit, text.length);
    const details = { responseId: id, offset, nextOffset: end < text.length ? end : null, totalChars: text.length };
    return { content: [{ type: "text", text: `${JSON.stringify(details)}
${text.slice(offset, end)}` }], details };
  }
  function store(material, params) {
    const text = JSON.stringify(material, null, 2);
    if (text.length > 16e6) throw new Error("Source material exceeds the 16M-character session cache limit; narrow the request.");
    while (cache.size && (cacheChars + text.length > 16e6 || cache.size >= 32)) {
      const oldest = cache.keys().next().value;
      cacheChars -= cache.get(oldest).length;
      cache.delete(oldest);
    }
    const id = randomUUID();
    cache.set(id, text);
    cacheChars += text.length;
    return page(id, params.offset, params.limit);
  }
  async function execute(kind, params, signal) {
    signal?.throwIfAborted();
    if (params.responseId) return page(params.responseId, params.offset, params.limit);
    if (!networkAllowed) throw new Error("This task has no network authorization; return needs_owner for the missing permission.");
    let material;
    if (kind === "search") {
      if (!["brave", "tavily"].includes(params.provider) || typeof params.query !== "string" || !params.query.trim()) throw new Error("For a new search, supply provider brave or tavily and a non-empty query.");
      const module = await load(`${params.provider}.ts`);
      signal?.throwIfAborted();
      const search = params.provider === "brave" ? module.searchWithBrave : module.searchWithTavily;
      if (typeof search !== "function") throw new Error("Raw search export missing; restore pi-web-access before retrying.");
      const result = await search(params.query, {
        numResults: params.numResults,
        domainFilter: params.domainFilter,
        recencyFilter: params.recencyFilter,
        includeContent: true,
        signal
      });
      material = { provider: params.provider, query: params.query, results: result.results, inlineContent: result.inlineContent ?? [] };
    } else {
      const url = new URL(params.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("research_fetch accepts HTTP(S) URLs only; use local read tools for local files.");
      const module = await load("extract.ts");
      signal?.throwIfAborted();
      if (typeof module.extractContent !== "function") throw new Error("Raw HTTP export missing; restore pi-web-access before retrying.");
      material = await module.extractContent(url.href, signal, { mode: "raw" });
      signal?.throwIfAborted();
      if (material.error) throw new Error(`Raw HTTP fetch failed: ${material.error}`);
      material = { status: material.status, mimeType: material.mimeType, ...material };
    }
    signal?.throwIfAborted();
    return store(material, params);
  }
  const tools = [
    {
      name: "research_search",
      label: "Research Search",
      promptSnippet: "Search Brave or Tavily for raw source results (paged)",
      description: "Discover sources using explicit Brave or Tavily raw search. Returns structured results and available original text, without model synthesis. Output is paged at 12000 characters; continue with responseId and nextOffset. Cache holds up to 32 responses / 16M characters until session shutdown.",
      parameters: schema({
        provider: { type: "string", enum: ["brave", "tavily"], description: "Required for a new search; selects the raw provider directly." },
        query: str("Required for a new search; search terms."),
        numResults: { type: "integer", minimum: 1, maximum: 20, description: "Results requested; default 5." },
        domainFilter: { type: "array", items: str("Domain; prefix - to exclude.") },
        recencyFilter: { type: "string", enum: ["day", "week", "month", "year"] },
        ...pageFields
      }),
      execute: (_id, params, signal) => execute("search", params, signal)
    },
    {
      name: "research_fetch",
      label: "Research Fetch",
      promptSnippet: "Fetch the raw text body of an HTTP(S) URL (paged)",
      description: "Read an HTTP(S) textual response body using the plugin's raw HTTP path, without model fallback or clean-text extraction. Includes HTTP status and MIME type; binary/PDF/video are unsupported. Output is paged at 12000 characters; continue with responseId and nextOffset. Cache is session-local (32 responses / 16M characters).",
      parameters: schema({ url: str("Required for a new fetch; HTTP(S) URL."), ...pageFields }),
      execute: (_id, params, signal) => execute("fetch", params, signal)
    }
  ];
  return { tools, clear() {
    cache.clear();
    cacheChars = 0;
  } };
}
function configureResearchSession(pi, task, { load, surface = null } = {}) {
  if (!usesResearchSurface(task)) return null;
  const originalTools = pi.getAllTools();
  let importer;
  const raw = createResearchTools({
    load: load ?? ((name) => {
      importer ??= pluginLoader(originalTools);
      return importer(name);
    }),
    networkAllowed: task.tool_contract?.network_allowed === true
  });
  const allowed = (name) => researchToolAllowed(name, task, pi.getAllTools(), surface);
  for (const tool of raw.tools) if (allowed(tool.name)) pi.registerTool(tool);
  const enforce = () => pi.setActiveTools(pi.getActiveTools().filter(allowed));
  pi.setActiveTools([.../* @__PURE__ */ new Set([...pi.getActiveTools(), ...RESEARCH_TOOLS.filter(allowed)])]);
  enforce();
  return { enforce, allowed, clear: raw.clear };
}

// ops/tools/pi_worker_tools_extension.mjs
var runnerToolSurface = () => process.env.PI_WORKER_TOOL_SURFACE ? JSON.parse(process.env.PI_WORKER_TOOL_SURFACE) : null;
function workerTools(pi, { readTask = readWorkerTask, load, surface = runnerToolSurface() } = {}) {
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
        active: active.has(tool.name)
      }))
    }, null, 2));
  };
  pi.on("session_start", () => {
    let task;
    try {
      task = readTask();
    } catch (error) {
      identityError = error.message;
    }
    if (!identityError && process.env.PI_WORKER_INHERIT_TOOLS === "1" && !Array.isArray(task?.tool_contract?.allowed)) {
      const builtins = pi.getAllTools().filter((tool) => tool.sourceInfo?.source === "builtin").map((tool) => tool.name);
      pi.setActiveTools([.../* @__PURE__ */ new Set([...pi.getActiveTools(), ...builtins])]);
    }
    const replaced = pi.getAllTools().filter((tool) => tool.sourceInfo?.source === "builtin" && BUILTIN_OVERRIDE_TOOLS.includes(tool.name)).map((tool) => tool.name);
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
export {
  workerTools as default
};
