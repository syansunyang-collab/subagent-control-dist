from __future__ import annotations

import sys
from typing import Any

from .ids import extract_monitor_id, extract_monitor_id_from_tool_input
from .settings import MAX_INPUT, MAX_OUTPUT
from .text_utils import clip

sys.dont_write_bytecode = True

def classify_error(tool_response: Any) -> bool:
    text = clip(tool_response, 3000).lower()
    signals = [
        "traceback",
        "exception",
        "error:",
        "failed",
        "fatal:",
        "permission denied",
        "timed out",
        "timeout",
        '"exit_code": 1',
        '"exit_code": 2',
        '"status": "failed"',
    ]
    return any(signal in text for signal in signals)

def summarize(event: dict[str, Any]) -> tuple[str, str, str, str]:
    hook = event.get("hook_event_name", "")
    tool = event.get("tool_name", "")

    if hook == "SessionStart":
        source = event.get("source", "")
        return "session_started", tool, "", f"session started source={source}"

    if hook == "UserPromptSubmit":
        prompt = event.get("prompt", "")
        monitor_id = extract_monitor_id(prompt)
        summary = "prompt submitted"
        if monitor_id:
            summary += f" monitor_id={monitor_id}"
        summary += f" prompt={clip(prompt, 260)}"
        return "prompted", tool, monitor_id, summary

    if hook == "PreToolUse":
        tool_input = event.get("tool_input", {})
        if isinstance(tool_input, dict):
            command = tool_input.get("command") or clip(tool_input, MAX_INPUT)
        else:
            command = clip(tool_input, MAX_INPUT)
        monitor_id = extract_monitor_id_from_tool_input(tool_input)
        return "running_tool", tool, monitor_id, f"running {tool}: {clip(command, 280)}"

    if hook == "PermissionRequest":
        tool_input = event.get("tool_input", {})
        monitor_id = extract_monitor_id_from_tool_input(tool_input)
        summary = f"waiting approval for {tool}: {clip(tool_input, 280)}"
        return "waiting_approval", tool, monitor_id, summary

    if hook == "PostToolUse":
        monitor_id = extract_monitor_id_from_tool_input(event.get("tool_input", {}))
        tool_response = event.get("tool_response", {})
        is_error = classify_error(tool_response)
        state = "tool_error" if is_error else "tool_done"
        outcome = "error" if is_error else "done"
        return state, tool, monitor_id, f"{tool} {outcome}: {clip(tool_response, MAX_OUTPUT)}"

    if hook == "SubagentStart":
        agent_type = event.get("agent_type", "")
        agent_id = event.get("agent_id", "")
        return "subagent_started", tool, "", f"subagent started type={agent_type} id={clip(agent_id, 120)}"

    if hook in {"Stop", "SubagentStop"}:
        message = event.get("last_assistant_message") or ""
        agent_type = event.get("agent_type", "")
        if hook == "SubagentStop":
            return "subagent_stopped", tool, "", f"subagent stopped type={agent_type}: {clip(message, 320)}"
        return "stopped", tool, "", f"turn stopped: {clip(message, 320)}"

    return "seen", tool, "", f"event={hook}"

def compact_payload(event: dict[str, Any]) -> dict[str, Any]:
    tool_input = event.get("tool_input", {})
    tool_response = event.get("tool_response", {})
    return {
        "session_id": event.get("session_id", ""),
        "turn_id": event.get("turn_id", ""),
        "cwd": event.get("cwd", ""),
        "hook_event_name": event.get("hook_event_name", ""),
        "model": event.get("model", ""),
        "tool_name": event.get("tool_name", ""),
        "tool_use_id": event.get("tool_use_id", ""),
        "source": event.get("source", ""),
        "tool_input": clip(tool_input, 1200),
        "tool_response_summary": clip(tool_response, 1600),
        "tool_response_bytes": len(clip(tool_response, 1000000).encode("utf-8", errors="replace")),
    }
