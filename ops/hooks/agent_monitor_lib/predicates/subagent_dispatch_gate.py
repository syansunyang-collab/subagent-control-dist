from __future__ import annotations

import re
import sys
from typing import Any

from ..ids import command_from_event
from ..text_utils import safe_text

sys.dont_write_bytecode = True

_DIRECT_DELIVERY_RE = re.compile(r"(^|\s)--delivery(?:\s+|=)direct(\s|$)")
_ASYNC_CLI_SUBMIT_RE = re.compile(r"subagent_service\.mjs\s+submit(\s|$)")


def subagent_dispatch_block_reason(event: dict[str, Any], flavor: str = "codex") -> str:
    if event.get("hook_event_name") != "PreToolUse":
        return ""
    tool_name = safe_text(event.get("tool_name") or event.get("tool") or "")
    normalized_tool_name = tool_name.lower()
    # Kimi 轨等价绕路面：内置 Agent/AgentSwarm 工具直发（对应 codex 的 spawn_agent）。
    # 拦截触发范围由注册侧 matcher 控制（kimi-hooks.toml），gate 内部只按 flavor 决定工具名集。
    if flavor == "kimi" and normalized_tool_name in ("agent", "agentswarm"):
        return (
            "本仓禁止使用 Agent/AgentSwarm 内置子代理工具直接派发任务。"
            "请改用 `node ops/tools/dispatch_prepare.mjs --seed-stdin --format json` 构包提交。"
        )
    if flavor == "codex" and (
        normalized_tool_name == "spawn_agent"
        or normalized_tool_name.endswith("__spawn_agent")
        or normalized_tool_name.endswith(".spawn_agent")
    ):
        return (
            "本仓禁止使用同步子代理工具直接发送任务。"
            "请改用 `node ops/tools/dispatch_prepare.mjs --seed-stdin --format json`，"
            "由 MCP async 通道提交后台任务。"
        )
    # 线程协作面（create_thread / fork_thread / send_message_to_thread）放行：
    # 同工作区或跨工作区建线程、线程自 fork、线程间对话是保留的协作能力。
    # 任务派发纪律不靠拦线程面维持——spawn_agent 门与 config.toml `[features] multi_agent = false`
    # 已封死原生子代理，执行类任务仍由 dispatch_prepare.mjs 构包走 MCP async 通道。
    # 用线程面绕过构包链派执行任务属违规使用，由规则与审计约束，不由本门硬拦。
    if normalized_tool_name != "bash":
        return ""
    command = command_from_event(event).replace("\\", "/")
    if _ASYNC_CLI_SUBMIT_RE.search(command):
        return (
            "禁止手跑 `subagent_service.mjs submit`。"
            "`submit` 只能由 MCP `subagent_submit_prepared` 接收已构包材料后执行。"
        )
    if ("dispatch_prepare.mjs" in command or "dispatch_prepare.py" in command) and _DIRECT_DELIVERY_RE.search(command):
        return (
            "禁止 `dispatch_prepare.mjs --delivery direct` 发送同步子代理。"
            "需要预览时使用 `--action preview`；需要派发时使用默认 auto/async-subagent。"
        )
    return ""
