#!/usr/bin/env python3
"""planning_manifest_check --self-test 的机械用例集，由 planning_manifest_check.self_test 调用。"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

sys.dont_write_bytecode = True

import planning_manifest_check as pmc
from _tool_common import ToolError

# 生产文件的 yaml 是可选导入（缺 PyYAML 时为 None），取它的绑定而非自行 import，保持同一份缺失语义。
yaml = pmc.yaml


def self_test() -> dict[str, Any]:
    topology = {
        "phase_id": "p1",
        "trusted_spec_ref": "spec.md",
        "planning_slices": [
            {
                "slice_id": "S1",
                "tasks": ["T01"],
                "trusted_spec_refs": ["AS-01"],
                "validation_objects": {"AS-01": "rule_structure"},
                "requires_contracts": [],
                "producer_contracts": [],
                "conflict_keys": [],
                "dependency_edges": [],
                "resource_locks": [],
                "write_ownership": {"direct_paths": ["a.md"], "shared_paths": []},
            }
        ],
        "parallelism_contract": {
            "candidate_lanes": [{"lane_id": "L1", "slice_ids": ["S1"], "conflict_keys": [], "must_parallel": True, "blocked_by": None}],
            "serial_lanes": [],
        },
        "slice_parallelism": {"max_lanes": 1, "ready_order": ["S1"]},
    }
    contracts = {"interface_contracts": []}
    dispatch = {
        "dispatch_manifest": {
            "version": 1,
            "phase_id": "p1",
            "trusted_spec_ref": "spec.md",
            "acceptance_contract_ref": "acceptance.yaml",
            "acceptance_join_ref": "acceptance-join.json",
            "source_topology_ref": "notes/manifests/p1-planning-topology.yaml",
            "source_fragments": ["fragment.md"],
            "waves": [
                {
                    "wave": 1,
                    "lanes": [
                        {
                            "lane_id": "L1",
                            "task": "edit a.md",
                            "scope": {"read": ["a.md"], "write": ["a.md"]},
                            "conflict_keys": [],
                            "depends_on": [],
                            "dependency_edges": [],
                            "resource_locks": [],
                            "write_ownership": {"direct_paths": ["a.md"], "shared_paths": []},
                            "validation": {
                                "object": "a",
                                "method": "lint",
                                "pass_condition": "pass",
                                "requirement_refs": ["AS-01"],
                            },
                            "parallel_required": True,
                            "mode": "direct_write",
                        }
                    ],
                    "serial_lanes": [],
                }
            ],
            "conflict_resolution": [],
            "patch_intents": [],
            "join_gate": {"enter_validation_when": "all_lanes_done"},
        }
    }
    with TemporaryDirectory() as temp:
        root = Path(temp)
        top = root / "topology.yaml"
        con = root / "contracts.yaml"
        dis = root / "dispatch.yaml"
        frag = root / "fragment.md"
        front_matter_frag = root / "front-matter-fragment.md"
        heading_frag = root / "heading-fragment.md"
        bad_frag = root / "bad-fragment.md"
        top.write_text(yaml.safe_dump(topology, sort_keys=False), encoding="utf-8")
        con.write_text(yaml.safe_dump(contracts, sort_keys=False), encoding="utf-8")
        dis.write_text(yaml.safe_dump(dispatch, sort_keys=False), encoding="utf-8")
        fragment = {
            "slice_fragment": {
                "slice_id": "S1",
                "task": "edit a.md",
                "scope": {"read": ["a.md"], "write": ["a.md"]},
                "validation": {
                    "object": "a",
                    "method": "lint",
                    "pass_condition": "pass",
                    "requirement_refs": ["AS-01"],
                },
                "mode": "direct_write",
                "parallel_policy_basis": "ready_if_no_hard_blocker",
                "dependency_edges": [{"type": "hard_output", "release_gate": "execution_done"}],
                "write_ownership": {"direct_paths": ["a.md"], "shared_paths": []},
            }
        }
        invalid_fragment = json.loads(json.dumps(fragment))
        invalid_fragment["slice_fragment"]["dependency_edges"] = [
            {"type": "invented", "release_gate": "invented"}
        ]
        missing_validation_fragment = json.loads(json.dumps(fragment))
        missing_validation_fragment["slice_fragment"]["validation"].pop("requirement_refs")
        fragment_yaml = yaml.safe_dump(fragment, sort_keys=False)
        frag.write_text("```yaml\n" + fragment_yaml + "```\n", encoding="utf-8")
        front_matter_frag.write_text("---\n" + fragment_yaml + "---\n\n## Source Audit\n", encoding="utf-8")
        heading_frag.write_text("## slice_fragment\n\n" + fragment_yaml + "\n## Source Audit\n", encoding="utf-8")
        bad_frag.write_text(
            "```yaml\n" + yaml.safe_dump(invalid_fragment, sort_keys=False) + "```\n",
            encoding="utf-8",
        )
        missing_validation_path = root / "missing-validation-fragment.md"
        missing_validation_path.write_text(
            "```yaml\n" + yaml.safe_dump(missing_validation_fragment, sort_keys=False) + "```\n",
            encoding="utf-8",
        )
        topology_result = pmc.build_topology_data(top, con)
        dispatch_result = pmc.build_dispatch_data(dis)
        invalid_dispatch = json.loads(json.dumps(dispatch))
        invalid_dispatch["dispatch_manifest"]["waves"][0]["lanes"][0]["validation"].pop(
            "requirement_refs"
        )
        invalid_dispatch_path = root / "invalid-dispatch.yaml"
        invalid_dispatch_path.write_text(yaml.safe_dump(invalid_dispatch, sort_keys=False), encoding="utf-8")
        invalid_dispatch_result = pmc.build_dispatch_data(invalid_dispatch_path)
        original_seed_root = pmc.ROOT
        try:
            # 无锁定接口合同的对照组也要在临时 ROOT 下取:真仓里
            # notes/manifests/p1-interface-contracts.yaml 存在与否会左右自动补读面的断言。
            pmc.ROOT = root
            compile_result = pmc.build_compile_executor_seeds_data(dis, 1)
            interface_ref_path = root / "notes" / "manifests" / "p1-interface-contracts.yaml"
            interface_ref_path.parent.mkdir(parents=True, exist_ok=True)
            interface_ref_path.write_text("interface_contracts: []\n", encoding="utf-8")
            compile_with_contracts_result = pmc.build_compile_executor_seeds_data(dis, 1)
        finally:
            pmc.ROOT = original_seed_root
        compile_invalid_result = pmc.build_compile_executor_seeds_data(invalid_dispatch_path, 1)
        try:
            pmc.build_compile_executor_seeds_data(dis, 9)
        except ToolError as exc:
            compile_missing_wave_rejected = "wave 9 not found" in str(exc)
        else:
            compile_missing_wave_rejected = False
        unknown_serial_dispatch = json.loads(json.dumps(dispatch))
        unknown_serial_dispatch["dispatch_manifest"]["waves"][0]["serial_lanes"] = [
            {"lane_id": "L-GHOST", "reason": "hard_dependency", "evidence": "stale reference"}
        ]
        unknown_serial_path = root / "unknown-serial-dispatch.yaml"
        unknown_serial_path.write_text(yaml.safe_dump(unknown_serial_dispatch, sort_keys=False), encoding="utf-8")
        unknown_serial_result = pmc.build_compile_executor_seeds_data(unknown_serial_path, 1)
        serial_dispatch = json.loads(json.dumps(dispatch))
        second_lane = json.loads(json.dumps(serial_dispatch["dispatch_manifest"]["waves"][0]["lanes"][0]))
        second_lane["lane_id"] = "L2"
        second_lane["scope"] = {"read": ["a.md"], "write": ["b.md"]}
        second_lane["write_ownership"] = {"direct_paths": ["b.md"], "shared_paths": []}
        serial_dispatch["dispatch_manifest"]["waves"][0]["lanes"].append(second_lane)
        serial_dispatch["dispatch_manifest"]["waves"][0]["serial_lanes"] = [
            {"lane_id": "L2", "reason": "same_object_write", "evidence": "shares a.md read chain"}
        ]
        serial_dispatch_path = root / "serial-dispatch.yaml"
        serial_dispatch_path.write_text(yaml.safe_dump(serial_dispatch, sort_keys=False), encoding="utf-8")
        serial_compile_result = pmc.build_compile_executor_seeds_data(serial_dispatch_path, 1)
        bad_scope_dispatch = json.loads(json.dumps(dispatch))
        bad_scope_dispatch["dispatch_manifest"]["waves"][0]["lanes"][0]["scope"] = {
            "read": "a.md",
            "write": [{"path": "a.md"}],
            "delete": [" "],
        }
        bad_scope_path = root / "bad-scope-dispatch.yaml"
        bad_scope_path.write_text(yaml.safe_dump(bad_scope_dispatch, sort_keys=False), encoding="utf-8")
        bad_scope_result = pmc.build_compile_executor_seeds_data(bad_scope_path, 1)
        fragment_result = pmc.build_fragment_data(frag, "S1", [])
        front_matter_fragment_result = pmc.build_fragment_data(front_matter_frag, "S1", [])
        heading_fragment_result = pmc.build_fragment_data(heading_frag, "S1", [])
        invalid_fragment_result = pmc.build_fragment_data(bad_frag, "S1", [])
        missing_validation_fragment_result = pmc.build_fragment_data(
            missing_validation_path, "S1", []
        )
        spec = root / "spec.md"
        acceptance = root / "acceptance.yaml"
        acceptance_join = root / "acceptance-join.json"
        state_file = root / "planning-state.yaml"
        spec.write_text("# locked spec\n", encoding="utf-8")
        acceptance.write_text("acceptance_contract:\n  schema_version: 1\n", encoding="utf-8")
        acceptance_join.write_text(
            json.dumps(
                {
                    "status": "pass",
                    "contract": "acceptance.yaml",
                    "topology": "notes/manifests/p1-planning-topology.yaml",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        original_root = pmc.ROOT
        try:
            pmc.ROOT = root
            current_refs = {
                "trusted_spec": pmc.identity("spec.md"),
                "interface_contracts": pmc.identity("contracts.yaml"),
                "acceptance_contract": pmc.identity("acceptance.yaml"),
                "acceptance_join": pmc.identity("acceptance-join.json"),
                "source_fragments": [pmc.identity("fragment.md")],
                "dispatch_manifest": pmc.identity("dispatch.yaml"),
            }
            review_state = {
                "planning_state": {
                    "trusted_spec_ref": "spec.md",
                    "interface_contracts_ref": "contracts.yaml",
                    "acceptance_contract_ref": "acceptance.yaml",
                    "acceptance_join_ref": "acceptance-join.json",
                    "dispatch_manifest_ref": "dispatch.yaml",
                    "semantic_review": {
                        "status": "pass",
                        "trusted_spec_ref": "spec.md",
                        "acceptance_contract_ref": "acceptance.yaml",
                        "acceptance_join_ref": "acceptance-join.json",
                        "dispatch_manifest_ref": "dispatch.yaml",
                        "coverage_checks": {
                            "locked_spec_coverage": "pass",
                            "fragment_coverage": "pass",
                            "interface_contract_compatibility": "pass",
                            "validation_object_coverage": "pass",
                            "acceptance_contract_coverage": "pass",
                            "acceptance_dispatch_traceability": "pass",
                            "deviations": [],
                        },
                        "manifest_revision": 1,
                    },
                    "manifest_freeze": {
                        "status": "frozen",
                        "phase_id": "p1",
                        "manifest_revision": 1,
                    },
                }
            }
            state_file.write_text(yaml.safe_dump(review_state, sort_keys=False), encoding="utf-8")
            review_binding_result = pmc.build_review_binding_data(state_file)
            review_state_result = pmc.build_review_state_data(state_file)
            review_state["planning_state"]["semantic_review"]["dispatch_manifest_ref"] = "stale-dispatch.yaml"
            review_state["planning_state"]["semantic_review"]["trusted_spec_ref"] = "stale-spec.md"
            state_file.write_text(yaml.safe_dump(review_state, sort_keys=False), encoding="utf-8")
            review_ref_mismatch_result = pmc.build_review_state_data(state_file)
            review_state["planning_state"]["semantic_review"]["dispatch_manifest_ref"] = "dispatch.yaml"
            review_state["planning_state"]["semantic_review"]["trusted_spec_ref"] = "spec.md"
            review_state["planning_state"]["semantic_review"]["coverage_checks"]["deviations"] = ["known gap"]
            state_file.write_text(yaml.safe_dump(review_state, sort_keys=False), encoding="utf-8")
            deviations_result = pmc.build_review_state_data(state_file)
            review_state["planning_state"]["semantic_review"]["coverage_checks"]["deviations"] = []
            state_file.write_text(yaml.safe_dump(review_state, sort_keys=False), encoding="utf-8")
            spec.write_text("# changed spec\n", encoding="utf-8")
            changed_input_result = pmc.build_review_state_data(state_file)
            spec.write_text("# locked spec\n", encoding="utf-8")
            bumped_dispatch = json.loads(json.dumps(dispatch))
            bumped_dispatch["dispatch_manifest"]["version"] = 2
            dis.write_text(yaml.safe_dump(bumped_dispatch, sort_keys=False), encoding="utf-8")
            bumped_revision_result = pmc.build_review_state_data(state_file)
            dis.write_text(yaml.safe_dump(dispatch, sort_keys=False), encoding="utf-8")
            review_state["planning_state"]["manifest_freeze"]["manifest_sha256"] = "deadbeef"
            review_state["planning_state"]["semantic_review"]["shared_metadata"] = {"hash": "unused"}
            state_file.write_text(yaml.safe_dump(review_state, sort_keys=False), encoding="utf-8")
            hash_key_result = pmc.build_review_state_data(state_file)
            del review_state["planning_state"]["manifest_freeze"]["manifest_sha256"]
            state_file.write_text(yaml.safe_dump(review_state, sort_keys=False), encoding="utf-8")
            acceptance_join.write_text('{"status":"fail"}\n', encoding="utf-8")
            try:
                pmc.build_review_binding_data(state_file)
            except ToolError as exc:
                failed_join_rejected = "acceptance join is not pass" in str(exc)
            else:
                failed_join_rejected = False
        finally:
            pmc.ROOT = original_root
    checks = {
        "topology_passes": topology_result["status"] == "pass",
        "dispatch_passes": dispatch_result["status"] == "pass",
        "dispatch_requires_validation_requirement_refs": invalid_dispatch_result["status"] == "fail"
        and any("validation_requirement_refs_missing" in item["code"] for item in invalid_dispatch_result["issues"]),
        "compile_executor_seeds_maps_lane_fields": (
            compile_result["status"] == "pass"
            and len(compile_result["parallel_seeds"]) == 1
            and not compile_result["serial_seeds"]
            and compile_result["parallel_seeds"][0]["route_id"] == pmc.EXECUTOR_ROUTE_ID
            and compile_result["parallel_seeds"][0]["slug"] == "p1/p1-L1-SUMMARY"
            and compile_result["parallel_seeds"][0]["scope"]["write_extra"] == ["a.md"]
            and compile_result["parallel_seeds"][0]["scope"]["read"][0] == compile_result["dispatch_manifest"]
            and "a.md" in compile_result["parallel_seeds"][0]["scope"]["read"]
            and compile_result["parallel_seeds"][0]["contract"]["lane_id"] == "L1"
            and compile_result["parallel_seeds"][0]["contract"]["planning_wave"] == 1
            and compile_result["parallel_seeds"][0]["contract"]["task"] == "edit a.md"
            and compile_result["parallel_seeds"][0]["contract"]["lane_execution_mode"] == "direct_write"
            and compile_result["parallel_seeds"][0]["contract"]["validation"]["requirement_refs"] == ["AS-01"]
        ),
        "compile_executor_seeds_fail_closed_on_invalid_manifest": (
            compile_invalid_result["status"] == "fail"
            and not compile_invalid_result["parallel_seeds"]
            and not compile_invalid_result["serial_seeds"]
        ),
        "compile_executor_seeds_rejects_missing_wave": compile_missing_wave_rejected,
        "compile_seed_auto_includes_locked_interface_contracts": (
            "notes/manifests/p1-interface-contracts.yaml"
            in compile_with_contracts_result["parallel_seeds"][0]["scope"]["read"]
            and "notes/manifests/p1-interface-contracts.yaml"
            not in compile_result["parallel_seeds"][0]["scope"]["read"]
        ),
        "dispatch_rejects_unknown_serial_lane_reference": (
            unknown_serial_result["status"] == "fail"
            and any("serial_lane_unknown=L-GHOST" in item["code"] for item in unknown_serial_result["issues"])
            and not unknown_serial_result["parallel_seeds"]
        ),
        "compile_executor_seeds_groups_serial_lanes": (
            serial_compile_result["status"] == "pass"
            and [seed["contract"]["lane_id"] for seed in serial_compile_result["parallel_seeds"]] == ["L1"]
            and [seed["contract"]["lane_id"] for seed in serial_compile_result["serial_seeds"]] == ["L2"]
        ),
        "dispatch_rejects_non_string_list_scope_and_blocks_compile": (
            bad_scope_result["status"] == "fail"
            and all(
                any(f"scope_{key}_not_string_list" in item["code"] for item in bad_scope_result["issues"])
                for key in ("read", "write", "delete")
            )
            and not bad_scope_result["parallel_seeds"]
            and not bad_scope_result["serial_seeds"]
        ),
        "fragment_dependency_edges_pass": fragment_result["status"] == "pass",
        "fragment_accepts_leading_front_matter_machine_block": front_matter_fragment_result["status"] == "pass",
        "fragment_accepts_raw_machine_block_under_required_heading": heading_fragment_result["status"] == "pass",
        "fragment_dependency_edges_reject_invalid_closed_values": (
            invalid_fragment_result["status"] == "fail"
            and any("dependency_type_invalid=invented" in item["code"] for item in invalid_fragment_result["issues"])
            and any("release_gate_invalid=invented" in item["code"] for item in invalid_fragment_result["issues"])
        ),
        "fragment_requires_validation_requirement_refs": missing_validation_fragment_result["status"]
        == "fail"
        and any(
            "validation_requirement_refs_missing" in item["code"]
            for item in missing_validation_fragment_result["issues"]
        ),
        "review_state_passes_with_matching_refs_and_revision": review_state_result["status"] == "pass",
        "review_binding_snapshot_is_checker_owned": (
            review_binding_result["status"] == "pass"
            and review_binding_result["summary"]["phase_id"] == "p1"
            and review_binding_result["summary"]["manifest_revision"] == 1
            and review_binding_result["summary"]["input_refs"] == current_refs
            and "sha256" not in json.dumps(review_binding_result)
        ),
        "review_state_binds_by_revision_not_content": changed_input_result["status"] == "pass",
        "review_state_rejects_manifest_revision_bump_without_rereview": (
            bumped_revision_result["status"] == "fail"
            and any("semantic_review_manifest_revision_mismatch" in item["code"] for item in bumped_revision_result["issues"])
            and any("manifest_freeze_manifest_revision_mismatch" in item["code"] for item in bumped_revision_result["issues"])
        ),
        "review_state_accepts_unconsumed_metadata": hash_key_result["status"] == "pass",
        "review_binding_rejects_failed_acceptance_join": failed_join_rejected,
        "review_state_rejects_nonempty_deviations": (
            deviations_result["status"] == "fail"
            and any("semantic_review_deviations_not_empty" in item["code"] for item in deviations_result["issues"])
        ),
        "review_state_rejects_semantic_ref_mismatch": (
            review_ref_mismatch_result["status"] == "fail"
            and any("semantic_review_dispatch_manifest_ref_mismatch" in item["code"] for item in review_ref_mismatch_result["issues"])
            and any("semantic_review_trusted_spec_ref_mismatch" in item["code"] for item in review_ref_mismatch_result["issues"])
        ),
    }
    return {"tool": "planning_manifest_check", "status": "pass" if all(checks.values()) else "fail", "exit_code": 0 if all(checks.values()) else 1, "checks": checks}


if __name__ == "__main__":
    result = self_test()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(result["exit_code"])
