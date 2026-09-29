from __future__ import annotations

import json
import re
import sys
from typing import Any

from .settings import PROTECTED_JSON_ESCAPE
from .text_utils import protect_escapes_in_json_string_fields, sanitize_json_value

sys.dont_write_bytecode = True


def parse_hook_event(raw_input: str) -> tuple[dict[str, Any] | None, str, str]:
    try:
        return sanitize_json_value(json.loads(raw_input)), "json", ""
    except Exception as first_exc:
        # Windows hook payloads may contain raw backslashes in paths. Preserve
        # multiline message escapes first, then repair path-like backslashes.
        protected = protect_escapes_in_json_string_fields(raw_input)
        repaired = re.sub(r'(?<!\\)\\(?!["\\/])', r"\\\\", protected)
        repaired = repaired.replace(PROTECTED_JSON_ESCAPE, "\\")
        try:
            return sanitize_json_value(json.loads(repaired)), "repaired_backslash", str(first_exc)
        except Exception as second_exc:
            return None, "failed", f"{first_exc}; repair_failed: {second_exc}"
