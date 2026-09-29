#!/usr/bin/env node
// ops/tools/fleet_manifest_check.py 的 CLI 同形复刻：flag 集合、互斥组、默认值与 main() 分支顺序一致，
// 退出码经 dispatch-core/_tool_common.mjs 的 emit()。校验逻辑全在 dispatch-core/fleet_manifest_check.mjs。
import process from "node:process";

import { ToolError, emit, rel } from "./dispatch-core/_tool_common.mjs";
import { exampleManifest, loadManifest, manifestSchema, validateManifest } from "./dispatch-core/fleet_manifest_check.mjs";
import { selfTest } from "./fleet_manifest_check.selftest.mjs";

const PROGRAM = "fleet_manifest_check.mjs";

const USAGE = `usage: ${PROGRAM} [-h] [--manifest MANIFEST | --schema | --example | --self-test]
                               [--format {text,json}]`;

function argparseError(message) {
  process.stderr.write(`${USAGE}\n${PROGRAM}: error: ${message}\n`);
  process.exit(2);
}

// argparse 的互斥组：--manifest / --schema / --example / --self-test 至多一个。

function parseArgs(argv) {
  const args = { manifest: null, schema: false, example: false, self_test: false, format: "text" };
  let chosen = null;
  const choose = (name) => {
    if (chosen && chosen !== name) argparseError(`argument ${name}: not allowed with argument ${chosen}`);
    chosen = name;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "-h" || token === "--help") {
      process.stdout.write(`${USAGE}\n\nValidate a fleet dispatch manifest before any subagent is submitted.\n`);
      process.exit(0);
    }
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq > 0 ? token.slice(0, eq) : token;
    const inlineValue = token.startsWith("--") && eq > 0 ? token.slice(eq + 1) : null;
    const takesValue = name === "--manifest" || name === "--format";
    if (!takesValue && !["--schema", "--example", "--self-test"].includes(name)) {
      argparseError(`unrecognized arguments: ${token}`);
    }
    if (!takesValue) {
      if (inlineValue !== null) argparseError(`argument ${name}: ignored explicit argument '${inlineValue}'`);
      choose(name);
      args[name === "--schema" ? "schema" : name === "--example" ? "example" : "self_test"] = true;
      continue;
    }
    let value = inlineValue;
    if (value === null) {
      index += 1;
      if (index >= argv.length) argparseError(`argument ${name}: expected one argument`);
      value = String(argv[index]);
    }
    if (name === "--format") {
      if (!["text", "json"].includes(value)) {
        argparseError(`argument --format: invalid choice: '${value}' (choose from 'text', 'json')`);
      }
      args.format = value;
      continue;
    }
    choose(name);
    args.manifest = value;
  }
  return args;
}

function jsonDumpsIndent2(value) {
  return JSON.stringify(value, null, 2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.schema) {
      const data = manifestSchema();
      return emit(data, args.format, jsonDumpsIndent2(data));
    }
    if (args.example) {
      const data = exampleManifest();
      return emit(data, args.format, jsonDumpsIndent2(data));
    }
    if (args.self_test) {
      const data = selfTest();
      const text = `fleet_manifest_check self-test ${data.status}`;
      return emit(data, args.format, text);
    }
    if (!args.manifest) {
      throw new ToolError("one of --manifest, --schema, --example or --self-test is required");
    }
    const data = validateManifest(loadManifest(args.manifest));
    data.manifest_path = rel(args.manifest);
    const text = data.status === "ok"
      ? `fleet manifest ok: ${data.nodes.length} nodes, ${data.layers.length} layers`
      : `fleet manifest failed:\n${data.errors.map((item) => `- ${item}`).join("\n")}`;
    return emit(data, args.format, text);
  } catch (error) {
    if (error?.name !== "ToolError") throw error;
    return emit({ status: "failed", error: String(error.message) }, args.format, `failed: ${error.message}`);
  }
}

process.exitCode = main();
