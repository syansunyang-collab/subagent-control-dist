"""从 alignment_recorder.py 原样搬出的阶段阅读与当前开轮号。"""

from __future__ import annotations

import sys
from typing import Any

sys.dont_write_bytecode = True

from alignment_guard import round_ref, round_status
from alignment_recorder_parts.constants import STAGE_READS

def next_reads(state: dict[str, Any]) -> list[str]:
    """下一步所处阶段的本步需读：有 open 轮取当前阶段；否则按锁推出下一步落在哪一步。"""
    stage = state.get("current_stage")
    locks = state.get("locks") if isinstance(state.get("locks"), dict) else {}
    product = locks.get("requirements_locked") is True and locks.get("product_experience_locked") is True
    if open_round_number(state) is None:
        if stage == "complete":
            stage = "exit"
        elif product and locks.get("execution_locked") is True and stage != "exit":
            stage = "review"
        elif product and locks.get("execution_locked") is not True:
            stage = "solution"
    return list(STAGE_READS.get(stage, ()))


def open_round_number(state: dict[str, Any]) -> int | None:
    for entry in state.get("confirmations") or []:
        if isinstance(entry, dict) and round_status(entry) == "open":
            return round_ref(entry.get("ref"))[1] if round_ref(entry.get("ref")) else None
    return None
