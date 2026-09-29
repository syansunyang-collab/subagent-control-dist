from __future__ import annotations

import re
import sys
from typing import Any

from ..settings import injection_enabled
from ..text_utils import safe_text

sys.dont_write_bytecode = True


def should_inject_stop_state_check(event: dict[str, Any]) -> bool:
    if not injection_enabled("stop_state_check_reminder"):
        return False
    if event.get("hook_event_name") != "Stop":
        return False
    message = safe_text(event.get("last_assistant_message") or "")
    return bool(
        re.search(
            r"STATUS\.md|ROADMAP\.md|\b(?:checkpoint|blocker|milestone|surface)\b|恢复入口",
            message,
            re.IGNORECASE,
        )
    )
