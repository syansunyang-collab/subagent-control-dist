#!/usr/bin/env python3
"""Validate Acceptance Contracts and compile validation/rework Fleet DAGs."""

from __future__ import annotations

import argparse
import json
import re
import sys
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

try:
    import yaml
except ImportError as exc:  # pragma: no cover
    yaml = None
    YAML_IMPORT_ERROR = exc
else:
    YAML_IMPORT_ERROR = None

from _tool_common import ROOT, RUNTIME_ROOT, ToolError, add, emit, issue_text, node_json, rel, repo_path
from _tool_common import load_yaml as read_yaml_mapping
from planning_manifest_check import project_lane_scope


# 闭集真源：ops/templates/acceptance-schema.json，Python 与 dispatch-core/seed_minimal.mjs 共读同一份。
ACCEPTANCE_SCHEMA_FILE = RUNTIME_ROOT / "ops" / "templates" / "acceptance-schema.json"
_ACCEPTANCE_SCHEMA = json.loads(ACCEPTANCE_SCHEMA_FILE.read_text(encoding="utf-8"))

SCHEMA_VERSION = _ACCEPTANCE_SCHEMA["schema_version"]
VALIDATION_ROUTES = tuple(_ACCEPTANCE_SCHEMA["validation_routes"])
# 规格锁定了 product_experience(用户可见产物)时,合同至少一条 item 必须交给入口级验证能力;
# 集合约束只看闭集字段,不审 diff、不读语义。
ENTRY_ROUTES = tuple(_ACCEPTANCE_SCHEMA["entry_routes"])
TECHNIQUES = set(_ACCEPTANCE_SCHEMA["techniques"])
CASE_KINDS = set(_ACCEPTANCE_SCHEMA["case_kinds"])
MECHANICAL_SYNC_FORBIDDEN_PREFIXES = (
    "AGENTS.md",
    "ops/agent-prompts",
    "ops/agents",
    "ops/policies",
    "ops/protocols",
    "ops/skills",
    "ops/tools",
    "ops/workflows",
)
SEVERITY_VALUES = set(_ACCEPTANCE_SCHEMA["severity_values"])
DISPOSITIONS = set(_ACCEPTANCE_SCHEMA["dispositions"])
GATE_BY_DISPOSITION = {"pass": "pass", "rework": "fail", "needs_owner": "needs_owner"}
# 验收轮次总预算；前后未决集作为诊断输出，不决定是否续跑。
MAX_REVIEW_ROUNDS = _ACCEPTANCE_SCHEMA["max_review_rounds"]
MACROS = set(_ACCEPTANCE_SCHEMA["macros"])


def load_yaml(path: Path) -> dict[str, Any]:
    if yaml is None:
        raise ToolError("PyYAML is required for acceptance_contract_check.py") from YAML_IMPORT_ERROR
    return read_yaml_mapping(path)


def acceptance_root(doc: dict[str, Any]) -> dict[str, Any]:
    value = doc.get("acceptance_contract", doc)
    if not isinstance(value, dict):
        raise ToolError("acceptance_contract root is not object")
    return value


def dispatch_root(doc: dict[str, Any]) -> dict[str, Any]:
    value = doc.get("dispatch_manifest", doc)
    if not isinstance(value, dict):
        raise ToolError("dispatch_manifest root is not object")
    return value


def string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def unique_strings(value: Any, issues: list[dict[str, str]], location: str, *, nonempty: bool = True) -> list[str]:
    if not isinstance(value, list):
        add(issues, "expected_string_list", location)
        return []
    values = string_list(value)
    if len(values) != len(value):
        add(issues, "string_list_contains_empty_or_non_string", location)
    if len(set(values)) != len(values):
        add(issues, "string_list_contains_duplicates", location)
    if nonempty and not values:
        add(issues, "string_list_empty", location)
    return values


def required_string(obj: dict[str, Any], key: str, issues: list[dict[str, str]], location: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        add(issues, f"missing_{key}", location)
        return ""
    return value.strip()


def get_path(data: dict[str, Any], dotted: str) -> Any:
    current: Any = data
    for part in dotted.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def placeholder_strings(value: Any) -> set[str]:
    if isinstance(value, str):
        return {value} if value.startswith("$") else set()
    if isinstance(value, list):
        return set().union(*(placeholder_strings(item) for item in value)) if value else set()
    if isinstance(value, dict):
        return set().union(*(placeholder_strings(item) for item in value.values())) if value else set()
    return set()


# 编译链已迁到 dispatch-core；本校验器留在 Python，改经 ops/tools/seed_minimal.mjs 取 route 数据。
# 同一 (command, route_id) 在一次运行里会被问很多次，缓存一份再 deepcopy 交出去，调用方照旧可以改。
@lru_cache(maxsize=None)
def _seed_minimal_cached(command: str, route_id: str) -> str:
    return json.dumps(
        node_json(["ops/tools/seed_minimal.mjs", command, "--route-id", route_id])["result"],
        ensure_ascii=False,
    )


def seed_minimal_call(command: str, route_id: str) -> Any:
    return json.loads(_seed_minimal_cached(command, route_id))


def route_contract_requirements() -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for route_id in VALIDATION_ROUTES:
        card = seed_minimal_call("profile", route_id).get("card")
        if not isinstance(card, dict):
            raise ToolError(f"validation route has no route_card: {route_id}")
        result[route_id] = sorted(
            item["path"].removeprefix("contract.")
            for item in card.get("required", [])
            if isinstance(item, dict)
            and isinstance(item.get("path"), str)
            and item["path"].startswith("contract.")
        )
    return result


def acceptance_schema_snapshot() -> dict[str, Any]:
    """Return checker-owned closed sets injected into acceptance authoring tasks."""
    return {
        "source": "ops/tools/acceptance_contract_check.py",
        "schema_version": SCHEMA_VERSION,
        "technique_values": sorted(TECHNIQUES),
        "case_kind_values": sorted(CASE_KINDS),
        "severity_values": sorted(SEVERITY_VALUES),
        "validation_route_values": list(VALIDATION_ROUTES),
        "entry_route_values": list(ENTRY_ROUTES),
        "route_contract_requirements": route_contract_requirements(),
        "route_contract_macros": sorted(MACROS),
        "disposition_values": sorted(DISPOSITIONS),
        "max_review_rounds": MAX_REVIEW_ROUNDS,
    }


def selftest_contract() -> dict[str, Any]:
    """单 item 合同夹具:自测与机械同步模板的基线,不作为出卷示例。"""
    return {
        "acceptance_contract": {
            "schema_version": SCHEMA_VERSION,
            "contract_id": "p1-acceptance",
            "phase_id": "p1",
            "trusted_spec_ref": "notes/context/example-alignment.md#alignment_spec",
            "spec_revision": "locked-1",
            "requirement_ids": ["AS-01"],
            "source_refs": ["notes/context/example-alignment.md"],
            "entry_conditions": ["implementation wave completed"],
            "exit_conditions": ["all blocking acceptance items pass"],
            "items": [
                {
                    "acceptance_id": "AC-01",
                    "requirement_refs": ["AS-01"],
                    "validation_object": "changed code behavior",
                    "oracle": "specified behavior and scoped regression checks pass",
                    "technique": "boundary_value",
                    "cases": [
                        {
                            "case_id": "AC-01-C1",
                            "kind": "positive",
                            "stimulus": "run the specified main path",
                            "expected": "the specified result is produced",
                        },
                        {
                            "case_id": "AC-01-C2",
                            "kind": "boundary",
                            "stimulus": "run the nearest boundary case",
                            "expected": "the boundary result matches the specification",
                        },
                    ],
                    "route_id": "verify-agent__code-verification",
                    "evidence_refs": ["notes/context/example-alignment.md"],
                    "evidence_requirements": ["scoped diff", "test command and result"],
                    "severity": "blocking",
                    "confirmation_scope": ["failed case and repaired surface"],
                    "regression_scope": ["adjacent state transition"],
                    "route_contract": {
                        "verify_mode": "verification",
                        "task_description": "verify the implementation against AS-01",
                        "review_goal": "decide AC-01 with cited evidence",
                        "affected_files": ["$implementation_refs"],
                        "require_test_first_evidence": False,
                        "changed_surfaces": ["state transition"],
                        "allowed_risk_triggers": ["state transition changed"],
                        "disallowed_topics": ["历史遗留与泛化加固"],
                        "issue_admission_required": False,
                    },
                }
            ],
        }
    }


def example_contract() -> dict[str, Any]:
    """出卷示例:用户可见入口交给 functional-inspection,内部不变量交给 code-verification,两套并列。"""
    return {
        "acceptance_contract": {
            "schema_version": SCHEMA_VERSION,
            "contract_id": "p1-acceptance",
            "phase_id": "p1",
            "trusted_spec_ref": "notes/context/example-alignment.md#alignment_spec",
            "spec_revision": "locked-1",
            "requirement_ids": ["AS-01"],
            "source_refs": ["notes/context/example-alignment.md"],
            "entry_conditions": ["implementation wave completed"],
            "exit_conditions": ["all blocking acceptance items pass"],
            "items": [
                {
                    "acceptance_id": "AC-01",
                    "requirement_refs": ["AS-01"],
                    "validation_object": "cli_strict_conflict_rejection",
                    "oracle": (
                        "running the real entrypoint with `--strict --input a.txt --preset demo` exits non-zero "
                        "and stderr names the conflict; running the main path without conflict exits 0 and prints "
                        "the processed target"
                    ),
                    "technique": "example",
                    "cases": [
                        {
                            "case_id": "AC-01-C1",
                            "kind": "negative",
                            "stimulus": "invoke the entrypoint with `--strict --input a.txt --preset demo`",
                            "expected": "exit code is non-zero and stderr contains the conflict message",
                        },
                        {
                            "case_id": "AC-01-C2",
                            "kind": "positive",
                            "stimulus": "invoke the entrypoint with `--strict --input a.txt`",
                            "expected": "exit code is 0 and stdout contains `processed:a.txt`",
                        },
                    ],
                    "route_id": "verify-agent__functional-inspection",
                    "evidence_refs": ["notes/context/example-alignment.md"],
                    "evidence_requirements": ["captured exit codes", "captured stdout/stderr per case"],
                    "severity": "blocking",
                    "confirmation_scope": ["failed case and repaired entrypoint"],
                    "regression_scope": ["other `--strict` argument combinations"],
                    "route_contract": {
                        "inspection_target": "CLI strict-mode conflict handling at the real entrypoint",
                        "source_refs": ["$source_refs"],
                        "entrypoints": ["python -m app.cli"],
                        "input_assets": ["$acceptance_contract_ref"],
                        "artifact_paths": ["test-results/functional-inspection"],
                        "implementation_refs": ["$implementation_refs"],
                        "work_dir": "$verification_work_dir",
                    },
                },
                {
                    "acceptance_id": "AC-02",
                    "requirement_refs": ["AS-01"],
                    "validation_object": "cli_strict_conflict_rejection",
                    "oracle": (
                        "the call site of the conflict check inside `main()` is cited from the diff and the "
                        "scoped regression tests for the check pass"
                    ),
                    "technique": "white_box",
                    "cases": [
                        {
                            "case_id": "AC-02-C1",
                            "kind": "positive",
                            "stimulus": "trace `main()` from argument parsing to target selection",
                            "expected": "the conflict check is invoked on the parsed args before any processing",
                        },
                        {
                            "case_id": "AC-02-C2",
                            "kind": "regression",
                            "stimulus": "run the scoped unit tests for the conflict check",
                            "expected": "all pass and cover the conflicting combination",
                        },
                    ],
                    "route_id": "verify-agent__code-verification",
                    "evidence_refs": ["notes/context/example-alignment.md"],
                    "evidence_requirements": ["scoped diff with cited call site", "test command and result"],
                    "severity": "blocking",
                    "confirmation_scope": ["failed case and repaired call site"],
                    "regression_scope": ["adjacent argument handling"],
                    "route_contract": {
                        "verify_mode": "verification",
                        "task_description": "verify the wiring of the conflict check against AS-01",
                        "review_goal": "decide AC-02 with cited evidence",
                        "affected_files": ["$implementation_refs"],
                        "require_test_first_evidence": False,
                        "changed_surfaces": ["argument handling"],
                        "allowed_risk_triggers": ["entry path changed"],
                        "disallowed_topics": ["历史遗留与泛化加固"],
                        "issue_admission_required": False,
                    },
                },
            ],
        }
    }


def spec_alignment_state(contract: dict[str, Any], *, root: Path = ROOT) -> dict[str, Any] | None:
    """读取 trusted_spec_ref 所在文件的 Alignment State;规格不可定位或无法解析时返回 None。"""
    ref = contract.get("trusted_spec_ref")
    if not isinstance(ref, str) or not ref.strip():
        return None
    candidate = Path(ref.split("#", 1)[0])
    resolved_root = root.resolve()
    resolved = candidate.resolve() if candidate.is_absolute() else (resolved_root / candidate).resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError:
        return None
    if not resolved.is_file():
        return None
    from alignment_guard import extract_alignment_state

    try:
        parsed, problems = extract_alignment_state(resolved)
    except ToolError:
        return None
    if problems or not isinstance(parsed, dict):
        return None
    state = parsed.get("alignment_state", parsed)
    return state if isinstance(state, dict) else None


def spec_product_experience_locked(contract: dict[str, Any], *, root: Path = ROOT) -> bool | None:
    """返回规格 locks.product_experience_locked 是否为 true。

    规格不可定位、无 Alignment State 或该键缺失时返回 None:不新增失败模式,只在能读到锁定事实时施加约束。
    """
    state = spec_alignment_state(contract, root=root)
    locks = state.get("locks") if state else None
    value = locks.get("product_experience_locked") if isinstance(locks, dict) else None
    return value if isinstance(value, bool) else None


def spec_validation_objects(contract: dict[str, Any], *, root: Path = ROOT) -> dict[str, Any] | None:
    """返回规格 alignment_spec 的 spec_id → validation_object。

    读不到 alignment_spec 时返回 None,沿用不新增失败模式的口径;读到了,合同的 requirement_ids 与 validation_object 就必须与之一致。
    """
    state = spec_alignment_state(contract, root=root)
    entries = state.get("alignment_spec") if state else None
    if not isinstance(entries, list):
        return None
    objects = {
        entry["spec_id"].strip(): entry.get("validation_object")
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("spec_id"), str) and entry["spec_id"].strip()
    }
    return objects or None


def validate_contract_data(contract: dict[str, Any], *, root: Path = ROOT) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    if contract.get("schema_version") != SCHEMA_VERSION:
        add(issues, f"schema_version_invalid={contract.get('schema_version')}", "acceptance_contract")
    required_string(contract, "contract_id", issues, "acceptance_contract")
    required_string(contract, "phase_id", issues, "acceptance_contract")
    required_string(contract, "trusted_spec_ref", issues, "acceptance_contract")
    if contract.get("spec_revision") in (None, ""):
        add(issues, "missing_spec_revision", "acceptance_contract")
    requirement_ids = unique_strings(
        contract.get("requirement_ids"), issues, "acceptance_contract.requirement_ids"
    )
    for key in ("source_refs", "entry_conditions", "exit_conditions"):
        unique_strings(contract.get(key), issues, f"acceptance_contract.{key}")

    requirements = set(requirement_ids)
    mechanical_sync = contract.get("mechanical_sync")
    if mechanical_sync is not None:
        if not isinstance(mechanical_sync, dict):
            add(issues, "mechanical_sync_not_object", "acceptance_contract.mechanical_sync")
        else:
            write_paths = unique_strings(
                mechanical_sync.get("write_paths"), issues, "acceptance_contract.mechanical_sync.write_paths"
            )
            for path_value in write_paths:
                try:
                    normalized = repo_path(
                        path_value,
                        "acceptance_contract.mechanical_sync.write_paths",
                        must_exist=False,
                    ).relative_to(ROOT.resolve()).as_posix().casefold()
                except ToolError:
                    add(
                        issues,
                        f"mechanical_sync_write_path_outside_repo={path_value}",
                        "acceptance_contract.mechanical_sync.write_paths",
                    )
                    continue
                if any(
                    normalized == prefix.casefold()
                    or normalized.startswith(prefix.casefold().rstrip("/") + "/")
                    for prefix in MECHANICAL_SYNC_FORBIDDEN_PREFIXES
                ):
                    add(
                        issues,
                        f"mechanical_sync_write_path_forbidden={path_value}",
                        "acceptance_contract.mechanical_sync.write_paths",
                    )
    route_requirements = route_contract_requirements()
    raw_items = contract.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        add(issues, "items_missing", "acceptance_contract.items")
        raw_items = []
    item_ids: set[str] = set()
    covered_requirements: set[str] = set()
    for index, raw_item in enumerate(raw_items):
        location = f"acceptance_contract.items[{index}]"
        if not isinstance(raw_item, dict):
            add(issues, "item_not_object", location)
            continue
        acceptance_id = required_string(raw_item, "acceptance_id", issues, location)
        if acceptance_id:
            if acceptance_id in item_ids:
                add(issues, f"acceptance_id_duplicate={acceptance_id}", location)
            item_ids.add(acceptance_id)
        refs = unique_strings(raw_item.get("requirement_refs"), issues, f"{location}.requirement_refs")
        unknown_refs = sorted(set(refs) - requirements)
        if unknown_refs:
            add(issues, f"requirement_refs_unknown={','.join(unknown_refs)}", location)
        covered_requirements.update(refs)
        required_string(raw_item, "validation_object", issues, location)
        required_string(raw_item, "oracle", issues, location)
        if raw_item.get("technique") not in TECHNIQUES:
            add(issues, f"technique_invalid={raw_item.get('technique')}", location)
        if raw_item.get("severity") not in SEVERITY_VALUES:
            add(issues, f"severity_invalid={raw_item.get('severity')}", location)
        for key in ("evidence_refs", "evidence_requirements", "confirmation_scope", "regression_scope"):
            unique_strings(raw_item.get(key), issues, f"{location}.{key}")

        cases = raw_item.get("cases")
        if not isinstance(cases, list) or not cases:
            add(issues, "cases_missing", f"{location}.cases")
            cases = []
        case_ids: set[str] = set()
        for case_index, case in enumerate(cases):
            case_location = f"{location}.cases[{case_index}]"
            if not isinstance(case, dict):
                add(issues, "case_not_object", case_location)
                continue
            case_id = required_string(case, "case_id", issues, case_location)
            if case_id:
                if case_id in case_ids:
                    add(issues, f"case_id_duplicate={case_id}", case_location)
                case_ids.add(case_id)
            if case.get("kind") not in CASE_KINDS:
                add(issues, f"case_kind_invalid={case.get('kind')}", case_location)
            required_string(case, "stimulus", issues, case_location)
            required_string(case, "expected", issues, case_location)

        route_id = raw_item.get("route_id")
        if route_id not in VALIDATION_ROUTES:
            add(issues, f"route_id_invalid={route_id}", location)
            continue
        route_contract = raw_item.get("route_contract")
        if not isinstance(route_contract, dict):
            add(issues, "route_contract_missing", location)
            continue
        outside_route_contract = {
            key: value for key, value in raw_item.items() if key != "route_contract"
        }
        for placeholder in sorted(placeholder_strings(outside_route_contract)):
            add(issues, f"route_macro_outside_route_contract={placeholder}", location)
        for placeholder in sorted(placeholder_strings(route_contract) - MACROS):
            add(issues, f"route_macro_unknown={placeholder}", f"{location}.route_contract")
        for dotted in route_requirements[route_id]:
            if get_path(route_contract, dotted) in (None, "", [], {}):
                add(issues, f"route_contract_field_missing={dotted}", location)
        if route_id == "verify-agent__code-verification" and route_contract.get("verify_mode") != "verification":
            add(issues, "code_verification_requires_read_only_verification_mode", location)

    uncovered = sorted(requirements - covered_requirements)
    if uncovered:
        add(issues, f"requirements_uncovered={','.join(uncovered)}", "acceptance_contract.items")
    spec_objects = spec_validation_objects(contract, root=root)
    if spec_objects is not None:
        spec_missing = sorted(set(spec_objects) - requirements)
        spec_unknown = sorted(requirements - set(spec_objects))
        if spec_missing:
            add(issues, f"spec_requirements_missing={','.join(spec_missing)}", "acceptance_contract.requirement_ids")
        if spec_unknown:
            add(issues, f"spec_requirements_unknown={','.join(spec_unknown)}", "acceptance_contract.requirement_ids")
        for index, raw_item in enumerate(raw_items):
            if not isinstance(raw_item, dict):
                continue
            value = raw_item.get("validation_object")
            for requirement_ref in string_list(raw_item.get("requirement_refs")):
                expected = spec_objects.get(requirement_ref)
                if requirement_ref in spec_objects and (
                    not isinstance(value, str) or not isinstance(expected, str) or value.strip() != expected.strip()
                ):
                    add(
                        issues,
                        f"validation_object_mismatch={requirement_ref}",
                        f"acceptance_contract.items[{index}].validation_object",
                    )
    if spec_product_experience_locked(contract, root=root) is True and not any(
        isinstance(raw_item, dict) and raw_item.get("route_id") in ENTRY_ROUTES for raw_item in raw_items
    ):
        add(
            issues,
            f"user_visible_spec_without_entry_route=expected_one_of:{'|'.join(ENTRY_ROUTES)}",
            "acceptance_contract.items",
        )
    return {
        "tool": "acceptance_contract_check",
        "check": "contract",
        "status": "pass" if not issues else "fail",
        "exit_code": 0 if not issues else 1,
        "issue_count": len(issues),
        "issues": issues,
        "summary": {
            "contract_id": contract.get("contract_id"),
            "phase_id": contract.get("phase_id"),
            "requirement_count": len(requirement_ids),
            "acceptance_item_count": len(item_ids),
        },
    }


def contract_items(contract: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for item in contract.get("items", []) if isinstance(item, dict)]


def contract_requirement_ids(contract: dict[str, Any]) -> set[str]:
    return set(string_list(contract.get("requirement_ids")))


def topology_requirement_ids(topology: dict[str, Any]) -> set[str]:
    result: set[str] = set()
    for item in topology.get("planning_slices", []):
        if not isinstance(item, dict):
            continue
        objects = item.get("validation_objects")
        if isinstance(objects, dict):
            result.update(str(key) for key in objects if str(key).strip())
        elif isinstance(objects, list):
            for value in objects:
                if isinstance(value, str) and value.strip():
                    result.add(value.strip())
                elif isinstance(value, dict) and isinstance(value.get("requirement_ref"), str):
                    result.add(value["requirement_ref"].strip())
    return result


def build_topology_join_data(contract: dict[str, Any], topology: dict[str, Any]) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    contract_check = validate_contract_data(contract)
    issues.extend(contract_check["issues"])
    if topology.get("phase_id") != contract.get("phase_id"):
        add(issues, "phase_id_mismatch", "topology.phase_id")
    if topology.get("trusted_spec_ref") != contract.get("trusted_spec_ref"):
        add(issues, "trusted_spec_ref_mismatch", "topology.trusted_spec_ref")
    expected = contract_requirement_ids(contract)
    actual = topology_requirement_ids(topology)
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing:
        add(issues, f"topology_requirements_missing={','.join(missing)}", "topology.planning_slices")
    if extra:
        add(issues, f"topology_requirements_unknown={','.join(extra)}", "topology.planning_slices")
    return {
        "tool": "acceptance_contract_check",
        "check": "topology_join",
        "status": "pass" if not issues else "fail",
        "exit_code": 0 if not issues else 1,
        "issue_count": len(issues),
        "issues": issues,
        "summary": {
            "contract_requirements": sorted(expected),
            "topology_requirements": sorted(actual),
        },
    }


def dispatch_lanes(dispatch: dict[str, Any]) -> list[dict[str, Any]]:
    lanes: list[dict[str, Any]] = []
    for wave in dispatch.get("waves", []):
        if not isinstance(wave, dict):
            continue
        wave_number = wave.get("wave")
        for raw_lane in wave.get("lanes", []):
            if isinstance(raw_lane, dict):
                lane = deepcopy(raw_lane)
                lane["_wave"] = wave_number
                lanes.append(lane)
    return lanes


def build_dispatch_join_data(
    contract: dict[str, Any], dispatch: dict[str, Any], contract_ref: str | None = None
) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    contract_check = validate_contract_data(contract)
    issues.extend(contract_check["issues"])
    if dispatch.get("phase_id") != contract.get("phase_id"):
        add(issues, "phase_id_mismatch", "dispatch_manifest.phase_id")
    if dispatch.get("trusted_spec_ref") != contract.get("trusted_spec_ref"):
        add(issues, "trusted_spec_ref_mismatch", "dispatch_manifest.trusted_spec_ref")
    if not isinstance(dispatch.get("acceptance_join_ref"), str) or not dispatch["acceptance_join_ref"].strip():
        add(issues, "acceptance_join_ref_missing", "dispatch_manifest.acceptance_join_ref")
    if contract_ref and dispatch.get("acceptance_contract_ref") != contract_ref:
        add(issues, "acceptance_contract_ref_mismatch", "dispatch_manifest.acceptance_contract_ref")
    expected = contract_requirement_ids(contract)
    actual: set[str] = set()
    mapping: dict[str, list[str]] = {item: [] for item in expected}
    lane_ids: set[str] = set()
    for index, lane in enumerate(dispatch_lanes(dispatch)):
        location = f"dispatch_manifest.lanes[{index}]"
        lane_id = lane.get("lane_id")
        if not isinstance(lane_id, str) or not lane_id.strip():
            add(issues, "lane_id_missing", location)
            continue
        if lane_id in lane_ids:
            add(issues, f"lane_id_duplicate={lane_id}", location)
        lane_ids.add(lane_id)
        validation = lane.get("validation")
        if not isinstance(validation, dict):
            add(issues, "validation_missing", location)
            continue
        refs = unique_strings(
            validation.get("requirement_refs"), issues, f"{location}.validation.requirement_refs"
        )
        actual.update(refs)
        for requirement_ref in refs:
            mapping.setdefault(requirement_ref, []).append(lane_id)
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing:
        add(issues, f"dispatch_requirements_missing={','.join(missing)}", "dispatch_manifest.waves")
    if extra:
        add(issues, f"dispatch_requirements_unknown={','.join(extra)}", "dispatch_manifest.waves")
    return {
        "tool": "acceptance_contract_check",
        "check": "dispatch_join",
        "status": "pass" if not issues else "fail",
        "exit_code": 0 if not issues else 1,
        "issue_count": len(issues),
        "issues": issues,
        "summary": {
            "contract_requirements": sorted(expected),
            "dispatch_requirements": sorted(actual),
            "requirement_lane_map": {key: sorted(value) for key, value in sorted(mapping.items())},
        },
    }


def merge_unique(*values: Any) -> list[str]:
    result: list[str] = []
    for value in values:
        for item in string_list(value):
            if item not in result:
                result.append(item)
    return result


def lane_implementation_refs(lane: dict[str, Any]) -> list[str]:
    validation = lane.get("validation") if isinstance(lane.get("validation"), dict) else {}
    if validation.get("implementation_refs"):
        return merge_unique(validation["implementation_refs"])
    scope = lane.get("scope") if isinstance(lane.get("scope"), dict) else {}
    ownership = lane.get("write_ownership") if isinstance(lane.get("write_ownership"), dict) else {}
    return merge_unique(
        scope.get("write"), ownership.get("direct_paths"), ownership.get("shared_paths")
    )


def expand_review_file_refs(values: Any, *, root: Path = ROOT) -> list[str]:
    """Normalize review read references, leaving directories for on-demand leaf reads."""
    result: list[str] = []
    resolved_root = root.resolve()
    for value in string_list(values):
        candidate = Path(value)
        resolved = candidate.resolve() if candidate.is_absolute() else (resolved_root / candidate).resolve()
        try:
            candidates = [resolved.relative_to(resolved_root).as_posix()]
        except ValueError:
            candidates = [str(resolved)]
        for item in candidates:
            if item not in result:
                result.append(item)
    return result


def existing_file_refs(value: Any, *, root: Path = ROOT) -> list[str]:
    """Collect existing repository files named anywhere in a route contract."""
    result: list[str] = []
    resolved_root = root.resolve()

    def visit(item: Any) -> None:
        if isinstance(item, dict):
            for child in item.values():
                visit(child)
            return
        if isinstance(item, list):
            for child in item:
                visit(child)
            return
        if not isinstance(item, str) or not item.strip():
            return
        candidate = Path(item.split("#", 1)[0])
        resolved = candidate.resolve() if candidate.is_absolute() else (resolved_root / candidate).resolve()
        try:
            relative = resolved.relative_to(resolved_root).as_posix()
        except ValueError:
            return
        if resolved.is_file() and relative not in result:
            result.append(relative)

    visit(value)
    return result


def replace_macros(value: Any, replacements: dict[str, Any]) -> Any:
    if isinstance(value, str):
        return deepcopy(replacements.get(value, value))
    if isinstance(value, list):
        result: list[Any] = []
        for item in value:
            replaced = replace_macros(item, replacements)
            if isinstance(replaced, list):
                result.extend(replaced)
            else:
                result.append(replaced)
        return result
    if isinstance(value, dict):
        return {key: replace_macros(item, replacements) for key, item in value.items()}
    return deepcopy(value)


def safe_id(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized or "item"


def route_short(route_id: str) -> str:
    """`verify-agent__functional-inspection` → `functional-inspection`。"""
    return str(route_id).split("__", 1)[-1] or str(route_id)


def item_is_exclusive(item: dict[str, Any]) -> bool:
    """`exclusive_measurement: true` 的验收项(计时/资源类硬门)必须独占机器测量。"""
    return item.get("exclusive_measurement") is True


def group_items_by_route(items: list[dict[str, Any]]) -> list[tuple[str, list[dict[str, Any]]]]:
    """同 route 且执行参数一致的项合为一叶，保持首次出现顺序。

    执行参数指 work_dir 与非字符串标量（布尔、数字）；描述性文字不同不拆叶，合并时并列保留。
    """
    def scalar_shape(value: Any, key: str = "") -> Any:
        if isinstance(value, dict):
            return {name: scalar_shape(item, name) for name, item in value.items()}
        if isinstance(value, list) or (isinstance(value, str) and key != "work_dir"):
            return None
        return {"scalar": value}

    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in items:
        signature = json.dumps(scalar_shape(item.get("route_contract", {})), sort_keys=True)
        grouped.setdefault((str(item["route_id"]), signature), []).append(item)
    return [(route, group) for (route, _), group in grouped.items()]


def item_acceptance_context(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "acceptance_id": str(item["acceptance_id"]),
        "requirement_refs": item.get("requirement_refs", []),
        "validation_object": item.get("validation_object"),
        "oracle": item.get("oracle"),
        "technique": item.get("technique"),
        "cases": item.get("cases", []),
        "evidence_requirements": item.get("evidence_requirements", []),
        "severity": item.get("severity"),
        "confirmation_scope": item.get("confirmation_scope", []),
        "regression_scope": item.get("regression_scope", []),
    }


def merge_route_contracts(contracts: list[dict[str, Any]]) -> dict[str, Any]:
    """合并已按执行参数分组的 route_contract：列表并集，描述文字并列，执行参数取一。"""
    merged: dict[str, Any] = {}
    for contract in contracts:
        for key, value in contract.items():
            if key not in merged:
                merged[key] = deepcopy(value)
                continue
            current = merged[key]
            if isinstance(current, list) or isinstance(value, list):
                merged[key] = merge_unique(current, value)
            elif isinstance(current, dict) and isinstance(value, dict):
                merged[key] = merge_route_contracts([current, value])
            elif isinstance(current, str) and isinstance(value, str) and value not in current.split("；"):
                merged[key] = f"{current}；{value}" if current else value
    return merged


def leaf_seed(
    items: dict[str, Any] | list[dict[str, Any]],
    contract: dict[str, Any],
    contract_ref: str,
    dispatch_ref: str,
    implementation_refs: list[str],
    *,
    round_number: int,
    variant: str = "",
    change_base: str | None = None,
) -> dict[str, Any]:
    """将同 route 且标量合同一致的一组验收项编为叶子，逐条出结论。"""
    group = [items] if isinstance(items, dict) else list(items)
    if not group:
        raise ToolError("leaf seed requires at least one acceptance item")
    route_id = str(group[0]["route_id"])
    if any(str(item["route_id"]) != route_id for item in group):
        raise ToolError("leaf seed items must share one route_id")
    seed = seed_minimal_call("example-seed", route_id)
    acceptance_ids = [str(item["acceptance_id"]) for item in group]
    route_name = route_short(route_id) + (f"-{variant}" if variant else "")
    # Leaf scope uses the same file-only resolver as route refs: anchors are evidence
    # locations, while dispatch preflight requires the underlying existing file identity.
    source_refs = existing_file_refs(
        merge_unique(*(item.get("evidence_refs") for item in group))
    )
    review_file_refs = expand_review_file_refs(implementation_refs)
    verification_work_dir = (
        f"test-results/{route_name}/"
        f"{safe_id(str(contract.get('contract_id')))}-{safe_id(route_name)}-r{round_number}/"
    )
    replacements = {
        "$acceptance_contract_ref": contract_ref,
        "$dispatch_manifest_ref": dispatch_ref,
        "$implementation_refs": review_file_refs,
        "$source_refs": source_refs,
        "$trusted_spec_ref": contract.get("trusted_spec_ref"),
        "$verification_work_dir": verification_work_dir,
    }
    route_contract = merge_route_contracts(
        [replace_macros(item.get("route_contract", {}), replacements) for item in group]
    )
    if route_id == "verify-agent__code-verification":
        # evidence-only 快路径只对 target 键给全文;把锁定规格文件登记为 truth_sources,
        # 让静态验收者能读到 oracle 背后的规格正文而不是只拿到 hash。
        spec_files = existing_file_refs([str(contract.get("trusted_spec_ref") or "")])
        if spec_files:
            route_contract["truth_sources"] = merge_unique(route_contract.get("truth_sources"), spec_files)
        if change_base and change_base.strip():
            route_contract["change_base"] = change_base.strip()
    route_card = seed_minimal_call("card", route_id) or {}
    route_defaults = replace_macros(route_card.get("contract_defaults", {}), replacements)
    route_read_refs = existing_file_refs([route_defaults, route_contract])
    acceptance_context: dict[str, Any] = {
        "acceptance_ids": acceptance_ids,
        "review_round": round_number,
        "items": [item_acceptance_context(item) for item in group],
    }
    if len(group) == 1:
        # 单项时保留扁平字段,兼容只认单项上下文的读者。
        acceptance_context.update(item_acceptance_context(group[0]))
    route_contract["acceptance_context"] = acceptance_context
    seed["goal"] = (
        f"独立验收 {'、'.join(acceptance_ids)}（{route_name}）：逐条按各自 oracle 施加刺激取证，"
        "每条给出可归并结论。"
    )
    seed["slug"] = f"{safe_id(str(contract.get('contract_id')))}-{safe_id(route_name)}-r{round_number}"
    seed["scope"]["read"] = merge_unique(
        source_refs,
        review_file_refs,
        route_read_refs,
    )
    if route_id == "verify-agent__functional-inspection":
        # 功能巡检在真实入口上施加刺激：合同点名的产物路径可写，真实模型运行需要联网。
        work_dir = route_contract.get("work_dir")
        writes = [work_dir] if isinstance(work_dir, str) and work_dir.strip() else []
        writes += [p for p in string_list(route_contract.get("artifact_paths")) if p.strip()]
        if writes:
            seed["scope"]["write_extra"] = merge_unique(seed["scope"].get("write_extra"), writes)
        seed.setdefault("runtime_context", {})["network_needed"] = "yes"
    seed["contract"] = route_contract
    seed["delegation_intent"] = (
        f"该节点判断 {'、'.join(acceptance_ids)} 这 {len(acceptance_ids)} 条同 route 验收项，逐条给结论；"
        "结果由 acceptance reducer 归并，不要求主代理逐份裁决。"
    )
    return seed


def reducer_seed(
    contract: dict[str, Any],
    contract_ref: str,
    dispatch_ref: str,
    node_map: dict[str, list[str]],
    *,
    round_number: int,
    prior_decision_ref: str | None = None,
    carried_acceptance_ids: list[str] | None = None,
) -> dict[str, Any]:
    seed = seed_minimal_call("example-seed", "verify-agent__acceptance-synthesis")
    seed["goal"] = (
        f"归并 {contract.get('contract_id')} 第 {round_number} 轮验收，"
        "按 Acceptance Contract 裁决 pass、rework 或 needs_owner。"
    )
    seed["slug"] = f"{safe_id(str(contract.get('contract_id')))}-reducer-r{round_number}"
    seed["scope"]["read"] = merge_unique(
        [contract_ref, dispatch_ref, prior_decision_ref or ""],
    )
    seed["contract"] = {
        "acceptance_contract_ref": contract_ref,
        "dispatch_manifest_ref": dispatch_ref,
        "acceptance_ids": [str(item["acceptance_id"]) for item in contract_items(contract)],
        "node_acceptance_map": node_map,
        "review_round": round_number,
        "max_review_rounds": MAX_REVIEW_ROUNDS,
        "prior_decision_ref": prior_decision_ref,
        "carried_acceptance_ids": carried_acceptance_ids or [],
    }
    seed["delegation_intent"] = (
        "该节点负责跨维度去重、冲突和覆盖裁决，输出供确定性 loop 消费的 disposition；"
        "主代理只接 needs_owner。"
    )
    return seed


def fleet_budget(node_count: int) -> dict[str, Any]:
    running = max(1, min(4, node_count))
    return {
        "max_nodes_total": max(node_count, 2),
        "max_running_total": running,
        "max_submitted_per_tick": running,
        "max_high_tier_nodes": max(node_count, 1),
        "max_scope_bytes_total": 50 * 1024 * 1024,
        "max_running_by_role": {},
    }


def compile_validation_manifest(
    contract: dict[str, Any],
    contract_ref: str,
    dispatch: dict[str, Any],
    dispatch_ref: str,
    *,
    round_number: int = 1,
    prior_decision_ref: str | None = None,
    change_base: str | None = None,
) -> dict[str, Any]:
    if not 1 <= round_number <= MAX_REVIEW_ROUNDS:
        raise ToolError(f"validation compile round must be 1..{MAX_REVIEW_ROUNDS}")
    if round_number > 1 and not prior_decision_ref:
        raise ToolError("validation compile round 2 requires prior_decision_ref")
    join = build_dispatch_join_data(contract, dispatch, contract_ref)
    if join["status"] != "pass":
        raise ToolError(
            "acceptance/dispatch join failed: "
            + "; ".join(issue_text(item) for item in join["issues"])
        )
    lanes = dispatch_lanes(dispatch)
    by_requirement: dict[str, list[dict[str, Any]]] = {}
    for lane in lanes:
        validation = lane.get("validation") if isinstance(lane.get("validation"), dict) else {}
        for requirement_ref in string_list(validation.get("requirement_refs")):
            by_requirement.setdefault(requirement_ref, []).append(lane)
    nodes: list[dict[str, Any]] = []
    node_map: dict[str, list[str]] = {}
    exclusive_pending: list[tuple[str, list[dict[str, Any]]]] = []

    def leaf_node(route_id: str, group: list[dict[str, Any]], *, variant: str = "", depends_on: list[str] | None = None) -> None:
        matched_lanes: list[dict[str, Any]] = []
        for item in group:
            for requirement_ref in string_list(item.get("requirement_refs")):
                for lane in by_requirement.get(requirement_ref, []):
                    if lane not in matched_lanes:
                        matched_lanes.append(lane)
        implementation_refs = merge_unique(
            *(lane_implementation_refs(lane) for lane in matched_lanes)
        )
        suffix = f"-{variant}" if variant else ""
        node_id = f"verify-{safe_id(route_short(route_id))}{suffix}"
        base_id = node_id
        index = 2
        while node_id in node_map:
            node_id = f"{base_id}-{index}"
            index += 1
        if node_id != base_id:
            variant = f"{variant}-{index - 1}".strip("-")
        node_map[node_id] = [str(item["acceptance_id"]) for item in group]
        verification_seed = leaf_seed(
            group,
            contract,
            contract_ref,
            dispatch_ref,
            implementation_refs,
            round_number=round_number,
            variant=variant,
            change_base=change_base,
        )
        node: dict[str, Any] = {"id": node_id, "depends_on": list(depends_on or [])}
        if depends_on:
            # 独占测量叶等其他叶终态后单独跑,避免验收自身并发污染计时。
            node["dependency_policy"] = "all_settled"
        node.update(
            {
                "isolation": "same_tree_locked",
                "target_isolation": "read_only",
                "artifact_write_scope": merge_unique(
                    ["notes/verify", "notes/handoffs"],
                    verification_seed.get("scope", {}).get("write_extra"),
                ),
                "seed": verification_seed,
            }
        )
        nodes.append(node)

    # 同 route 且标量合同一致的项复用一个叶子；独占测量另行串行化。
    for route_id, group in group_items_by_route(contract_items(contract)):
        normal = [item for item in group if not item_is_exclusive(item)]
        exclusive = [item for item in group if item_is_exclusive(item)]
        if normal:
            leaf_node(route_id, normal)
        if exclusive:
            exclusive_pending.append((route_id, exclusive))
    for route_id, group in exclusive_pending:
        leaf_node(route_id, group, variant="exclusive", depends_on=list(node_map))
    if len(contract_items(contract)) > 1:
        # 多 item 合同固定挂 reducer(哪怕并桌后只剩一个叶子):逐条 disposition 由 reducer 出。
        reducer_id = f"acceptance-reducer-r{round_number}"
        nodes.append(
            {
                "id": reducer_id,
                "depends_on": list(node_map),
                "dependency_artifacts": ["report"],
                "dependency_policy": "all_settled",
                "isolation": "same_tree_locked",
                "target_isolation": "read_only",
                "artifact_write_scope": ["notes/verify", "notes/handoffs"],
                "seed": reducer_seed(
                    contract,
                    contract_ref,
                    dispatch_ref,
                    node_map,
                    round_number=round_number,
                    prior_decision_ref=prior_decision_ref,
                    carried_acceptance_ids=[],
                ),
            }
        )
    # 单 item 合同不挂 reducer:唯一叶子报告即本轮终态,消费走 --leaf-decision-report 机械转换。
    return {
        "schema_version": 2,
        "run_id": f"acceptance-{safe_id(str(contract.get('contract_id')))}-r{round_number}",
        "defaults": {"isolation": "same_tree_locked", "target_isolation": "read_only"},
        "budget": fleet_budget(len(nodes)),
        "nodes": nodes,
    }


def extract_review_result(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ToolError(f"reducer report not found: {rel(path)}") from exc
    match = re.search(r"```json(?:\s+review_result)?\s*\n([\s\S]*?)\n```", text, flags=re.IGNORECASE)
    if not match:
        raise ToolError("reducer report has no fenced review_result JSON")
    try:
        result = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise ToolError(f"reducer review_result is invalid JSON: {exc}") from exc
    if not isinstance(result, dict):
        raise ToolError("reducer review_result root is not object")
    item_match = re.search(r"```json\s+acceptance_results\s*\n([\s\S]*?)\n```", text)
    if item_match:
        try:
            item_result = json.loads(item_match.group(1))
            result["acceptance_results"] = item_result.get("acceptance_results")
        except (json.JSONDecodeError, AttributeError):
            result["acceptance_results"] = None
    if "output" not in result and "disposition" in result:
        # 四节报告模式:reducer 按能力提示词只放 acceptance-synthesis 的 output 对象;
        # 机械包成 review_result 同构,gate 由 disposition 推出。
        result = {"gate": GATE_BY_DISPOSITION.get(result.get("disposition")), "output": result}
    return result


def validate_decision(result: dict[str, Any], contract: dict[str, Any]) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    output = result.get("output") if isinstance(result.get("output"), dict) else {}
    disposition = output.get("disposition")
    if disposition not in DISPOSITIONS:
        add(issues, f"disposition_invalid={disposition}", "review_result.output")
    expected_ids = {str(item["acceptance_id"]) for item in contract_items(contract)}
    considered = set(
        unique_strings(
            output.get("acceptance_ids_considered"),
            issues,
            "review_result.output.acceptance_ids_considered",
        )
    )
    failed = set(
        unique_strings(
            output.get("failed_acceptance_ids"),
            issues,
            "review_result.output.failed_acceptance_ids",
            nonempty=False,
        )
    )
    confirmation = set(
        unique_strings(
            output.get("confirmation_acceptance_ids"),
            issues,
            "review_result.output.confirmation_acceptance_ids",
            nonempty=False,
        )
    )
    regression = set(
        unique_strings(
            output.get("regression_acceptance_ids"),
            issues,
            "review_result.output.regression_acceptance_ids",
            nonempty=False,
        )
    )
    coverage = output.get("coverage") if isinstance(output.get("coverage"), dict) else {}
    coverage_sets: dict[str, set[str]] = {}
    for key in ("passed", "failed", "uncertain", "missing"):
        coverage_sets[key] = set(
            unique_strings(
                coverage.get(key),
                issues,
                f"review_result.output.coverage.{key}",
                nonempty=False,
            )
        )
    if considered != expected_ids:
        add(issues, "acceptance_ids_considered_mismatch", "review_result.output")
    coverage_values = [item for values in coverage_sets.values() for item in values]
    if set(coverage_values) != expected_ids or len(coverage_values) != len(expected_ids):
        add(issues, "coverage_partition_mismatch", "review_result.output.coverage")
    for label, values in (
        ("failed", failed),
        ("confirmation", confirmation),
        ("regression", regression),
    ):
        unknown = sorted(values - expected_ids)
        if unknown:
            add(issues, f"{label}_acceptance_ids_unknown={','.join(unknown)}", "review_result.output")
    blocking_ids = {
        str(item["acceptance_id"]) for item in contract_items(contract)
        if item.get("severity") != "non_blocking"
    }
    uncertainty = output.get("uncertainty", {})
    if not isinstance(uncertainty, dict):
        add(issues, "uncertainty_expected_object", "review_result.output.uncertainty")
        uncertainty = {}
    evidence_uncertain = set(string_list(uncertainty.get("evidence")))
    gate = result.get("gate")
    if failed != coverage_sets["failed"]:
        add(issues, "failed_ids_coverage_mismatch", "review_result.output")
    if disposition == "pass" and (
        gate != "pass"
        or confirmation
        or regression
        or not coverage_sets["passed"]
        or not blocking_ids.issubset(coverage_sets["passed"])
    ):
        add(issues, "pass_disposition_inconsistent", "review_result")
    # rework 沿用既有协议：产品失败修复，未取证只确认；格式缺口先补回执。
    if disposition == "rework" and (gate != "fail" or not (failed or coverage_sets["uncertain"])):
        add(issues, "rework_disposition_inconsistent", "review_result")
    if disposition == "rework" and (
        coverage_sets["missing"] or evidence_uncertain
        or not coverage_sets["uncertain"].issubset(confirmation)
    ):
        add(issues, "rework_requires_complete_evidence", "review_result.output.coverage")
    if disposition == "needs_owner" and gate != "needs_owner":
        add(issues, "needs_owner_disposition_inconsistent", "review_result")
    if disposition == "rework" and not failed.issubset(confirmation):
        add(issues, "failed_ids_missing_from_confirmation", "review_result.output")
    return {
        "tool": "acceptance_contract_check",
        "check": "reducer_decision",
        "status": "pass" if not issues else "fail",
        "exit_code": 0 if not issues else 1,
        "issue_count": len(issues),
        "issues": issues,
        "summary": {
            "disposition": disposition,
            "failed_acceptance_ids": sorted(failed),
            "confirmation_acceptance_ids": sorted(confirmation),
            "regression_acceptance_ids": sorted(regression),
            "passed_acceptance_ids": sorted(coverage_sets["passed"]),
            "uncertain_acceptance_ids": sorted(coverage_sets["uncertain"]),
            "missing_acceptance_ids": sorted(coverage_sets["missing"]),
            "evidence_uncertain_acceptance_ids": sorted(evidence_uncertain),
        },
    }


LEAF_GATES = {"fail", "needs_owner", "pass"}


def leaf_decision_from_report(result: dict[str, Any], contract: dict[str, Any]) -> dict[str, Any]:
    """把单 item 合同的叶子 review_result 机械转换为 reducer decision 同构结构。"""
    items = contract_items(contract)
    if len(items) != 1:
        raise ToolError("leaf decision consumption is only valid for single-item contracts")
    acceptance_id = str(items[0]["acceptance_id"])
    entries = result.get("acceptance_results")
    matches = [entry for entry in entries
               if isinstance(entry, dict) and entry.get("acceptance_id") == acceptance_id] \
        if isinstance(entries, list) else []
    gate = matches[0].get("gate") if len(matches) == 1 else None
    missing = gate not in LEAF_GATES
    if missing:
        gate = "needs_owner"
    raw_findings = result.get("findings")
    if raw_findings is None:
        raw_findings = []
    if not isinstance(raw_findings, list):
        raise ToolError("leaf report findings must be a list when present")
    findings = raw_findings
    for index, finding in enumerate(findings):
        if not isinstance(finding, dict):
            raise ToolError(f"leaf report findings[{index}] is not an object")
        refs = finding.get("acceptance_refs")
        if refs is not None:
            unknown = sorted(set(string_list(refs)) - {acceptance_id})
            if unknown:
                raise ToolError(
                    f"leaf report findings[{index}] references foreign acceptance ids: {','.join(unknown)}"
                )
    if gate == "fail" and not findings:
        raise ToolError("leaf report gate=fail requires at least one finding")
    raw_gaps = result.get("evidence_gaps")
    if raw_gaps is None:
        raw_gaps = []
    if not isinstance(raw_gaps, list):
        raise ToolError("leaf report evidence_gaps must be a list when present")
    evidence_gaps = list(raw_gaps)
    if missing:
        evidence_gaps.append({"type": "producer", "acceptance_ids": [acceptance_id],
                              "gap": "补齐该项 acceptance_results 后重新消费；复用已有证据。"})
    if gate == "pass" and findings:
        raise ToolError("leaf report gate=pass cannot carry findings")
    if gate == "pass" and evidence_gaps:
        raise ToolError("leaf report gate=pass cannot carry evidence_gaps")
    if gate == "pass":
        disposition = "pass"
        failed: list[str] = []
        confirmation: list[str] = []
        coverage = {"passed": [acceptance_id], "failed": [], "uncertain": [], "missing": []}
    elif gate == "fail":
        disposition = "rework"
        failed = [acceptance_id]
        confirmation = [acceptance_id]
        coverage = {"passed": [], "failed": [acceptance_id], "uncertain": [], "missing": []}
    else:
        gap_types = {gap.get("type") for gap in evidence_gaps if isinstance(gap, dict)}
        retryable = bool(gap_types) and gap_types <= {"environment", "unverified"}
        disposition = "rework" if retryable and not missing else "needs_owner"
        failed = []
        confirmation = [acceptance_id] if disposition == "rework" else []
        coverage = {"passed": [], "failed": [],
                    "uncertain": [] if missing else [acceptance_id],
                    "missing": [acceptance_id] if missing else []}
    return {
        "schema_version": result.get("schema_version", 1),
        "gate": GATE_BY_DISPOSITION[disposition],
        "summary": str(result.get("summary") or "leaf decision derived mechanically"),
        "findings": findings,
        "evidence_gaps": evidence_gaps,
        "scope": result.get("scope") if isinstance(result.get("scope"), dict) else {},
        "output": {
            "disposition": disposition,
            "acceptance_ids_considered": [acceptance_id],
            "failed_acceptance_ids": failed,
            "confirmation_acceptance_ids": confirmation,
            "regression_acceptance_ids": [],
            "coverage": coverage,
        },
    }


def authoritative_report_paths(task_root: Path, task_id: str) -> list[Path]:
    """从 task 运行产物反查该 task 声明的权威报告路径集合。"""
    task_dir = task_root / task_id
    candidates: list[Path] = [task_dir / "report.md", task_dir / "child-final.md"]
    for meta_name in ("result.json", "status.json"):
        meta_path = task_dir / meta_name
        if not meta_path.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ToolError(f"invalid bound task metadata: {meta_path}") from exc
        artifacts = meta.get("artifacts") if isinstance(meta.get("artifacts"), dict) else {}
        for value in (*(meta.get(key) for key in ("business_report_path", "declared_report_path", "report")),
                      artifacts.get("report_path")):
            if isinstance(value, str) and value.strip():
                candidates.append(Path(value))
    return [candidate.resolve() for candidate in candidates]


def verify_leaf_origin(
    state_doc: dict[str, Any],
    leaf_node: str,
    source_task: str | None,
    report_path: Path,
    *,
    task_root: Path,
    label: str = "leaf",
) -> dict[str, Any]:
    """核对报告来源(报告来源纪律的机械执行;叶子与 reducer 报告共用同一权威链)。

    权威链:Fleet state 当前绑定 task_id → 该 task 运行产物声明的报告路径 → 与被消费报告做
    规范化精确比较。路径字符串包含、调用者单方断言都不构成来源证据;--source-task 只作交叉断言。
    label 只影响错误文本,不改判定。
    """
    nodes = state_doc.get("nodes") if isinstance(state_doc.get("nodes"), list) else []
    node = next((item for item in nodes if isinstance(item, dict) and str(item.get("id")) == leaf_node), None)
    if node is None:
        raise ToolError(f"{label} node not found in fleet state: {leaf_node}")
    bound_task = str(node.get("task_id") or "")
    if not bound_task:
        raise ToolError(f"{label} node has no bound task_id in fleet state: {leaf_node}")
    asserted = str(source_task or "")
    if asserted and asserted != bound_task:
        raise ToolError(f"{label} report origin mismatch: fleet state binds {bound_task}, caller asserts {asserted}")
    authoritative = authoritative_report_paths(task_root, bound_task)
    if not authoritative:
        raise ToolError(f"bound task has no authoritative report artifacts under task root: {bound_task}")
    resolved_report = report_path.resolve()
    if resolved_report not in authoritative:
        raise ToolError(
            f"{label} report is not an authoritative artifact of the bound task; "
            f"expected one of the task-declared report paths for {bound_task}"
        )
    return {"node": leaf_node, "task_id": bound_task, "report": str(resolved_report)}


def previous_decision_result(args: argparse.Namespace) -> dict[str, Any] | None:
    """上一轮 reducer 报告的原始 review_result;未提供时返回 None(校验留给调用方)。"""
    if not args.previous_decision_report:
        return None
    return extract_review_result(
        repo_path(args.previous_decision_report, "previous decision report", must_exist=True)
    )


def task_root_path(value: str) -> Path:
    """任务根是目录:沿用仓库逃逸检查,但不套用 repo_path 的文件存在性判据。"""
    path = Path(value)
    resolved = path.resolve() if path.is_absolute() else (ROOT / path).resolve()
    try:
        resolved.relative_to(ROOT.resolve())
    except ValueError as exc:
        raise ToolError(f"task root escapes repository: {value}") from exc
    if not resolved.is_dir():
        raise ToolError(f"task root is not a readable directory: {value}")
    return resolved


def fleet_report_origin(args: argparse.Namespace, report_path: Path, *, label: str) -> dict[str, Any]:
    """按 Fleet state 当前绑定 task 核对报告来源;label 只影响错误文本。"""
    state_path = repo_path(args.fleet_state, "fleet state", must_exist=True)
    state_doc = json.loads(state_path.read_text(encoding="utf-8"))
    binding = verify_leaf_origin(
        state_doc,
        args.leaf_node,
        args.source_task,
        report_path,
        task_root=task_root_path(args.task_root),
        label=label,
    )
    return {"binding": "fleet", "label": label, **binding}


def resolve_decision_report(
    args: argparse.Namespace, contract: dict[str, Any]
) -> tuple[Path, dict[str, Any], dict[str, Any]]:
    """读取被消费的 leaf/reducer 报告并做来源绑定,返回 (报告路径, review_result, 来源记录)。

    叶子报告沿用默认必带的 Fleet 绑定;reducer 报告复用同一绑定能力,但历史未带绑定参数的
    调用继续可用(binding=unbound),不升级为硬门;--standalone-leaf 是显式的非 Fleet 路径。
    """
    if args.decision_report and args.leaf_decision_report:
        raise ToolError("choose only one of --decision-report or --leaf-decision-report")
    is_leaf = bool(args.leaf_decision_report)
    label = "leaf" if is_leaf else "reducer"
    report_path = repo_path(
        args.leaf_decision_report or args.decision_report, f"{label} decision report", must_exist=True
    )
    if args.standalone_leaf:
        if args.fleet_state or args.leaf_node or args.source_task:
            raise ToolError("--standalone-leaf cannot be combined with fleet origin binding options")
        origin = {"binding": "standalone", "label": label}
    elif args.fleet_state and args.leaf_node:
        origin = fleet_report_origin(args, report_path, label=label)
    elif is_leaf:
        raise ToolError(
            "leaf consumption requires --fleet-state and --leaf-node; "
            "pass --standalone-leaf explicitly for non-fleet leaf reports"
        )
    elif args.fleet_state or args.leaf_node or args.source_task:
        raise ToolError("decision report origin binding requires both --fleet-state and --leaf-node")
    else:
        origin = {"binding": "unbound", "label": "reducer"}
    result = extract_review_result(report_path)
    return report_path, leaf_decision_from_report(result, contract) if is_leaf else result, origin


def convergence_text(data: dict[str, Any]) -> str:
    """--check-convergence 的文本投影:一行业务出口,不落 manifest。"""
    if data.get("status") != "pass":
        return "convergence_preview status=fail; " + "; ".join(
            issue_text(item) for item in data.get("issues", [])
        )
    return " ".join(
        [
            "convergence_preview",
            f"action={data.get('action')}",
            f"reason={data.get('reason')}",
            f"round={data.get('round')}",
            f"next_round={data.get('next_round')}",
            f"open={','.join(data.get('open_acceptance_ids') or [])}",
            f"carried={','.join(data.get('carried_acceptance_ids') or [])}",
        ]
    )


def mechanical_sync_template() -> dict[str, Any]:
    """机械同步类任务的单 item 合同骨架:主代理直填,不派 acceptance authoring。"""
    data = selftest_contract()
    contract = data["acceptance_contract"]
    contract["contract_id"] = "<phase>-mechanical-sync-acceptance"
    contract["phase_id"] = "<phase>"
    contract["trusted_spec_ref"] = "<notes/context/…-alignment.md>#alignment_spec"
    contract["spec_revision"] = "<locked revision>"
    contract["requirement_ids"] = ["<AS-nn>"]
    contract["source_refs"] = ["<notes/context/…-alignment.md>"]
    contract["entry_conditions"] = ["机械同步动作已执行完毕"]
    contract["exit_conditions"] = ["同步目标与来源一致；写域未触及规则对象"]
    contract["mechanical_sync"] = {"write_paths": ["<实际写入的目标路径，逐项列出>"]}
    item = contract["items"][0]
    item["acceptance_id"] = "<AC-nn>"
    item["requirement_refs"] = ["<AS-nn>"]
    item["validation_object"] = "<同步目标文件集>与<来源>的一致性"
    item["oracle"] = "同步目标与来源逐项一致，写域不含 AGENTS、workflow、policy、protocol、agent-prompt 等规则对象"
    item["technique"] = "example"
    item["cases"] = [
        {
            "case_id": "<AC-nn>-C1",
            "kind": "positive",
            "stimulus": "逐项比对同步目标与来源",
            "expected": "全部一致，无多余或缺失条目",
        },
        {
            "case_id": "<AC-nn>-C2",
            "kind": "negative",
            "stimulus": "检查实际写入路径清单",
            "expected": "不含规则对象路径",
        },
    ]
    item["evidence_refs"] = ["<notes/context/…-alignment.md>"]
    item["evidence_requirements"] = ["同步目标与来源的比对结果", "实际写入路径清单"]
    item["confirmation_scope"] = ["不一致条目与其修复"]
    item["regression_scope"] = ["同批同步的相邻目标"]
    route_contract = item["route_contract"]
    route_contract["task_description"] = "核验机械同步目标与来源的一致性及实际写入路径"
    route_contract["review_goal"] = "按当前单项验收合同判定机械同步结果"
    route_contract["changed_surfaces"] = ["机械同步目标文件集"]
    route_contract["allowed_risk_triggers"] = ["同步范围含新增或删除文件"]
    return data


def repair_seed(
    lane: dict[str, Any],
    contract: dict[str, Any],
    dispatch_ref: str,
    decision_ref: str,
    acceptance_ids: list[str],
    *,
    round_number: int,
) -> dict[str, Any]:
    lane_id = str(lane["lane_id"])
    scope = lane.get("scope") if isinstance(lane.get("scope"), dict) else {}
    writes = string_list(scope.get("write"))
    seed = seed_minimal_call("example-seed", "executor-agent__plan-execution")
    seed["goal"] = (
        f"定向修复 lane {lane_id} 的验收失败项 {', '.join(acceptance_ids)}；"
        "不扩大原 lane 写域。"
    )
    seed["slug"] = f"{safe_id(str(contract.get('contract_id')))}/{safe_id(str(contract.get('contract_id')))}-{safe_id(lane_id)}-repair-r{round_number}-SUMMARY"
    trusted_spec_path = str(contract.get("trusted_spec_ref") or "").split("#", 1)[0]
    seed["scope"] = project_lane_scope(scope, merge_unique(
        [dispatch_ref, decision_ref, trusted_spec_path],
        scope.get("read"),
        writes,
        scope.get("delete"),
    ))
    validation = deepcopy(lane.get("validation") or {})
    validation["failed_acceptance_ids"] = acceptance_ids
    seed["contract"] = {
        "dispatch_manifest_ref": dispatch_ref,
        "trusted_spec_ref": contract.get("trusted_spec_ref"),
        "lane_id": lane_id,
        "planning_wave": lane.get("_wave"),
        "task": f"{lane.get('task')}；只修复 reducer 指向的验收失败项 {acceptance_ids}",
        "scope": scope,
        "validation": validation,
        "lane_execution_mode": lane.get("mode"),
        "dependency_edges": lane.get("dependency_edges", []),
        "resource_locks": lane.get("resource_locks", []),
        "write_ownership": lane.get("write_ownership", {"direct_paths": writes, "shared_paths": []}),
        "execution_adjustment_policy": {
            "local_adjustment_allowed": True,
            "plan_return_only_for": [
                "target_changed",
                "validation_object_changed",
                "scope_expansion_required",
                "exclusive_resource_blocked",
                "unresolvable_dispatch_direction",
            ],
        },
    }
    seed["known_facts"] = [
        f"reducer_decision_ref={decision_ref}",
        f"failed_acceptance_ids={json.dumps(acceptance_ids, ensure_ascii=False)}",
    ]
    seed["delegation_intent"] = (
        "Reducer 已完成失败定位；该节点只执行确定的 lane 内返工，结果释放对应确认验收。"
    )
    return seed


def decision_open_ids(decision: dict[str, Any]) -> list[str]:
    """诊断未决集包含产品失败、未验证与缺失回执。"""
    summary = decision.get("summary") if isinstance(decision.get("summary"), dict) else {}
    return sorted(
        set(string_list(summary.get("failed_acceptance_ids")))
        | set(string_list(summary.get("uncertain_acceptance_ids")))
        | set(string_list(summary.get("missing_acceptance_ids")))
    )


def decision_carried_ids(decision: dict[str, Any]) -> list[str]:
    """本轮不再重跑的已通过项:passed 去掉被点名确认/回归的项。"""
    summary = decision.get("summary") if isinstance(decision.get("summary"), dict) else {}
    verify_ids = set(string_list(summary.get("confirmation_acceptance_ids"))) | set(
        string_list(summary.get("regression_acceptance_ids"))
    )
    return sorted(set(string_list(summary.get("passed_acceptance_ids"))) - verify_ids)


def followup_outcome(
    contract: dict[str, Any],
    decision: dict[str, Any],
    *,
    current_round: int,
    previous_result: dict[str, Any] | None = None,
    owner_resolved: bool = False,
) -> dict[str, Any]:
    """预览、消费和编译共用返工判断；历史报告可选，提供时校验并输出未决集。"""
    summary = decision["summary"]
    disposition = summary["disposition"]
    outcome: dict[str, Any] = {
        "action": "reject_invalid_decision",
        "reason": None,
        "disposition": disposition,
        "round": current_round,
        "next_round": None,
        "open_acceptance_ids": decision_open_ids(decision),
        "previous_open_acceptance_ids": None,
        "carried_acceptance_ids": [],
    }
    if disposition == "pass":
        outcome.update(action="close", reason="acceptance_passed")
        return outcome
    outcome["carried_acceptance_ids"] = decision_carried_ids(decision)
    if summary.get("missing_acceptance_ids"):
        outcome.update(action="repair_reports", reason="producer_results_missing")
        return outcome
    if disposition == "needs_owner" and not owner_resolved:
        outcome.update(action="escalate", reason="reducer_needs_owner")
        return outcome
    # owner 以 --owner-resolution-ref 记录裁决后，needs_owner 按同一返工判据定向续跑，已通过项照常 carried。
    if disposition not in ("rework", "needs_owner"):
        return outcome
    if current_round >= MAX_REVIEW_ROUNDS:
        outcome.update(action="escalate", reason="review_round_limit_reached")
        return outcome
    if previous_result is not None:
        previous_decision = validate_decision(previous_result, contract)
        if previous_decision["status"] != "pass":
            raise ToolError(
                "previous reducer decision invalid: "
                + "; ".join(issue_text(item) for item in previous_decision["issues"])
            )
        outcome["previous_open_acceptance_ids"] = decision_open_ids(previous_decision)
    outcome.update(
        action="dispatch_rework",
        reason="owner_resolved_rework" if disposition == "needs_owner" else "targeted_rework",
        next_round=current_round + 1,
    )
    return outcome


def followup_blocked_message(outcome: dict[str, Any]) -> str:
    """把非 dispatch_rework 出口渲染成编译路径的 ToolError 文本(沿用既有消息与拒绝语义)。"""
    if outcome.get("reason") == "review_round_limit_reached":
        return f"review round limit reached ({MAX_REVIEW_ROUNDS}); unresolved rework requires needs_owner"
    return "follow-up manifest is only valid for disposition=rework"


def compile_followup_manifest(
    contract: dict[str, Any],
    contract_ref: str,
    dispatch: dict[str, Any],
    dispatch_ref: str,
    result: dict[str, Any],
    decision_ref: str,
    *,
    current_round: int,
    previous_result: dict[str, Any] | None = None,
    owner_resolved: bool = False,
    change_base: str | None = None,
) -> dict[str, Any]:
    decision = validate_decision(result, contract)
    if decision["status"] != "pass":
        raise ToolError(
            "reducer decision invalid: "
            + "; ".join(issue_text(item) for item in decision["issues"])
        )
    # 与只读预览共用预算和裁决判断；未决集变化仅供主代理诊断。
    outcome = followup_outcome(
        contract,
        decision,
        current_round=current_round,
        previous_result=previous_result,
        owner_resolved=owner_resolved,
    )
    if outcome["action"] != "dispatch_rework":
        raise ToolError(followup_blocked_message(outcome))
    next_round = current_round + 1
    failed_ids = set(decision["summary"]["failed_acceptance_ids"])
    confirmation_ids = set(decision["summary"]["confirmation_acceptance_ids"])
    regression_ids = set(decision["summary"]["regression_acceptance_ids"])
    items = {str(item["acceptance_id"]): item for item in contract_items(contract)}
    failed_requirements: set[str] = set()
    for acceptance_id in failed_ids:
        failed_requirements.update(string_list(items[acceptance_id].get("requirement_refs")))

    lanes = dispatch_lanes(dispatch)
    impacted_lanes: list[dict[str, Any]] = []
    for lane in lanes:
        validation = lane.get("validation") if isinstance(lane.get("validation"), dict) else {}
        if failed_requirements.intersection(string_list(validation.get("requirement_refs"))):
            impacted_lanes.append(lane)
    if failed_ids and not impacted_lanes:
        raise ToolError("reducer failed acceptance IDs map to no dispatch lanes")
    # 只有 failed 项映射产品返工 lane；未取证项仅进入确认叶子。

    lane_to_failed: dict[str, list[str]] = {}
    for lane in impacted_lanes:
        lane_requirements = set(string_list((lane.get("validation") or {}).get("requirement_refs")))
        lane_to_failed[str(lane["lane_id"])] = sorted(
            acceptance_id
            for acceptance_id in failed_ids
            if lane_requirements.intersection(string_list(items[acceptance_id].get("requirement_refs")))
        )

    nodes: list[dict[str, Any]] = []
    repair_node_ids: dict[str, str] = {}
    impacted_ids = {str(lane["lane_id"]) for lane in impacted_lanes}
    for lane in impacted_lanes:
        lane_id = str(lane["lane_id"])
        node_id = f"repair-{safe_id(lane_id)}"
        repair_node_ids[lane_id] = node_id
        dependencies = [
            repair_node_ids.get(str(dep), f"repair-{safe_id(str(dep))}")
            for dep in lane.get("depends_on", [])
            if str(dep) in impacted_ids
        ]
        nodes.append(
            {
                "id": node_id,
                "depends_on": dependencies,
                "isolation": "same_tree_locked",
                "target_isolation": "writable",
                "write_scope": merge_unique(
                    (lane.get("scope") or {}).get("write"),
                    (lane.get("scope") or {}).get("delete"),
                ),
                "seed": repair_seed(
                    lane,
                    contract,
                    dispatch_ref,
                    decision_ref,
                    lane_to_failed[lane_id],
                    round_number=next_round,
                ),
            }
        )

    # owner 裁决解除的是 needs_owner 未决项,这些项随复验叶子一并重出结论。
    owner_ids = set(decision["summary"]["uncertain_acceptance_ids"]) if owner_resolved else set()
    verify_ids = sorted(confirmation_ids | regression_ids | owner_ids)
    verifier_node_map: dict[str, list[str]] = {}
    # 全量 lanes 提供复验读域；repair_node_ids 仅由失败 lanes 产生。
    candidate_lanes = lanes

    def confirm_leaf(route_id: str, group: list[dict[str, Any]], *, variant: str = "", extra_deps: list[str] | None = None) -> None:
        matched_lanes: list[dict[str, Any]] = []
        for item in group:
            requirement_refs = set(string_list(item.get("requirement_refs")))
            for lane in candidate_lanes:
                if lane not in matched_lanes and requirement_refs.intersection(
                    string_list((lane.get("validation") or {}).get("requirement_refs"))
                ):
                    matched_lanes.append(lane)
        dependencies = merge_unique(
            [repair_node_ids[str(lane["lane_id"])] for lane in matched_lanes if str(lane["lane_id"]) in repair_node_ids]
        )
        if not dependencies:
            dependencies = list(repair_node_ids.values())
        implementation_refs = merge_unique(
            *(lane_implementation_refs(lane) for lane in matched_lanes or candidate_lanes)
        )
        suffix = f"-{variant}" if variant else ""
        node_id = f"confirm-{safe_id(route_short(route_id))}{suffix}"
        base_id = node_id
        index = 2
        while node_id in verifier_node_map:
            node_id = f"{base_id}-{index}"
            index += 1
        if node_id != base_id:
            variant = f"{variant}-{index - 1}".strip("-")
        verifier_node_map[node_id] = [str(item["acceptance_id"]) for item in group]
        verification_seed = leaf_seed(
            group,
            contract,
            contract_ref,
            dispatch_ref,
            implementation_refs,
            round_number=next_round,
            variant=variant,
            change_base=change_base,
        )
        dependencies = merge_unique(dependencies, extra_deps or [])
        confirm_node: dict[str, Any] = {"id": node_id, "depends_on": dependencies}
        if dependencies:
            confirm_node["dependency_artifacts"] = ["handoff"]
            confirm_node["dependency_policy"] = "all_succeeded" if not extra_deps else "all_settled"
        confirm_node.update(
            {
                "isolation": "same_tree_locked",
                "target_isolation": "read_only",
                "artifact_write_scope": merge_unique(
                    ["notes/verify", "notes/handoffs"],
                    verification_seed.get("scope", {}).get("write_extra"),
                ),
                "seed": verification_seed,
            }
        )
        nodes.append(confirm_node)

    exclusive_confirms: list[tuple[str, list[dict[str, Any]]]] = []
    for route_id, group in group_items_by_route([items[acceptance_id] for acceptance_id in verify_ids]):
        normal = [item for item in group if not item_is_exclusive(item)]
        exclusive = [item for item in group if item_is_exclusive(item)]
        if normal:
            confirm_leaf(route_id, normal)
        if exclusive:
            exclusive_confirms.append((route_id, exclusive))
    for route_id, group in exclusive_confirms:
        confirm_leaf(route_id, group, variant="exclusive", extra_deps=list(verifier_node_map))
    reducer_id = f"acceptance-reducer-r{next_round}"
    nodes.append(
        {
            "id": reducer_id,
            "depends_on": list(verifier_node_map),
            "dependency_artifacts": ["report"],
            "dependency_policy": "all_settled",
            "isolation": "same_tree_locked",
            "target_isolation": "read_only",
            "artifact_write_scope": ["notes/verify", "notes/handoffs"],
            "seed": reducer_seed(
                contract,
                contract_ref,
                dispatch_ref,
                verifier_node_map,
                round_number=next_round,
                prior_decision_ref=decision_ref,
                carried_acceptance_ids=outcome["carried_acceptance_ids"],
            ),
        }
    )
    return {
        "schema_version": 2,
        "run_id": f"acceptance-{safe_id(str(contract.get('contract_id')))}-r{next_round}",
        "defaults": {"isolation": "same_tree_locked", "target_isolation": "writable"},
        "budget": fleet_budget(len(nodes)),
        "nodes": nodes,
    }


def write_json(path_value: str, data: dict[str, Any], label: str) -> str:
    path = repo_path(path_value, label, must_exist=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return rel(path)


def self_test() -> dict[str, Any]:
    """Delegate to the companion self-test module; fixtures live outside the tool."""
    from acceptance_contract_check_selftest import self_test as run_self_test

    return run_self_test()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate Acceptance Contracts and compile verifier/rework Fleet manifests."
    )
    parser.add_argument("--schema", action="store_true")
    parser.add_argument("--example", action="store_true")
    parser.add_argument(
        "--mechanical-sync-template",
        action="store_true",
        help="Emit a single-item contract skeleton for mechanical sync tasks",
    )
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument(
        "--check-convergence",
        action="store_true",
        help="Read-only follow-up preview: emit the rework business exit without writing a manifest",
    )
    parser.add_argument("--contract", help="Acceptance Contract YAML path")
    parser.add_argument("--topology", help="Planning topology YAML path")
    parser.add_argument("--dispatch", help="Dispatch manifest YAML path")
    parser.add_argument("--compile-fleet", help="Write initial verifier Fleet manifest JSON")
    parser.add_argument(
        "--prior-decision-report",
        help="Prior reducer report required when compiling a full owner-resolved round 2",
    )
    parser.add_argument("--decision-report", help="Acceptance reducer report path")
    parser.add_argument(
        "--leaf-decision-report",
        help="Single-item contract leaf report path; mechanically derived into a reducer-equivalent decision",
    )
    parser.add_argument("--fleet-state", help="Fleet run state.json for leaf/reducer report origin binding")
    parser.add_argument(
        "--leaf-node",
        help="Fleet node id (leaf or reducer) whose bound task must be the consumed report origin",
    )
    parser.add_argument("--source-task", help="Cross-assertion of the origin task id; never replaces artifact provenance")
    parser.add_argument(
        "--standalone-leaf",
        action="store_true",
        help="Explicitly declare a non-fleet leaf/decision report; skips fleet origin binding",
    )
    parser.add_argument(
        "--task-root",
        default=".runtime/cockpit/async_tasks",
        help="Async task root used to resolve authoritative report artifacts",
    )
    parser.add_argument("--compile-followup", help="Write targeted rework/retest Fleet manifest JSON")
    parser.add_argument(
        "--previous-decision-report",
        help=(
            "Optional previous reducer report; exposes previous open acceptance IDs "
            "for follow-up and preview diagnostics"
        ),
    )
    parser.add_argument(
        "--owner-resolution-ref",
        help=(
            "Owner decision record (repo file) resolving a needs_owner reducer; lets --compile-followup and "
            "--check-convergence treat that disposition as targeted rework with passed items carried"
        ),
    )
    parser.add_argument(
        "--round", type=int, default=1, help="Review round for validation compile or decision consumption"
    )
    parser.add_argument(
        "--change-base",
        help=(
            "Commit before the phase's implementation (planning_state.execute_gate.change_base); passed to "
            "code-verification leaves so they review committed and uncommitted changes since it. Every round, "
            "including follow-up, uses the same value"
        ),
    )
    parser.add_argument("--join-output", help="Write topology join result JSON")
    parser.add_argument("--format", choices=("json", "text"), default="text")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    modes = sum(bool(item) for item in (args.schema, args.example, args.mechanical_sync_template, args.self_test))
    if modes > 1:
        raise ToolError("choose only one of --schema, --example, --mechanical-sync-template or --self-test")
    if args.mechanical_sync_template:
        data = mechanical_sync_template()
        return emit(
            {"tool": "acceptance_contract_check", "status": "pass", "exit_code": 0, **data},
            args.format,
            yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
        )
    if args.schema:
        data = {
            "tool": "acceptance_contract_check",
            "status": "pass",
            "exit_code": 0,
            "schema": acceptance_schema_snapshot(),
        }
        return emit(data, args.format, yaml.safe_dump(data, allow_unicode=True, sort_keys=False))
    if args.example:
        data = example_contract()
        return emit(
            {"tool": "acceptance_contract_check", "status": "pass", "exit_code": 0, **data},
            args.format,
            yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
        )
    if args.self_test:
        data = self_test()
        return emit(data, args.format, json.dumps(data, ensure_ascii=False, indent=2))
    if not args.contract:
        raise ToolError("--contract is required")

    contract_path = repo_path(args.contract, "contract", must_exist=True)
    contract = acceptance_root(load_yaml(contract_path))
    contract_ref = rel(contract_path)
    if args.check_convergence and (args.topology or args.join_output):
        raise ToolError("--check-convergence cannot be combined with topology join")
    if args.owner_resolution_ref:
        if not (args.compile_followup or args.check_convergence or args.decision_report or args.leaf_decision_report):
            raise ToolError("--owner-resolution-ref is only valid with decision consumption or --compile-followup")
        repo_path(args.owner_resolution_ref, "owner resolution", must_exist=True)
    if args.check_convergence and (args.compile_fleet or args.compile_followup):
        raise ToolError("--check-convergence cannot be combined with manifest compilation")
    if args.check_convergence and not (args.decision_report or args.leaf_decision_report):
        raise ToolError("--check-convergence requires --decision-report or --leaf-decision-report")
    if args.prior_decision_report and not args.compile_fleet:
        raise ToolError("--prior-decision-report is only valid with --compile-fleet")
    if args.previous_decision_report and not (
        args.compile_followup or args.check_convergence or args.decision_report or args.leaf_decision_report
    ):
        raise ToolError(
            "--previous-decision-report is only valid with --compile-followup, "
            "--check-convergence or decision consumption"
        )
    if args.check_convergence:
        if not 1 <= args.round <= MAX_REVIEW_ROUNDS:
            raise ToolError(f"--round must be 1..{MAX_REVIEW_ROUNDS}")
        preview_path, preview_result, preview_origin = resolve_decision_report(args, contract)
        preview = validate_decision(preview_result, contract)
        data: dict[str, Any] = {
            "tool": "acceptance_contract_check",
            "check": "convergence_preview",
            "status": preview["status"],
            "exit_code": preview["exit_code"],
            "contract": contract_ref,
            "report": rel(preview_path),
            "report_origin": preview_origin,
            "manifest": None,
        }
        if preview["status"] == "pass":
            data.update(
                followup_outcome(
                    contract,
                    preview,
                    current_round=args.round,
                    previous_result=previous_decision_result(args),
                    owner_resolved=bool(args.owner_resolution_ref),
                )
            )
        else:
            data["issue_count"] = preview["issue_count"]
            data["issues"] = preview["issues"]
        return emit(data, args.format, convergence_text(data))
    if args.topology:
        if (
            args.dispatch
            or args.decision_report
            or args.leaf_decision_report
            or args.compile_fleet
            or args.compile_followup
            or args.prior_decision_report
        ):
            raise ToolError("--topology join cannot be combined with dispatch/decision compilation")
        topology_path = repo_path(args.topology, "topology", must_exist=True)
        data = build_topology_join_data(contract, load_yaml(topology_path))
        data["contract"] = contract_ref
        data["topology"] = rel(topology_path)
        if args.join_output:
            data["join_output"] = write_json(args.join_output, data, "join output")
        return emit(data, args.format, json.dumps(data, ensure_ascii=False, indent=2))
    if not args.dispatch:
        if (
            args.decision_report
            or args.leaf_decision_report
            or args.compile_fleet
            or args.compile_followup
            or args.prior_decision_report
        ):
            raise ToolError("decision consumption and fleet compilation require --dispatch")
        data = validate_contract_data(contract)
        data["contract"] = contract_ref
        return emit(data, args.format, json.dumps(data, ensure_ascii=False, indent=2))

    dispatch_path = repo_path(args.dispatch, "dispatch", must_exist=True)
    dispatch = dispatch_root(load_yaml(dispatch_path))
    dispatch_ref = rel(dispatch_path)
    if args.compile_fleet:
        if args.decision_report or args.leaf_decision_report or args.compile_followup:
            raise ToolError("--compile-fleet cannot be combined with decision consumption")
        prior_decision_ref = None
        prior_disposition = None
        reverified_passed_ids: list[str] = []
        if args.prior_decision_report:
            if args.round < 2:
                raise ToolError("--prior-decision-report requires --round 2")
            prior_path = repo_path(args.prior_decision_report, "prior decision report", must_exist=True)
            # 全量重编译重验全部项；校验并保留上一轮报告身份。
            prior_decision = validate_decision(extract_review_result(prior_path), contract)
            if prior_decision["status"] != "pass":
                raise ToolError(
                    "prior reducer decision invalid: "
                    + "; ".join(issue_text(item) for item in prior_decision["issues"])
                )
            prior_decision_ref = rel(prior_path)
            prior_disposition = prior_decision["summary"]["disposition"]
            reverified_passed_ids = sorted(prior_decision["summary"]["passed_acceptance_ids"])
        manifest = compile_validation_manifest(
            contract,
            contract_ref,
            dispatch,
            dispatch_ref,
            round_number=args.round,
            prior_decision_ref=prior_decision_ref,
            change_base=args.change_base,
        )
        output_ref = write_json(args.compile_fleet, manifest, "validation Fleet manifest")
        data = {
            "tool": "acceptance_contract_check",
            "check": "compile_validation_fleet",
            "status": "pass",
            "exit_code": 0,
            "prior_disposition": prior_disposition,
            "reverified_passed_acceptance_ids": reverified_passed_ids,
            "manifest": output_ref,
            "run_id": manifest["run_id"],
            "node_count": len(manifest["nodes"]),
        }
        return emit(data, args.format, json.dumps(data, ensure_ascii=False, indent=2))
    if args.decision_report and args.leaf_decision_report:
        raise ToolError("choose only one of --decision-report or --leaf-decision-report")
    if args.decision_report or args.leaf_decision_report:
        if not 1 <= args.round <= MAX_REVIEW_ROUNDS:
            raise ToolError(f"--round must be 1..{MAX_REVIEW_ROUNDS}")
        report_path, result, origin = resolve_decision_report(args, contract)
        previous_result = previous_decision_result(args)
        data = validate_decision(result, contract)
        if args.leaf_decision_report:
            data["check"] = "leaf_decision"
            if origin.get("binding") == "fleet":
                data["leaf_binding"] = {key: origin[key] for key in ("node", "task_id", "report")}
        data["report_origin"] = origin
        if data["status"] == "pass":
            # 消费与 --compile-followup / --check-convergence 共用同一 follow-up 判断。
            outcome = followup_outcome(
                contract,
                data,
                current_round=args.round,
                previous_result=previous_result,
                owner_resolved=bool(args.owner_resolution_ref),
            )
            data["action"] = outcome["action"]
            data["reason"] = outcome["reason"]
            data["open_acceptance_ids"] = outcome["open_acceptance_ids"]
            data["carried_acceptance_ids"] = outcome["carried_acceptance_ids"]
            if outcome["previous_open_acceptance_ids"] is not None:
                data["previous_open_acceptance_ids"] = outcome["previous_open_acceptance_ids"]
        else:
            data["action"] = "reject_invalid_decision"
        if args.compile_followup:
            if data["action"] != "dispatch_rework":
                # 非返工出口:不写 manifest,与只读预览同 action/reason。
                data["followup_manifest"] = None
                data["followup_run_id"] = None
            else:
                manifest = compile_followup_manifest(
                    contract,
                    contract_ref,
                    dispatch,
                    dispatch_ref,
                    result,
                    rel(report_path),
                    current_round=args.round,
                    previous_result=previous_result,
                    owner_resolved=bool(args.owner_resolution_ref),
                    change_base=args.change_base,
                )
                data["followup_manifest"] = write_json(
                    args.compile_followup, manifest, "follow-up Fleet manifest"
                )
                data["followup_run_id"] = manifest["run_id"]
        return emit(data, args.format, json.dumps(data, ensure_ascii=False, indent=2))
    if args.compile_followup:
        raise ToolError("--compile-followup requires --decision-report or --leaf-decision-report")
    data = build_dispatch_join_data(contract, dispatch, contract_ref)
    return emit(data, args.format, json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ToolError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)
