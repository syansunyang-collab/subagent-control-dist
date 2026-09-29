#!/usr/bin/env python3
"""Validate planning topology, fragment, and dispatch manifests."""

from __future__ import annotations

import argparse
import json
import re
import sys
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

from _tool_common import ROOT, RUNTIME_ROOT, ToolError, add, as_list, emit, issue_text, rel
from _tool_common import load_yaml as read_yaml_mapping


# 闭集真源：ops/templates/planning-schema.json，Python 与 dispatch-core/seed_minimal.mjs 共读同一份。
PLANNING_SCHEMA_FILE = RUNTIME_ROOT / "ops" / "templates" / "planning-schema.json"
_PLANNING_SCHEMA = json.loads(PLANNING_SCHEMA_FILE.read_text(encoding="utf-8"))

CONTRACT_KINDS = set(_PLANNING_SCHEMA["contract_kinds"])
CONTRACT_STABILITY = set(_PLANNING_SCHEMA["contract_stability"])
SERIAL_REASONS = set(_PLANNING_SCHEMA["serial_reasons"])
DISPATCH_MODES = set(_PLANNING_SCHEMA["dispatch_modes"])
RELEASE_GATES = set(_PLANNING_SCHEMA["release_gates"])
DEPENDENCY_TYPES = set(_PLANNING_SCHEMA["dependency_types"])
PLANNING_PASSES = set(_PLANNING_SCHEMA["planning_passes"])


def planning_schema_snapshot() -> dict[str, Any]:
    """Return the checker-owned closed sets injected into planner task packages."""
    return {
        "source": "ops/tools/planning_manifest_check.py",
        "planning_pass_values": sorted(PLANNING_PASSES),
        "interface_contract_kind_values": sorted(CONTRACT_KINDS),
        "interface_contract_stability_values": sorted(CONTRACT_STABILITY),
        "serial_reason_values": sorted(SERIAL_REASONS),
        "dispatch_mode_values": sorted(DISPATCH_MODES),
        "release_gate_values": sorted(RELEASE_GATES),
        "dependency_type_values": sorted(DEPENDENCY_TYPES),
    }


def load_yaml(path: Path) -> dict[str, Any]:
    if yaml is None:
        raise ToolError("PyYAML is required for planning_manifest_check.py") from YAML_IMPORT_ERROR
    return read_yaml_mapping(path)


def require_str(obj: dict[str, Any], key: str, issues: list[dict[str, str]], location: str) -> str | None:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        add(issues, f"missing_{key}", location)
        return None
    return value


def require_list(obj: dict[str, Any], key: str, issues: list[dict[str, str]], location: str) -> list[Any]:
    value = obj.get(key)
    if not isinstance(value, list):
        add(issues, f"missing_{key}_list", location)
        return []
    return value


def require_obj(obj: dict[str, Any], key: str, issues: list[dict[str, str]], location: str) -> dict[str, Any]:
    value = obj.get(key)
    if not isinstance(value, dict):
        add(issues, f"missing_{key}_object", location)
        return {}
    return value


def validate_write_ownership(value: Any, issues: list[dict[str, str]], location: str) -> None:
    if not isinstance(value, dict):
        add(issues, "write_ownership_missing", location)
        return
    for key in ("direct_paths", "shared_paths"):
        if not isinstance(value.get(key), list):
            add(issues, f"write_ownership_{key}_not_list", location)


def validate_slices(topology: dict[str, Any], issues: list[dict[str, str]]) -> dict[str, dict[str, Any]]:
    raw = topology.get("planning_slices")
    if not isinstance(raw, list) or not raw:
        add(issues, "planning_slices_missing", "topology.planning_slices")
        return {}
    slices: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(raw):
        location = f"topology.planning_slices[{index}]"
        if not isinstance(item, dict):
            add(issues, "slice_not_object", location)
            continue
        slice_id = require_str(item, "slice_id", issues, location)
        if slice_id:
            if slice_id in slices:
                add(issues, f"slice_id_duplicate={slice_id}", location)
            slices[slice_id] = item
        require_list(item, "tasks", issues, location)
        if not item.get("trusted_spec_refs"):
            add(issues, "slice_trusted_spec_refs_missing", location)
        validation_objects = item.get("validation_objects")
        if not isinstance(validation_objects, (dict, list)) or not validation_objects:
            add(issues, "slice_validation_objects_missing", location)
        for key in ("requires_contracts", "producer_contracts", "conflict_keys", "dependency_edges", "resource_locks"):
            if not isinstance(item.get(key), list):
                add(issues, f"slice_{key}_not_list", location)
        validate_write_ownership(item.get("write_ownership"), issues, location)
    return slices


def validate_parallelism_contract(topology: dict[str, Any], slices: dict[str, dict[str, Any]], issues: list[dict[str, str]]) -> None:
    value = require_obj(topology, "parallelism_contract", issues, "topology")
    candidates = value.get("candidate_lanes")
    serial = value.get("serial_lanes")
    if not isinstance(candidates, list):
        add(issues, "candidate_lanes_not_list", "topology.parallelism_contract")
        candidates = []
    if not isinstance(serial, list):
        add(issues, "serial_lanes_not_list", "topology.parallelism_contract")
        serial = []
    lane_ids: set[str] = set()
    for index, item in enumerate(candidates):
        location = f"topology.parallelism_contract.candidate_lanes[{index}]"
        if not isinstance(item, dict):
            add(issues, "candidate_lane_not_object", location)
            continue
        lane_id = require_str(item, "lane_id", issues, location)
        if lane_id:
            if lane_id in lane_ids:
                add(issues, f"lane_id_duplicate={lane_id}", location)
            lane_ids.add(lane_id)
        slice_ids = require_list(item, "slice_ids", issues, location)
        for slice_id in slice_ids:
            if isinstance(slice_id, str) and slices and slice_id not in slices:
                add(issues, f"candidate_slice_unknown={slice_id}", location)
    for index, item in enumerate(serial):
        location = f"topology.parallelism_contract.serial_lanes[{index}]"
        if not isinstance(item, dict):
            add(issues, "serial_lane_not_object", location)
            continue
        require_str(item, "lane_id", issues, location)
        reason = item.get("blocked_by")
        if reason not in SERIAL_REASONS:
            add(issues, f"serial_reason_invalid={reason}", location)
        evidence = item.get("evidence")
        if not isinstance(evidence, str) or not evidence.strip():
            add(issues, "serial_evidence_missing", location)


def validate_parallelism(topology: dict[str, Any], issues: list[dict[str, str]]) -> None:
    value = require_obj(topology, "slice_parallelism", issues, "topology")
    max_lanes = value.get("max_lanes")
    if not isinstance(max_lanes, int) or max_lanes < 1:
        add(issues, "slice_parallelism_max_lanes_invalid", "topology.slice_parallelism.max_lanes")
    if "ready_order" in value and not isinstance(value.get("ready_order"), list):
        add(issues, "slice_parallelism_ready_order_not_list", "topology.slice_parallelism.ready_order")


def validate_contracts(contracts_doc: dict[str, Any], slices: dict[str, dict[str, Any]], issues: list[dict[str, str]]) -> dict[str, dict[str, Any]]:
    raw = contracts_doc.get("interface_contracts", [])
    if not isinstance(raw, list):
        add(issues, "interface_contracts_not_list", "contracts.interface_contracts")
        return {}
    contracts: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(raw):
        location = f"contracts.interface_contracts[{index}]"
        if not isinstance(item, dict):
            add(issues, "contract_not_object", location)
            continue
        contract_id = require_str(item, "contract_id", issues, location)
        if contract_id:
            if contract_id in contracts:
                add(issues, f"contract_id_duplicate={contract_id}", location)
            contracts[contract_id] = item
        producer = require_str(item, "producer_slice", issues, location)
        if producer and slices and producer not in slices:
            add(issues, f"producer_slice_unknown={producer}", location)
        for key in ("consumer_slices", "required_by_slices"):
            for slice_id in require_list(item, key, issues, location):
                if isinstance(slice_id, str) and slices and slice_id not in slices:
                    add(issues, f"{key}_unknown={slice_id}", location)
        if item.get("kind") not in CONTRACT_KINDS:
            add(issues, f"contract_kind_invalid={item.get('kind')}", location)
        if item.get("stability") not in CONTRACT_STABILITY:
            add(issues, f"contract_stability_invalid={item.get('stability')}", location)
        contract = item.get("contract")
        if not isinstance(contract, (dict, list, str)) or contract in ({}, [], ""):
            add(issues, "contract_body_missing", location)
        for key in ("promoted_by", "promoted_at"):
            if key not in item:
                add(issues, f"missing_{key}", location)
    return contracts


def ready_slices(slices: dict[str, dict[str, Any]], contracts: dict[str, dict[str, Any]], issues: list[dict[str, str]]) -> list[str]:
    ready: list[str] = []
    for slice_id, item in slices.items():
        requires = as_list(item.get("requires_contracts"))
        producers = as_list(item.get("producer_contracts"))
        for contract_id in requires + producers:
            if not isinstance(contract_id, str) or not contract_id.strip():
                add(issues, "slice_contract_ref_invalid", f"topology.planning_slices[{slice_id}]")
                continue
            if contract_id not in contracts:
                add(issues, f"slice_contract_ref_unknown={contract_id}", f"topology.planning_slices[{slice_id}]")
        if all(isinstance(cid, str) and contracts.get(cid, {}).get("stability") == "locked" for cid in requires):
            ready.append(slice_id)
    return sorted(ready)


def build_topology_data(topology_path: Path, contracts_path: Path) -> dict[str, Any]:
    topology = load_yaml(topology_path)
    contracts_doc = load_yaml(contracts_path)
    issues: list[dict[str, str]] = []
    require_str(topology, "phase_id", issues, "topology")
    require_str(topology, "trusted_spec_ref", issues, "topology")
    slices = validate_slices(topology, issues)
    validate_parallelism(topology, issues)
    validate_parallelism_contract(topology, slices, issues)
    contracts = validate_contracts(contracts_doc, slices, issues)
    ready = ready_slices(slices, contracts, issues)
    if slices and not ready:
        add(issues, "ready_slice_ids_empty", "topology.planning_slices")
    return {
        "tool": "planning_manifest_check",
        "check": "topology",
        "status": "pass" if not issues else "fail",
        "exit_code": 0 if not issues else 1,
        "topology": rel(topology_path),
        "contracts": rel(contracts_path),
        "issue_count": len(issues),
        "issues": issues,
        "summary": {"slice_count": len(slices), "contract_count": len(contracts), "ready_slice_ids": ready},
    }


def extract_yaml_blocks(markdown: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []

    def append_mapping(source: str) -> None:
        try:
            value = yaml.safe_load(source)
        except yaml.YAMLError:
            return
        if isinstance(value, dict) and value not in blocks:
            blocks.append(value)

    for match in re.finditer(r"```ya?ml\s*\n(.*?)\n```", markdown, flags=re.IGNORECASE | re.DOTALL):
        append_mapping(match.group(1))

    # Planner output is Markdown, but models commonly emit the machine block as
    # leading front matter or directly below the required slice_fragment heading.
    # Accept only a mapping that actually owns slice_fragment; do not scan arbitrary
    # prose examples or relax the closed-value validation below.
    if not block_items(blocks, "slice_fragment"):
        front_matter = re.match(r"\A\s*---\s*\n(.*?)\n---(?:\s*\n|\Z)", markdown, flags=re.DOTALL)
        if front_matter:
            append_mapping(front_matter.group(1))

    if not block_items(blocks, "slice_fragment"):
        heading = re.search(r"(?im)^#{2,6}\s+slice_fragment\s*$", markdown)
        if heading:
            body_start = heading.end()
            next_heading = re.search(r"(?m)^#{1,6}\s+\S", markdown[body_start:])
            body_end = body_start + next_heading.start() if next_heading else len(markdown)
            candidate = markdown[body_start:body_end].strip()
            if candidate.startswith("slice_fragment:"):
                append_mapping(candidate)

    if not block_items(blocks, "slice_fragment"):
        first_heading = re.search(r"(?m)^#{1,6}\s+\S", markdown)
        candidate = markdown[: first_heading.start() if first_heading else len(markdown)].strip()
        if candidate.startswith("slice_fragment:"):
            append_mapping(candidate)
    return blocks


def block_items(blocks: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for block in blocks:
        value = block.get(key)
        if isinstance(value, list):
            items.extend(item for item in value if isinstance(item, dict))
        elif isinstance(value, dict):
            items.append(value)
    return items


def build_fragment_data(fragment_path: Path, slice_id: str | None, producer_contracts: list[str]) -> dict[str, Any]:
    try:
        text = fragment_path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ToolError(f"fragment file not found: {rel(fragment_path)}") from exc
    issues: list[dict[str, str]] = []
    blocks = extract_yaml_blocks(text)
    fragments = block_items(blocks, "slice_fragment")
    if not fragments:
        add(issues, "slice_fragment_missing", rel(fragment_path))
    fragment = fragments[0] if fragments else {}
    if slice_id and fragment.get("slice_id") != slice_id:
        add(issues, f"slice_id_mismatch={fragment.get('slice_id')}!={slice_id}", "slice_fragment")
    for key in ("task", "scope", "validation", "mode", "parallel_policy_basis"):
        if key not in fragment:
            add(issues, f"slice_fragment_missing_{key}", "slice_fragment")
    if fragment.get("mode") not in DISPATCH_MODES:
        add(issues, f"slice_fragment_mode_invalid={fragment.get('mode')}", "slice_fragment")
    validation = fragment.get("validation") if isinstance(fragment.get("validation"), dict) else {}
    if not as_list(validation.get("requirement_refs")):
        add(issues, "validation_requirement_refs_missing", "slice_fragment.validation")
    validate_dependency_edges(fragment.get("dependency_edges", []), issues, "slice_fragment")
    validate_write_ownership(fragment.get("write_ownership"), issues, "slice_fragment")
    contract_fragments = {item.get("contract_id"): item for item in block_items(blocks, "contract_fragment")}
    promotions = {item.get("contract_id"): item for item in block_items(blocks, "contract_promotions")}
    for contract_id in producer_contracts:
        if contract_id not in contract_fragments:
            add(issues, f"missing_contract_fragment={contract_id}", rel(fragment_path))
        if contract_id not in promotions:
            add(issues, f"missing_contract_promotion={contract_id}", rel(fragment_path))
    return {
        "tool": "planning_manifest_check",
        "check": "fragment",
        "status": "pass" if not issues else "fail",
        "exit_code": 0 if not issues else 1,
        "fragment": rel(fragment_path),
        "slice_id": slice_id,
        "producer_contracts": producer_contracts,
        "issue_count": len(issues),
        "issues": issues,
    }


def validate_dependency_edges(edges: Any, issues: list[dict[str, str]], location: str) -> None:
    if not isinstance(edges, list):
        add(issues, "dependency_edges_not_list", location)
        return
    for index, edge in enumerate(edges):
        edge_location = f"{location}.dependency_edges[{index}]"
        if not isinstance(edge, dict):
            add(issues, "dependency_edge_not_object", edge_location)
            continue
        if edge.get("type") not in DEPENDENCY_TYPES:
            add(issues, f"dependency_type_invalid={edge.get('type')}", edge_location)
        if edge.get("release_gate") not in RELEASE_GATES:
            add(issues, f"release_gate_invalid={edge.get('release_gate')}", edge_location)


def validate_lane(lane: dict[str, Any], issues: list[dict[str, str]], location: str) -> str | None:
    lane_id = require_str(lane, "lane_id", issues, location)
    require_str(lane, "task", issues, location)
    scope = require_obj(lane, "scope", issues, location)
    for scope_key in ("read", "write", "delete"):
        if scope_key not in scope:
            continue
        value = scope.get(scope_key)
        if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
            add(issues, f"scope_{scope_key}_not_string_list", location)
    require_list(lane, "conflict_keys", issues, location)
    if not isinstance(lane.get("depends_on"), list):
        add(issues, "depends_on_not_list", location)
    validate_dependency_edges(lane.get("dependency_edges", []), issues, location)
    require_list(lane, "resource_locks", issues, location)
    validate_write_ownership(lane.get("write_ownership"), issues, location)
    validation = require_obj(lane, "validation", issues, location)
    for key in ("object", "method", "pass_condition"):
        if not isinstance(validation.get(key), str) or not validation.get(key, "").strip():
            add(issues, f"validation_{key}_missing", location)
    requirement_refs = validation.get("requirement_refs")
    if not isinstance(requirement_refs, list) or not requirement_refs:
        add(issues, "validation_requirement_refs_missing", location)
    elif any(not isinstance(item, str) or not item.strip() for item in requirement_refs):
        add(issues, "validation_requirement_refs_invalid", location)
    if lane.get("mode") not in DISPATCH_MODES:
        add(issues, f"mode_invalid={lane.get('mode')}", location)
    return lane_id


def build_dispatch_data(dispatch_path: Path) -> dict[str, Any]:
    doc = load_yaml(dispatch_path)
    manifest = doc.get("dispatch_manifest", doc)
    if not isinstance(manifest, dict):
        raise ToolError("dispatch_manifest root is not object")
    issues: list[dict[str, str]] = []
    require_str(manifest, "phase_id", issues, "dispatch_manifest")
    require_str(manifest, "trusted_spec_ref", issues, "dispatch_manifest")
    require_str(manifest, "acceptance_contract_ref", issues, "dispatch_manifest")
    require_str(manifest, "acceptance_join_ref", issues, "dispatch_manifest")
    require_str(manifest, "source_topology_ref", issues, "dispatch_manifest")
    require_list(manifest, "source_fragments", issues, "dispatch_manifest")
    waves = require_list(manifest, "waves", issues, "dispatch_manifest")
    lane_ids: set[str] = set()
    for wave_index, wave in enumerate(waves):
        location = f"dispatch_manifest.waves[{wave_index}]"
        if not isinstance(wave, dict):
            add(issues, "wave_not_object", location)
            continue
        if not isinstance(wave.get("wave"), int):
            add(issues, "wave_number_invalid", location)
        lanes = require_list(wave, "lanes", issues, location)
        wave_lane_ids: set[str] = set()
        for lane_index, lane in enumerate(lanes):
            lane_location = f"{location}.lanes[{lane_index}]"
            if not isinstance(lane, dict):
                add(issues, "lane_not_object", lane_location)
                continue
            lane_id = validate_lane(lane, issues, lane_location)
            if lane_id:
                if lane_id in lane_ids:
                    add(issues, f"lane_id_duplicate={lane_id}", lane_location)
                lane_ids.add(lane_id)
                wave_lane_ids.add(lane_id)
        serial = wave.get("serial_lanes", [])
        if not isinstance(serial, list):
            add(issues, "serial_lanes_not_list", location)
            serial = []
        serial_seen: set[str] = set()
        for serial_index, item in enumerate(serial):
            serial_location = f"{location}.serial_lanes[{serial_index}]"
            if not isinstance(item, dict):
                add(issues, "serial_lane_not_object", serial_location)
                continue
            serial_id = require_str(item, "lane_id", issues, serial_location)
            if serial_id:
                if serial_id not in wave_lane_ids:
                    add(issues, f"serial_lane_unknown={serial_id}", serial_location)
                if serial_id in serial_seen:
                    add(issues, f"serial_lane_duplicate={serial_id}", serial_location)
                serial_seen.add(serial_id)
            if item.get("reason") not in SERIAL_REASONS:
                add(issues, f"serial_reason_invalid={item.get('reason')}", serial_location)
            if not isinstance(item.get("evidence"), str) or not item.get("evidence", "").strip():
                add(issues, "serial_evidence_missing", serial_location)
    require_list(manifest, "conflict_resolution", issues, "dispatch_manifest")
    if not isinstance(manifest.get("patch_intents", []), list):
        add(issues, "patch_intents_not_list", "dispatch_manifest")
    join_gate = require_obj(manifest, "join_gate", issues, "dispatch_manifest")
    if join_gate.get("enter_validation_when") not in {"validation_object_lanes_done", "all_lanes_done"}:
        add(issues, f"join_gate_invalid={join_gate.get('enter_validation_when')}", "dispatch_manifest.join_gate")
    return {
        "tool": "planning_manifest_check",
        "check": "dispatch",
        "status": "pass" if not issues else "fail",
        "exit_code": 0 if not issues else 1,
        "dispatch_manifest": rel(dispatch_path),
        "issue_count": len(issues),
        "issues": issues,
        "summary": {"lane_count": len(lane_ids)},
    }


EXECUTOR_ROUTE_ID = "executor-agent__plan-execution"
EXECUTION_ADJUSTMENT_POLICY_DEFAULT = {
    "local_adjustment_allowed": True,
    "plan_return_only_for": [
        "target_changed",
        "validation_object_changed",
        "scope_expansion_required",
        "exclusive_resource_blocked",
        "unresolvable_dispatch_direction",
    ],
}


def compile_lane_seed(manifest: dict[str, Any], dispatch_ref: str, wave_number: int, lane: dict[str, Any]) -> dict[str, Any]:
    phase_id = str(manifest.get("phase_id"))
    lane_id = str(lane.get("lane_id"))
    trusted_spec_ref = str(manifest.get("trusted_spec_ref"))
    lane_scope = lane.get("scope") if isinstance(lane.get("scope"), dict) else {}
    # 锁定接口合同是全 lane 只读公共真源;种子漏带会让 lane 中途 needs_owner(读面未授权),
    # 编译器机械补全,不依赖 manifest 作者手写。
    interface_contracts_ref = f"notes/manifests/{phase_id}-interface-contracts.yaml"
    auto_reads = [interface_contracts_ref] if (ROOT / interface_contracts_ref).exists() else []
    read_paths: list[str] = []
    for entry in [dispatch_ref, trusted_spec_ref.split("#", 1)[0], *auto_reads, *as_list(lane_scope.get("read"))]:
        text = str(entry).strip()
        if text and text not in read_paths:
            read_paths.append(text)
    seed: dict[str, Any] = {
        "route_id": EXECUTOR_ROUTE_ID,
        "goal": f"执行 {phase_id} wave {wave_number} lane {lane_id}: {lane.get('task')}",
        "scope": project_lane_scope(lane_scope, read_paths),
        "slug": f"{phase_id}/{phase_id}-{lane_id}-SUMMARY",
        "contract": {
            "dispatch_manifest_ref": dispatch_ref,
            "trusted_spec_ref": trusted_spec_ref,
            "lane_id": lane_id,
            "planning_wave": wave_number,
            "task": lane.get("task"),
            "scope": lane_scope,
            "validation": lane.get("validation"),
            "lane_execution_mode": lane.get("mode"),
            "dependency_edges": as_list(lane.get("dependency_edges")),
            "resource_locks": as_list(lane.get("resource_locks")),
            "write_ownership": lane.get("write_ownership"),
            "execution_adjustment_policy": EXECUTION_ADJUSTMENT_POLICY_DEFAULT,
        },
    }
    return seed


def project_lane_scope(lane_scope: dict[str, Any], read_paths: list[str]) -> dict[str, Any]:
    """Project original lane authorizations for executor and repair seeds."""
    scope = {
        "read": read_paths,
        "write_extra": [str(item) for item in as_list(lane_scope.get("write"))],
    }
    delete_paths = [str(item) for item in as_list(lane_scope.get("delete"))]
    if delete_paths:
        scope["delete"] = delete_paths
    return scope


def build_compile_executor_seeds_data(dispatch_path: Path, wave_number: int) -> dict[str, Any]:
    validation = build_dispatch_data(dispatch_path)
    if validation["status"] != "pass":
        return {**validation, "check": "compile_executor_seeds", "parallel_seeds": [], "serial_seeds": []}
    doc = load_yaml(dispatch_path)
    manifest = doc.get("dispatch_manifest", doc)
    wave = next(
        (item for item in as_list(manifest.get("waves")) if isinstance(item, dict) and item.get("wave") == wave_number),
        None,
    )
    if wave is None:
        raise ToolError(f"wave {wave_number} not found in {rel(dispatch_path)}")
    dispatch_ref = rel(dispatch_path)
    serial_ids = {str(item.get("lane_id")) for item in as_list(wave.get("serial_lanes")) if isinstance(item, dict)}
    parallel_seeds: list[dict[str, Any]] = []
    serial_seeds: list[dict[str, Any]] = []
    for lane in as_list(wave.get("lanes")):
        seed = compile_lane_seed(manifest, dispatch_ref, wave_number, lane)
        (serial_seeds if str(lane.get("lane_id")) in serial_ids else parallel_seeds).append(seed)
    return {
        "tool": "planning_manifest_check",
        "check": "compile_executor_seeds",
        "status": "pass",
        "exit_code": 0,
        "dispatch_manifest": dispatch_ref,
        "wave": wave_number,
        "issue_count": 0,
        "issues": [],
        "summary": {"lane_count": len(parallel_seeds) + len(serial_seeds)},
        "parallel_seeds": parallel_seeds,
        "serial_seeds": serial_seeds,
    }


def ref_path(ref: str) -> Path:
    relative = ref.split("#", 1)[0]
    path = (ROOT / relative).resolve()
    try:
        path.relative_to(ROOT.resolve())
    except ValueError as exc:
        raise ToolError(f"review identity ref escapes repository: {ref}") from exc
    if not path.is_file():
        raise ToolError(f"review identity ref is not readable: {ref}")
    return path


def identity(ref: str) -> dict[str, str]:
    """A review input is identified by its repository ref only; the file must exist. No digest is derived."""
    ref_path(ref)
    return {"ref": ref}


def manifest_revision_value(manifest: dict[str, Any]) -> int | None:
    value = manifest.get("revision", manifest.get("version"))
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return None
    return value


def build_review_binding_data(state_path: Path) -> dict[str, Any]:
    """Checker-owned binding values for semantic_review / manifest_freeze: input refs, phase_id, manifest_revision.

    Binding is by manifest revision (planner bumps `revision` on every manifest write); no content digest is
    computed. Re-review is capped by the same two-round rule as alignment.
    """
    doc = load_yaml(state_path)
    state = doc.get("planning_state", doc)
    if not isinstance(state, dict):
        raise ToolError("planning_state root is not object")
    dispatch_ref = str(state.get("dispatch_manifest_ref") or "")
    if not dispatch_ref:
        raise ToolError("planning_state.dispatch_manifest_ref is required")
    dispatch_doc = load_yaml(ref_path(dispatch_ref))
    manifest = dispatch_doc.get("dispatch_manifest", dispatch_doc)
    if not isinstance(manifest, dict):
        raise ToolError(f"dispatch_manifest root is not object: {dispatch_ref}")
    trusted_spec_ref = str(manifest.get("trusted_spec_ref") or state.get("trusted_spec_ref") or "")
    interface_contracts_ref = str(state.get("interface_contracts_ref") or "")
    acceptance_contract_ref = str(state.get("acceptance_contract_ref") or "")
    acceptance_join_ref = str(state.get("acceptance_join_ref") or "")
    fragment_refs = [item for item in as_list(manifest.get("source_fragments")) if isinstance(item, str)]
    if not trusted_spec_ref or not interface_contracts_ref or not acceptance_contract_ref or not acceptance_join_ref or not fragment_refs:
        raise ToolError(
            "review identities require trusted_spec_ref, interface_contracts_ref, acceptance_contract_ref, acceptance_join_ref and source_fragments"
        )
    if manifest.get("acceptance_contract_ref") != acceptance_contract_ref:
        raise ToolError("dispatch_manifest.acceptance_contract_ref does not match planning_state")
    if manifest.get("acceptance_join_ref") != acceptance_join_ref:
        raise ToolError("dispatch_manifest.acceptance_join_ref does not match planning_state")
    acceptance_join = load_yaml(ref_path(acceptance_join_ref))
    if acceptance_join.get("status") != "pass":
        raise ToolError("acceptance join is not pass")
    if acceptance_join.get("contract") != acceptance_contract_ref:
        raise ToolError("acceptance join contract ref does not match planning_state")
    if acceptance_join.get("topology") != manifest.get("source_topology_ref"):
        raise ToolError("acceptance join topology ref does not match dispatch_manifest")
    revision = manifest_revision_value(manifest)
    if revision is None:
        raise ToolError(f"dispatch_manifest.revision must be a positive integer (planner bumps it on every write): {dispatch_ref}")
    input_refs = {
        "trusted_spec": identity(trusted_spec_ref),
        "interface_contracts": identity(interface_contracts_ref),
        "acceptance_contract": identity(acceptance_contract_ref),
        "acceptance_join": identity(acceptance_join_ref),
        "source_fragments": [identity(item) for item in fragment_refs],
        "dispatch_manifest": identity(dispatch_ref),
    }
    return {
        "tool": "planning_manifest_check",
        "check": "review_binding",
        "status": "pass",
        "exit_code": 0,
        "planning_state": rel(state_path),
        "issue_count": 0,
        "issues": [],
        "summary": {
            "input_refs": input_refs,
            "phase_id": manifest.get("phase_id"),
            "manifest_revision": revision,
        },
    }


def build_review_state_data(state_path: Path) -> dict[str, Any]:
    doc = load_yaml(state_path)
    state = doc.get("planning_state", doc)
    if not isinstance(state, dict):
        raise ToolError("planning_state root is not object")
    issues: list[dict[str, str]] = []
    review = require_obj(state, "semantic_review", issues, "planning_state")
    freeze = require_obj(state, "manifest_freeze", issues, "planning_state")
    dispatch_ref = str(state.get("dispatch_manifest_ref") or "")
    if not dispatch_ref:
        add(issues, "dispatch_manifest_ref_missing", "planning_state")
        dispatch_doc: dict[str, Any] = {}
    else:
        dispatch_doc = load_yaml(ref_path(dispatch_ref))
    manifest = dispatch_doc.get("dispatch_manifest", dispatch_doc)
    if not isinstance(manifest, dict):
        manifest = {}
        add(issues, "dispatch_manifest_root_invalid", dispatch_ref)

    coverage = review.get("coverage_checks")
    required_coverage = (
        "locked_spec_coverage",
        "fragment_coverage",
        "interface_contract_compatibility",
        "validation_object_coverage",
        "acceptance_contract_coverage",
        "acceptance_dispatch_traceability",
    )
    if not isinstance(coverage, dict):
        add(issues, "semantic_review_coverage_checks_missing", "planning_state.semantic_review")
    else:
        for key in required_coverage:
            if coverage.get(key) != "pass":
                add(issues, f"semantic_review_{key}_not_pass", "planning_state.semantic_review.coverage_checks")
        if not isinstance(coverage.get("deviations"), list):
            add(issues, "semantic_review_deviations_not_list", "planning_state.semantic_review.coverage_checks")

        elif coverage.get("deviations"):
            add(issues, "semantic_review_deviations_not_empty", "planning_state.semantic_review.coverage_checks")

    binding_data = build_review_binding_data(state_path)
    binding_summary = binding_data["summary"]
    current_refs = binding_summary["input_refs"]
    if review.get("dispatch_manifest_ref") != dispatch_ref:
        add(issues, "semantic_review_dispatch_manifest_ref_mismatch", "planning_state.semantic_review.dispatch_manifest_ref")
    if review.get("trusted_spec_ref") != current_refs["trusted_spec"]["ref"]:
        add(issues, "semantic_review_trusted_spec_ref_mismatch", "planning_state.semantic_review.trusted_spec_ref")
    if review.get("acceptance_contract_ref") != current_refs["acceptance_contract"]["ref"]:
        add(issues, "semantic_review_acceptance_contract_ref_mismatch", "planning_state.semantic_review.acceptance_contract_ref")
    if review.get("acceptance_join_ref") != current_refs["acceptance_join"]["ref"]:
        add(issues, "semantic_review_acceptance_join_ref_mismatch", "planning_state.semantic_review.acceptance_join_ref")
    if review.get("manifest_revision") != binding_summary["manifest_revision"]:
        add(issues, "semantic_review_manifest_revision_mismatch", "planning_state.semantic_review.manifest_revision")
    if freeze.get("phase_id") != binding_summary["phase_id"]:
        add(issues, "manifest_freeze_phase_id_mismatch", "planning_state.manifest_freeze.phase_id")
    if freeze.get("manifest_revision") != binding_summary["manifest_revision"]:
        add(issues, "manifest_freeze_manifest_revision_mismatch", "planning_state.manifest_freeze.manifest_revision")
    if review.get("status") != "pass":
        add(issues, "semantic_review_status_not_pass", "planning_state.semantic_review.status")
    if freeze.get("status") != "frozen":
        add(issues, "manifest_freeze_status_not_frozen", "planning_state.manifest_freeze.status")
    return {
        "tool": "planning_manifest_check",
        "check": "review_state",
        "status": "pass" if not issues else "fail",
        "exit_code": 0 if not issues else 1,
        "planning_state": rel(state_path),
        "issue_count": len(issues),
        "issues": issues,
        "summary": {
            **binding_summary,
        },
    }


def build_text(data: dict[str, Any]) -> str:
    lines = [
        "# Planning Manifest Check",
        "",
        f"check: {data.get('check')}",
        f"status: {data['status']}",
        f"issue_count: {data['issue_count']}",
    ]
    if data.get("check") == "compile_executor_seeds":
        lines.append(f"parallel_seeds: {len(data.get('parallel_seeds', []))}")
        lines.append(f"serial_seeds: {len(data.get('serial_seeds', []))}")
    if data.get("issues"):
        lines.append("issues:")
        lines.extend(f"- {issue_text(item)}" for item in data["issues"])
    return "\n".join(lines)


def self_test() -> dict[str, Any]:
    from planning_manifest_check_selftest import self_test as _self_test

    return _self_test()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate planning topology, fragment, and dispatch manifests.")
    parser.add_argument("--topology", help="Path to notes/manifests/<phase>-planning-topology.yaml")
    parser.add_argument("--contracts", help="Path to notes/manifests/<phase>-interface-contracts.yaml")
    parser.add_argument("--fragment", help="Path to .planning/phases/<phase>/fragments/<slice_id>.md")
    parser.add_argument("--slice-id", help="Expected slice_id for --fragment checks")
    parser.add_argument("--producer-contract", action="append", default=[], help="Expected producer contract id. Repeat for multiple contracts.")
    parser.add_argument("--dispatch", help="Path to notes/manifests/<phase>-dispatch-manifest.yaml")
    parser.add_argument("--compile-executor-seeds", action="store_true", help="Compile executor package seeds from --dispatch for --wave; validation failures block compilation")
    parser.add_argument("--wave", type=int, help="Wave number for --compile-executor-seeds")
    parser.add_argument("--review-binding", "--review-identities", dest="review_binding", help="Path to planning state; emit checker-owned binding values (input refs, phase_id, manifest_revision) for semantic_review / manifest_freeze")
    parser.add_argument("--review-state", help="Path to planning state with semantic review and freeze identities")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--self-test", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def resolve_check_mode(args: argparse.Namespace) -> str:
    modes: list[str] = []
    if args.compile_executor_seeds and not args.dispatch:
        raise ToolError("--compile-executor-seeds requires --dispatch")
    if args.dispatch:
        modes.append("compile_executor_seeds" if args.compile_executor_seeds else "dispatch")
    if args.review_state:
        modes.append("review_state")
    if args.review_binding:
        modes.append("review_binding")
    if args.fragment:
        modes.append("fragment")
    if args.topology or args.contracts:
        if not args.topology or not args.contracts:
            raise ToolError("--topology and --contracts must be provided together")
        modes.append("topology")
    if len(modes) != 1:
        raise ToolError(f"provide exactly one check mode: topology+contracts, fragment, dispatch, review-binding, or review-state; selected={modes}")
    return modes[0]


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.self_test:
            data = self_test()
            return emit(data, args.format, "planning_manifest_check self-test passed" if data["status"] == "pass" else "planning_manifest_check self-test failed")
        mode = resolve_check_mode(args)
        if mode == "compile_executor_seeds":
            if args.wave is None:
                raise ToolError("--compile-executor-seeds requires --wave")
            data = build_compile_executor_seeds_data((ROOT / args.dispatch).resolve(), args.wave)
            return emit(data, args.format, build_text(data))
        if mode == "dispatch":
            data = build_dispatch_data((ROOT / args.dispatch).resolve())
            return emit(data, args.format, build_text(data))
        if mode == "review_state":
            data = build_review_state_data((ROOT / args.review_state).resolve())
            return emit(data, args.format, build_text(data))
        if mode == "review_binding":
            data = build_review_binding_data((ROOT / args.review_binding).resolve())
            return emit(data, args.format, build_text(data))
        if mode == "fragment":
            data = build_fragment_data((ROOT / args.fragment).resolve(), args.slice_id, args.producer_contract)
            return emit(data, args.format, build_text(data))
        data = build_topology_data((ROOT / args.topology).resolve(), (ROOT / args.contracts).resolve())
        return emit(data, args.format, build_text(data))
    except ToolError as exc:
        data = {
            "tool": "planning_manifest_check",
            "status": "fail",
            "exit_code": 1,
            "issues": [{"code": "tool_error", "message": str(exc)}],
        }
        return emit(data, args.format, f"# Planning Manifest Check\n\nstatus: fail\nerror: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
