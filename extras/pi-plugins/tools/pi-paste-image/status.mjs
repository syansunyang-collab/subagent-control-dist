#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length > 2) {
  process.stderr.write("Usage: node tools/pi-paste-image/status.mjs\n");
  process.exitCode = 1;
} else {
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "paste-image.ts");
  const installed = path.join(homedir(), ".pi", "agent", "extensions", "paste-image.ts");
  const sha256 = (file) => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
  const sourceHash = sha256(source);
  const installedHash = sha256(installed);
  const match = Boolean(sourceHash && sourceHash === installedHash);
  process.stdout.write(`${JSON.stringify({ source, installed, sourceHash, installedHash, match })}\n`);
  if (match) process.stdout.write("PASTE_IMAGE_OK\n");
  process.exitCode = match ? 0 : 1;
}
