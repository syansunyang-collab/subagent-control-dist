from __future__ import annotations

import json
import re
import sys
from typing import Any

from .settings import MAX_INPUT, MULTILINE_JSON_STRING_FIELDS, PROTECTED_JSON_ESCAPE

sys.dont_write_bytecode = True

def safe_text(value: Any) -> str:
    """Return UTF-8 writable text even when hook payload contains surrogates."""
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    return value.encode("utf-8", errors="replace").decode("utf-8", errors="replace")

def clip(value: Any, limit: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, default=str)
    value = safe_text(value).replace("\x00", "")
    if len(value) <= limit:
        return value
    return value[:limit] + " ...<clipped>"

def sanitize_json_value(value: Any) -> Any:
    if isinstance(value, str):
        return safe_text(value)
    if isinstance(value, list):
        return [sanitize_json_value(item) for item in value]
    if isinstance(value, dict):
        return {safe_text(key): sanitize_json_value(item) for key, item in value.items()}
    return value

def safe_json_dumps(value: Any, limit: int | None = None) -> str:
    text = json.dumps(value, ensure_ascii=False, default=str)
    text = safe_text(text)
    if limit is not None and len(text) > limit:
        return text[:limit] + " ...<clipped>"
    return text

def safe_hook_json_dumps(value: Any, limit: int | None = None) -> str:
    text = json.dumps(value, ensure_ascii=True, default=str)
    text = safe_text(text)
    if limit is not None and len(text) > limit:
        return text[:limit] + " ...<clipped>"
    return text

def read_hook_stdin() -> str:
    data = sys.stdin.buffer.read()
    if not data:
        return ""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        encoding = sys.stdin.encoding or "utf-8"
        return data.decode(encoding, errors="replace")

def protect_escapes_in_json_string_fields(raw_input: str) -> str:
    """Protect real JSON escapes in selected fields before path backslash repair."""
    text = raw_input
    for field in MULTILINE_JSON_STRING_FIELDS:
        key = f'"{field}"'
        result: list[str] = []
        cursor = 0
        while True:
            pos = text.find(key, cursor)
            if pos < 0:
                result.append(text[cursor:])
                break
            colon = text.find(":", pos + len(key))
            if colon < 0:
                result.append(text[cursor:])
                break
            value_start = colon + 1
            while value_start < len(text) and text[value_start].isspace():
                value_start += 1
            if value_start >= len(text) or text[value_start] != '"':
                result.append(text[cursor:value_start])
                cursor = value_start
                continue

            result.append(text[cursor : value_start + 1])
            i = value_start + 1
            while i < len(text):
                ch = text[i]
                if ch == "\\" and i + 1 < len(text):
                    nxt = text[i + 1]
                    if nxt in '"\\/bfnrtu':
                        result.append(PROTECTED_JSON_ESCAPE + nxt)
                        i += 2
                        continue
                    result.append(ch)
                    i += 1
                    continue
                result.append(ch)
                i += 1
                if ch == '"':
                    break
            cursor = i
        text = "".join(result)
    return text
