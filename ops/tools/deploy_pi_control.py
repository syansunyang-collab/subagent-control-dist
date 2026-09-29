#!/usr/bin/env python3
"""Build, verify, and transactionally install the user-level Pi control extension."""

from __future__ import annotations

import argparse
import posixpath
import re
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Callable

sys.dont_write_bytecode = True

from _tool_common import ROOT, ToolError, emit  # noqa: E402


DEPLOYMENT_CONTRACT = "subagent-control-pi-deployment/v1"
DEFAULT_TARGET = Path.home() / ".pi" / "agent" / "extensions" / "subagent-control"
ADAPTER_ROOT = Path("adapters/pi")
CORE_FILES = (
    Path("ops/tools/_dispatch-prepare-argv.mjs"),
    Path("ops/tools/_fs-utils.mjs"),
    # 全局默认角色/模型配置的来源解析：适配器与 runner 都按此模块读取同一份来源。
    Path("ops/tools/model_config.mjs"),
    Path("ops/tools/async-core/contracts.mjs"),
    Path("ops/tools/async-core/index.mjs"),
    Path("ops/tools/async-core/runtime.mjs"),
    Path("ops/tools/async-core/runtime/artifacts.mjs"),
    Path("ops/tools/async-core/runtime/attempt-policy.mjs"),
    Path("ops/tools/async-core/runtime/cancellation.mjs"),
    Path("ops/tools/async-core/runtime/child-attempt.mjs"),
    Path("ops/tools/async-core/runtime/claims.mjs"),
    Path("ops/tools/async-core/runtime/collection.mjs"),
    Path("ops/tools/async-core/runtime/dispatch.mjs"),
    Path("ops/tools/async-core/runtime/handoff.mjs"),
    Path("ops/tools/async-core/runtime/lifecycle.mjs"),
    Path("ops/tools/async-core/runtime/listing.mjs"),
    Path("ops/tools/async-core/runtime/notifications.mjs"),
    Path("ops/tools/async-core/runtime/process-tree.mjs"),
    Path("ops/tools/async-core/runtime/projection.mjs"),
    Path("ops/tools/async-core/runtime/registry.mjs"),
    Path("ops/tools/async-core/runtime/shared.mjs"),
    Path("ops/tools/async-core/runtime/status.mjs"),
    Path("ops/tools/async-core/runtime/submit.mjs"),
    Path("ops/tools/async-core/runtime/task-package.mjs"),
    Path("ops/tools/async-core/runtime/utilities.mjs"),
    Path("ops/tools/async-core/runtime/worker.mjs"),
    Path("ops/tools/pi_write_domain_extension.mjs"),
    Path("ops/tools/fleet-tools-core.mjs"),
    Path("ops/tools/pause-surface.mjs"),
    Path("ops/tools/task-outcome.mjs"),
    Path("ops/tools/pi_transient_retry.mjs"),
    Path("ops/tools/subagent_runtime.mjs"),
    Path("ops/tools/pi_child_bash_process_tree.mjs"),
)
# 全局默认角色/模型配置：部署槽自带一份，作为父子两端的缺省来源；项目侧只认显式覆盖声明。
GLOBAL_CONFIG_FILES = (
    Path("ops/model-notes.toml"),
)
GLOBAL_CONFIG_DIRS = (Path("ops/agents"),)
DIST_FILES = (
    Path("ops/dist/subagent_service.bundle.mjs"),
    Path("ops/dist/subagent_service.manifest.json"),
    Path("ops/dist/subagent_service.licenses.json"),
    Path("ops/dist/run-pi-task.bundle.mjs"),
    # run-pi-task 按同目录解析 child 扩展(*.bundle.mjs 名),Pi 面随 runner 一起落地。
    Path("ops/dist/pi_review_result_extension.bundle.mjs"),
    Path("ops/dist/pi_task_result_extension.bundle.mjs"),
    Path("ops/dist/pi_write_domain_extension.bundle.mjs"),
    Path("ops/dist/pi_worker_tools_extension.bundle.mjs"),
    Path("ops/dist/pi_search_extension.bundle.mjs"),
    Path("ops/dist/pi_transient_retry.bundle.mjs"),
    Path("ops/dist/pi_child_command_jobs.bundle.mjs"),
    # handoff checker 自带JS依赖；ops/node_modules只携带清单声明的原生依赖。
    Path("ops/dist/subagent_handoff_check.bundle.mjs"),
    # CR-PACKAGE-v1 消费入口 bundle:按入口名独立落地,与 dist artifact manifest 一致。
    Path("ops/dist/dispatch_prepare.bundle.mjs"),
    Path("ops/dist/agent_panel_launcher.bundle.mjs"),
    Path("ops/dist/agent_panel_server.bundle.mjs"),
    Path("ops/dist/agent_panel_aggregation_worker.bundle.mjs"),
    Path("ops/dist/agent_panel_config_worker.bundle.mjs"),
    Path("ops/dist/fleet_scheduler.bundle.mjs"),
    Path("ops/dist/fleet_manifest_check.bundle.mjs"),
    Path("ops/dist/task_package_build.bundle.mjs"),
    Path("ops/dist/task_package_lint.bundle.mjs"),
    Path("ops/dist/subagent_preload.bundle.mjs"),
    Path("ops/dist/review_evidence.bundle.mjs"),
    Path("ops/dist/runtime_retention.bundle.mjs"),
    Path("ops/dist/delegate_work_selection.bundle.mjs"),
    Path("ops/dist/THIRD_PARTY_LICENSES.txt"),
)
TEMPLATE_FILES = (
    Path("ops/templates/handoff-prompt-template.md"),
    Path("ops/templates/review-evidence-prompt-template.md"),
    Path("ops/templates/worker-system-prompt.md"),
    Path("ops/templates/worker-resources.json"),
    Path("ops/templates/planning-schema.json"),
    Path("ops/templates/acceptance-schema.json"),
)
ADAPTER_METADATA_FILES = (
    Path("adapters/pi/package.json"),
    Path("adapters/pi/package-lock.json"),
    Path("adapters/pi/README.md"),
)
ROOT_PACKAGE = {
    "name": "subagent-control-pi-extension-deployment",
    "version": "0.1.0",
    "private": True,
    "type": "module",
}


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ToolError(f"required JSON file is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ToolError(f"invalid JSON: {path}:{exc.lineno}") from exc
    if not isinstance(value, dict):
        raise ToolError(f"JSON root must be an object: {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def canonical_directory(value: str | Path, label: str, *, must_exist: bool = True) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ToolError(f"{label} must be an absolute path: {value}")
    resolved = path.resolve()
    if must_exist and not resolved.is_dir():
        raise ToolError(f"{label} is not an existing directory: {resolved}")
    return resolved


def adapter_source_files(source_root: Path) -> list[Path]:
    source_dir = source_root / ADAPTER_ROOT / "src"
    if not source_dir.is_dir():
        raise ToolError(f"Pi adapter source directory is missing: {source_dir}")
    files = sorted(path.relative_to(source_root) for path in source_dir.glob("*.mjs") if path.is_file())
    if not files:
        raise ToolError("Pi adapter source inventory is empty")
    return files


def missing_dist_artifacts(source_root: Path) -> list[str]:
    """dist artifact manifest 的每个条目都必须在部署清单里（入口与 manifest 一致）。"""
    manifest_path = source_root / "ops/dist/subagent_service.manifest.json"
    manifest = read_json(manifest_path)
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict) or not artifacts:
        raise ToolError("dist manifest declares no artifacts")
    deployed = {path.as_posix() for path in DIST_FILES}
    missing: list[str] = []
    for name, record in artifacts.items():
        if not isinstance(record, dict) or not record.get("file"):
            raise ToolError(f"dist manifest artifact is incomplete: {name}")
        relative = Path("ops/dist") / str(record["file"])
        if relative.as_posix() not in deployed:
            missing.append(f"{name} -> {relative.as_posix()}")
        elif not (source_root / relative).is_file():
            missing.append(f"{name} -> {relative.as_posix()} (missing on disk)")
    return missing


def compiler_resource_files(source_root: Path) -> list[Path]:
    """Reuse the consumer inventory for the compiler's read-only resource closure."""
    import fnmatch
    manifest = read_json(source_root / "ops/templates/consumer-release-manifest.json")
    packaged_source = (source_root / "consumer-release-manifest.json").is_file()
    files: set[Path] = set()
    for entry in manifest["files"]:
        if entry["role"] not in {"rule", "agent-config", "template", "dependency"}:
            continue
        relative = Path(entry["target"] if packaged_source else entry["source"])
        if not relative.as_posix().startswith(("ops/", "src/agent-panel/", "node_modules/")):
            continue
        if entry.get("kind") == "dir":
            directory = source_root / relative
            if not directory.is_dir():
                raise ToolError(f"compiler resource directory is missing: {relative}")
            for child in directory.rglob("*"):
                name = child.relative_to(directory).as_posix()
                if child.is_file() and not any(fnmatch.fnmatch(name, pattern) for pattern in entry.get("exclude", [])):
                    if not entry.get("include") or any(fnmatch.fnmatch(name, pattern) for pattern in entry["include"]):
                        files.add(child.relative_to(source_root))
        elif "consumer-template" not in relative.parts:
            files.add(relative)
    return sorted(files)


def required_files(source_root: Path) -> list[Path]:
    return [
        *ADAPTER_METADATA_FILES,
        *adapter_source_files(source_root),
        *CORE_FILES,
        *DIST_FILES,
        *TEMPLATE_FILES,
        *GLOBAL_CONFIG_FILES,
        *compiler_resource_files(source_root),
    ]


def git_identity(source_root: Path) -> dict[str, Any]:
    def run(*args: str) -> tuple[int, str]:
        result = subprocess.run(
            ["git", "-C", str(source_root), *args],
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        return result.returncode, result.stdout.strip()

    head_code, head = run("rev-parse", "HEAD")
    branch_code, branch = run("branch", "--show-current")
    status_code, status = run("status", "--short")
    return {
        "head": head if head_code == 0 and head else None,
        "branch": branch if branch_code == 0 and branch else None,
        "dirty": bool(status) if status_code == 0 else None,
    }


def validate_source(source_root: Path) -> dict[str, Any]:
    source_root = canonical_directory(source_root, "source root")
    missing = [str(relative) for relative in required_files(source_root) if not (source_root / relative).is_file()]
    missing.extend(
        str(relative) for relative in GLOBAL_CONFIG_DIRS if not (source_root / relative).is_dir()
    )
    if missing:
        raise ToolError("Pi deployment source is incomplete: " + ", ".join(missing))
    undeployed_artifacts = missing_dist_artifacts(source_root)
    if undeployed_artifacts:
        raise ToolError(
            "dist artifact manifest and deployment inventory disagree: " + ", ".join(undeployed_artifacts)
        )

    manifest_path = source_root / "ops/dist/subagent_service.manifest.json"
    manifest = read_json(manifest_path)
    if not str(manifest.get("build_id") or ""):
        raise ToolError("dist manifest has no build_id")

    return {
        "source_root": str(source_root),
        "build_id": str(manifest["build_id"]),
        "git": git_identity(source_root),
    }


def copy_first_party(source_root: Path, staging: Path) -> None:
    for relative in required_files(source_root):
        source = source_root / relative
        target = staging / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    # 角色目录整棵落地：部署槽缺它就会退回项目内旧 ops 副本，正是本次要消除的漂移。
    for relative in GLOBAL_CONFIG_DIRS:
        shutil.copytree(source_root / relative, staging / relative, dirs_exist_ok=True)


def extension_entry_text() -> str:
    return """import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionBoundControl } from "./adapters/pi/src/session-bound-control.mjs";

const deploymentRoot = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(deploymentRoot, "deployment.json"), "utf8"));

export default function subagentControlGlobalExtension(pi, options) {
  return createSessionBoundControl(pi, config, options);
}
"""


def npm_executable(explicit: str | None = None) -> str:
    candidate = explicit or shutil.which("npm") or shutil.which("npm.cmd")
    if not candidate:
        raise ToolError("npm executable was not found")
    return str(candidate)


def run_command(argv: list[str], cwd: Path, *, timeout: int = 600) -> dict[str, Any]:
    result = subprocess.run(
        argv,
        cwd=str(cwd),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    return {
        "argv": argv,
        "cwd": str(cwd),
        "exit_code": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
    }


def install_adapter_dependencies(staging: Path, npm_command: str | None = None) -> dict[str, Any]:
    command = [
        npm_executable(npm_command),
        "ci",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
    ]
    result = run_command(command, staging / ADAPTER_ROOT, timeout=900)
    if result["exit_code"] != 0:
        raise ToolError(f"offline adapter dependency install failed: {result['stderr'] or result['stdout']}")
    return result


def node_runtime_identity() -> dict[str, str]:
    node = shutil.which("node")
    if not node:
        raise ToolError("node executable was not found")
    probe = run_command([node, "-p", "JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch,modules:process.versions.modules})"], ROOT, timeout=30)
    if probe["exit_code"] != 0:
        raise ToolError(f"cannot inspect Node runtime: {probe['stderr']}")
    try:
        identity = json.loads(probe["stdout"])
    except ValueError as error:
        raise ToolError("Node runtime probe did not emit JSON") from error
    if not isinstance(identity, dict) or not all(isinstance(identity.get(key), str) and identity[key] for key in ("node", "platform", "arch", "modules")):
        raise ToolError("Node runtime probe returned incomplete identity")
    return identity


def can_reuse_dependencies(staging: Path, previous: Path | None, identity: dict[str, str]) -> bool:
    if previous is None or not (previous / ADAPTER_ROOT / "node_modules").is_dir():
        return False
    try:
        old = read_json(previous / "deployment.json")
        dependencies = old.get("dependency_install")
        if not isinstance(dependencies, dict) or dependencies.get("runtime") != identity:
            return False
        return all((staging / ADAPTER_ROOT / name).read_bytes() == (previous / ADAPTER_ROOT / name).read_bytes()
                   for name in ("package.json", "package-lock.json"))
    except (ToolError, OSError):
        return False


def prepare_adapter_dependencies(staging: Path, previous: Path | None, npm_command: str | None) -> dict[str, Any]:
    identity = node_runtime_identity()
    started = time.monotonic()
    if can_reuse_dependencies(staging, previous, identity):
        print("[pi] dependencies: reuse installed tree", file=sys.stderr, flush=True)
        shutil.copytree(previous / ADAPTER_ROOT / "node_modules", staging / ADAPTER_ROOT / "node_modules", symlinks=True)
        return {"mode": "reuse-copy", "performed": False, "runtime": identity,
                "duration_seconds": round(time.monotonic() - started, 3)}
    print("[pi] dependencies: npm ci --offline (no compatible installed tree)", file=sys.stderr, flush=True)
    install_adapter_dependencies(staging, npm_command)
    return {"mode": "npm-ci-offline-ignore-scripts", "performed": True, "runtime": identity,
            "duration_seconds": round(time.monotonic() - started, 3)}


def node_probe_script() -> str:
    return """import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [entry, cwd] = process.argv.slice(1);
const mod = await import(pathToFileURL(entry).href);
const options = mod.resolveDefaultCoreOptions({ cwd });
// 部署槽自带的全局角色/模型配置：解析结果必须指向本槽，而不是项目内旧 ops 副本。
const deploymentRoot = path.resolve(path.dirname(entry), '..', '..', '..');
const configMod = await import(pathToFileURL(path.join(deploymentRoot, 'ops', 'tools', 'model_config.mjs')).href);
const config = configMod.resolveModelConfigSources({
  roots: [{ root: deploymentRoot, source: 'deployment' }],
  projectRoot: cwd,
});
const checks = {
  cwd: options.cwd === cwd,
  worker: options.workerEntrypoint.endsWith('subagent_service.bundle.mjs'),
  defaultRunner: options.defaultRunnerPath.endsWith('run-pi-task.bundle.mjs'),
  piRunner: options.runnerCatalog.pi.path.endsWith('run-pi-task.bundle.mjs'),
  checkerRoot: options.handoffCheckerPolicy.rootEnvironmentKey === 'SUBAGENT_CONTROL_REPO_ROOT',
  checkerCommand: options.handoffCheckerPolicy.command === process.execPath,
  globalModelConfig: config.global_root === deploymentRoot,
};
console.log(JSON.stringify({ checks, config: {
  cwd: options.cwd,
  registryRoot: options.registryRoot,
  defaultTaskRoot: options.defaultTaskRoot,
  workerEntrypoint: options.workerEntrypoint,
  defaultRunnerPath: options.defaultRunnerPath,
  checker: options.handoffCheckerPolicy.candidates,
  model_config: config.describe(),
} }));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
"""


def wrapper_probe_script() -> str:
    return """import { pathToFileURL } from 'node:url';
const [entry, expectedText, sessionCwd] = process.argv.slice(1);
const expectedLoaded = expectedText === 'true';
const mod = await import(pathToFileURL(entry).href);
const tools = [];
const commands = [];
const handlers = new Map();
const pi = {
  registerTool(tool) { tools.push(tool.name); },
  registerCommand(name) { commands.push(name); },
  on(name, handler) { handlers.set(name, handler); },
};
// 探针只验证装配决策与注册结果,不启动常驻轮询。
const holder = mod.default(pi, { enableCompletionWatcher: false, enableFleetCompletionWatcher: false });
const ctx = { cwd: sessionCwd || process.cwd(), sessionManager: { getSessionId: () => 'deployment-probe', getBranch: () => [] } };
await handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
const loaded = Boolean(holder.runtime);
const checks = {
  loadDecision: loaded === expectedLoaded,
};
if (!expectedLoaded) checks.noToolsOutsideScope = tools.length === 0;
if (loaded && handlers.has('session_shutdown')) await handlers.get('session_shutdown')();
console.log(JSON.stringify({ loaded, tools, commands, checks }));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
"""


def check_deployment_files(deployment: Path) -> dict[str, Any]:
    deployment = canonical_directory(deployment, "deployment")
    metadata = read_json(deployment / "deployment.json")
    if metadata.get("contract_version") != DEPLOYMENT_CONTRACT:
        raise ToolError("unsupported Pi deployment contract")
    inventory = metadata.get("runtime_files")
    required = [Path("index.ts"), Path("package.json"), *(
        [Path(name) for name in inventory] if isinstance(inventory, list) and inventory else required_files(deployment)
    )]
    missing = [relative.as_posix() for relative in required if not (deployment / relative).is_file()]
    missing.extend(
        relative.as_posix() for relative in GLOBAL_CONFIG_DIRS if not (deployment / relative).is_dir()
    )
    if missing:
        raise ToolError("Pi deployment is incomplete: " + ", ".join(missing))
    allowed = metadata.get("allowed_projects")
    if not isinstance(allowed, list) or (not allowed and metadata.get("allow_any_project") is not True):
        raise ToolError("deployment requires allowed_projects or allow_any_project=true")
    for value in allowed:
        canonical_directory(value, "allowed project")
    manifest = read_json(deployment / "ops/dist/subagent_service.manifest.json")
    if metadata.get("build_id") != manifest.get("build_id"):
        raise ToolError("Pi deployment build identity does not match its manifest")
    return metadata


def verify_installed_entry(deployment: Path, *, node_command: str | None = None) -> dict[str, Any]:
    # 文件清单已在原子切换前核对；此处只验证最终安装位置的入口加载。
    metadata = read_json(deployment / "deployment.json")
    projects = [Path(value) for value in metadata["allowed_projects"]]
    local_entry = lambda project: (project / ".pi/extensions/control-delegate.ts").is_file()
    project = next((item for item in projects if not local_entry(item)), projects[0] if projects else deployment.parent)
    node = node_command or shutil.which("node")
    if not node:
        raise ToolError("node executable was not found")
    probe = run_command([
        str(node), "--input-type=module", "-e", wrapper_probe_script(), str(deployment / "index.ts"),
        "false" if local_entry(project) else "true", str(project),
    ], project, timeout=180)
    if probe["exit_code"] != 0:
        raise ToolError(f"installed Pi entry failed: {probe['stderr'] or probe['stdout']}")
    try:
        result = json.loads(probe["stdout"].strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise ToolError("installed Pi entry did not emit JSON") from exc
    checks = result.get("checks")
    if not isinstance(checks, dict) or not checks or not all(checks.values()):
        raise ToolError(f"installed Pi entry emitted failing checks: {result}")
    return {"status": "pass", "scope": "installed_entry_load", "build_id": metadata["build_id"],
            "project": str(project), "entry_probe": result}


def verify_deployment(deployment: Path, *, node_command: str | None = None) -> dict[str, Any]:
    """Explicit full-project diagnostic; not part of the normal publication transaction."""
    deployment = canonical_directory(deployment, "deployment")
    metadata = check_deployment_files(deployment)
    allowed = metadata["allowed_projects"]
    allowed_projects = [Path(value) for value in allowed]
    node = node_command or shutil.which("node")
    if not node:
        raise ToolError("node executable was not found")

    def json_probe(argv: list[str], cwd: Path, label: str) -> dict[str, Any]:
        probe = run_command(argv, cwd, timeout=180)
        if probe["exit_code"] != 0:
            raise ToolError(f"{label} failed: {probe['stderr'] or probe['stdout']}")
        try:
            value = json.loads(probe["stdout"].strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError) as exc:
            raise ToolError(f"{label} did not emit JSON") from exc
        checks = value.get("checks") if isinstance(value, dict) else None
        if not isinstance(checks, dict) or not checks or not all(checks.values()):
            raise ToolError(f"{label} emitted failing checks: {value}")
        return value

    node_probes: list[dict[str, Any]] = []
    wrapper_probes: list[dict[str, Any]] = []
    for project in allowed_projects:
        node_probes.append(json_probe(
            [
                str(node),
                "--input-type=module",
                "-e",
                node_probe_script(),
                str(deployment / "adapters/pi/src/extension.mjs"),
                str(project),
            ],
            project,
            f"deployed Pi extension config probe for {project}",
        ))
        local_entry = project / ".pi" / "extensions" / "control-delegate.ts"
        wrapper_probes.append(json_probe(
            [
                str(node),
                "--input-type=module",
                "-e",
                wrapper_probe_script(),
                str(deployment / "index.ts"),
                "false" if local_entry.is_file() else "true",
                str(project),
            ],
            project,
            f"deployed Pi wrapper probe for {project}",
        ))

    allowed_keys = {os.path.normcase(str(project)) for project in allowed_projects}
    negative_candidates = [Path(tempfile.gettempdir()).resolve(), Path.home().resolve(), deployment.parent.resolve()]
    negative_cwd = next(
        (
            candidate
            for candidate in negative_candidates
            if candidate.is_dir() and os.path.normcase(str(candidate)) not in allowed_keys
        ),
        None,
    )
    if negative_cwd is None:
        raise ToolError("no existing unallowed directory is available for the negative wrapper probe")
    unallowed_probe = json_probe(
        [
            str(node),
            "--input-type=module",
            "-e",
            wrapper_probe_script(),
            str(deployment / "index.ts"),
            "true" if metadata.get("allow_any_project") is True else "false",
            str(negative_cwd),
        ],
        negative_cwd,
        "deployed Pi wrapper negative allowlist probe",
    )
    return {
        "status": "pass",
        "contract_version": metadata["contract_version"],
        "build_id": metadata.get("build_id"),
        "deployment": str(deployment),
        "allowed_projects": allowed,
        "node_probes": node_probes,
        "wrapper_probes": wrapper_probes,
        "unallowed_probe": {"cwd": str(negative_cwd), **unallowed_probe},
    }


def build_staging(
    source_root: Path,
    staging: Path,
    *,
    allowed_projects: list[Path],
    python_executable: Path,
    npm_command: str | None = None,
    install_dependencies: bool = True,
    previous_target: Path | None = None,
    allow_any_project: bool = False,
) -> dict[str, Any]:
    source = validate_source(source_root)
    if staging.exists():
        raise ToolError(f"staging path already exists: {staging}")
    staging.mkdir(parents=True)
    copy_first_party(Path(source["source_root"]), staging)
    write_json(staging / "package.json", ROOT_PACKAGE)
    (staging / "index.ts").write_text(extension_entry_text(), encoding="utf-8")
    dependency_install = {"mode": "not_installed", "performed": False}
    if install_dependencies:
        dependency_install = prepare_adapter_dependencies(staging, previous_target, npm_command)
    metadata = {
        "contract_version": DEPLOYMENT_CONTRACT,
        "build_id": source["build_id"],
        "source": source,
        "allowed_projects": [str(path) for path in allowed_projects],
        "allow_any_project": allow_any_project,
        "python_executable": str(python_executable),
        "skip_when_project_extension_exists": True,
        "consumer_runtime_policy": "published",
        "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dependency_install": dependency_install,
        "runtime_files": sorted({item.as_posix() for item in required_files(source_root)}),
    }
    write_json(staging / "deployment.json", metadata)
    return {"source": source, "metadata": metadata, "dependency_install": dependency_install}


def backup_root(target: Path) -> Path:
    return target.parent.parent / "extension-backups" / target.name


def staging_root(target: Path) -> Path:
    return target.parent.parent / "extension-staging" / target.name


def atomic_switch(
    staging: Path,
    target: Path,
    verifier: Callable[[Path], Any],
) -> dict[str, Any]:
    target.parent.mkdir(parents=True, exist_ok=True)
    backups = backup_root(target)
    backups.mkdir(parents=True, exist_ok=True)
    backup = backups / f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.{uuid.uuid4().hex[:8]}"
    moved_old = False
    installed_new = False
    try:
        if target.exists():
            os.replace(target, backup)
            moved_old = True
        os.replace(staging, target)
        installed_new = True
        verification = verifier(target)
    except Exception as exc:
        failed = backups / f"failed.{uuid.uuid4().hex[:8]}"
        if installed_new and target.exists():
            os.replace(target, failed)
        if moved_old and backup.exists():
            os.replace(backup, target)
        if failed.exists():
            shutil.rmtree(failed, ignore_errors=True)
        raise ToolError(f"Pi deployment transaction rolled back: {exc}") from exc
    return {
        "target": str(target),
        "backup": str(backup) if moved_old else None,
        "verification": verification,
        "transaction_committed": True,
    }


def prune_backups(target: Path, keep: int = 2) -> list[str]:
    backups = sorted(
        (path for path in backup_root(target).glob("*") if not path.name.startswith("failed.")),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    removed: list[str] = []
    for backup in backups[keep:]:
        # 旧备份里的原生模块可能仍被在跑的 pi 进程占用(WinError 5):切换已提交,清理失败只记录不回滚。
        try:
            if backup.is_dir():
                shutil.rmtree(backup)
            else:
                backup.unlink(missing_ok=True)
        except OSError as exc:
            removed.append(f"{backup} (skipped: {exc.__class__.__name__}: {exc})")
            continue
        removed.append(str(backup))
    return removed


def deploy(
    source_root: Path,
    target: Path,
    *,
    allowed_projects: list[Path],
    python_executable: Path,
    npm_command: str | None = None,
    allow_any_project: bool = False,
) -> dict[str, Any]:
    target = target.expanduser().resolve()
    token = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"
    stages = staging_root(target)
    stages.mkdir(parents=True, exist_ok=True)
    staging = stages / token
    try:
        staged = build_staging(
            source_root,
            staging,
            allowed_projects=allowed_projects,
            python_executable=python_executable,
            npm_command=npm_command,
            previous_target=target,
            allow_any_project=allow_any_project,
        )
        print("[pi] staging: file inventory check", file=sys.stderr, flush=True)
        check_deployment_files(staging)
        staged_verification = {"status": "pass", "scope": "files_only"}
        print("[pi] switch: load installed entry once", file=sys.stderr, flush=True)
        transaction = atomic_switch(staging, target, verify_installed_entry)
        removed_backups = prune_backups(target)
        return {
            "status": "pass",
            "mode": "apply",
            "staged": staged,
            "staged_verification": staged_verification,
            "transaction": transaction,
            "removed_backups": removed_backups,
        }
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


RELATIVE_IMPORT_RE = re.compile(r"""from\s+["'](\.{1,2}/[^"']+)["']""")


def deployed_module_inventory(source_root: Path) -> list[Path]:
    """部署清单里会被运行时 import 的 .mjs 源文件。"""
    return [
        *(item for item in CORE_FILES if item.suffix == ".mjs"),
        *(item for item in adapter_source_files(source_root) if item.suffix == ".mjs"),
    ]


def missing_relative_imports(source_root: Path) -> list[str]:
    """清单内 .mjs 的相对 import 若指向清单外文件，返回这些引用。"""
    modules = deployed_module_inventory(source_root)
    inventory = {rel.as_posix() for rel in modules}
    missing: list[str] = []
    for rel in modules:
        text = (source_root / rel).read_text(encoding="utf-8")
        for spec in RELATIVE_IMPORT_RE.findall(text):
            target = posixpath.normpath(rel.parent.as_posix() + "/" + spec)
            if target not in inventory:
                missing.append(f"{rel.as_posix()} -> {spec}")
    return missing


def missing_entry_imports(source_root: Path) -> list[str]:
    """index.ts 的相对 import 若指向清单外文件，返回这些引用（入口按部署槽根解析）。"""
    inventory = {rel.as_posix() for rel in deployed_module_inventory(source_root)}
    missing: list[str] = []
    for spec in RELATIVE_IMPORT_RE.findall(extension_entry_text()):
        target = posixpath.normpath(spec)
        if target not in inventory:
            missing.append(f"index.ts -> {spec}")
    return missing


def self_test() -> dict[str, Any]:
    checks: dict[str, bool] = {}
    with tempfile.TemporaryDirectory(prefix="pi-control-deploy-self-test-") as raw:
        root = Path(raw)
        allowed = root / "project"
        allowed.mkdir()
        checks["relative_allowed_project_rejected"] = False
        try:
            canonical_directory("relative-project", "allowed project")
        except ToolError:
            checks["relative_allowed_project_rejected"] = True

        target = root / "extensions" / "subagent-control"
        target.mkdir(parents=True)
        (target / "old.txt").write_text("old", encoding="utf-8")
        stage = root / "extensions" / "stage-pass"
        stage.mkdir()
        (stage / "new.txt").write_text("new", encoding="utf-8")
        committed = atomic_switch(stage, target, lambda value: {"new": (value / "new.txt").is_file()})
        committed_backup = Path(str(committed["backup"]))
        checks["atomic_switch_commits_verified_candidate"] = (
            committed["transaction_committed"] is True
            and (target / "new.txt").is_file()
            and committed_backup.joinpath("old.txt").is_file()
            and committed_backup.parent == backup_root(target)
            and not any(target.parent.glob(f"{target.name}.backup.*"))
        )

        failing_target = root / "extensions" / "rollback"
        failing_target.mkdir()
        (failing_target / "old.txt").write_text("old", encoding="utf-8")
        failing_stage = root / "extensions" / "stage-fail"
        failing_stage.mkdir()
        (failing_stage / "new.txt").write_text("new", encoding="utf-8")
        try:
            atomic_switch(failing_stage, failing_target, lambda _value: (_ for _ in ()).throw(RuntimeError("probe failed")))
        except ToolError:
            checks["failed_verification_restores_previous_deployment"] = (
                (failing_target / "old.txt").read_text(encoding="utf-8") == "old"
                and not (failing_target / "new.txt").exists()
            )
        else:
            checks["failed_verification_restores_previous_deployment"] = False
        checks["transaction_artifacts_stay_outside_extension_discovery"] = (
            {path.name for path in (root / "extensions").iterdir()} == {"subagent-control", "rollback"}
            and committed_backup.parent == root / "extension-backups" / "subagent-control"
        )

        entry = extension_entry_text()
        checks["entry_is_exact_project_allowlist_gate"] = (
            "createSessionBoundControl(pi, config, options)" in entry
            and "session-bound-control.mjs" in entry
            and "deployment.json" in entry
            and "process.cwd()" not in entry
        )
        checks["deployment_inventory_has_dist_and_checker"] = (
            Path("ops/dist/subagent_service.bundle.mjs") in DIST_FILES
            and Path("ops/dist/subagent_handoff_check.bundle.mjs") in DIST_FILES
        )
        # 发布资产必须带上全局角色/模型配置与来源解析模块：缺角色目录就会退回项目内旧 ops 副本。
        checks["global_model_config_assets_are_deployed"] = (
            Path("ops/agents") in GLOBAL_CONFIG_DIRS
            and Path("ops/model-notes.toml") in GLOBAL_CONFIG_FILES
            and Path("ops/tools/model_config.mjs") in CORE_FILES
            and all((ROOT / relative).is_file() for relative in GLOBAL_CONFIG_FILES)
            and all((ROOT / relative).is_dir() for relative in GLOBAL_CONFIG_DIRS)
            and any((ROOT / Path("ops/agents")).glob("*.toml"))
        )
        # CR-PACKAGE-v1：入口 bundle 与 dist artifact manifest 逐条一致；缺一个就是具名缺口。
        checks["dist_artifact_manifest_matches_deployment_inventory"] = not missing_dist_artifacts(ROOT)
        checks["consumer_entrypoint_bundles_are_deployed"] = all(
            Path(f"ops/dist/{name}.bundle.mjs") in DIST_FILES
            for name in (
                "dispatch_prepare",
                "agent_panel_launcher",
                "fleet_scheduler",
                "fleet_manifest_check",
                "task_package_build",
                "task_package_lint",
                "subagent_preload",
                "review_evidence",
                "runtime_retention",
            )
        )
        # notes/tooling/20260910-pi-deploy-inventory-misses-runtime-import.md：
        # 清单里每个源文件的相对 import 也必须在清单里，否则部署槽装配后 import 就断。
        checks["core_file_relative_imports_are_deployed"] = not missing_relative_imports(ROOT)
        # notes/tooling/20260911-pi-web-host-extension-cwd-gate.md：
        # 生成的 index.ts 引用的模块同样要在清单里，否则部署后入口直接 import 失败。
        checks["entry_relative_imports_are_deployed"] = not missing_entry_imports(ROOT)

    return {
        "status": "ok" if all(checks.values()) else "failed",
        "checks": checks,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", default=str(ROOT))
    parser.add_argument("--target", default=str(DEFAULT_TARGET))
    parser.add_argument("--allowed-project", action="append", default=[])
    parser.add_argument("--project-scope", choices=("all", "listed"), default="listed", help="all 在所有会话项目启用；listed 仅在允许列表启用。任务权限校验不变。")
    parser.add_argument("--python", dest="python_executable", default=sys.executable)
    parser.add_argument("--npm-command")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--format", choices=("json", "text"), default="text")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if sum(bool(value) for value in (args.apply, args.verify, args.self_test)) > 1:
            raise ToolError("choose only one of --apply, --verify, or --self-test")
        if args.self_test:
            result = self_test()
            return emit(result, args.format, f"Pi deployment self-test: {result['status']}")
        target = Path(args.target).expanduser().resolve()
        if args.verify:
            result = verify_deployment(target)
            return emit(result, args.format, f"Pi deployment verified: {target}")
        source_root = canonical_directory(args.source_root, "source root")
        python_executable = Path(args.python_executable).expanduser().resolve()
        if not python_executable.is_file():
            raise ToolError(f"Python executable is missing: {python_executable}")
        allowed_projects = [canonical_directory(value, "allowed project") for value in args.allowed_project]
        if not allowed_projects and args.project_scope != "all":
            raise ToolError("listed scope requires at least one exact --allowed-project")
        if args.apply:
            result = deploy(
                source_root,
                target,
                allowed_projects=allowed_projects,
                python_executable=python_executable,
                npm_command=args.npm_command,
                allow_any_project=args.project_scope == "all",
            )
            return emit(result, args.format, f"Pi control extension deployed: {target}")
        source = validate_source(source_root)
        result = {
            "status": "ok",
            "mode": "preview",
            "source": source,
            "target": str(target),
            "allowed_projects": [str(path) for path in allowed_projects],
            "allow_any_project": args.project_scope == "all",
            "python_executable": str(python_executable),
            "dependency_install": "npm ci --offline --ignore-scripts --no-audit --no-fund",
            "writes": [],
        }
        return emit(result, args.format, f"Pi deployment preview: build={source['build_id']} target={target}")
    except (ToolError, OSError, subprocess.SubprocessError) as exc:
        return emit({"status": "failed", "error": str(exc)}, args.format, f"Pi deployment failed: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
