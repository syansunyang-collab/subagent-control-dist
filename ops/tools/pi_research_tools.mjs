import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function readWorkerTask(env = process.env, read = readFileSync) {
  const file = env.PI_WORKER_TASK_PACKAGE_PATH;
  if (!file) return null;
  const parsed = JSON.parse(read(file, "utf8"));
  const task = parsed.task_package ?? parsed;
  if (!task?.package_id || !(task.agent?.runtime_role || task.agent?.role)) throw new Error("Worker task identity missing; restore the task package before retrying.");
  return task;
}

// Capabilities whose worker session runs on the research tool surface.
export const RESEARCH_CAPABILITIES = ["external-research", "wheel-discovery"];
export function usesResearchSurface(task) {
  return task?.agent?.role === "research-agent"
    && (!task.agent.runtime_role || task.agent.runtime_role === "research-agent")
    && RESEARCH_CAPABILITIES.includes(task.agent.capability?.name);
}

export const RESEARCH_TOOLS = ["research_search", "research_fetch"];
// pi_search_extension 以同名注册覆盖的内置工具；覆盖后来源不再是 builtin，但按内置工具同等对待。
export const BUILTIN_OVERRIDE_TOOLS = ["grep", "find"];
// Only local analysis and delivery extensions join the built-ins on this capability's surface.
const LOCAL_TOOLS = new Set(["submit_task_result", "submit_review_result", "command_job", "lsp_diagnostics", "lsp_fix"]);
// surface is the runner's final tool list (the -t list: task allowlist, default_on tools and the delivery tool);
// null when the worker keeps Pi's configured tools.
export function researchToolAllowed(name, task, allTools, surface = null) {
  if (task.tool_contract?.forbidden?.includes(name)) return false;
  if (Array.isArray(surface) && !surface.includes(name)) return false;
  return RESEARCH_TOOLS.includes(name) || LOCAL_TOOLS.has(name) || BUILTIN_OVERRIDE_TOOLS.includes(name)
    || allTools.some(t => t.name === name && t.sourceInfo?.source === "builtin");
}

/** Load the configured plugin through Pi's existing TS loader, never its agentic index. */
export function pluginLoader(allTools, { cli = process.argv[1], requireFrom = createRequire } = {}) {
  const source = allTools.find(t => t.name === "web_search")?.sourceInfo?.path;
  if (!source || path.basename(path.dirname(source)) !== "pi-web-access") {
    throw new Error("Configured pi-web-access source is unavailable; restore the worker plugin configuration and retry.");
  }
  const runtimeRequire = requireFrom(path.resolve(cli));
  const { createJiti } = runtimeRequire("jiti");
  const runtimeLoader = createJiti(path.resolve(cli));
  const alias = Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]
    .map(name => [name, runtimeLoader.esmResolve(name)]));
  const jiti = createJiti(source, { fsCache: false, moduleCache: true, alias });
  return name => jiti.import(path.join(path.dirname(source), name));
}

const str = description => ({ type: "string", minLength: 1, description });
const pageFields = {
  responseId: str("Read a cached response from this session instead of making a network request."),
  offset: { type: "integer", minimum: 0, description: "Zero-based character offset in the cached serialized source material; default 0." },
  limit: { type: "integer", minimum: 1, maximum: 12000, description: "Maximum characters returned; default 12000." },
};
const schema = properties => ({ type: "object", properties, additionalProperties: false });

/** Per-session, bounded raw-material cache; no files or persistent credentials are copied. */
export function createResearchTools({ load, networkAllowed = true } = {}) {
  const cache = new Map();
  let cacheChars = 0;
  function page(id, offset = 0, limit = 12000) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 12000) throw new Error("Use offset >= 0 and limit between 1 and 12000.");
    const text = cache.get(id);
    if (text === undefined) throw new Error("Cached response unavailable (expired or new session); repeat the original authorized request.");
    if (offset > text.length) throw new Error(`Offset exceeds totalChars=${text.length}; use an offset within this response.`);
    const end = Math.min(offset + limit, text.length);
    const details = { responseId: id, offset, nextOffset: end < text.length ? end : null, totalChars: text.length };
    return { content: [{ type: "text", text: `${JSON.stringify(details)}\n${text.slice(offset, end)}` }], details };
  }
  function store(material, params) {
    const text = JSON.stringify(material, null, 2);
    if (text.length > 16_000_000) throw new Error("Source material exceeds the 16M-character session cache limit; narrow the request.");
    while (cache.size && (cacheChars + text.length > 16_000_000 || cache.size >= 32)) {
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
        numResults: params.numResults, domainFilter: params.domainFilter,
        recencyFilter: params.recencyFilter, includeContent: true, signal,
      });
      // Ignore provider answer fields, including unexpected synthesized answers.
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
      // Keep response metadata on the first page, before a potentially long body.
      material = { status: material.status, mimeType: material.mimeType, ...material };
    }
    signal?.throwIfAborted();
    return store(material, params);
  }
  const tools = [
    {
      name: "research_search", label: "Research Search",
      promptSnippet: "Search Brave or Tavily for raw source results (paged)",
      description: "Discover sources using explicit Brave or Tavily raw search. Returns structured results and available original text, without model synthesis. Output is paged at 12000 characters; continue with responseId and nextOffset. Cache holds up to 32 responses / 16M characters until session shutdown.",
      parameters: schema({
        provider: { type: "string", enum: ["brave", "tavily"], description: "Required for a new search; selects the raw provider directly." },
        query: str("Required for a new search; search terms."),
        numResults: { type: "integer", minimum: 1, maximum: 20, description: "Results requested; default 5." },
        domainFilter: { type: "array", items: str("Domain; prefix - to exclude.") },
        recencyFilter: { type: "string", enum: ["day", "week", "month", "year"] },
        ...pageFields,
      }),
      execute: (_id, params, signal) => execute("search", params, signal),
    },
    {
      name: "research_fetch", label: "Research Fetch",
      promptSnippet: "Fetch the raw text body of an HTTP(S) URL (paged)",
      description: "Read an HTTP(S) textual response body using the plugin's raw HTTP path, without model fallback or clean-text extraction. Includes HTTP status and MIME type; binary/PDF/video are unsupported. Output is paged at 12000 characters; continue with responseId and nextOffset. Cache is session-local (32 responses / 16M characters).",
      parameters: schema({ url: str("Required for a new fetch; HTTP(S) URL."), ...pageFields }),
      execute: (_id, params, signal) => execute("fetch", params, signal),
    },
  ];
  return { tools, clear() { cache.clear(); cacheChars = 0; } };
}

export function configureResearchSession(pi, task, { load, surface = null } = {}) {
  if (!usesResearchSurface(task)) return null;
  const originalTools = pi.getAllTools();
  let importer;
  const raw = createResearchTools({
    load: load ?? (name => { importer ??= pluginLoader(originalTools); return importer(name); }),
    networkAllowed: task.tool_contract?.network_allowed === true,
  });
  const allowed = name => researchToolAllowed(name, task, pi.getAllTools(), surface);
  // Pi dynamically registered tools can become active immediately: filter in the same handler.
  for (const tool of raw.tools) if (allowed(tool.name)) pi.registerTool(tool);
  const enforce = () => pi.setActiveTools(pi.getActiveTools().filter(allowed));
  pi.setActiveTools([...new Set([...pi.getActiveTools(), ...RESEARCH_TOOLS.filter(allowed)])]);
  enforce();
  return { enforce, allowed, clear: raw.clear };
}

