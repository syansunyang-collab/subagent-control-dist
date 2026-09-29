from __future__ import annotations

import re
import sys
from typing import Any

from ..ids import command_from_event
from ..settings import injection_enabled

sys.dont_write_bytecode = True

_SKIP_FLAGS_RE = re.compile(
    r"(^|\s)(--self-test|--help|-h|/\?|--list|--list-routes|--seed-template|--sample-route|"
    r"--print-json|--dry-run|--card-check)(\s|$)"
)


def should_inject_subagent_dispatch_reminder(event: dict[str, Any], state: str) -> bool:
    if not injection_enabled("dispatch_reminder"):
        return False
    if event.get("hook_event_name") != "PostToolUse" or state != "tool_done":
        return False
    if event.get("tool_name") != "Bash":
        return False
    command = command_from_event(event)
    if not command or _SKIP_FLAGS_RE.search(command):
        return False
    normalized = command.replace("\\", "/")
    if "dispatch_prepare.mjs" in normalized or "dispatch_prepare.py" in normalized:
        return bool(re.search(r"(^|\s)(--seed-stdin|--seed)(\s|$)", command))
    if "subagent_preload.mjs" in normalized or "subagent_preload.py" in normalized:
        return bool(re.search(r"\bprepare\b", command))
    return False
