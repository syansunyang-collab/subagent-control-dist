from __future__ import annotations

from typing import Any


def should_inject_compact_agents_reminder(event: dict[str, Any]) -> bool:
    return event.get("hook_event_name") == "SessionStart" and str(event.get("source", "")).lower() == "compact"
