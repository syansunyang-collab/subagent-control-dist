from __future__ import annotations

import sys
from pathlib import Path

sys.dont_write_bytecode = True


def strip_prompt_metadata(text: str) -> str:
    text = text.lstrip("\ufeff").strip()
    lines = text.splitlines()
    if not lines or not lines[0].lstrip().startswith("#"):
        return text
    index = 1
    while index < len(lines):
        stripped = lines[index].strip()
        if not stripped or stripped.startswith(">"):
            index += 1
            continue
        break
    return "\n".join(lines[index:]).strip()


def load_prompt_text(root: Path, prompt_path: str) -> str:
    if not prompt_path:
        return ""
    path = Path(prompt_path)
    if not path.is_absolute():
        path = root / path
    try:
        return strip_prompt_metadata(path.read_text(encoding="utf-8"))
    except OSError:
        return ""
