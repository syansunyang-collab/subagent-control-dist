#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  process.stdout.write("Usage: npm --prefix ops run build:subagent [-- --dist-dir <目录>]\n");
  process.exit(0);
}
let distDirOverride = null;
for (let index = 0; index < cliArgs.length; index += 1) {
  const arg = cliArgs[index];
  if (arg === "--dist-dir") {
    distDirOverride = cliArgs[index + 1];
    if (!distDirOverride) {
      process.stderr.write("--dist-dir requires a value\n");
      process.exit(2);
    }
    index += 1;
    continue;
  }
  process.stderr.write(`Unknown argument: ${arg}\n`);
  process.exit(2);
}

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const opsDir = path.dirname(toolsDir);
const distDir = distDirOverride ? path.resolve(distDirOverride) : path.join(opsDir, "dist");
const serverSource = path.join(toolsDir, "subagent_service.mjs");
const piRunnerSource = path.join(toolsDir, "run-pi-task.mjs");
const reviewResultExtensionSource = path.join(toolsDir, "pi_review_result_extension.mjs");
const taskResultExtensionSource = path.join(toolsDir, "pi_task_result_extension.mjs");
const writeDomainExtensionSource = path.join(toolsDir, "pi_write_domain_extension.mjs");
const workerToolsExtensionSource = path.join(toolsDir, "pi_worker_tools_extension.mjs");
const searchExtensionSource = path.join(toolsDir, "pi_search_extension.mjs");
// Pi 扩展加载器按别名提供这些模块（与宿主共用同一实例）；effect、minimatch 打进包。
const PI_HOST_PROVIDED_MODULES = ["@earendil-works/*", "@mariozechner/*", "typebox", "typebox/*", "@sinclair/typebox", "@sinclair/typebox/*"];
const commandJobsSource = path.join(toolsDir, "pi_child_command_jobs.mjs");
// 部署槽不带 ops/node_modules,handoff checker 经 dispatch-core 依赖 smol-toml,必须打包后再落地。
const handoffCheckSource = path.join(toolsDir, "subagent_handoff_check.mjs");
// CR-PACKAGE-v1：消费者运行包按名解析的独立 bundle。入口与 dist artifact manifest 一致,
// 不再要求消费者把 ops/tools 源码树或 node_modules 装进项目。
const consumerBundles = [
  ["dispatch_prepare_bundle", "dispatch_prepare.mjs", "dispatch_prepare.bundle.mjs"],
  ["delegate_work_selection_bundle", "delegate_work_selection.mjs", "delegate_work_selection.bundle.mjs"],
  ["transient_retry_extension_bundle", "pi_transient_retry.mjs", "pi_transient_retry.bundle.mjs"],
  ["agent_panel_launcher_bundle", "agent_panel_launcher.mjs", "agent_panel_launcher.bundle.mjs"],
  ["fleet_scheduler_bundle", "fleet_scheduler.mjs", "fleet_scheduler.bundle.mjs"],
  ["fleet_manifest_check_bundle", "fleet_manifest_check.mjs", "fleet_manifest_check.bundle.mjs"],
  ["task_package_build_bundle", "task_package_build.mjs", "task_package_build.bundle.mjs"],
  ["task_package_lint_bundle", "task_package_lint.mjs", "task_package_lint.bundle.mjs"],
  ["subagent_preload_bundle", "subagent_preload.mjs", "subagent_preload.bundle.mjs"],
  ["review_evidence_bundle", "review_evidence.mjs", "review_evidence.bundle.mjs"],
  ["runtime_retention_bundle", "runtime_retention.mjs", "runtime_retention.bundle.mjs"],
];
const panelBundles = [
  ["agent_panel_server_bundle", "index.mjs", "agent_panel_server.bundle.mjs"],
  ["agent_panel_aggregation_worker_bundle", "aggregation-worker.mjs", "agent_panel_aggregation_worker.bundle.mjs"],
  ["agent_panel_config_worker_bundle", "config-worker.mjs", "agent_panel_config_worker.bundle.mjs"],
];
const {
  DISPATCH_ENVELOPE_VERSION,
  PUBLIC_TOOL_NAMES,
  SUPPORTED_DISPATCH_ENVELOPE_VERSIONS,
} = await import(pathToFileURL(serverSource).href);

function atomicWrite(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function packageInfoForInput(inputPath) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = inputPath.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const relative = inputPath.slice(markerIndex + marker.length).split(path.sep);
  const packageParts = relative[0]?.startsWith("@") ? relative.slice(0, 2) : relative.slice(0, 1);
  const packageDir = path.join(inputPath.slice(0, markerIndex + marker.length), ...packageParts);
  const packageFile = path.join(packageDir, "package.json");
  if (!existsSync(packageFile)) return null;
  const data = JSON.parse(readFileSync(packageFile, "utf8"));
  return {
    name: String(data.name || packageParts.join("/")),
    version: String(data.version || "unknown"),
    license: String(data.license || "unknown"),
    package_dir: packageDir,
  };
}

function licenseText(info) {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md"]) {
    const candidate = path.join(info.package_dir, name);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8").trim();
  }
  return "License text not found in the installed package.";
}

mkdirSync(distDir, { recursive: true });
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  logLevel: "silent",
};

const bundles = [
  { oneOff: serverSource, file: "subagent_service.bundle.mjs" },
  { oneOff: piRunnerSource, file: "run-pi-task.bundle.mjs" },
  { oneOff: reviewResultExtensionSource, file: "pi_review_result_extension.bundle.mjs" },
  { oneOff: taskResultExtensionSource, file: "pi_task_result_extension.bundle.mjs" },
  { oneOff: writeDomainExtensionSource, file: "pi_write_domain_extension.bundle.mjs" },
  { oneOff: workerToolsExtensionSource, file: "pi_worker_tools_extension.bundle.mjs" },
  { oneOff: searchExtensionSource, file: "pi_search_extension.bundle.mjs", external: PI_HOST_PROVIDED_MODULES },
  { oneOff: commandJobsSource, file: "pi_child_command_jobs.bundle.mjs" },
  { oneOff: handoffCheckSource, file: "subagent_handoff_check.bundle.mjs" },
  ...consumerBundles.map(([artifact, sourceName, file]) => ({
    artifact,
    oneOff: path.join(toolsDir, sourceName),
    file,
  })),
  ...panelBundles.map(([artifact, sourceName, file]) => ({
    artifact,
    oneOff: path.join(opsDir, "..", "src", "agent-panel", "src", "server", sourceName),
    file,
    external: ["@earendil-works/pi-coding-agent"],
  })),
];
// The build id identifies this build invocation without making source bytes a deployment gate.
const buildId = randomBytes(8).toString("hex");
const builds = [];
for (const item of bundles) {
  const temporary = path.join(distDir, `${item.file.replace(/\.mjs$/, "")}.${process.pid}.tmp.mjs`);
  const options = { ...common, entryPoints: [item.oneOff], outfile: temporary, external: item.external };
  if (item.file === "subagent_service.bundle.mjs") {
    options.define = { __SUBAGENT_BUILD_ID__: JSON.stringify(buildId) };
    // 发布槽复用 MCP 入口提供面板 import API，同时保留入口自身的 worker CLI。
    delete options.entryPoints;
    options.stdin = {
      contents: 'export * from "./subagent_service.mjs"; export { createAsyncTaskCore } from "./async-core/index.mjs";',
      resolveDir: toolsDir,
      sourcefile: "subagent-service-entry.mjs",
      loader: "js",
    };
  }
  const result = await build(options);
  builds.push({ ...item, temporary, result });
}
for (const item of builds) {
  const final = path.join(distDir, item.file);
  rmSync(final, { force: true });
  renameSync(item.temporary, final);
}

const packages = new Map();
for (const item of builds) {
  for (const input of Object.keys(item.result.metafile.inputs)) {
    const info = packageInfoForInput(path.resolve(input));
    if (info) packages.set(`${info.name}@${info.version}`, info);
  }
}
const esbuildInfo = packageInfoForInput(path.join(opsDir, "node_modules", "esbuild", "lib", "main.js"));
if (esbuildInfo) packages.set(`${esbuildInfo.name}@${esbuildInfo.version}`, esbuildInfo);
const packageList = [...packages.values()].sort((left, right) => left.name.localeCompare(right.name));
const licenses = {
  generated_at: new Date().toISOString(),
  build_id: buildId,
  packages: packageList.map(({ package_dir, ...info }) => info),
};
const licensesFile = path.join(distDir, "subagent_service.licenses.json");
atomicWrite(licensesFile, `${JSON.stringify(licenses, null, 2)}\n`);
const licenseTextFile = path.join(distDir, "THIRD_PARTY_LICENSES.txt");
atomicWrite(licenseTextFile, `${packageList.map((info) => [
  "=".repeat(80),
  `${info.name}@${info.version} (${info.license})`,
  "=".repeat(80),
  licenseText(info),
  "",
].join("\n")).join("\n")}\n${readFileSync(path.join(opsDir, "THIRD_PARTY_NOTICES.md"), "utf8")}\n`);

const artifacts = {
  server_bundle: { file: "subagent_service.bundle.mjs" },
  pi_runner_bundle: { file: "run-pi-task.bundle.mjs" },
  review_result_extension_bundle: { file: "pi_review_result_extension.bundle.mjs" },
  task_result_extension_bundle: { file: "pi_task_result_extension.bundle.mjs" },
  write_domain_extension_bundle: { file: "pi_write_domain_extension.bundle.mjs" },
  worker_tools_extension_bundle: { file: "pi_worker_tools_extension.bundle.mjs" },
  search_extension_bundle: { file: "pi_search_extension.bundle.mjs" },
  command_jobs_bundle: { file: "pi_child_command_jobs.bundle.mjs" },
  handoff_check_bundle: { file: "subagent_handoff_check.bundle.mjs" },
  licenses: { file: path.basename(licensesFile) },
  third_party_licenses: { file: path.basename(licenseTextFile) },
};
for (const [artifact, , file] of [...consumerBundles, ...panelBundles]) {
  artifacts[artifact] = { file };
}
const manifest = {
  server_name: "async-subagent",
  server_version: "1.0.0",
  contract_version: "async-task-service/v1",
  dispatch_contract_version: DISPATCH_ENVELOPE_VERSION,
  supported_dispatch_contract_versions: [...SUPPORTED_DISPATCH_ENVELOPE_VERSIONS],
  build_id: buildId,
  built_at: new Date().toISOString(),
  node_target: ">=18",
  public_tools: [...PUBLIC_TOOL_NAMES],
  dependencies: { "@modelcontextprotocol/sdk": "1.29.0", zod: "3.25.76", esbuild: "0.28.1" },
  external_runtime_extensions: {
    configured_worker_resources: { source: "Pi user configuration", selection: "role × capability whitelist", import_scope: "templates/worker-resources.json" },
  },
  artifacts,
};
const manifestFile = path.join(distDir, "subagent_service.manifest.json");
atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
