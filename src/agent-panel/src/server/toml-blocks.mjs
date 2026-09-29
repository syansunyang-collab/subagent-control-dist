import { parse as parseToml, patch, stringify } from "@decimalturn/toml-patch";

export class TomlWritebackError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "TomlWritebackError";
    this.code = code;
    this.file = options.file ?? null;
  }
}

function parse(text, file = "TOML") {
  try {
    return parseToml(text);
  } catch (error) {
    throw new TomlWritebackError("TOML_INVALID", `${file}: ${error.message}`, { file });
  }
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function table(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A draft may omit fields it cannot edit. Keep these (and their original key order).
// Explicit deletions are supplied through editIdentity.deletedPaths.
function merge(base, draft, location = []) {
  if (Array.isArray(draft)) {
    if (location.at(-1) === "picks" && Array.isArray(base)) {
      const byId = new Map(base.map((pick) => [pick.id, pick]));
      return draft.map((pick) => merge(byId.get(pick.id), pick, [...location, pick.id]));
    }
    return draft;
  }
  if (!table(draft)) return draft;
  const result = table(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(draft)) {
    result[key] = merge(result[key], value, [...location, key]);
  }
  return result;
}

function tableLike(value) {
  return table(value) || (Array.isArray(value) && value.length > 0 && value.every(table));
}

// merge appends new root keys after existing tables; TOML root key-values must precede
// every table. Place them after `anchor` when the source has it, else before the first table.
function hoistNewRootValues(original, target, anchor) {
  const added = Object.keys(target).filter((key) => !Object.hasOwn(original, key) && !tableLike(target[key]));
  if (!added.length) return target;
  const rest = Object.keys(target).filter((key) => !added.includes(key));
  let at = anchor && rest.includes(anchor) ? rest.indexOf(anchor) + 1 : rest.findIndex((key) => tableLike(target[key]));
  if (at < 0) at = rest.length;
  const order = [...rest.slice(0, at), ...added, ...rest.slice(at)];
  return Object.fromEntries(order.map((key) => [key, target[key]]));
}

function deletePath(object, path) {
  let parent = object;
  for (const part of path.slice(0, -1)) {
    if (!table(parent?.[part])) throw new TomlWritebackError("TOML_DELETE_MISSING", `Missing table: ${path.join(".")}`);
    // merge leaves omitted subtrees shared with the parsed source. Clone the
    // deletion path so block discovery can still compare source and target.
    parent[part] = { ...parent[part] };
    parent = parent[part];
  }
  if (!table(parent)) throw new TomlWritebackError("TOML_DELETE_MISSING", `Missing table: ${path.join(".")}`);
  delete parent[path.at(-1)];
}

function parseHeader(header) {
  const parts = [];
  const body = header.replace(/^\[\[?/, "").replace(/\]\]?$/, "");
  const re = /(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\.|$)/g;
  let match;
  let end = 0;
  while ((match = re.exec(body))) {
    if (match.index !== end) return null;
    const value = match[0].replace(/\.$/, "");
    parts.push(value[0] === '"' ? JSON.parse(value) : value[0] === "'" ? value.slice(1, -1) : value);
    end = re.lastIndex;
  }
  return end === body.length ? parts : null;
}

// Recognize only physical headers: ignore fake headers in triple-quoted instructions
// and inside multi-line arrays. Comments attach only when immediately above a header.
function blocks(text) {
  const lines = text.split("\n");
  const headers = [];
  let triple = null;
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!triple && depth === 0) {
      const match = /^\s*(\[\[?[^\]\r\n]+\]\]?)\s*(?:#.*)?$/.exec(line);
      if (match) {
        const path = parseHeader(match[1]);
        if (path) headers.push({ index, path, array: match[1].startsWith("[[") });
      }
    }
    let quote = null;
    for (let at = 0; at < line.length; at += 1) {
      if (triple) {
        if (line.startsWith(triple, at)) { at += 2; triple = null; }
        continue;
      }
      if (quote) {
        if (quote === '"' && line[at] === "\\") { at++; continue; }
        if (line[at] === quote) quote = null;
        continue;
      }
      if (line[at] === "#") break;
      if (line.startsWith('"""', at) || line.startsWith("'''", at)) {
        triple = line.slice(at, at + 3);
        at += 2;
      } else if (line[at] === '"' || line[at] === "'") quote = line[at];
      else if (line[at] === "[") depth++;
      else if (line[at] === "]") depth = Math.max(0, depth - 1);
    }
  }
  return headers.map((item, index) => {
    let start = item.index;
    while (start > 0 && /^\s*#/.test(lines[start - 1])) start--;
    const next = headers[index + 1];
    let end = next?.index ?? lines.length;
    if (next) while (end > 0 && /^\s*#/.test(lines[end - 1])) end--;
    return { ...item, start, end };
  });
}

function atPath(object, path) {
  return path.reduce((value, key) => value?.[key], object);
}

function pathsOfTables(data, prefix = []) {
  const paths = [];
  if (!table(data)) return paths;
  for (const [key, value] of Object.entries(data)) {
    const path = [...prefix, key];
    if (table(value)) {
      paths.push(path);
      paths.push(...pathsOfTables(value, path));
    }
  }
  return paths;
}

function header(path) {
  return `[${path.map((key) => /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)).join(".")}]`;
}

function renderNewTable(path, value) {
  let result = `${header(path)}\n`;
  for (const [key, entry] of Object.entries(value)) {
    if (table(entry)) continue;
    // String lists use the compact style patched arrays keep: ["a", "b"].
    if (Array.isArray(entry) && entry.every((item) => typeof item === "string") && /^[A-Za-z0-9_-]+$/.test(key)) {
      result += `${key} = [${entry.map((item) => JSON.stringify(item)).join(", ")}]\n`;
      continue;
    }
    // stringify one key at a time so arrays of inline tables stay arrays.
    result += `${stringify({ [key]: entry }).trimEnd()}\n`;
  }
  return result;
}

function patchSafe(text, data, file) {
  const warnings = [];
  const previous = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  let output;
  try { output = patch(text, data, { updateOrder: true }); }
  finally { console.warn = previous; }
  // The sole tolerated warning is mixed-line-ending normalization. Normalize
  // first, then patch without that warning; any remaining warning is fatal.
  if (warnings.length) throw new TomlWritebackError("TOML_PATCH_WARNING", `${file}: ${warnings.join("; ")}`, { file });
  return output;
}

/** Return a candidate only; the caller performs semantic validation, CAS and atomic writes.
 * editIdentity: {file, deletedPaths?: string[][], rootAnchor?: string}. targetData is an
 * editable projection; omitted unknown fields survive, deletions must be explicit.
 */
export function patchDocument(originalText, targetData, editIdentity = {}) {
  const file = editIdentity.file ?? "TOML";
  const original = parse(originalText, file);
  let target = merge(original, targetData);
  for (const path of editIdentity.deletedPaths ?? []) deletePath(target, path);
  target = hoistNewRootValues(original, target, editIdentity.rootAnchor);
  let text = originalText.replace(/\r\n?/g, "\n");
  // Whole table removal is performed outside the library: it otherwise swallows
  // the following table's attached comments or leaves orphan comments behind.
  const physical = blocks(text);
  const originalPickIds = new Set((original.picks ?? []).map((item) => item.id));
  const targetPickIds = new Set((target.picks ?? []).map((item) => item.id));
  const pickBlocks = physical.filter((block) => block.array && same(block.path, ["picks"]));
  const removedPickIds = new Set([...originalPickIds].filter((id) => !targetPickIds.has(id)));
  const removed = physical.filter((block) => !block.array && atPath(original, block.path) !== undefined
    && atPath(target, block.path) === undefined);
  for (const block of pickBlocks) {
    const rows = text.split("\n");
    const snippet = `${rows.slice(block.index, block.end).join("\n")}\n`;
    const id = parse(snippet, file).picks?.[0]?.id;
    if (removedPickIds.has(id)) removed.push(block);
  }
  for (const block of removed.sort((a, b) => b.start - a.start)) {
    const rows = text.split("\n");
    rows.splice(block.start, block.end - block.start);
    text = rows.join("\n");
  }
  const additions = pathsOfTables(target).filter((path) => atPath(original, path) === undefined
    && Object.values(atPath(target, path)).some((entry) => !table(entry)));
  for (const path of additions) {
    const entries = blocks(text);
    // Insert after the last block under the longest shared ancestor path, so peers
    // stay together and a parent table precedes its new children; else append.
    let anchor;
    for (let depth = path.length - 1; depth > 0 && !anchor; depth -= 1) {
      const prefix = path.slice(0, depth);
      anchor = entries.filter((entry) => !entry.array && prefix.every((part, index) => entry.path[index] === part)).at(-1);
    }
    const rows = text.split("\n");
    const place = anchor ? anchor.end : rows.at(-1) === "" ? rows.length - 1 : rows.length;
    const insertion = renderNewTable(path, atPath(target, path)).trimEnd().split("\n");
    rows.splice(place, 0, ...(place && rows[place - 1]?.trim() ? [""] : []), ...insertion, "");
    text = rows.join("\n");
  }
  const newPicks = (target.picks ?? []).filter((pick) => !originalPickIds.has(pick.id));
  for (const pick of newPicks) {
    const rows = text.split("\n");
    const entries = blocks(text).filter((block) => block.array && same(block.path, ["picks"]));
    const place = entries.at(-1)?.end ?? rows.length;
    const serialized = Object.entries(pick).map(([key, value]) => stringify({ [key]: value }).trimEnd());
    rows.splice(place, 0, ...(place && rows[place - 1]?.trim() ? [""] : []), "[[picks]]", ...serialized, "");
    text = rows.join("\n");
  }
  return patchSafe(text, target, file).replace(/\r\n?/g, "\n");
}
