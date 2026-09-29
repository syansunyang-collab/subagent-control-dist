from __future__ import annotations

import re
import sys
from typing import Any

from ..ids import command_from_event
from ..settings import ROOT

sys.dont_write_bytecode = True

# 命令中出现「绝对路径 + AGENTS/CLAUDE 治理文件」形态才候选；相对路径（本仓读取）不触发。
_EXTERNAL_GOVERNANCE_RE = re.compile(
    r"(?P<path>[A-Za-z]:[\\/][^\"'|;<>\s]*(?:AGENTS|CLAUDE)\.md)", re.IGNORECASE
)


def should_inject_external_truth_reminder(event: dict[str, Any], state: str) -> bool:
    """读取外仓 AGENTS.md / CLAUDE.md 后提醒：那是维护对象不是本会话行为真源。"""
    if event.get("hook_event_name") != "PostToolUse":
        return False
    if state != "tool_done":
        return False
    tool_name = str(event.get("tool_name") or event.get("tool") or "").lower()
    if tool_name != "bash":
        return False
    command = command_from_event(event)
    if not command:
        return False
    root = str(ROOT.resolve()).replace("\\", "/").lower().rstrip("/")
    for match in _EXTERNAL_GOVERNANCE_RE.finditer(command):
        candidate = match.group("path").replace("\\", "/").lower()
        if not candidate.startswith(root + "/"):
            return True
    return False
