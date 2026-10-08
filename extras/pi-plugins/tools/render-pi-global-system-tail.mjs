#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const templateDir = path.join(repoRoot, "artifacts", "templates", "pi-global-system-tail");
const defaultOutput = path.join(templateDir, "APPEND_SYSTEM.md");
const packageFiles = ["APPEND_SYSTEM.md", "global-style.md", "local-time.ts", "package.json", "README.md"];

function read(name) {
  return readFileSync(path.join(templateDir, name), "utf8").replace(/\r\n/g, "\n").trim();
}

export function composeAppendSystem() {
  return `${read("global-style.md")}\n`;
}

export function sha256File(file) {
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function deploymentPaths(agentRoot = path.join(homedir(), ".pi", "agent")) {
  return {
    templateDir,
    packageDir: path.join(agentRoot, "local-packages", "pi-global-system-tail"),
    agentAppend: path.join(agentRoot, "APPEND_SYSTEM.md"),
  };
}

export function compareDeployment(agentRoot) {
  const paths = deploymentPaths(agentRoot);
  const files = packageFiles.map((name) => ({
    name,
    template: sha256File(path.join(paths.templateDir, name)),
    package: sha256File(path.join(paths.packageDir, name)),
  }));
  const append = {
    template: sha256File(path.join(paths.templateDir, "APPEND_SYSTEM.md")),
    package: sha256File(path.join(paths.packageDir, "APPEND_SYSTEM.md")),
    agent: sha256File(paths.agentAppend),
  };
  const packageOk = files.every((row) => row.template && row.template === row.package);
  const agentOk = Boolean(append.template && append.template === append.agent);
  return { paths, files, append, ok: packageOk && agentOk };
}

export function deploymentDrift(report) {
  const lines = [];
  for (const row of report.files) {
    if (row.template !== row.package) {
      lines.push(`package drift ${row.name}: template ${row.template ?? "missing"} package ${row.package ?? "missing"}`);
    }
  }
  if (report.append.template !== report.append.agent) {
    lines.push(`agent root drift APPEND_SYSTEM.md: template ${report.append.template ?? "missing"} agent ${report.append.agent ?? "missing"}`);
  }
  return lines;
}

function usage() {
  return "Usage: node tools/render-pi-global-system-tail.mjs (--check|--write) [--output <path>] [--agent-root <path>]\n";
}

function parseArgs(argv) {
  const mode = argv.includes("--check") ? "check" : argv.includes("--write") ? "write" : null;
  if (!mode || (argv.includes("--check") && argv.includes("--write"))) throw new Error(usage().trim());
  const outputIndex = argv.indexOf("--output");
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : defaultOutput;
  const rootIndex = argv.indexOf("--agent-root");
  const agentRoot = rootIndex >= 0 ? argv[rootIndex + 1] : undefined;
  const valueIndexes = new Set([outputIndex + 1, rootIndex + 1].filter((index) => index > 0));
  const flags = new Set(["--check", "--write", "--output", "--agent-root"]);
  if (!output || (rootIndex >= 0 && !agentRoot) || argv.some((arg, index) => !flags.has(arg) && !valueIndexes.has(index))) {
    throw new Error(usage().trim());
  }
  return { mode, output: path.resolve(output), agentRoot: agentRoot ? path.resolve(agentRoot) : undefined };
}

function atomicWrite(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, file);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const { mode, output, agentRoot } = parseArgs(process.argv.slice(2));
    const expected = composeAppendSystem();
    if (mode === "write") {
      atomicWrite(output, expected);
      process.stdout.write(`wrote ${output}\n`);
    } else {
      const actual = readFileSync(output, "utf8").replace(/\r\n/g, "\n");
      if (actual !== expected) throw new Error(`generated APPEND_SYSTEM.md is stale: ${output}`);
      const report = compareDeployment(agentRoot);
      if (!report.ok) throw new Error(deploymentDrift(report).join("\n"));
      process.stdout.write(`APPEND_SYSTEM_OK ${output}\n`);
      process.stdout.write(`DEPLOYMENT_OK template=${report.append.template} package=${report.append.package} agent=${report.append.agent}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
