import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import controlDelegateExtension, { resolveDefaultCoreOptions } from "./extension.mjs";
import { createAgentPanelEnsurer, createDispatchPrepareCompiler } from "./dispatch-prepare-tool.mjs";
import {
  isInsideRuntimeRoot,
  resolveRealPath,
  resolveSessionRootContract,
  rootContractError,
} from "./consumer-root.mjs";
import { createFleetCore } from "../../../ops/tools/fleet-tools-core.mjs";

const PROJECT_ENTRY_SEGMENTS = [".pi", "extensions", "control-delegate.ts"];
const WRITE_TOOL_NAMES = ["write", "edit"];

export function normalizeProjectPath(value) {
  const resolved = resolveRealPath(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function normalizedSessionCwd(value) {
  // 会话目录不可解析时按"不在白名单"处理：不能因为别的工程让 session_start 抛错。
  try {
    return normalizeProjectPath(value);
  } catch {
    return null;
  }
}

function toolPathInput(value, projectRoot) {
  const text = String(value ?? "").replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").trim();
  if (!text) return null;
  if (text === "~") return os.homedir();
  if (text.startsWith("~/") || (process.platform === "win32" && text.startsWith("~\\"))) {
    return path.join(os.homedir(), text.slice(2));
  }
  return path.isAbsolute(text) ? text : path.join(projectRoot, text);
}

// 父会话写域守卫：常规 write/edit 经 realpath 归一到真实祖先后，拒绝落入只读运行包。
// 这不是 shell 沙箱；bash 等命令面仍由各自工具契约约束。
export function guardRuntimeRootWrite(event, projectRoot, runtimeRoot) {
  const toolName = String(event?.toolName ?? event?.name ?? "");
  if (!WRITE_TOOL_NAMES.includes(toolName)) return null;
  if (!runtimeRoot) return null;
  const rawPath = event?.input && typeof event.input === "object" ? event.input.path : undefined;
  const target = toolPathInput(rawPath, projectRoot);
  if (!target) return null;
  const resolved = resolveRealPath(target);
  if (!isInsideRuntimeRoot(resolved, runtimeRoot)) return null;
  return {
    block: true,
    reason: [
      `write domain violation: ${toolName} target ${rawPath ?? "(missing path)"} resolves inside the read-only shared runtime package.`,
      "Shared runtime assets are injected read-only; create project-local copies instead.",
      "Do not retry the same path through another tool or a link.",
    ].join(" "),
  };
}

// 工厂期拿不到会话工程目录（ExtensionAPI 无 cwd 字段），进程 cwd 在常驻宿主里恒为宿主目录。
// 白名单判定与装配一律推迟到 session_start，用 ctx.cwd 作唯一工程来源。
export function createSessionBoundControl(pi, config = {}, extensionOptions = {}) {
  const deploymentIdentity = String(config.build_id ?? "").trim();
  const devRuntimeRoot = extensionOptions.devRuntimeRoot
    ?? path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  let runtime;
  let boundCwd = null;
  let assemblyError = null;
  let contract = null;

  const assemble = async (event, ctx) => {
    const cwd = normalizedSessionCwd(ctx?.cwd);
    if (cwd === null) return;
    let resolvedContract;
    try {
      resolvedContract = resolveSessionRootContract({
        cwd,
        config,
        options: extensionOptions,
        devRuntimeRoot,
      });
    } catch (error) {
      // 无效 marker / 不受信根 / 身份不匹配：fail closed，不装配、不回落到开发分支。
      assemblyError = error;
      try {
        ctx?.ui?.notify?.(`Subagent Control is disabled: ${error.message}`, "error");
      } catch {
        // 通知失败不改变 fail closed 结论。
      }
      return;
    }
    if (resolvedContract.mode === "excluded") return;
    if (
      config.skip_when_project_extension_exists !== false
      && existsSync(path.join(cwd, ...PROJECT_ENTRY_SEGMENTS))
    ) return;
    const roots = {
      mode: resolvedContract.mode,
      projectRoot: resolvedContract.projectRoot,
      runtimeRoot: resolvedContract.runtimeRoot,
      manifest: resolvedContract.mode === "consumer"
        ? { entrypoints: resolvedContract.entrypoints, files: resolvedContract.files }
        : null,
    };
    const assembled = controlDelegateExtension(pi, {
      ...roots,
      dispatchCompiler: extensionOptions.dispatchCompiler
        ?? createDispatchPrepareCompiler({ ...roots, cwd: resolvedContract.projectRoot }),
      agentPanelEnsurer: extensionOptions.agentPanelEnsurer
        ?? createAgentPanelEnsurer({ ...roots, cwd: resolvedContract.projectRoot }),
      fleetCore: extensionOptions.fleetCore
        ?? createFleetCore({ ...roots, cwd: resolvedContract.projectRoot }),
      ...extensionOptions,
      asyncServiceOptions: {
        ...(extensionOptions.asyncServiceOptions ?? {}),
        coreOptions: resolveDefaultCoreOptions({
          ...roots,
          cwd: resolvedContract.projectRoot,
          env: extensionOptions.env ?? process.env,
          home: extensionOptions.home ?? os.homedir(),
        }),
      },
    });
    runtime = assembled;
    boundCwd = resolvedContract.projectRoot;
    contract = resolvedContract;
    // 保护实际运行包及安装链接指向的共享包；维护仓同根源码仍可编辑。
    const sharedRoots = [...new Set([resolvedContract.runtimeRoot, resolvedContract.marker?.runtime_root]
      .filter(Boolean).map(normalizeProjectPath))]
      .filter((root) => root !== normalizeProjectPath(resolvedContract.projectRoot));
    if (sharedRoots.length) {
      pi.on?.("tool_call", (toolEvent) => {
        for (const root of sharedRoots) {
          const verdict = guardRuntimeRootWrite(toolEvent, resolvedContract.projectRoot, root);
          if (verdict) return verdict;
        }
        return undefined;
      });
    }
    // 内层 session_start 处理器是在本次事件分发中新注册的，本次分发不会带上它。
    await assembled.startSession?.(event, ctx);
  };

  if (deploymentIdentity) {
    pi.registerCommand("control-deployment-info", {
      description: "Show the active Subagent Control deployment identity",
      handler: async (_args, ctx) => {
        const build = contract?.runtimeBuildId || deploymentIdentity;
        const installed = contract?.followsPublished ? `\n安装记录：${contract.marker.build_id}` : "";
        ctx.ui.notify(`Subagent Control ${build} · ${boundCwd ?? ctx.cwd}\n运行根：${contract?.runtimeRoot ?? "未绑定"}${installed}`, "info");
      },
    });
  }

  pi.on("session_start", async (event, ctx) => {
    if (runtime) return;
    await assemble(event, ctx);
  });

  return {
    get runtime() { return runtime; },
    get cwd() { return boundCwd; },
    get contract() { return contract; },
    get assemblyError() { return assemblyError; },
  };
}

export { rootContractError };
export default createSessionBoundControl;
