#!/usr/bin/env python3
"""挂账台账(工程债)机械校验与投影工具。

台账真源: notes/ledger/DEBT.toml
用法:
  python ops/tools/ledger_check.py              # 校验 schema 与状态约束
  python ops/tools/ledger_check.py --open       # 输出 open/in_progress 清单(先校验)
  python ops/tools/ledger_check.py --gate       # 关门核对: blocking 级 open/in_progress 非零则退出 1
  python ops/tools/ledger_check.py --self-test  # 自测(含负例)
  python ops/tools/ledger_check.py --ledger <path>  # 指定台账文件(默认仓内真源)

约束(状态不变量,即最小状态迁移合法性):
  - status 闭集: open | in_progress | resolved | waived
  - severity 闭集: blocking | degrading | cosmetic
  - open/in_progress 必填 trigger; resolved 必填 evidence; waived 必填 waived_by
  - id 形如 DEBT-0001 且全局唯一; source 引用的文件必须存在(可带 " ## 节" 后缀)
无第三方依赖(tomllib 为 Python 3.11+ 标准库)。
"""
from __future__ import annotations

import argparse
import re
import sys
import tempfile
import tomllib
from pathlib import Path

# 台账归项目本地：根用独立的项目根（显式 SUBAGENT_PROJECT_ROOT → cwd 上溯），
# 不从脚本 realpath 推项目根；脚本自身位置只用来加载同目录的共享助手。
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _tool_common import ROOT as PROJECT_ROOT  # noqa: E402

DEFAULT_LEDGER = PROJECT_ROOT / "notes" / "ledger" / "DEBT.toml"

ID_RE = re.compile(r"^DEBT-\d{4}$")
STATUSES = ("open", "in_progress", "resolved", "waived")
SEVERITIES = ("blocking", "degrading", "cosmetic")
SEV_RANK = {s: i for i, s in enumerate(SEVERITIES)}
REQUIRED_FIELDS = ("id", "title", "status", "severity", "source")
OPTIONAL_FIELDS = ("trigger", "evidence", "waived_by")
ALLOWED_FIELDS = set(REQUIRED_FIELDS) | set(OPTIONAL_FIELDS)


def _is_nonempty_str(v) -> bool:
    return isinstance(v, str) and v.strip() != ""


def validate_data(data: dict, root: Path | None) -> list[str]:
    """校验台账数据,返回错误清单(空 = pass)。root 非空时校验 source 文件存在性。"""
    errors: list[str] = []
    extra_top = set(data) - {"schema", "debt"}
    if extra_top:
        errors.append(f"顶层出现闭集外键: {sorted(extra_top)}")
    if data.get("schema") != 1:
        errors.append(f"schema 必须为 1,实际: {data.get('schema')!r}")
    debts = data.get("debt", [])
    if not isinstance(debts, list):
        errors.append("[[debt]] 必须为条目数组")
        return errors
    # 空台账合法:模板出厂态与全部清账后的仓都没有条目。

    seen_ids: set[str] = set()
    for idx, entry in enumerate(debts):
        tag = entry.get("id") if isinstance(entry, dict) else None
        tag = tag if _is_nonempty_str(tag) else f"debt[{idx}]"
        if not isinstance(entry, dict):
            errors.append(f"{tag}: 条目不是表")
            continue
        extra = set(entry) - ALLOWED_FIELDS
        if extra:
            errors.append(f"{tag}: 出现字段闭集外键: {sorted(extra)}")
        missing = [f for f in REQUIRED_FIELDS if f not in entry]
        if missing:
            errors.append(f"{tag}: 缺必填字段: {missing}")

        entry_id = entry.get("id")
        if _is_nonempty_str(entry_id):
            if not ID_RE.match(entry_id):
                errors.append(f"{tag}: id 不符合 DEBT-\\d{{4}} 格式")
            if entry_id in seen_ids:
                errors.append(f"{tag}: id 重复")
            seen_ids.add(entry_id)
        elif "id" in entry:
            errors.append(f"{tag}: id 必须为非空字符串")

        if "title" in entry and not _is_nonempty_str(entry.get("title")):
            errors.append(f"{tag}: title 必须为非空字符串")

        status = entry.get("status")
        if "status" in entry and status not in STATUSES:
            errors.append(f"{tag}: 非法状态 {status!r},闭集为 {STATUSES}")
        severity = entry.get("severity")
        if "severity" in entry and severity not in SEVERITIES:
            errors.append(f"{tag}: 非法严重度 {severity!r},闭集为 {SEVERITIES}")

        source = entry.get("source")
        if "source" in entry:
            if not isinstance(source, list) or not source or not all(_is_nonempty_str(s) for s in source):
                errors.append(f"{tag}: source 必须为非空字符串列表")
            elif root is not None:
                for src in source:
                    file_part = src.split(" ")[0]
                    candidate = root / file_part
                    try:
                        inside = candidate.resolve().is_relative_to(root.resolve())
                    except OSError:
                        inside = False
                    if not inside or not candidate.is_file():
                        errors.append(f"{tag}: source 引用不可解析: {file_part}")

        if status in ("open", "in_progress") and not _is_nonempty_str(entry.get("trigger")):
            errors.append(f"{tag}: {status} 状态缺回流触发条件 trigger")
        if status == "resolved" and not _is_nonempty_str(entry.get("evidence")):
            errors.append(f"{tag}: resolved 状态缺关闭证据 evidence")
        if status == "waived" and not _is_nonempty_str(entry.get("waived_by")):
            errors.append(f"{tag}: waived 状态缺 owner 依据 waived_by")
    return errors


def load_ledger(path: Path) -> dict:
    with path.open("rb") as fh:
        return tomllib.load(fh)


def select_open(data: dict) -> list[dict]:
    debts = data.get("debt") or []
    picked = [e for e in debts if e.get("status") in ("open", "in_progress")]
    return sorted(picked, key=lambda e: (SEV_RANK[e["severity"]], e["id"]))


def format_entries(entries: list[dict]) -> str:
    return "\n".join(
        f"{e['id']}  {e['status']:<11}  {e['severity']:<9}  {e['title']}" for e in entries
    )


def cmd_check(data: dict, root: Path | None) -> int:
    errors = validate_data(data, root)
    if errors:
        print("ledger check: FAIL")
        for err in errors:
            print(f"  - {err}")
        return 1
    print(f"ledger check: pass ({len(data.get('debt') or [])} entries)")
    return 0


def cmd_open(data: dict, root: Path | None) -> int:
    errors = validate_data(data, root)
    if errors:
        return cmd_check(data, root)
    entries = select_open(data)
    print(format_entries(entries))
    n_open = sum(1 for e in entries if e["status"] == "open")
    n_prog = len(entries) - n_open
    n_blocking = sum(1 for e in entries if e["severity"] == "blocking")
    print(f"-- open: {n_open}, in_progress: {n_prog}, 其中 blocking 级: {n_blocking}")
    return 0


def cmd_gate(data: dict, root: Path | None) -> int:
    errors = validate_data(data, root)
    if errors:
        return cmd_check(data, root)
    blocking = [e for e in select_open(data) if e["severity"] == "blocking"]
    if blocking:
        print(format_entries(blocking))
        print(f"gate: FAIL — {len(blocking)} 条 blocking 级挂账未清(转 resolved 带证据,或逐条 waived 带 owner 依据)")
        return 1
    print("gate: pass — 无 blocking 级 open/in_progress 挂账")
    return 0


# ---------------- self-test ----------------

_VALID_BASE = """
schema = 1
[[debt]]
id = "DEBT-0001"
title = "开着的债"
status = "open"
severity = "blocking"
source = ["a.md"]
trigger = "下次动 X 时处理"
[[debt]]
id = "DEBT-0002"
title = "进行中的债"
status = "in_progress"
severity = "degrading"
source = ["a.md ## 某节"]
trigger = "本批正在修"
[[debt]]
id = "DEBT-0003"
title = "已解决的债"
status = "resolved"
severity = "degrading"
source = ["a.md"]
evidence = "notes/verify/x.md 实跑记录"
[[debt]]
id = "DEBT-0004"
title = "豁免的债"
status = "waived"
severity = "cosmetic"
source = ["a.md"]
waived_by = "owner 2026-07-15 拍板: 成本收益不成立"
"""


def cmd_self_test() -> int:
    cases: list[tuple[str, str, str | None]] = [
        ("合法台账全 pass", _VALID_BASE, None),
        ("resolved 无证据被拒", _VALID_BASE.replace('evidence = "notes/verify/x.md 实跑记录"', 'evidence = ""'), "resolved 状态缺关闭证据"),
        ("resolved 证据字段缺失被拒", _VALID_BASE.replace('evidence = "notes/verify/x.md 实跑记录"\n', ""), "resolved 状态缺关闭证据"),
        ("waived 无依据被拒", _VALID_BASE.replace('waived_by = "owner 2026-07-15 拍板: 成本收益不成立"\n', ""), "waived 状态缺 owner 依据"),
        ("非法状态被拒", _VALID_BASE.replace('status = "open"', 'status = "done"'), "非法状态"),
        ("非法严重度被拒", _VALID_BASE.replace('severity = "cosmetic"', 'severity = "trivial"'), "非法严重度"),
        ("id 重复被拒", _VALID_BASE.replace('id = "DEBT-0002"', 'id = "DEBT-0001"'), "id 重复"),
        ("id 格式非法被拒", _VALID_BASE.replace('id = "DEBT-0004"', 'id = "DEBT-4"'), "格式"),
        ("open 缺 trigger 被拒", _VALID_BASE.replace('trigger = "下次动 X 时处理"\n', ""), "缺回流触发条件"),
        ("字段闭集外键被拒", _VALID_BASE + '\n[[debt]]\nid = "DEBT-0005"\ntitle = "t"\nstatus = "open"\nseverity = "cosmetic"\nsource = ["a.md"]\ntrigger = "t"\nowner_note = "x"\n', "闭集外键"),
        ("source 空列表被拒", _VALID_BASE.replace('source = ["a.md"]\ntrigger', 'source = []\ntrigger'), "非空字符串列表"),
        ("schema 版本非法被拒", _VALID_BASE.replace("schema = 1", "schema = 2"), "schema 必须为 1"),
    ]

    failures: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "a.md").write_text("stub", encoding="utf-8")
        for name, text, expect in cases:
            errors = validate_data(tomllib.loads(text), root)
            if expect is None:
                if errors:
                    failures.append(f"{name}: 预期 pass,实际错误 {errors}")
            else:
                if not any(expect in e for e in errors):
                    failures.append(f"{name}: 预期含错误「{expect}」,实际 {errors}")

        # 空台账(仅 schema 行,模板出厂态)必须 pass
        errors = validate_data(tomllib.loads("schema = 1\n"), root)
        if errors:
            failures.append(f"空台账应 pass,实际错误 {errors}")

        # source 引用不可解析负例(引用 root 下不存在的文件)
        errors = validate_data(tomllib.loads(_VALID_BASE.replace('source = ["a.md"]\ntrigger', 'source = ["missing.md"]\ntrigger')), root)
        if not any("source 引用不可解析" in e for e in errors):
            failures.append(f"source 不可解析被拒: 实际 {errors}")

        # source 引用目录被拒(必须为文件)
        (root / "somedir").mkdir()
        errors = validate_data(tomllib.loads(_VALID_BASE.replace('source = ["a.md"]\ntrigger', 'source = ["somedir"]\ntrigger')), root)
        if not any("source 引用不可解析" in e for e in errors):
            failures.append(f"source 目录被拒: 实际 {errors}")

        # source 越根引用被拒(../ 逃逸)
        errors = validate_data(tomllib.loads(_VALID_BASE.replace('source = ["a.md"]\ntrigger', 'source = ["../outside.md"]\ntrigger')), root)
        if not any("source 引用不可解析" in e for e in errors):
            failures.append(f"source 越根被拒: 实际 {errors}")

        # --open 投影: 只取 open/in_progress,按严重度排序
        data = tomllib.loads(_VALID_BASE)
        picked = select_open(data)
        if [e["id"] for e in picked] != ["DEBT-0001", "DEBT-0002"]:
            failures.append(f"open 投影错误: {[e['id'] for e in picked]}")

        # gate: blocking open 存在时判 FAIL,清掉后 pass
        blocking = [e for e in select_open(data) if e["severity"] == "blocking"]
        if [e["id"] for e in blocking] != ["DEBT-0001"]:
            failures.append(f"gate blocking 判定错误: {[e['id'] for e in blocking]}")
        cleared = tomllib.loads(_VALID_BASE.replace('severity = "blocking"', 'severity = "degrading"'))
        if [e for e in select_open(cleared) if e["severity"] == "blocking"]:
            failures.append("gate 误报: 无 blocking 仍判非零")

    total = len(cases) + 7
    if failures:
        print(f"self-test: FAIL ({total - len(failures)}/{total})")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"self-test: pass ({total}/{total})")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="挂账台账机械校验与投影")
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER, help="台账文件路径")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--open", action="store_true", help="输出 open/in_progress 清单")
    group.add_argument("--gate", action="store_true", help="关门核对: blocking 级挂账非零则退出 1")
    group.add_argument("--self-test", action="store_true", help="运行自测(含负例)")
    args = parser.parse_args(argv)

    if args.self_test:
        return cmd_self_test()

    ledger_path: Path = args.ledger
    if not ledger_path.exists():
        print(f"台账文件不存在: {ledger_path}")
        return 1
    try:
        data = load_ledger(ledger_path)
    except tomllib.TOMLDecodeError as exc:
        print(f"台账 TOML 解析失败: {exc}")
        return 1
    root = PROJECT_ROOT
    if args.open:
        return cmd_open(data, root)
    if args.gate:
        return cmd_gate(data, root)
    return cmd_check(data, root)


if __name__ == "__main__":
    sys.exit(main())
