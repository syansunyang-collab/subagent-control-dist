#!/usr/bin/env python3
"""Promote named planning interface contracts to locked by exact contract_id."""

from __future__ import annotations

import argparse
import sys
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

sys.dont_write_bytecode = True

try:
    import yaml
except ImportError as exc:  # pragma: no cover - environment failure path
    yaml = None
    YAML_IMPORT_ERROR = exc
else:
    YAML_IMPORT_ERROR = None

from _tool_common import ROOT, ToolError, emit, rel
from _tool_common import load_yaml as read_yaml_mapping


def load_yaml(path: Path) -> dict[str, Any]:
    if yaml is None:
        raise ToolError("PyYAML is required for planning_contract_promote.py") from YAML_IMPORT_ERROR
    return read_yaml_mapping(path, label="contracts")


def contract_map(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = doc.get("interface_contracts")
    if not isinstance(raw, list):
        raise ToolError("interface_contracts must be a list")
    result: dict[str, dict[str, Any]] = {}
    for item in raw:
        contract_id = item.get("contract_id")
        if isinstance(contract_id, str) and contract_id:
            result[contract_id] = item
    return result


def promote_data(
    contracts_path: Path,
    contract_ids: list[str],
    promoted_by: str,
    promoted_at: str,
    dry_run: bool,
) -> dict[str, Any]:
    doc = load_yaml(contracts_path)
    updated = deepcopy(doc)
    contracts = contract_map(updated)
    issues: list[str] = []
    changes: list[dict[str, Any]] = []

    for contract_id in contract_ids:
        item = contracts.get(contract_id)
        if not item:
            issues.append(f"contract_not_found: {contract_id}")
            continue
        before = {
            "contract_id": contract_id,
            "stability": item.get("stability"),
            "promoted_by": item.get("promoted_by"),
            "promoted_at": item.get("promoted_at"),
        }
        if item.get("stability") == "locked" and item.get("promoted_by") not in (None, promoted_by):
            issues.append(f"contract_locked_by_other_source: {contract_id}")
            continue
        effective_promoted_at = promoted_at
        if item.get("stability") == "locked" and item.get("promoted_by") == promoted_by and item.get("promoted_at"):
            effective_promoted_at = item.get("promoted_at")
        item["stability"] = "locked"
        item["promoted_by"] = promoted_by
        item["promoted_at"] = effective_promoted_at
        changes.append(
            {
                "before": before,
                "after": {
                    "contract_id": contract_id,
                    "stability": item.get("stability"),
                    "promoted_by": item.get("promoted_by"),
                    "promoted_at": item.get("promoted_at"),
                },
            }
        )

    status = "pass" if not issues and changes else "fail"
    if status == "pass" and not dry_run:
        contracts_path.write_text(yaml.safe_dump(updated, allow_unicode=True, sort_keys=False), encoding="utf-8")

    return {
        "tool": "planning_contract_promote",
        "status": status,
        "exit_code": 0 if status == "pass" else 1,
        "contracts": rel(contracts_path),
        "contract_ids": contract_ids,
        "promoted_by": promoted_by,
        "promoted_at": promoted_at,
        "dry_run": dry_run,
        "changes": changes,
        "issues": issues,
    }


def build_text(data: dict[str, Any]) -> str:
    lines = [
        "# Planning Contract Promote",
        "",
        f"status: {data['status']}",
        f"contracts: {data['contracts']}",
        f"dry_run: {str(data['dry_run']).lower()}",
        "contract_ids:",
    ]
    lines.extend(f"- {item}" for item in data["contract_ids"])
    if data["issues"]:
        lines.append("issues:")
        lines.extend(f"- {item}" for item in data["issues"])
    return "\n".join(lines)


def self_test() -> dict[str, Any]:
    doc = {
        "interface_contracts": [
            {"contract_id": "C1", "stability": "estimated", "promoted_by": None, "promoted_at": None},
            {"contract_id": "C2", "stability": "estimated", "promoted_by": None, "promoted_at": None},
        ]
    }
    with TemporaryDirectory() as temp:
        path = Path(temp) / "contracts.yaml"
        path.write_text(yaml.safe_dump(doc, allow_unicode=True, sort_keys=False), encoding="utf-8")
        dry = promote_data(path, ["C1"], "fragment.md", "2026-06-23T00:00:00+08:00", dry_run=True)
        after_dry = load_yaml(path)
        applied = promote_data(path, ["C1"], "fragment.md", "2026-06-23T00:00:00+08:00", dry_run=False)
        after_apply = load_yaml(path)
        repeated = promote_data(path, ["C1"], "fragment.md", "2026-06-23T00:01:00+08:00", dry_run=True)
        missing = promote_data(path, ["NOPE"], "fragment.md", "2026-06-23T00:00:00+08:00", dry_run=True)
    checks = {
        "dry_run_does_not_write": after_dry["interface_contracts"][0]["stability"] == "estimated",
        "apply_locks_exact_id": after_apply["interface_contracts"][0]["stability"] == "locked"
        and after_apply["interface_contracts"][1]["stability"] == "estimated",
        "missing_contract_fails": missing["status"] == "fail",
        "status_passes": dry["status"] == "pass" and applied["status"] == "pass",
        "same_source_keeps_promoted_at": repeated["changes"][0]["after"]["promoted_at"]
        == "2026-06-23T00:00:00+08:00",
    }
    return {
        "tool": "planning_contract_promote",
        "status": "pass" if all(checks.values()) else "fail",
        "exit_code": 0 if all(checks.values()) else 1,
        "checks": checks,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Promote planning interface contracts by exact contract_id.")
    parser.add_argument("--contracts", help="Path to notes/manifests/<phase>-interface-contracts.yaml")
    parser.add_argument("--contract-id", action="append", default=[], help="Contract id to promote. Repeat for multiple.")
    parser.add_argument("--promoted-by", help="Fragment or package id that promoted this contract.")
    parser.add_argument("--promoted-at", help="ISO timestamp. Defaults to local current time.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--self-test", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.self_test:
            data = self_test()
            return emit(
                data,
                args.format,
                "planning_contract_promote self-test passed"
                if data["status"] == "pass"
                else "planning_contract_promote self-test failed",
            )
        if not args.contracts:
            raise ToolError("--contracts is required")
        if not args.contract_id:
            raise ToolError("--contract-id is required")
        if not args.promoted_by:
            raise ToolError("--promoted-by is required")
        promoted_at = args.promoted_at or datetime.now().astimezone().isoformat(timespec="seconds")
        data = promote_data((ROOT / args.contracts).resolve(), args.contract_id, args.promoted_by, promoted_at, args.dry_run)
        return emit(data, args.format, build_text(data))
    except ToolError as exc:
        data = {"tool": "planning_contract_promote", "status": "fail", "exit_code": 1, "issues": [str(exc)]}
        return emit(data, args.format, f"# Planning Contract Promote\n\nstatus: fail\nerror: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
