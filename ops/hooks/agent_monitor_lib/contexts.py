from __future__ import annotations

import sys
from typing import Any

from .predicates.dispatch_reminder import should_inject_subagent_dispatch_reminder
from .settings import injection_text

sys.dont_write_bytecode = True

def build_subagent_dispatch_reminder_context() -> str:
    return injection_text("dispatch_reminder")
