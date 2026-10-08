/**
 * Fetched copies of a file that the same batch also reads locally are withheld from the
 * summarizer. Given the upstream version and a partial local read of the same file, the
 * summarizer fills the local gaps from the upstream text and states the result as a fact
 * about the local file (see notes/verify/prune-summary-provenance-20260923.md). The fetch
 * stays retrievable by id; only its text is kept out of the summary. A fetch is a copy when
 * its URL path ends with the local path over at least three segments, or over a shorter tail
 * when the fetched text also repeats lines the batch saw locally; another project's
 * README.md or src/index.ts is not.
 */

const LOCAL_FILE_TOOLS = new Set(["read", "grep", "edit", "write"]);
/** A shared path tail this long names the same file on its own (crates/printer/src/summary.rs). */
const STRONG_PATH_SEGMENTS = 3;
/** Shorter tails (README.md, src/index.ts) also need the fetched text to repeat the local lines. */
const MIN_SHARED_LINES = 3;
const MIN_SHARED_SHARE = 0.2;
const GREP_LINE_PREFIX = /^\S*?[:-]\d+[:-] ?/;

type BatchCall = { toolName: string; args: unknown; resultText?: string };

export const WITHHELD_EXTERNAL_COPY = (chars: number) =>
  `[external content not shown: ${chars} chars; the assistant can fetch the original by id]`;

function segments(path: string): string[] {
  return path.replace(/\\/g, "/").toLowerCase().split("/").filter((part) => part && part !== ".");
}

function urlSegments(url: string): string[] | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return segments(decodeURIComponent(parsed.pathname));
  } catch {
    return undefined;
  }
}

function sharedTail(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function strings(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out);
  return out;
}

/** Trimmed lines long enough to identify a file's content. */
function contentLines(text: string, grep = false): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = (grep ? raw.replace(GREP_LINE_PREFIX, "") : raw).trim();
    if (line.length >= 12 && /[A-Za-z]/.test(line)) out.add(line);
  }
  return out;
}

/** What the batch saw of a local file: read and grep output, or the text an edit or write put there. */
function localContent(call: BatchCall): Set<string> {
  if (call.toolName === "read" || call.toolName === "grep") return contentLines(call.resultText ?? "", call.toolName === "grep");
  const { path: _path, ...rest } = (call.args ?? {}) as Record<string, unknown>;
  return contentLines(strings(rest, []).join("\n"));
}

function sharesContent(local: Set<string>, remote: Set<string>): boolean {
  let shared = 0;
  for (const line of local) if (remote.has(line)) shared++;
  return shared >= MIN_SHARED_LINES && shared >= MIN_SHARED_SHARE * Math.min(local.size, remote.size);
}

/** Indexes of calls whose URL names a file that another call in the batch reads, greps or edits locally. */
export function externalCopyIndexes(calls: readonly BatchCall[]): Set<number> {
  const local: { parts: string[]; call: BatchCall }[] = [];
  for (const call of calls) {
    const path = (call.args as { path?: unknown } | null)?.path;
    if (LOCAL_FILE_TOOLS.has(call.toolName) && typeof path === "string" && path) local.push({ parts: segments(path), call });
  }
  const out = new Set<number>();
  if (local.length === 0) return out;
  calls.forEach((call, index) => {
    const url = (call.args as { url?: unknown } | null)?.url;
    if (typeof url !== "string") return;
    const remote = urlSegments(url);
    if (!remote) return;
    let remoteLines: Set<string> | undefined;
    const sameFile = ({ parts, call: localCall }: (typeof local)[number]) => {
      const tail = sharedTail(parts, remote);
      if (tail === 0 || tail < Math.min(2, parts.length)) return false;
      if (tail >= STRONG_PATH_SEGMENTS) return true;
      remoteLines ??= contentLines(call.resultText ?? "");
      return sharesContent(localContent(localCall), remoteLines);
    };
    if (local.some(sameFile)) out.add(index);
  });
  return out;
}
