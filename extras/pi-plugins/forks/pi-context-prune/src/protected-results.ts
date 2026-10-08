import { posix } from "node:path";

function readPath(call: any): string | undefined {
  if ((call?.toolName ?? call?.name) !== "read") return undefined;
  const path = (call.args ?? call.input ?? call.arguments)?.path;
  if (typeof path !== "string") return undefined;
  return posix.normalize(path.replace(/\\/g, "/")).toLowerCase();
}

/** Include custom skill locations outside the conventional skills/ trees. */
export function skillDirectories(calls: Iterable<any>): string[] {
  const directories = new Set<string>();
  for (const call of calls) {
    const path = readPath(call);
    if (path && posix.basename(path) === "skill.md") directories.add(posix.dirname(path));
  }
  return [...directories];
}

export function assistantToolCalls(messages: any[]): any[] {
  return messages
    .filter((message) => message?.role === "assistant")
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block?.type === "toolCall");
}

/** Images cannot survive the text index; skill instructions must remain verbatim. */
export function isProtectedToolResult(result: any, call: any, directories: string[] = []): boolean {
  if (Array.isArray(result?.content) && result.content.some((block: any) => block?.type === "image")) {
    return true;
  }
  const path = readPath(call);
  if (!path) return false;
  return posix.basename(path) === "skill.md"
    || /(^|\/)skills\//.test(path)
    || directories.some((directory) => path.startsWith(`${directory}/`) || (directory === "." && !path.startsWith("/") && !path.startsWith("../") && !/^[a-z]:/.test(path)));
}
