// Shared filesystem and input-picking helpers; async-core/runtime.mjs holds the reference semantics.

import { existsSync, mkdirSync, readFileSync } from "node:fs";

export function pick(input, keys, fallback = "") {
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== true) {
      return String(input[key]);
    }
  }
  return fallback;
}

export function pickCsv(input, keys, fallback = []) {
  const raw = pick(input, keys, "");
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  if (!existsSync(file)) {
    return fallback;
  }
  return JSON.parse(readFileSync(file, "utf8"));
}
