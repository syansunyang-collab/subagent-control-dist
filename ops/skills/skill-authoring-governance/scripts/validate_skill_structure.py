from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


ALLOWED_DIRS = {"agents", "assets", "references", "scripts", "templates"}
LAYERS = {"orchestration", "business"}
PORTABILITY_VALUES = {"portable", "repo-bound"}
BANNED_TERMS = tuple("".join(parts) for parts in (("Her", "mes"), ("her", "mes")))
OPS_REF_RE = re.compile(r"ops/[A-Za-z0-9_.!~*'()/-]+")
TRIGGER_CASE_SECTIONS = ("正判例", "反判例")
ABSOLUTE_PATH_PATTERNS = (
    re.compile(r"(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s`'\"<>]+"),
    re.compile(r"\\\\[A-Za-z0-9_.-]+\\[^\s`'\"<>]+"),
    re.compile(r"/(?:Users|home|mnt|tmp)/[^\s`'\"<>]+"),
)
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
META_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
RESOURCE_REF_RE = re.compile(
    r"(?P<path>(?:references|templates|scripts|assets)/[A-Za-z0-9_.!~*'()/-]+)"
)


def split_frontmatter(text: str) -> tuple[dict[str, str], str, list[str]]:
    errors: list[str] = []
    if text.startswith("\ufeff"):
        errors.append("frontmatter 前存在 BOM")
        text = text.lstrip("\ufeff")
    if not text.startswith("---\n"):
        return {}, text, errors + ["文件必须从 frontmatter 起始符开始"]
    end = text.find("\n---", 4)
    if end == -1:
        return {}, "", errors + ["frontmatter 缺少结束符"]
    raw = text[4:end].strip()
    body = text[end + len("\n---") :].strip()
    data: dict[str, str] = {}
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            errors.append(f"frontmatter 行不可解析: {line}")
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key:
            data[key] = value
    return data, body, errors


def iter_markdown_files(skill_dir: Path) -> list[Path]:
    files = [skill_dir / "SKILL.md"]
    for folder in ("references", "templates"):
        root = skill_dir / folder
        if root.exists():
            files.extend(sorted(root.rglob("*.md")))
    return [path for path in files if path.exists()]


def find_resource_refs(text: str) -> set[str]:
    return {match.group("path") for match in RESOURCE_REF_RE.finditer(text)}


def section_body(text: str, keyword: str) -> str | None:
    """Return the body under the first heading containing keyword, or None if absent."""
    collecting = False
    body_lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            if collecting:
                break
            if keyword in stripped.lstrip("#").strip():
                collecting = True
            continue
        if collecting:
            body_lines.append(line)
    if not collecting:
        return None
    return "\n".join(body_lines)


def check_trigger_cases(skill_dir: Path) -> list[str]:
    issues: list[str] = []
    trigger_file = skill_dir / "references" / "trigger-cases.md"
    if not trigger_file.exists():
        return ["缺少 references/trigger-cases.md"]
    text = trigger_file.read_text(encoding="utf-8", errors="replace")
    for label in TRIGGER_CASE_SECTIONS:
        body = section_body(text, label)
        if body is None:
            issues.append(f"trigger-cases.md 缺少{label}小节")
        elif not any(line.strip() for line in body.splitlines()):
            issues.append(f"trigger-cases.md 的{label}小节为空")
    return issues


def check_portable_refs(content: str, relpath: str, self_prefix: str) -> list[str]:
    issues: list[str] = []
    for match in OPS_REF_RE.finditer(content):
        ref = match.group(0)
        if not ref.startswith(self_prefix):
            issues.append(f"{relpath}: portable 技能不得引用技能目录外仓内路径: {ref}")
    return issues


def check_absolute_paths(text: str, relpath: str) -> list[str]:
    issues: list[str] = []
    for pattern in ABSOLUTE_PATH_PATTERNS:
        for match in pattern.finditer(text):
            issues.append(f"{relpath}: 疑似绝对路径: {match.group(0)}")
    return issues


def validate(skill_dir: Path) -> dict[str, object]:
    errors: list[str] = []
    warnings: list[str] = []
    skill_dir = skill_dir.resolve()
    skill_file = skill_dir / "SKILL.md"

    if not skill_dir.exists() or not skill_dir.is_dir():
        return {"ok": False, "errors": [f"技能目录不存在: {skill_dir}"], "warnings": []}
    if not skill_file.exists():
        return {"ok": False, "errors": ["缺少主入口文件"], "warnings": []}

    for item in skill_dir.iterdir():
        if item.name == "SKILL.md":
            continue
        if item.is_dir() and item.name not in ALLOWED_DIRS:
            errors.append(f"不允许的支持目录: {item.name}")
        if item.is_file():
            errors.append(f"技能根目录不应放置额外文件: {item.name}")

    text = skill_file.read_text(encoding="utf-8", errors="replace")
    frontmatter, body, fm_errors = split_frontmatter(text)
    errors.extend(fm_errors)

    name = frontmatter.get("name", "")
    description = frontmatter.get("description", "")
    if not name:
        errors.append("frontmatter 缺少 name")
    elif not NAME_RE.match(name):
        errors.append("name 只能使用小写字母、数字和连字符，且长度不超过 64")
    if not description:
        errors.append("frontmatter 缺少 description")
    elif len(description) > 1024:
        errors.append("description 超过 1024 字符")
    layer = frontmatter.get("layer", "")
    domain = frontmatter.get("domain", "")
    capability_group = frontmatter.get("capability_group", "")
    if not layer:
        errors.append("frontmatter 缺少 layer")
    elif layer not in LAYERS:
        errors.append(f"layer 必须是 {sorted(LAYERS)} 之一")
    if not domain:
        errors.append("frontmatter 缺少 domain")
    elif not META_SLUG_RE.match(domain):
        errors.append("domain 只能使用小写字母、数字和连字符，且长度不超过 64")
    if not capability_group:
        errors.append("frontmatter 缺少 capability_group")
    elif not META_SLUG_RE.match(capability_group):
        errors.append("capability_group 只能使用小写字母、数字和连字符，且长度不超过 64")
    portability = frontmatter.get("portability", "")
    if not portability:
        errors.append("frontmatter 缺少 portability")
    elif portability not in PORTABILITY_VALUES:
        errors.append(f"portability 必须是 {sorted(PORTABILITY_VALUES)} 之一")
    if not body:
        errors.append("正文为空")

    errors.extend(check_trigger_cases(skill_dir))

    refs = find_resource_refs(text)
    for ref in sorted(refs):
        if not (skill_dir / ref).exists():
            errors.append(f"资源引用不存在: {ref}")

    portable = portability == "portable"
    self_prefix = f"ops/skills/{skill_dir.name}/"
    for md_file in iter_markdown_files(skill_dir):
        relpath = md_file.relative_to(skill_dir).as_posix()
        content = md_file.read_text(encoding="utf-8", errors="replace")
        errors.extend(check_absolute_paths(content, relpath))
        if portable:
            errors.extend(check_portable_refs(content, relpath, self_prefix))
        for term in BANNED_TERMS:
            if term in content:
                errors.append(f"{relpath}: 出现来源体系名: {term}")

    return {"ok": not errors, "errors": errors, "warnings": warnings}


def self_test() -> int:
    import tempfile

    failures: list[str] = []

    def run_case(name: str, files: dict[str, str], expect_ok: bool, expect_error: str = "") -> None:
        with tempfile.TemporaryDirectory() as tmp:
            skill = Path(tmp) / "case-skill"
            skill.mkdir()
            for rel, content in files.items():
                target = skill / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            result = validate(skill)
            if result["ok"] != expect_ok:
                failures.append(f"{name}: ok={result['ok']} 预期 {expect_ok}; errors={result['errors']}")
            elif expect_error and not any(expect_error in e for e in result["errors"]):
                failures.append(f"{name}: 未报出包含 '{expect_error}' 的错误; errors={result['errors']}")

    good = (
        "---\nname: demo-skill\nlayer: business\ndomain: demo-domain\n"
        "capability_group: demo-group\nportability: repo-bound\n"
        "description: Use when testing this validator.\n---\n\n"
        "正文：读取 references/guide.md。\n"
    )
    trigger = "# 触发判例\n\n## 正判例\n\n- 用户说要测试这个校验器。\n\n## 反判例\n\n- 用户要改业务代码（命中无技能）。\n"

    def base(skill_md: str) -> dict[str, str]:
        return {
            "SKILL.md": skill_md,
            "references/guide.md": "# guide\n内容。\n",
            "references/trigger-cases.md": trigger,
        }

    run_case("合法技能", base(good), True)
    run_case("缺主入口", {"references/guide.md": "内容。\n", "references/trigger-cases.md": trigger}, False, "缺少主入口文件")
    run_case("frontmatter 不在首字节", base("\n" + good), False, "起始符")
    run_case("name 非法", base(good.replace("demo-skill", "Demo_Skill")), False, "name")
    run_case(
        "缺 description",
        base("---\nname: demo-skill\nlayer: business\ndomain: demo-domain\ncapability_group: demo-group\nportability: repo-bound\n---\n\n正文。\n"),
        False,
        "description",
    )
    run_case("缺 layer", base(good.replace("layer: business\n", "")), False, "layer")
    run_case(
        "非法 capability_group",
        base(good.replace("capability_group: demo-group", "capability_group: Demo_Group")),
        False,
        "capability_group",
    )
    run_case("缺 portability", base(good.replace("portability: repo-bound\n", "")), False, "portability")
    run_case("非法 portability", base(good.replace("portability: repo-bound", "portability: everywhere")), False, "portability")
    run_case(
        "缺 trigger-cases",
        {"SKILL.md": good, "references/guide.md": "# guide\n内容。\n"},
        False,
        "trigger-cases",
    )
    run_case(
        "trigger-cases 缺反判例小节",
        {"SKILL.md": good, "references/guide.md": "# guide\n内容。\n", "references/trigger-cases.md": "# 触发判例\n\n## 正判例\n\n- 一条。\n"},
        False,
        "反判例",
    )
    run_case(
        "trigger-cases 反判例为空",
        {"SKILL.md": good, "references/guide.md": "# guide\n内容。\n", "references/trigger-cases.md": "# 触发判例\n\n## 正判例\n\n- 一条。\n\n## 反判例\n"},
        False,
        "为空",
    )
    run_case("portable 合规", base(good.replace("portability: repo-bound", "portability: portable")), True)
    run_case(
        "portable 越界引用",
        {
            "SKILL.md": good.replace("portability: repo-bound", "portability: portable").replace(
                "正文：读取 references/guide.md。", "正文：见 ops/skills/rule-authoring/SKILL.md 判据。"
            ),
            "references/guide.md": "# guide\n内容。\n",
            "references/trigger-cases.md": trigger,
        },
        False,
        "portable",
    )
    run_case("根目录多余文件", {**base(good), "extra.txt": "x\n"}, False, "额外文件")
    run_case("资源引用不存在", {"SKILL.md": good, "references/trigger-cases.md": trigger}, False, "资源引用不存在")
    run_case(
        "绝对路径",
        {"SKILL.md": good, "references/guide.md": "见 C:\\tools\\x.py\n", "references/trigger-cases.md": trigger},
        False,
        "绝对路径",
    )
    run_case(
        "HTTP链接不是盘符路径",
        {**base(good), "references/guide.md": "见 https://www.anthropic.com/claude/opus 和 http://example.com/model。\n"},
        True,
    )
    run_case(
        "正斜杠盘符路径",
        {**base(good), "references/guide.md": "路径C:/tools/x.py\n"},
        False,
        "绝对路径",
    )
    run_case(
        "来源体系名",
        {"SKILL.md": good, "references/guide.md": "Her" + "mes 相关说明\n", "references/trigger-cases.md": trigger},
        False,
        "来源体系名",
    )

    if failures:
        for line in failures:
            print(f"FAIL {line}")
        return 1
    print("validate_skill_structure self-test: pass")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate mechanical skill structure.")
    parser.add_argument("skill_dir", type=Path, nargs="?")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--self-test", action="store_true", help="run internal mechanical tests")
    args = parser.parse_args()

    if args.self_test:
        return self_test()
    if args.skill_dir is None:
        parser.error("缺少 skill_dir（或使用 --self-test）")

    result = validate(args.skill_dir)
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"ok: {str(result['ok']).lower()}")
        for error in result["errors"]:
            print(f"ERROR: {error}")
        for warning in result["warnings"]:
            print(f"WARN: {warning}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
