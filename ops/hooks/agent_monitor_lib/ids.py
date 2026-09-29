from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from .settings import MONITOR_ID_RE, ROOT, THREAD_ID_RE, MAX_INPUT
from .text_utils import clip, safe_json_dumps, safe_text

sys.dont_write_bytecode = True

def thread_id_from_path(value: Any) -> str:
    text = safe_text(value)
    if not text:
        return ""
    matches = THREAD_ID_RE.findall(text)
    return matches[-1].lower() if matches else ""

def target_thread_id_from_event(event: dict[str, Any]) -> str:
    hook = event.get("hook_event_name", "")
    common = [
        event.get("target_thread_id"),
        event.get("main_thread_id"),
        event.get("thread_id"),
        os.environ.get("CODEX_WAKE_THREAD_ID"),
        os.environ.get("CODEX_THREAD_ID"),
    ]
    if hook == "SubagentStop":
        candidates = [
            *common,
            thread_id_from_path(event.get("transcript_path")),
        ]
    else:
        candidates = [
            *common,
            event.get("session_id"),
            thread_id_from_path(event.get("transcript_path")),
        ]
    for candidate in candidates:
        value = safe_text(candidate).strip()
        if THREAD_ID_RE.fullmatch(value):
            return value.lower()
    return ""

def truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}

def is_internal_title_stop(event: dict[str, Any]) -> bool:
    if event.get("hook_event_name") != "Stop":
        return False
    message = safe_text(event.get("last_assistant_message") or "").strip()
    if not (message.startswith("{") and message.endswith("}")):
        return False
    try:
        payload = json.loads(message)
    except Exception:
        return False
    if not isinstance(payload, dict):
        return False
    return set(payload.keys()) == {"title"} and isinstance(payload.get("title"), str)

def extract_monitor_id(text: str) -> str:
    if not text:
        return ""
    patterns = [
        r"MONITOR_ID=([^\s\"'`]+)",
        r"(?m)^\s*monitor_id:\s*([^\s#]+)",
        r"(?m)^\s*package_id:\s*([^\s#]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            monitor_id = normalize_monitor_id(match.group(1))
            if monitor_id:
                return monitor_id
    return ""

def normalize_monitor_id(value: Any) -> str:
    if value is None:
        return ""
    candidate = str(value).strip().strip("\"'`").rstrip(".,;")
    if not candidate or candidate.startswith("<") or candidate.endswith(">"):
        return ""
    if "/" in candidate or "\\" in candidate:
        return ""
    if candidate.lower() in {"id", "monitor_id", "package_id", "none", "null", "unknown", "todo"}:
        return ""
    if not MONITOR_ID_RE.fullmatch(candidate):
        return ""
    return candidate

def extract_yamlish_field(text: str, field: str) -> str:
    if not text:
        return ""
    pattern = rf"(?m)^\s*{re.escape(field)}\s*:\s*([^\n#]+)"
    match = re.search(pattern, text)
    if not match:
        return ""
    value = str(match.group(1)).strip().strip("\"'`")
    return "" if value.lower() in {"null", "none", "~"} else value

def extract_final_handoff(text: str) -> str:
    if not text:
        return ""
    matches = list(re.finditer(r"(?m)^\s*FINAL_HANDOFF\s*:", text))
    if not matches:
        return ""
    return text[matches[-1].start() :].strip()

def marker_enabled(command: str, names: tuple[str, ...]) -> bool:
    if not command:
        return False
    for name in names:
        pattern = rf"(?:^|\s)(?:\$env:)?{re.escape(name)}\s*=\s*[\"']?([A-Za-z0-9_.:-]+)"
        match = re.search(pattern, command)
        if match and match.group(1).lower() in {"1", "true", "yes", "y", "blocking", "key_tool_error"}:
            return True
    return False

def command_from_event(event: dict[str, Any]) -> str:
    tool_input = event.get("tool_input", {})
    if isinstance(tool_input, dict):
        return safe_text(tool_input.get("command") or clip(tool_input, MAX_INPUT))
    return clip(tool_input, MAX_INPUT)

def extract_monitor_id_from_command(command: str) -> str:
    if not command:
        return ""
    patterns = [
        r"(?m)^\s*(?:\$env:)?MONITOR_ID\s*=\s*[\"']?([^\s;\"'`]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, command)
        if match:
            monitor_id = normalize_monitor_id(match.group(1))
            if monitor_id:
                return monitor_id
    return ""

def repo_ref(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT)).replace("\\", "/")
    except Exception:
        return str(path)

def extract_monitor_id_from_tool_input(tool_input: Any) -> str:
    if isinstance(tool_input, dict):
        command = tool_input.get("command") or clip(tool_input, MAX_INPUT)
    else:
        command = clip(tool_input, MAX_INPUT)
    return extract_monitor_id_from_command(command)
