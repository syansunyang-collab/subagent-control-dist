from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from .prompt_loader import load_prompt_text

sys.dont_write_bytecode = True

MAX_INPUT = 500
MAX_OUTPUT = 800
PROTECTED_JSON_ESCAPE = "@@CODEX_HOOK_JSON_ESCAPE@@"
MULTILINE_JSON_STRING_FIELDS = ("last_assistant_message",)
MONITOR_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{2,120}$")
THREAD_ID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


def repo_root() -> Path:
    here = Path(__file__).resolve()
    for path in here.parents:
        if (path / "ops").exists() and (path / "AGENTS.md").exists():
            return path

    cur = Path(os.getcwd()).resolve()
    for path in (cur, *cur.parents):
        if (path / ".git").exists() or ((path / "AGENTS.md").exists() and (path / "ops").exists()):
            return path
    return cur


ROOT = repo_root()
TOOLS_DIR = ROOT / "ops" / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

STATE_DIR = ROOT / ".runtime" / "cockpit" / "state"

INJECTION_CONFIG_PATH = ROOT / "ops" / "hooks" / "injection_config.json"

# 注入文案正文在 ops/hooks/prompts/；本配置只维护开关、阈值和文案路径。
INJECTION_DEFAULTS: dict = {
    "limits": {
        "additional_context_max_chars": 5000,
    },
    "toggles": {
        "compact_agents_reminder": True,
        "stop_state_check_reminder": True,
        "dispatch_reminder": True,
        "external_truth_reminder": True,
    },
    "prompts": {
        "compact_agents_reminder": "ops/hooks/prompts/main/compact-agents-reminder.md",
        "stop_state_check_reminder": "ops/hooks/prompts/main/stop-state-check.md",
        "dispatch_reminder": "ops/hooks/prompts/main/post-tool-dispatch-reminder.md",
        "external_truth_reminder": "ops/hooks/prompts/main/external-truth-reminder.md",
    },
}


def _injection_probe_log(message: str) -> None:
    _ = message


def _load_injection_config() -> tuple[dict, list[str]]:
    merged = {section: dict(values) for section, values in INJECTION_DEFAULTS.items()}
    unknown: list[str] = []
    try:
        import json as _json

        raw = INJECTION_CONFIG_PATH.read_text(encoding="utf-8")
        data = _json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("injection config root is not an object")
    except FileNotFoundError:
        return merged, unknown
    except Exception as exc:
        _injection_probe_log(f"injection_config_load_failed: {exc}")
        return merged, unknown
    version = data.get("schema_version")
    if version != 2:
        unknown.append(f"schema_version={version!r} (expected 2)")
        _injection_probe_log(f"injection_config_schema_version_mismatch: {version!r}")
    for section in ("limits", "toggles", "prompts"):
        overrides = data.get(section)
        if not isinstance(overrides, dict):
            continue
        for key, value in overrides.items():
            if key in merged[section]:
                merged[section][key] = value
            else:
                unknown.append(f"{section}.{key}")
    if unknown:
        _injection_probe_log("injection_config_unknown_keys: " + ", ".join(unknown))
    return merged, unknown


_INJECTION, _INJECTION_UNKNOWN_KEYS = _load_injection_config()


def injection_text(key: str) -> str:
    prompt_path = _INJECTION["prompts"].get(key, INJECTION_DEFAULTS["prompts"].get(key, ""))
    if not isinstance(prompt_path, str):
        return f"hook prompt path invalid: {key}"
    text = load_prompt_text(ROOT, prompt_path)
    return text or f"hook prompt missing: {key}"


def injection_enabled(key: str) -> bool:
    value = _INJECTION["toggles"].get(key, INJECTION_DEFAULTS["toggles"].get(key, True))
    return bool(value)


def injection_limit(key: str) -> int:
    value = _INJECTION["limits"].get(key, INJECTION_DEFAULTS["limits"].get(key, 0))
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(INJECTION_DEFAULTS["limits"].get(key, 0))


def injection_unknown_keys() -> list[str]:
    return list(_INJECTION_UNKNOWN_KEYS)


def injection_prompt_keys() -> list[str]:
    return list(INJECTION_DEFAULTS["prompts"].keys())
