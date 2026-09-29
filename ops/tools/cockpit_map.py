#!/usr/bin/env python3
"""cockpit_map — 扫描 Codex 编排治理文件，生成编排导航图。

零手维护：改完规则重跑即更新。输出 ops/map/cockpit-overview.md，
含编排文件职责表和引用关系（目录级 mermaid + 文件级入度排名）。
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

# 地图与治理语料归项目本地：项目根用显式 SUBAGENT_PROJECT_ROOT / cwd 上溯，
# 不从脚本 realpath 推项目根；脚本自身位置只用来加载同目录的共享助手。
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _tool_common import ROOT  # noqa: E402

CODEX = ROOT / "ops"
OUT = ROOT / "ops" / "map" / "cockpit-overview.md"

# 排除：运行态、临时和缓存
EXCLUDE_DIRS = {"state", "runs", "map", "__pycache__"}
CODEX_EXCLUDE_DIRS = EXCLUDE_DIRS | {"templates", "node_modules", "dist"}
READ_MODES = {"固定读取", "命中读取", "维护读取", "不作为入口"}
ROOT_ENTRY_FILES = {"AGENTS.md", "PROJECT.md", "STATUS.md", "ROADMAP.md"}
NON_GOVERNANCE_PREFIXES = (
    ".planning/",
    "notes/",
    "docs/",
    "design/",
    "test-results/",
    "outputs/",
    "data/",
    "src/",
    "configs/",
    "scripts/",
    "tools/",
    "artifacts/",
    "refs/",
    "repos/",
    "tmp/",
    "sandbox/",
)
ARTIFACT_BASENAMES = {
    "CONTEXT.md",
    "PLAN.md",
    "SUMMARY.md",
    "INDEX.md",
    "TEST-RUN-TEMPLATE.md",
    "MODULE.md",
    "public_api.md",
    "notes_all.md",
    "status_history.md",
}
REF_RE = re.compile(
    r"`(?P<path>(?:ops/[^`§]+\.md|AGENTS\.md|PROJECT\.md|STATUS\.md|ROADMAP\.md))(?:\s+§[^`]*)?`"
)
SECTION_REF_RE = re.compile(
    r"`(?P<path>(?:ops/[^`§\s]+\.md|AGENTS\.md|PROJECT\.md|STATUS\.md|ROADMAP\.md))"
    r"(?:\s+§(?P<sec_in>[0-9][0-9.]*))?`(?:\s*§(?P<sec_out>[0-9][0-9.]*))?"
)
HEADING_TOKEN_RE = re.compile(r"^#{1,6}\s+(?:§\s*)?(?P<tok>[0-9]+(?:\.[0-9]+)*)\.?\s", re.MULTILINE)

_heading_cache: dict[str, set[str] | None] = {}


def heading_tokens_for(path: Path) -> set[str] | None:
    key = str(path)
    if key not in _heading_cache:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            _heading_cache[key] = None
        else:
            _heading_cache[key] = {m.group("tok").rstrip(".") for m in HEADING_TOKEN_RE.finditer(text)}
    return _heading_cache[key]
BACKTICK_MD_RE = re.compile(r"`(?P<ref>[^`]+\.md(?:\s+§[^`]*)?)`")
MD_LINK_RE = re.compile(r"\[[^\]]+\]\((?P<ref>[^)]+\.md(?:#[^)]+)?)\)")
PLAIN_MD_RE = re.compile(r"(?<![`/\w.-])(?P<ref>[A-Za-z0-9_.-]+\.md)(?![`/\w.-])")
HEADER_RE = {
    "职责": re.compile(r"^>\s*职责：\s*(?P<value>.+?)\s*$"),
    "真源": re.compile(r"^>\s*真源：\s*(?P<value>.+?)\s*$"),
    "读取": re.compile(r"^>\s*读取：\s*(?P<value>.+?)\s*$"),
}
TASK_PACKAGE_AGENT_BLOCK_RE = re.compile(r"```yaml task_package_agent\n(?P<body>.*?)\n```", re.DOTALL)


def iter_md() -> list[Path]:
    out = []
    for p in CODEX.rglob("*.md"):
        parts = p.relative_to(ROOT).parts
        if any(part in CODEX_EXCLUDE_DIRS for part in parts):
            continue
        if is_skill_path(p) and not is_orchestration_skill_path(p):
            continue
        out.append(p)
    # 纳入根入口：它引用大量规则文件，不计入会让入度失真、假孤儿成堆
    for entry in ("AGENTS.md",):
        ep = ROOT / entry
        if ep.exists():
            out.append(ep)
    return sorted(out)


def is_skill_path(path: Path) -> bool:
    parts = path.relative_to(ROOT).parts
    return len(parts) >= 3 and parts[0] == "ops" and parts[1] == "skills"


def skill_slug(path: Path) -> str:
    parts = path.relative_to(ROOT).parts
    if len(parts) >= 3 and parts[0] == "ops" and parts[1] == "skills":
        return parts[2]
    return ""


def parse_frontmatter(text: str) -> dict[str, str]:
    if text.startswith("\ufeff"):
        text = text.lstrip("\ufeff")
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end == -1:
        return {}
    raw = text[4:end].strip()
    data: dict[str, str] = {}
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key:
            data[key] = value
    return data


def skill_metadata(slug: str) -> dict[str, str]:
    path = CODEX / "skills" / slug / "SKILL.md"
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8", errors="replace")
    return parse_frontmatter(text)


def is_orchestration_skill_path(path: Path) -> bool:
    slug = skill_slug(path)
    return bool(slug) and skill_metadata(slug).get("layer") == "orchestration"


def rel(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()


def truncate_text(value: str, limit: int | None) -> str:
    if limit is None or len(value) <= limit:
        return value
    return value[:limit] + "…"


def extract_duty(text: str, limit: int | None = 48) -> str:
    """优先读取文件头职责；缺少时回退到第一个非标题段落。"""
    header = extract_header(text)
    if header.get("职责"):
        return truncate_text(header["职责"], limit)
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("```"):
            continue
        s = re.sub(r"[*`>]", "", s)
        return truncate_text(s, limit)
    return "(无职责描述)"


def extract_refs(text: str) -> set[str]:
    body = strip_fenced_code(text)
    return {m.group("path") for m in REF_RE.finditer(body)}


def strip_fenced_code(text: str) -> str:
    lines: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_fence = not in_fence
            lines.append("")
            continue
        lines.append("" if in_fence else line)
    return "\n".join(lines)


def extract_header(text: str) -> dict[str, str]:
    if text.startswith("\ufeff"):
        text = text.lstrip("\ufeff")
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            text = text[end + len("\n---") :]
    header: dict[str, str] = {}
    for line in text.splitlines()[:20]:
        s = line.strip()
        for key, pattern in HEADER_RE.items():
            match = pattern.match(s)
            if match:
                header[key] = match.group("value").strip()
    return header


def is_canonical_ref(raw: str) -> bool:
    return bool(REF_RE.fullmatch(f"`{raw}`"))


def line_no(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def inside_inline_code(text: str, offset: int) -> bool:
    line_start = text.rfind("\n", 0, offset) + 1
    return text[line_start:offset].count("`") % 2 == 1


def split_section(raw: str) -> tuple[str, str]:
    if " §" not in raw:
        return raw.strip(), ""
    base, section = raw.split(" §", 1)
    return base.strip(), f" §{section.strip()}"


def path_basename(raw: str) -> str:
    return raw.replace("\\", "/").rstrip("/").split("/")[-1]


def allowed_non_governance_ref(raw: str) -> bool:
    base, _ = split_section(raw)
    base = base.strip()
    if base.startswith("capability.file: ops/"):
        return True
    if base.startswith(NON_GOVERNANCE_PREFIXES):
        return True
    if path_basename(base) in ARTIFACT_BASENAMES:
        return True
    if any(token in base for token in ("<", ">", "*", "{", "}")):
        return True
    return False


def build_basename_map(paths: set[str]) -> dict[str, list[str]]:
    by_name: dict[str, list[str]] = defaultdict(list)
    for item in paths:
        by_name[path_basename(item)].append(item)
    return dict(by_name)


def resolve_governance_ref(raw: str, source: Path, known_paths: set[str], by_name: dict[str, list[str]]) -> str | None:
    base, _ = split_section(raw)
    base = base.strip().replace("\\", "/")

    if allowed_non_governance_ref(raw):
        return None
    if base in ROOT_ENTRY_FILES:
        return base
    if base.startswith("ops/"):
        return base if base.endswith(".md") else None
    if base.startswith("task-package-routes/"):
        return f"ops/protocols/{base}"
    if base.startswith("./") or base.startswith("../"):
        candidate = (source.parent / base).resolve()
        try:
            rel_candidate = candidate.relative_to(ROOT).as_posix()
        except ValueError:
            return None
        return rel_candidate if rel_candidate in known_paths else None
    if "/" in base:
        same_root = (source.parent / base).resolve()
        try:
            same_rel = same_root.relative_to(ROOT).as_posix()
        except ValueError:
            same_rel = ""
        return same_rel if same_rel in known_paths else None

    same_dir = (source.parent / base).resolve()
    try:
        same_rel = same_dir.relative_to(ROOT).as_posix()
    except ValueError:
        same_rel = ""
    if same_rel in known_paths:
        return same_rel

    options = by_name.get(base, [])
    if len(options) == 1:
        return options[0]

    source_rel = rel(source)
    if source_rel.startswith("ops/workflows/alignment/"):
        candidate = f"ops/workflows/alignment/{base}"
        if candidate in known_paths:
            return candidate
    if source_rel.startswith("ops/workflows/planning/"):
        candidate = f"ops/workflows/planning/{base}"
        if candidate in known_paths:
            return candidate
    if source_rel.startswith("ops/policies/"):
        candidate = f"ops/policies/{base}"
        if candidate in known_paths:
            return candidate
    if source_rel.startswith("ops/protocols/task-package-reference/"):
        candidate = f"ops/protocols/task-package-reference/{base}"
        if candidate in known_paths:
            return candidate
    return None


def header_defaults(path: Path) -> dict[str, str]:
    r = rel(path)
    name = path.name

    if r == "AGENTS.md":
        return {
            "职责": "规定主代理入口、路由和硬红线。",
            "真源": "主代理入口顺序、子代理调度入口、状态和提交红线",
            "读取": "固定读取",
        }

    if r.startswith("ops/agent-prompts/"):
        if name == "_common.md":
            duty = "规定子代理公共运行和回执边界。"
            truth = "子代理公共运行规则、公共回执骨架和通用拒收规则"
        elif name == "CAPABILITIES.md":
            duty = "登记子代理能力和模型推理配置。"
            truth = "子代理能力索引、模型和推理强度配置"
        else:
            role = path.parent.name
            capability = path.stem
            duty = f"规定 {role} / {capability} 能力边界。"
            truth = "对应子代理能力的输入契约、拒收条件和输出要求"
        return {"职责": duty, "真源": truth, "读取": "维护读取"}

    if r.startswith("ops/protocols/task-package-routes/"):
        route = path.stem.replace("__", " / ")
        return {
            "职责": f"规定 {route} 的专用派发规范。",
            "真源": "对应能力的 task_package 构造、拒收条件和回执接收规则",
            "读取": "命中读取",
        }

    if r.startswith("ops/policies/"):
        # 各文件真实职责以自身 "> 职责：" 头为准；此处只提供缺头兜底，不维护逐文件副本。
        return {"职责": "规定本策略文件的运行处置规则。", "真源": "本策略文件定义的运行处置规则", "读取": "命中读取"}

    if r.startswith("ops/workflows/alignment/"):
        return {"职责": "规定 alignment 专项阶段规则。", "真源": "对应 alignment 专项阶段规则", "读取": "命中读取"}

    if r == "ops/workflows/planning/WORKFLOW.md":
        return {
            "职责": "规定 planning 执行编排、派发、验证和收口主线。",
            "真源": "planning 阶段状态机、执行运行池和回流规则",
            "读取": "命中读取",
        }

    protocol_defaults = {
        "ops/protocols/file-convention.md": (
            "规定治理文件引用、文件头和地图 lint 约定。",
            "治理文件引用格式、文件头字段、读取字段值域",
            "维护读取",
        ),
        "ops/protocols/repository-structure.md": (
            "规定目录归属和新目录准入。",
            "目录归属、新目录准入和任务包路径写入规则",
            "命中读取",
        ),
        "ops/protocols/cockpit-layering.md": (
            "规定 `ops/` 内部目录分层和归属。",
            "ops 内部目录职责、跨层引用和拆分规则",
            "命中读取",
        ),
        "ops/protocols/task-package.md": (
            "规定任务包协议入口和字段维护归属。",
            "任务包协议入口、字段维护索引和运行期构包链路",
            "维护读取",
        ),
        "ops/protocols/task-package-reference/design-guide.md": (
            "规定任务包和派发规范设计方法。",
            "任务包、派发规范和能力对齐设计规则",
            "维护读取",
        ),
        "ops/protocols/task-package-reference/field-dictionary.md": (
            "解释 task_package 和 FINAL_HANDOFF 字段。",
            "task_package 和 FINAL_HANDOFF 字段含义和值域",
            "维护读取",
        ),
    }
    if r in protocol_defaults:
        duty, truth, read_mode = protocol_defaults[r]
        return {"职责": duty, "真源": truth, "读取": read_mode}

    return {"职责": "记录本治理文件的规则内容。", "真源": "本文件定义的治理规则", "读取": "维护读取"}


def lint_file(path: Path, known_paths: set[str], by_name: dict[str, list[str]]) -> dict[str, list[str]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    relpath = rel(path)
    issues: dict[str, list[str]] = defaultdict(list)
    header = extract_header(text)

    for key in ("职责", "真源", "读取"):
        if not header.get(key):
            issues[f"missing_{key}"].append(f"{relpath}: 文件头缺少 `{key}`")

    read_mode = header.get("读取")
    if read_mode and read_mode not in READ_MODES:
        issues["invalid_read_mode"].append(f"{relpath}: `读取` 值 `{read_mode}` 不在闭集内")

    body = strip_fenced_code(text)
    canonical_refs = {m.group("path") for m in REF_RE.finditer(body)}
    for target in sorted(canonical_refs):
        if "<" in target or ">" in target:
            continue
        if target not in known_paths and not (ROOT / target).exists():
            issues["dead_link"].append(f"{relpath}: `{target}` 指向不存在的文件")

    for match in SECTION_REF_RE.finditer(body):
        target = match.group("path")
        sec = (match.group("sec_in") or match.group("sec_out") or "").rstrip(".")
        if not sec or "<" in target:
            continue
        target_path = ROOT / target
        if not target_path.exists():
            continue
        tokens = heading_tokens_for(target_path)
        if tokens is not None and sec not in tokens:
            issues["dead_section_ref"].append(
                f"{relpath}:{line_no(body, match.start())}: `{target}` §{sec} 在目标文件无对应章节"
            )

    for match in BACKTICK_MD_RE.finditer(body):
        raw = match.group("ref")
        if is_canonical_ref(raw) or allowed_non_governance_ref(raw):
            continue
        if resolve_governance_ref(raw, path, known_paths, by_name):
            issues["noncanonical_backtick_ref"].append(
                f"{relpath}:{line_no(body, match.start())}: `{raw}`"
            )

    for match in MD_LINK_RE.finditer(body):
        if inside_inline_code(body, match.start()):
            continue
        issues["markdown_link_ref"].append(
            f"{relpath}:{line_no(body, match.start())}: {match.group('ref')}"
        )

    for match in PLAIN_MD_RE.finditer(body):
        start = match.start()
        line_start = body.rfind("\n", 0, start) + 1
        line_end = body.find("\n", start)
        line_end = len(body) if line_end == -1 else line_end
        line = body[line_start:line_end]
        raw = match.group("ref")
        if line.lstrip().startswith("#") or "`" in line or "](" in line:
            continue
        if allowed_non_governance_ref(raw) or not resolve_governance_ref(raw, path, known_paths, by_name):
            continue
        issues["plain_md_mention"].append(
            f"{relpath}:{line_no(body, start)}: {raw}"
        )

    if is_route_file(relpath):
        for key, values in lint_route_agent_block(path, text).items():
            issues[key].extend(values)

    return issues


def is_route_file(relpath: str) -> bool:
    return relpath.startswith("ops/protocols/task-package-routes/") and relpath.endswith(".md")


def expected_route_agent(path: Path) -> dict[str, object]:
    role, capability = path.stem.split("__", 1)
    prompt_file = f"ops/agent-prompts/{role}/{capability}.md"
    return {
        "role": role,
        "runtime_role": role,
        "capability_name": capability,
        "capability_file": prompt_file,
        "required_files": ["ops/agent-prompts/_common.md", prompt_file],
    }


def parse_route_agent_block(text: str) -> tuple[list[str], list[dict[str, object]]]:
    blocks: list[dict[str, object]] = []
    raw_blocks = [match.group("body") for match in TASK_PACKAGE_AGENT_BLOCK_RE.finditer(text)]
    for raw in raw_blocks:
        parsed: dict[str, object] = {"required_files": []}
        for line in raw.splitlines():
            stripped = line.strip()
            if stripped.startswith("role: "):
                parsed["role"] = stripped.removeprefix("role: ").strip()
            elif stripped.startswith("runtime_role: "):
                parsed["runtime_role"] = stripped.removeprefix("runtime_role: ").strip()
            elif stripped.startswith("name: "):
                parsed["capability_name"] = stripped.removeprefix("name: ").strip()
            elif stripped.startswith("file: "):
                parsed["capability_file"] = stripped.removeprefix("file: ").strip()
            elif stripped.startswith("- "):
                parsed.setdefault("required_files", [])
                parsed["required_files"].append(stripped.removeprefix("- ").strip())  # type: ignore[index]
        blocks.append(parsed)
    return raw_blocks, blocks


def lint_route_agent_block(path: Path, text: str) -> dict[str, list[str]]:
    relpath = rel(path)
    issues: dict[str, list[str]] = defaultdict(list)
    if "__" not in path.stem:
        issues["route_filename_invalid"].append(
            f"{relpath}: 路由文件名必须为 <role>__<capability>.md"
        )
        return issues
    raw_blocks, blocks = parse_route_agent_block(text)
    if not raw_blocks:
        issues["missing_task_package_agent_block"].append(
            f"{relpath}: 缺少 ```yaml task_package_agent``` 固定包头"
        )
        return issues
    if len(raw_blocks) > 1:
        issues["duplicate_task_package_agent_block"].append(
            f"{relpath}: 固定包头数量为 {len(raw_blocks)}，必须只有 1 个"
        )

    expected = expected_route_agent(path)
    actual = blocks[0]
    for key in ("role", "runtime_role", "capability_name", "capability_file"):
        if actual.get(key) != expected[key]:
            issues["route_agent_header_mismatch"].append(
                f"{relpath}: {key}={actual.get(key)!r}，应为 {expected[key]!r}"
            )
    actual_required = [str(item) for item in actual.get("required_files") or []]
    must_have = [item for item in expected["required_files"] if item not in actual_required]
    dead_required = [item for item in actual_required if not (ROOT / item).exists()]
    if must_have or dead_required:
        issues["route_agent_required_files_mismatch"].append(
            f"{relpath}: required_files 缺必需项 {must_have!r} 或含缺失路径 {dead_required!r}"
        )

    prompt_path = ROOT / str(expected["capability_file"])
    if not prompt_path.exists():
        issues["route_agent_prompt_missing"].append(
            f"{relpath}: 能力提示词不存在 `{expected['capability_file']}`"
        )
    return issues


def rewrite_outside_fences(text: str, line_rewriter) -> str:
    out: list[str] = []
    in_fence = False
    for line in text.splitlines(keepends=True):
        if line.strip().startswith("```"):
            in_fence = not in_fence
            out.append(line)
            continue
        out.append(line if in_fence else line_rewriter(line))
    return "".join(out)


def canonicalize_refs(text: str, path: Path, known_paths: set[str], by_name: dict[str, list[str]]) -> str:
    def rewrite_line(line: str) -> str:
        original = line

        if not line.lstrip().startswith("#") and "`" not in line and "](" not in line:
            def plain_repl(match: re.Match[str]) -> str:
                raw = match.group("ref")
                if allowed_non_governance_ref(raw):
                    return raw
                target = resolve_governance_ref(raw, path, known_paths, by_name)
                return f"`{target}`" if target else raw

            line = PLAIN_MD_RE.sub(plain_repl, line)

        def link_repl(match: re.Match[str]) -> str:
            raw = match.group("ref").replace("#", " §")
            target = resolve_governance_ref(raw, path, known_paths, by_name)
            if not target:
                return match.group(0)
            _, section = split_section(raw)
            return f"`{target}{section}`"

        line = MD_LINK_RE.sub(link_repl, line)

        def backtick_repl(match: re.Match[str]) -> str:
            raw = match.group("ref")
            if is_canonical_ref(raw) or allowed_non_governance_ref(raw):
                return match.group(0)
            target = resolve_governance_ref(raw, path, known_paths, by_name)
            if not target:
                return match.group(0)
            _, section = split_section(raw)
            return f"`{target}{section}`"

        line = BACKTICK_MD_RE.sub(backtick_repl, line)
        return line if line != original else original

    return rewrite_outside_fences(text, rewrite_line)


def ensure_header(text: str, path: Path) -> str:
    header = extract_header(text)
    if all(header.get(key) for key in ("职责", "真源", "读取")):
        return text

    defaults = header_defaults(path)
    header_lines = [
        f"> 职责：{header.get('职责') or defaults['职责']}",
        f"> 真源：{header.get('真源') or defaults['真源']}",
        f"> 读取：{header.get('读取') or defaults['读取']}",
    ]

    has_trailing_newline = text.endswith("\n")
    lines = text.splitlines()
    if not lines or not lines[0].lstrip().startswith("#"):
        title = f"# {path.stem}"
        lines = [title, ""] + lines

    body_start = 1
    while body_start < len(lines) and lines[body_start].strip() == "":
        body_start += 1

    while body_start < len(lines):
        stripped = lines[body_start].strip()
        if any(pattern.match(stripped) for pattern in HEADER_RE.values()):
            body_start += 1
            continue
        if stripped == "":
            body_start += 1
            continue
        break

    rebuilt = lines[:1] + [""] + header_lines + [""]
    rebuilt.extend(lines[body_start:])
    result = "\n".join(rebuilt)
    if has_trailing_newline:
        result += "\n"
    return result


def fix_convention(files: list[Path], known_paths: set[str], by_name: dict[str, list[str]]) -> list[str]:
    changed: list[str] = []
    for path in files:
        original = path.read_text(encoding="utf-8", errors="replace")
        updated = canonicalize_refs(original, path, known_paths, by_name)
        updated = ensure_header(updated, path)
        if updated != original:
            path.write_text(updated, encoding="utf-8")
            changed.append(rel(path))
    return changed


def check_map_staleness(files: list[Path]) -> list[str]:
    """地图产物 mtime 早于任一被收录治理文件时，视为过期。"""
    if not OUT.exists():
        return [f"{rel(OUT)} 不存在，运行 `python -B ops/tools/cockpit_map.py` 生成"]
    out_mtime = OUT.stat().st_mtime
    stale: list[str] = []
    for path in files:
        if path.stat().st_mtime > out_mtime:
            stale.append(f"{rel(path)} 晚于 {rel(OUT)}，运行 `python -B ops/tools/cockpit_map.py` 重新生成")
    return stale


def merge_issues(items: list[dict[str, list[str]]]) -> dict[str, list[str]]:
    merged: dict[str, list[str]] = defaultdict(list)
    for item in items:
        for key, values in item.items():
            merged[key].extend(values)
    return dict(merged)


def write_lint_report(issues: dict[str, list[str]], report_path: Path, scanned_count: int) -> None:
    lines: list[str] = []
    total = sum(len(values) for values in issues.values())
    lines.append("# 文件引用规范扫描报告\n")
    lines.append("> 职责：记录治理文件引用和文件头的机器扫描结果。")
    lines.append("> 真源：none")
    lines.append("> 读取：维护读取\n")
    lines.append("## 扫描结果\n")
    lines.append(f"- 扫描文件数：{scanned_count}")
    lines.append(f"- 问题总数：{total}")
    lines.append("- 判定边界：本报告只记录机器可判定问题，不判断文件是否应删除。\n")
    lines.append("## 分类统计\n")
    lines.append("| 类型 | 数量 |")
    lines.append("| --- | ---: |")
    for key in sorted(issues):
        lines.append(f"| `{key}` | {len(issues[key])} |")
    lines.append("")
    for key in sorted(issues):
        lines.append(f"## {key}\n")
        for value in issues[key]:
            lines.append(f"- {value}")
        lines.append("")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines), encoding="utf-8")


def group_of(relpath: str) -> str:
    """把文件归到一个顶层分组，用于目录级依赖图。"""
    if relpath == "AGENTS.md" or relpath.endswith("/AGENTS.md"):
        return "entry"
    if relpath.startswith("ops/skills/"):
        return "orchestration_skills"
    if "/workflows/alignment/" in relpath:
        return "alignment"
    if "/workflows/planning/" in relpath:
        return "planning"
    if "/task-package-routes/" in relpath:
        return "routes"
    if "/agent-prompts/" in relpath:
        return "capabilities"
    if "/protocols/" in relpath:
        return "protocols"
    if "/policies/" in relpath:
        return "policies"
    return "other"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "扫描编排治理文件（AGENTS.md 与 ops/workflows、policies、protocols、agent-prompts、task-package-routes 等）"
            "生成 ops/map/ 导航地图，或执行引用与文件头 lint。改完编排治理文件后重跑生成；提交前跑 --lint。"
        ),
        epilog="引用与文件头约定见 ops/protocols/file-convention.md",
    )
    parser.add_argument("--lint", action="store_true", help="只检查不修改：治理文件引用是否存活、§ 锚点是否真实、文件头三行是否齐")
    parser.add_argument("--self-test", action="store_true", help="验证 vendored/generated 目录不会进入治理语料扫描")
    parser.add_argument("--fix-convention", action="store_true", help="会写入文件：按约定改写引用格式与文件头；先跑 --lint 看范围再用")
    parser.add_argument("--report", help="lint 报告输出路径")
    args = parser.parse_args()

    files = iter_md()
    known = {rel(f) for f in files}
    by_name = build_basename_map(known)

    if args.fix_convention:
        changed = fix_convention(files, known, by_name)
        print(f"cockpit_map fix-convention: scanned={len(files)} changed={len(changed)}")
        for item in changed:
            print(f"- {item}")
        return 0

    if args.self_test:
        leaked = [
            str(path.relative_to(ROOT)).replace("\\", "/")
            for path in iter_md()
            if any(part in {"node_modules", "dist"} for part in path.relative_to(ROOT).parts)
        ]
        if leaked:
            print(f"cockpit_map self-test: failed leaked={leaked[:5]}")
            return 1
        print("cockpit_map self-test: pass")
        return 0
    if args.lint:
        issues = merge_issues([lint_file(f, known, by_name) for f in files])
        stale = check_map_staleness(files)
        if stale:
            issues["map_stale"] = stale
        total = sum(len(values) for values in issues.values())
        if args.report:
            write_lint_report(issues, ROOT / args.report, len(files))
            print(f"lint report: {args.report}")
        print(f"cockpit_map lint: scanned={len(files)} issues={total}")
        for key in sorted(issues):
            print(f"- {key}: {len(issues[key])}")
        return 1 if total else 0

    duty: dict[str, str] = {}
    refs: dict[str, set[str]] = {}
    indeg: dict[str, int] = defaultdict(int)
    group_edges: dict[tuple[str, str], int] = defaultdict(int)

    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        r = rel(f)
        duty[r] = extract_duty(text)
        rs = {x for x in extract_refs(text) if x != r}
        refs[r] = rs
        for tgt in rs:
            if tgt in known:
                indeg[tgt] += 1
                gs, gt = group_of(r), group_of(tgt)
                if gs != gt:
                    group_edges[(gs, gt)] += 1

    lines: list[str] = []
    lines.append("# Cockpit 编排导航图\n")
    lines.append(
        "> 本文件由 `ops/tools/cockpit_map.py` 自动生成，请勿手改。"
        "本图定位 Codex 编排治理文件和编排型技能；真实业务目标进入后再建立业务地图。\n"
    )

    # §1 概览
    by_group: dict[str, list[str]] = defaultdict(list)
    for r in known:
        by_group[group_of(r)].append(r)
    lines.append("## 1. 概览\n")
    lines.append(f"- 编排文件总数：**{len(files)}**（已排除 state / runs / 业务层 skills）\n")
    lines.append("| 分组 | 文件数 |\n| --- | --- |")
    for g in sorted(by_group):
        lines.append(f"| {g} | {len(by_group[g])} |")
    lines.append("")

    # §2 目录级依赖图（mermaid，聚合避免糊成一团）
    lines.append("## 2. 分组依赖图\n")
    lines.append("箭头 A --> B 表示 A 分组的文件引用了 B 分组的文件，数字为引用次数。\n")
    lines.append("```mermaid")
    lines.append("graph LR")
    for (gs, gt), w in sorted(group_edges.items(), key=lambda x: (-x[1], x[0][0], x[0][1])):
        lines.append(f"  {gs} -->|{w}| {gt}")
    lines.append("```\n")

    # §3 核心真源排名（入度 = 被引用次数）
    lines.append("## 3. 核心真源排名（被引用最多）\n")
    lines.append("被引用越多 = 越是编排骨架，改动影响面越大。\n")
    lines.append("| 入度 | 文件 | 职责 |\n| ---: | --- | --- |")
    for r, d in sorted(indeg.items(), key=lambda x: (-x[1], x[0]))[:12]:
        lines.append(f"| {d} | `{r}` | {duty.get(r, '')} |")
    lines.append("")

    # §4 文件职责表（按分组）
    lines.append("## 4. 文件职责表\n")
    lines.append("入度表示该文件被当前 map 内已知文件引用的次数；出度表示该文件引用当前 map 内已知文件的次数。\n")
    for g in sorted(by_group):
        lines.append(f"### {g}\n")
        lines.append("| 文件 | 职责 | 入度 | 出度 |\n| --- | --- | ---: | ---: |")
        for r in sorted(by_group[g]):
            lines.append(f"| `{r}` | {duty[r]} | {indeg[r]} | {len(refs[r])} |")
        lines.append("")

    lines.append("## 5. 外部真源\n")
    lines.append("- 字段枚举和值域见 `ops/protocols/task-package-reference/field-dictionary.md`。")
    lines.append("- `ops/` 内部分层见 `ops/protocols/cockpit-layering.md`。")
    lines.append("- 技能归属以 `SKILL.md` frontmatter 的 `layer`、`domain` 和 `capability_group` 字段为准；编排型技能进入本图。")
    lines.append("- 当前状态见 `STATUS.md`；当前路线见 `ROADMAP.md`。")
    lines.append("")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    while lines and lines[-1] == "":
        lines.pop()
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"OK cockpit_map: {rel(OUT)} ({len(files)} files scanned)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
