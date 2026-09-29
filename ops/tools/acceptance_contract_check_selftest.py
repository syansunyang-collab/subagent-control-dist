#!/usr/bin/env python3
"""Self-test fixtures and checks for acceptance_contract_check.py."""

from __future__ import annotations

import json
import sys
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

sys.dont_write_bytecode = True

import acceptance_contract_check as acc
from _tool_common import ToolError, node_json


def fleet_manifest_check(manifest: dict[str, Any]) -> dict[str, Any]:
    """fleet_manifest_check 已迁 JS：写临时 manifest 再经 CLI 取 JSON。

    CLI 输出是 validate_manifest 的返回值再加一个 manifest_path，这里去掉该字段。
    manifest 不合法时 CLI 退出码 1，node_json 抛 ToolError，退化成 status=failed——
    本自测只断言 status == "ok"，与直接调用时的判定结果一致。
    """
    with TemporaryDirectory(prefix="acceptance-fleet-check-") as raw:
        path = Path(raw) / "manifest.json"
        path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        try:
            data = node_json(
                ["ops/tools/fleet_manifest_check.mjs", "--manifest", str(path), "--format", "json"]
            )
        except ToolError as exc:
            return {"status": "failed", "errors": [str(exc)]}
    data.pop("manifest_path", None)
    return data


def self_test() -> dict[str, Any]:
    if acc.yaml is None:
        raise ToolError("PyYAML is required for self-test") from acc.YAML_IMPORT_ERROR
    contract_doc = acc.selftest_contract()
    contract = acc.acceptance_root(contract_doc)
    example_doc = acc.example_contract()
    example = acc.acceptance_root(example_doc)
    example_result = acc.validate_contract_data(example)
    with TemporaryDirectory() as spec_temp:
        spec_root = Path(spec_temp)
        (spec_root / "notes" / "context").mkdir(parents=True)
        spec_path = spec_root / "notes" / "context" / "example-alignment.md"
        spec_path.write_text(
            "# spec\n\n## Alignment State\n\n```yaml\nalignment_state:\n  locks:\n"
            "    requirements_locked: true\n    product_experience_locked: true\n```\n\n"
            "## alignment_spec\n\nAS-01 the CLI rejects conflicting flags.\n",
            encoding="utf-8",
        )
        entry_locked_static_only = acc.validate_contract_data(contract, root=spec_root)
        entry_locked_with_functional = acc.validate_contract_data(example, root=spec_root)
        spec_path.write_text(
            "# spec\n\n## Alignment State\n\n```yaml\nalignment_state:\n  locks:\n"
            "    requirements_locked: true\n    product_experience_locked: not_needed\n```\n",
            encoding="utf-8",
        )
        entry_not_needed_static_only = acc.validate_contract_data(contract, root=spec_root)

        def write_v4_spec(objects: dict[str, str], *, product_experience_locked: bool = False) -> None:
            state = {
                "version": 4,
                "locks": {"requirements_locked": True, "product_experience_locked": product_experience_locked},
                "alignment_spec": [
                    {"spec_id": spec_id, "statement": "s", "acceptance": ["a"], "validation_object": value}
                    for spec_id, value in objects.items()
                ],
            }
            spec_path.write_text(
                "# spec\n\n## Alignment State\n\n```yaml\n"
                + acc.yaml.safe_dump({"alignment_state": state}, allow_unicode=True, sort_keys=False)
                + "```\n",
                encoding="utf-8",
            )

        write_v4_spec({"AS-01": "changed code behavior"})
        spec_aligned = acc.validate_contract_data(contract, root=spec_root)
        rephrased = deepcopy(contract)
        rephrased["items"][0]["validation_object"] = "changed behaviour of the code"
        spec_rephrased = acc.validate_contract_data(rephrased, root=spec_root)
        extra_requirement = deepcopy(contract)
        extra_requirement["requirement_ids"] = ["AS-01", "AS-09"]
        extra_requirement["items"][0]["requirement_refs"] = ["AS-01", "AS-09"]
        spec_extra_requirement = acc.validate_contract_data(extra_requirement, root=spec_root)
        write_v4_spec({"AS-01": "changed code behavior", "AS-02": "report layout"})
        spec_missing_requirement = acc.validate_contract_data(contract, root=spec_root)
        write_v4_spec({"AS-01": "cli_strict_conflict_rejection"}, product_experience_locked=True)
        spec_backed_example = acc.validate_contract_data(example, root=spec_root)
    topology = {
        "phase_id": "p1",
        "trusted_spec_ref": contract["trusted_spec_ref"],
        "planning_slices": [
            {"slice_id": "S1", "validation_objects": {"AS-01": "changed code behavior"}}
        ],
    }
    dispatch = {
        "version": 1,
        "phase_id": "p1",
        "trusted_spec_ref": contract["trusted_spec_ref"],
        "acceptance_contract_ref": "acceptance.yaml",
        "acceptance_join_ref": "acceptance-join.json",
        "waves": [
            {
                "wave": 1,
                "lanes": [
                    {
                        "lane_id": "L1",
                        "task": "edit src/a.py",
                        "scope": {"read": ["src/a.py"], "write": ["src/a.py"]},
                        "conflict_keys": [],
                        "depends_on": [],
                        "dependency_edges": [],
                        "resource_locks": [],
                        "write_ownership": {"direct_paths": ["src/a.py"], "shared_paths": []},
                        "validation": {
                            "object": "changed code behavior",
                            "method": "pytest",
                            "pass_condition": "pass",
                            "requirement_refs": ["AS-01"],
                        },
                        "parallel_required": True,
                        "mode": "direct_write",
                    }
                ],
            }
        ],
    }
    contract_result = acc.validate_contract_data(contract)
    topology_join = acc.build_topology_join_data(contract, topology)
    dispatch_join = acc.build_dispatch_join_data(contract, dispatch, "acceptance.yaml")
    invalid_contract = deepcopy(contract)
    invalid_contract["items"][0]["route_contract"].pop("review_goal")
    invalid_result = acc.validate_contract_data(invalid_contract)
    invalid_macro_location = deepcopy(contract)
    invalid_macro_location["items"][0]["evidence_refs"] = ["$trusted_spec_ref"]
    invalid_macro_location_result = acc.validate_contract_data(invalid_macro_location)
    invalid_macro_name = deepcopy(contract)
    invalid_macro_name["items"][0]["route_contract"]["affected_files"] = ["$invented_ref"]
    invalid_macro_name_result = acc.validate_contract_data(invalid_macro_name)
    missing_topology = deepcopy(topology)
    missing_topology["planning_slices"][0]["validation_objects"] = {}
    missing_join = acc.build_topology_join_data(contract, missing_topology)
    functional_item = {
        "acceptance_id": "AC-FUNCTION",
        "requirement_refs": ["AS-01"],
        "validation_object": "functional CLI flow",
        "oracle": "entrypoints are usable",
        "technique": "example",
        "cases": [],
        "evidence_requirements": [],
        "severity": "blocking",
        "confirmation_scope": [],
        "regression_scope": [],
        "route_id": "verify-agent__functional-inspection",
        "route_contract": {
            "inspection_target": "functional CLI flow",
            "source_refs": ["$source_refs"],
            "entrypoints": ["python -V"],
            "input_assets": ["$acceptance_contract_ref"],
            "artifact_paths": ["test-results/functional-inspection"],
            "implementation_refs": ["$implementation_refs"],
            "work_dir": "$verification_work_dir",
        },
    }
    functional_seed = acc.leaf_seed(
        functional_item,
        contract,
        "acceptance.yaml",
        "dispatch.yaml",
        ["src/a.py"],
        round_number=2,
    )
    spec_backed_contract = deepcopy(contract)
    spec_backed_contract["trusted_spec_ref"] = "ops/fixtures/acceptance-authoring-route-context.md#alignment_spec"
    spec_backed_code_seed = acc.leaf_seed(
        spec_backed_contract["items"][0],
        spec_backed_contract,
        "acceptance.yaml",
        "dispatch.yaml",
        ["src/a.py"],
        round_number=1,
    )
    spec_backed_functional_seed = acc.leaf_seed(
        functional_item,
        spec_backed_contract,
        "acceptance.yaml",
        "dispatch.yaml",
        ["src/a.py"],
        round_number=1,
    )
    rule_quality_item = {
        "acceptance_id": "AC-RULE",
        "requirement_refs": ["AS-01"],
        "validation_object": "rule quality",
        "oracle": "rules are executable",
        "technique": "white_box",
        "cases": [],
        "evidence_requirements": [],
        "severity": "blocking",
        "confirmation_scope": [],
        "regression_scope": [],
        "route_id": "semantic-review-agent__rule-quality-inspection",
        "route_contract": {
            "target_files": ["$implementation_refs"],
            "inspection_focus": ["single_direction"],
        },
    }
    rule_quality_seed = acc.leaf_seed(
        rule_quality_item,
        contract,
        "acceptance.yaml",
        "dispatch.yaml",
        ["AGENTS.md"],
        round_number=1,
    )
    mixed_ref_item = deepcopy(contract["items"][0])
    mixed_ref_item["evidence_refs"] = ["AGENTS.md#section-anchor", "ops/tools"]
    mixed_ref_seed = acc.leaf_seed(
        mixed_ref_item,
        contract,
        "AGENTS.md",
        "AGENTS.md",
        ["ops/tools/dispatch_prepare.py"],
        round_number=1,
    )

    with TemporaryDirectory() as path_temp:
        path_root = Path(path_temp)
        (path_root / "scope" / "nested").mkdir(parents=True)
        (path_root / "scope" / "a.txt").write_text("a", encoding="utf-8")
        (path_root / "scope" / "nested" / "b.txt").write_text("b", encoding="utf-8")
        expanded_review_refs = acc.expand_review_file_refs(
            ["scope", "new.py"], root=path_root
        )

    with TemporaryDirectory() as temp:
        root = Path(temp)
        report = root / "reducer.md"
        review_result = {
            "schema_version": 1,
            "gate": "fail",
            "summary": "AC-01 requires targeted rework",
            "findings": [
                {
                    "title": "boundary case fails",
                    "criteria": "AC-01 oracle",
                    "issue": "boundary result differs",
                    "impact": "AS-01 is not satisfied",
                    "repair": "repair L1 boundary handling",
                    "location": "src/a.py",
                    "evidence_refs": ["test-output.txt"],
                    "acceptance_refs": ["AC-01"],
                    "requirement_refs": ["AS-01"],
                }
            ],
            "evidence_gaps": [],
            "scope": {"reviewed": ["acceptance.yaml"], "not_reviewed": []},
            "output": {
                "disposition": "rework",
                "acceptance_ids_considered": ["AC-01"],
                "failed_acceptance_ids": ["AC-01"],
                "confirmation_acceptance_ids": ["AC-01"],
                "regression_acceptance_ids": [],
                "coverage": {"passed": [], "failed": ["AC-01"], "uncertain": [], "missing": []},
            },
        }
        report.write_text(
            "# reducer\n\n```json review_result\n"
            + json.dumps(review_result, ensure_ascii=False, indent=2)
            + "\n```\n",
            encoding="utf-8",
        )
        parsed = acc.extract_review_result(report)
        decision = acc.validate_decision(parsed, contract)
        bare_report = root / "reducer-bare.md"
        bare_report.write_text(
            "# reducer\n\n`acceptance_gate: needs_owner`\n\n```json\n"
            + json.dumps(
                {
                    "disposition": "needs_owner",
                    "acceptance_ids_considered": ["AC-01"],
                    "failed_acceptance_ids": [],
                    "confirmation_acceptance_ids": [],
                    "regression_acceptance_ids": [],
                    "coverage": {"passed": [], "failed": [], "uncertain": ["AC-01"], "missing": []},
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n```\n",
            encoding="utf-8",
        )
        bare_decision = acc.validate_decision(acc.extract_review_result(bare_report), contract)
        pass_with_followup = deepcopy(parsed)
        pass_with_followup["gate"] = "pass"
        pass_with_followup["findings"] = []
        pass_with_followup["output"] = {
            "disposition": "pass",
            "acceptance_ids_considered": ["AC-01"],
            "failed_acceptance_ids": [],
            "confirmation_acceptance_ids": ["AC-01"],
            "regression_acceptance_ids": ["AC-01"],
            "coverage": {"passed": ["AC-01"], "failed": [], "uncertain": [], "missing": []},
        }
        pass_with_followup_decision = acc.validate_decision(pass_with_followup, contract)
        two_item_contract = deepcopy(contract)
        second_item = deepcopy(two_item_contract["items"][0])
        second_item["acceptance_id"] = "AC-02"
        two_item_contract["items"].append(second_item)
        rework_with_gap = deepcopy(parsed)
        rework_with_gap["output"]["acceptance_ids_considered"] = ["AC-01", "AC-02"]
        rework_with_gap["output"]["coverage"] = {
            "passed": [],
            "failed": ["AC-01"],
            "uncertain": [],
            "missing": ["AC-02"],
        }
        gap_decision = acc.validate_decision(rework_with_gap, two_item_contract)
        two_item_rework = deepcopy(rework_with_gap)
        two_item_rework["output"]["coverage"] = {
            "passed": ["AC-02"],
            "failed": ["AC-01"],
            "uncertain": [],
            "missing": [],
        }
        invalid_decision_result = deepcopy(parsed)
        invalid_decision_result["output"]["coverage"] = {
            "passed": [],
            "failed": [],
            "uncertain": [],
            "missing": [],
        }
        invalid_decision = acc.validate_decision(invalid_decision_result, contract)
        initial = acc.compile_validation_manifest(contract, "acceptance.yaml", dispatch, "dispatch.yaml")
        legacy_item_contract = deepcopy(contract)
        legacy_item_contract["items"][0].update(
            {
                "risk": "medium",
                "risk_triggers": ["state transition changed"],
                "independence": "independent",
            }
        )
        legacy_item_result = acc.validate_contract_data(legacy_item_contract)
        legacy_item_manifest = acc.compile_validation_manifest(
            legacy_item_contract, "acceptance.yaml", dispatch, "dispatch.yaml"
        )
        initial_multi = acc.compile_validation_manifest(
            two_item_contract, "acceptance.yaml", dispatch, "dispatch.yaml"
        )
        # 并桌:两条同 route 项 → 1 个叶子 + reducer;跨 route 项 → 每 route 一叶。
        grouped_leaf = initial_multi["nodes"][0]
        two_route_contract = deepcopy(two_item_contract)
        two_route_contract["items"][1]["route_id"] = "verify-agent__functional-inspection"
        two_route_contract["items"][1]["route_contract"] = deepcopy(functional_item["route_contract"])
        two_route_manifest = acc.compile_validation_manifest(
            two_route_contract, "acceptance.yaml", dispatch, "dispatch.yaml"
        )
        exclusive_contract = deepcopy(two_route_contract)
        exclusive_contract["items"][1]["exclusive_measurement"] = True
        exclusive_contract["items"][1]["evidence_refs"] = ["AGENTS.md"]
        exclusive_manifest = acc.compile_validation_manifest(
            exclusive_contract, "acceptance.yaml", dispatch, "dispatch.yaml"
        )
        exclusive_fleet_check = fleet_manifest_check(exclusive_manifest)
        round_two = acc.compile_validation_manifest(
            two_item_contract,
            "acceptance.yaml",
            dispatch,
            "dispatch.yaml",
            round_number=2,
            prior_decision_ref="reducer-r1.md",
        )
        leaf_pass = acc.leaf_decision_from_report(
            {"schema_version": 1, "gate": "pass", "summary": "leaf ok", "findings": [],
             "acceptance_results": [{"acceptance_id": "AC-01", "gate": "pass"}]},
            contract,
        )
        leaf_pass_decision = acc.validate_decision(leaf_pass, contract)
        leaf_fail = acc.leaf_decision_from_report(
            {
                "schema_version": 1,
                "gate": "fail",
                "summary": "leaf fail",
                "acceptance_results": [{"acceptance_id": "AC-01", "gate": "fail"}],
                "findings": [{"title": "boundary case fails", "acceptance_refs": ["AC-01"]}],
            },
            contract,
        )
        leaf_fail_decision = acc.validate_decision(leaf_fail, contract)
        leaf_uncertain = acc.leaf_decision_from_report(
            {"schema_version": 1, "gate": "needs_owner", "summary": "leaf uncertain", "findings": [],
             "acceptance_results": [{"acceptance_id": "AC-01", "gate": "needs_owner"}]},
            contract,
        )
        leaf_uncertain_decision = acc.validate_decision(leaf_uncertain, contract)
        try:
            acc.leaf_decision_from_report({"gate": "pass"}, two_item_contract)
        except ToolError as exc:
            leaf_multi_rejected = "single-item" in str(exc)
        else:
            leaf_multi_rejected = False
        try:
            acc.leaf_decision_from_report(
                {"gate": "fail", "findings": [{"title": "x", "acceptance_refs": ["AC-99"]}]},
                contract,
            )
        except ToolError as exc:
            leaf_foreign_ref_rejected = "foreign acceptance ids" in str(exc)
        else:
            leaf_foreign_ref_rejected = False
        try:
            acc.leaf_decision_from_report(
                {"gate": "fail", "findings": [],
                 "acceptance_results": [{"acceptance_id": "AC-01", "gate": "fail"}]}, contract)
        except ToolError as exc:
            leaf_fail_requires_findings = "at least one finding" in str(exc)
        else:
            leaf_fail_requires_findings = False
        try:
            acc.leaf_decision_from_report(
                {
                    "gate": "pass",
                    "acceptance_results": [{"acceptance_id": "AC-01", "gate": "pass"}],
                    "findings": [{"title": "unexpected finding", "acceptance_refs": ["AC-01"]}],
                },
                contract,
            )
        except ToolError as exc:
            leaf_pass_rejects_findings = "findings" in str(exc)
        else:
            leaf_pass_rejects_findings = False
        try:
            acc.leaf_decision_from_report(
                {"gate": "pass", "findings": [], "evidence_gaps": ["missing log"],
                 "acceptance_results": [{"acceptance_id": "AC-01", "gate": "pass"}]}, contract
            )
        except ToolError as exc:
            leaf_pass_rejects_gaps = "evidence_gaps" in str(exc)
        else:
            leaf_pass_rejects_gaps = False
        try:
            acc.leaf_decision_from_report({"gate": "pass", "findings": {"oops": True}}, contract)
        except ToolError as exc:
            leaf_rejects_nonlist_findings = "must be a list" in str(exc)
        else:
            leaf_rejects_nonlist_findings = False
        try:
            acc.leaf_decision_from_report({"gate": "pass", "findings": [], "evidence_gaps": "gap"}, contract)
        except ToolError as exc:
            leaf_rejects_nonlist_gaps = "must be a list" in str(exc)
        else:
            leaf_rejects_nonlist_gaps = False
        origin_task_id = "subagent-2026-01-01T00-00-00-000Z-abcd1234"
        origin_state = {"nodes": [{"id": "verify-ac-01", "task_id": origin_task_id}]}
        with TemporaryDirectory() as origin_temp:
            origin_root = Path(origin_temp)
            origin_task_dir = origin_root / origin_task_id
            origin_task_dir.mkdir(parents=True)
            authoritative_report = origin_task_dir / "report.md"
            authoritative_report.write_text("# leaf report\n", encoding="utf-8")
            forged_dir = origin_root / "forged" / origin_task_id
            forged_dir.mkdir(parents=True)
            forged_report = forged_dir / "report.md"
            forged_report.write_text("# forged\n", encoding="utf-8")
            origin_ok = acc.verify_leaf_origin(
                origin_state, "verify-ac-01", "", authoritative_report, task_root=origin_root
            )
            try:
                acc.verify_leaf_origin(origin_state, "verify-ac-01", "", forged_report, task_root=origin_root)
            except ToolError as exc:
                origin_forged_path_rejected = "not an authoritative artifact" in str(exc)
            else:
                origin_forged_path_rejected = False
            try:
                acc.verify_leaf_origin(
                    origin_state, "verify-ac-01", "subagent-other-task", authoritative_report, task_root=origin_root
                )
            except ToolError as exc:
                origin_task_mismatch_rejected = "origin mismatch" in str(exc)
            else:
                origin_task_mismatch_rejected = False
        sync_ok_contract = deepcopy(contract)
        sync_ok_contract["mechanical_sync"] = {"write_paths": ["notes/manifests/example.yaml"]}
        sync_ok_result = acc.validate_contract_data(sync_ok_contract)
        sync_bad_contract = deepcopy(contract)
        sync_bad_contract["mechanical_sync"] = {"write_paths": ["ops/workflows/planning/WORKFLOW.md"]}
        sync_bad_result = acc.validate_contract_data(sync_bad_contract)
        sync_forbidden_results = {}
        for case_name, write_path in {
            "case_variant": "OPS/workflows/planning/WORKFLOW.md",
            "traversal": "tmp/../ops/workflows/planning/WORKFLOW.md",
            "role_config": "ops/agents/executor-agent.toml",
            "tools": "ops/tools/dispatch_prepare.py",
            "outside_repo": str(acc.ROOT.resolve().parent / "outside-mechanical-sync.txt"),
        }.items():
            candidate = deepcopy(contract)
            candidate["mechanical_sync"] = {"write_paths": [write_path]}
            sync_forbidden_results[case_name] = acc.validate_contract_data(candidate)
        leaf_followup = acc.compile_followup_manifest(
            contract,
            "acceptance.yaml",
            dispatch,
            "dispatch.yaml",
            leaf_fail,
            "leaf-r1.md",
            current_round=1,
        )
        template_doc = acc.mechanical_sync_template()
        template_contract = acc.acceptance_root(template_doc)
        try:
            acc.compile_validation_manifest(
                contract,
                "acceptance.yaml",
                dispatch,
                "dispatch.yaml",
                round_number=2,
            )
        except ToolError as exc:
            round_two_without_prior_rejected = "requires prior_decision_ref" in str(exc)
        else:
            round_two_without_prior_rejected = False
        followup = acc.compile_followup_manifest(
            contract,
            "acceptance.yaml",
            dispatch,
            "dispatch.yaml",
            parsed,
            "reducer.md",
            current_round=1,
        )
        two_item_followup = acc.compile_followup_manifest(
            two_item_contract,
            "acceptance.yaml",
            dispatch,
            "dispatch.yaml",
            two_item_rework,
            "reducer.md",
            current_round=1,
        )
        # 只重跑形态:没有失败项,AC-02 因叶子环境未决 → confirmation 覆盖它,rework 合法且不派返工 lane。
        rerun_only = deepcopy(parsed)
        rerun_only["gate"] = "fail"
        rerun_only["findings"] = []
        rerun_only["output"] = {
            "disposition": "rework",
            "acceptance_ids_considered": ["AC-01", "AC-02"],
            "failed_acceptance_ids": [],
            "confirmation_acceptance_ids": ["AC-02"],
            "regression_acceptance_ids": [],
            "coverage": {"passed": ["AC-01"], "failed": [], "uncertain": ["AC-02"], "missing": []},
        }
        rerun_only_decision = acc.validate_decision(rerun_only, two_item_contract)
        rerun_only_followup = acc.compile_followup_manifest(
            two_item_contract,
            "acceptance.yaml",
            dispatch,
            "dispatch.yaml",
            rerun_only,
            "reducer.md",
            current_round=1,
        )
        uncovered_uncertain = deepcopy(rerun_only)
        uncovered_uncertain["output"]["confirmation_acceptance_ids"] = []
        uncovered_uncertain_decision = acc.validate_decision(uncovered_uncertain, two_item_contract)
        initial_fleet_check = fleet_manifest_check(initial)
        followup_fleet_check = fleet_manifest_check(followup)
        rerun_only_fleet_check = fleet_manifest_check(rerun_only_followup)
        try:
            acc.compile_followup_manifest(
                contract,
                "acceptance.yaml",
                dispatch,
                "dispatch.yaml",
                parsed,
                "reducer.md",
                current_round=acc.MAX_REVIEW_ROUNDS,
                previous_result=two_item_rework,
            )
        except ToolError as exc:
            round_limit_rejected = "round limit" in str(exc)
        else:
            round_limit_rejected = False
        # 历史报告可选；预算内相同未决项仍可恢复重试。
        followup_without_previous = acc.compile_followup_manifest(
            contract, "acceptance.yaml", dispatch, "dispatch.yaml",
            parsed, "reducer.md", current_round=2,
        )
        shrinking_prev = deepcopy(two_item_rework)
        shrinking_prev["output"]["failed_acceptance_ids"] = ["AC-01", "AC-02"]
        shrinking_prev["output"]["confirmation_acceptance_ids"] = ["AC-01", "AC-02"]
        shrinking_prev["output"]["coverage"] = {
            "passed": [],
            "failed": ["AC-01", "AC-02"],
            "uncertain": [],
            "missing": [],
        }
        converging_followup = acc.compile_followup_manifest(
            two_item_contract,
            "acceptance.yaml",
            dispatch,
            "dispatch.yaml",
            two_item_rework,
            "reducer.md",
            current_round=2,
            previous_result=shrinking_prev,
        )
        non_shrinking_followup = acc.compile_followup_manifest(
            two_item_contract, "acceptance.yaml", dispatch, "dispatch.yaml",
            two_item_rework, "reducer.md", current_round=2,
            previous_result=two_item_rework,
        )

    checks = {
        "valid_contract_passes": contract_result["status"] == "pass",
        "example_contract_passes_and_pairs_entry_with_static_route": example_result["status"] == "pass"
        and [item["route_id"] for item in example["items"]]
        == ["verify-agent__functional-inspection", "verify-agent__code-verification"],
        "user_visible_spec_requires_entry_route": entry_locked_static_only["status"] == "fail"
        and any("user_visible_spec_without_entry_route" in item["code"] for item in entry_locked_static_only["issues"]),
        "user_visible_spec_satisfied_by_functional_item": entry_locked_with_functional["status"] == "pass",
        "entry_route_rule_only_applies_when_product_experience_locked": entry_not_needed_static_only["status"] == "pass"
        and contract_result["status"] == "pass",
        "spec_without_alignment_spec_adds_no_reconciliation": entry_not_needed_static_only["status"] == "pass",
        "spec_reconciliation_passes_when_ids_and_objects_match": spec_aligned["status"] == "pass",
        "spec_reconciliation_rejects_rephrased_validation_object": spec_rephrased["status"] == "fail"
        and [item["code"] for item in spec_rephrased["issues"]] == ["validation_object_mismatch=AS-01"],
        "spec_reconciliation_rejects_requirement_outside_spec": spec_extra_requirement["status"] == "fail"
        and [item["code"] for item in spec_extra_requirement["issues"]] == ["spec_requirements_unknown=AS-09"],
        "spec_reconciliation_rejects_spec_requirement_missing_from_contract": spec_missing_requirement["status"] == "fail"
        and [item["code"] for item in spec_missing_requirement["issues"]] == ["spec_requirements_missing=AS-02"],
        "example_contract_passes_against_v4_spec": spec_backed_example["status"] == "pass",
        "code_verification_leaf_packages_spec_as_truth_source": "ops/fixtures/acceptance-authoring-route-context.md"
        in spec_backed_code_seed["contract"].get("truth_sources", [])
        and "ops/fixtures/acceptance-authoring-route-context.md" in spec_backed_code_seed["scope"]["read"],
        "functional_leaf_does_not_get_truth_sources": "truth_sources" not in spec_backed_functional_seed["contract"],
        "missing_spec_file_adds_no_truth_sources": "truth_sources" not in initial["nodes"][0]["seed"]["contract"],
        "schema_omits_unconsumed_item_closed_sets": all(
            field not in acc.acceptance_schema_snapshot()
            for field in ("risk_values", "independence_values")
        ),
        "item_omits_unconsumed_fields": contract_result["status"] == "pass"
        and all(
            field not in contract["items"][0]
            for field in ("risk", "risk_triggers", "independence")
        ),
        "legacy_unconsumed_item_fields_preserve_compilation": legacy_item_result["status"] == "pass"
        and legacy_item_manifest == initial,
        "missing_route_contract_field_rejected": invalid_result["status"] == "fail"
        and any("route_contract_field_missing=review_goal" in item["code"] for item in invalid_result["issues"]),
        "route_macro_outside_contract_rejected": invalid_macro_location_result["status"] == "fail"
        and any("route_macro_outside_route_contract=$trusted_spec_ref" in item["code"] for item in invalid_macro_location_result["issues"]),
        "unknown_route_macro_rejected": invalid_macro_name_result["status"] == "fail"
        and any("route_macro_unknown=$invented_ref" in item["code"] for item in invalid_macro_name_result["issues"]),
        "review_directories_remain_read_references": expanded_review_refs
        == ["scope", "new.py"],
        "leaf_source_refs_strip_anchors_and_drop_directories": (
            "AGENTS.md" in mixed_ref_seed["scope"]["read"]
            and "AGENTS.md#section-anchor" not in mixed_ref_seed["scope"]["read"]
            and "ops/tools" not in mixed_ref_seed["scope"]["read"]
        ),
        "functional_work_dir_is_round_scoped_and_writable": functional_seed["contract"][
            "work_dir"
        ].endswith("-functional-inspection-r2/")
        and functional_seed["contract"]["work_dir"]
        in functional_seed["scope"].get("write_extra", []),
        "functional_leaf_writes_artifact_paths_and_uses_network": "test-results/functional-inspection"
        in functional_seed["scope"].get("write_extra", [])
        and functional_seed["runtime_context"]["network_needed"] == "yes",
        "leaf_scope_uses_item_material_not_contract_globals": "acceptance.yaml"
        not in rule_quality_seed["scope"]["read"]
        and "dispatch.yaml" not in rule_quality_seed["scope"]["read"]
        and "ops/skills/rule-authoring/SKILL.md" in rule_quality_seed["scope"]["read"],
        "topology_join_passes": topology_join["status"] == "pass",
        "topology_coverage_gap_rejected": missing_join["status"] == "fail",
        "dispatch_join_passes": dispatch_join["status"] == "pass",
        "validation_fleet_has_all_settled_reducer": initial_multi["nodes"][-1]["dependency_policy"]
        == "all_settled",
        "single_item_fleet_omits_reducer": len(initial["nodes"]) == 1
        and initial["nodes"][0]["id"].startswith("verify-")
        and "dependency_policy" not in initial["nodes"][0],
        "same_route_items_share_one_leaf": len(initial_multi["nodes"]) == 2
        and grouped_leaf["id"] == "verify-code-verification"
        and grouped_leaf["seed"]["contract"]["acceptance_context"]["acceptance_ids"] == ["AC-01", "AC-02"]
        and [entry["acceptance_id"] for entry in grouped_leaf["seed"]["contract"]["acceptance_context"]["items"]]
        == ["AC-01", "AC-02"]
        and initial_multi["nodes"][-1]["seed"]["contract"]["node_acceptance_map"]
        == {"verify-code-verification": ["AC-01", "AC-02"]},
        "cross_route_items_get_one_leaf_per_route": [node["id"] for node in two_route_manifest["nodes"]]
        == ["verify-code-verification", "verify-functional-inspection", "acceptance-reducer-r1"]
        and two_route_manifest["nodes"][1]["seed"]["contract"]["acceptance_context"]["acceptance_id"] == "AC-02",
        "exclusive_measurement_leaf_serialized_last": [node["id"] for node in exclusive_manifest["nodes"]]
        == ["verify-code-verification", "verify-functional-inspection-exclusive", "acceptance-reducer-r1"]
        and exclusive_manifest["nodes"][1]["depends_on"] == ["verify-code-verification"]
        and exclusive_manifest["nodes"][1]["dependency_policy"] == "all_settled"
        and exclusive_fleet_check["status"] == "ok",
        "leaf_decision_pass_is_machine_consumable": leaf_pass_decision["status"] == "pass"
        and leaf_pass_decision["summary"]["disposition"] == "pass",
        "leaf_decision_fail_maps_to_rework": leaf_fail_decision["status"] == "pass"
        and leaf_fail_decision["summary"]["disposition"] == "rework"
        and leaf_fail_decision["summary"]["failed_acceptance_ids"] == ["AC-01"],
        "leaf_decision_needs_owner_maps_to_needs_owner": leaf_uncertain_decision["status"] == "pass"
        and leaf_uncertain_decision["summary"]["disposition"] == "needs_owner",
        "leaf_decision_rejects_multi_item_contract": leaf_multi_rejected,
        "leaf_decision_rejects_foreign_acceptance_refs": leaf_foreign_ref_rejected,
        "leaf_decision_fail_requires_findings": leaf_fail_requires_findings,
        "leaf_decision_pass_rejects_findings": leaf_pass_rejects_findings,
        "leaf_decision_pass_rejects_evidence_gaps": leaf_pass_rejects_gaps,
        "leaf_decision_rejects_nonlist_findings": leaf_rejects_nonlist_findings,
        "leaf_decision_rejects_nonlist_evidence_gaps": leaf_rejects_nonlist_gaps,
        "leaf_origin_binding_accepts_authoritative_artifact": origin_ok["task_id"].endswith("abcd1234"),
        "leaf_origin_binding_rejects_forged_task_id_path": origin_forged_path_rejected,
        "leaf_origin_binding_rejects_task_mismatch": origin_task_mismatch_rejected,
        "mechanical_sync_write_paths_accepted": sync_ok_result["status"] == "pass",
        "mechanical_sync_rule_object_write_rejected": sync_bad_result["status"] == "fail"
        and any("mechanical_sync_write_path_forbidden" in item["code"] for item in sync_bad_result["issues"]),
        "mechanical_sync_canonical_paths_are_enforced": all(
            result["status"] == "fail" for result in sync_forbidden_results.values()
        ),
        "leaf_followup_contains_repair_confirmation_reducer": [node["id"] for node in leaf_followup["nodes"]]
        == ["repair-l1", "confirm-code-verification", "acceptance-reducer-r2"],
        "mechanical_sync_template_is_single_item_skeleton": len(template_contract.get("items") or []) == 1
        and bool(acc.placeholder_strings(template_doc))
        and all(
            stale not in json.dumps(template_doc, ensure_ascii=False)
            for stale in ("example-alignment", "AS-01", "AC-01", "state transition")
        ),
        "owner_resolved_round_two_keeps_prior_decision": round_two["run_id"].endswith("-r2")
        and round_two["nodes"][-1]["id"] == "acceptance-reducer-r2"
        and round_two["nodes"][-1]["seed"]["contract"]["prior_decision_ref"]
        == "reducer-r1.md"
        and round_two["nodes"][-1]["seed"]["scope"]["read"]
        == ["acceptance.yaml", "dispatch.yaml", "reducer-r1.md"],
        "round_two_full_compile_requires_prior_decision": round_two_without_prior_rejected,
        "validation_fleet_passes_manifest_check": initial_fleet_check["status"] == "ok",
        "reducer_decision_is_machine_consumable": decision["status"] == "pass"
        and decision["summary"]["disposition"] == "rework",
        "reducer_bare_output_block_is_machine_consumable": bare_decision["status"] == "pass"
        and bare_decision["summary"]["disposition"] == "needs_owner",
        "pass_decision_rejects_followup_ids": pass_with_followup_decision["status"] == "fail"
        and any(
            "pass_disposition_inconsistent" in item["code"]
            for item in pass_with_followup_decision["issues"]
        ),
        "reducer_decision_rejects_incomplete_coverage": invalid_decision["status"] == "fail"
        and any("coverage_partition_mismatch" in item["code"] for item in invalid_decision["issues"]),
        "rework_requires_producer_results_before_compilation": gap_decision["status"] == "fail"
        and any("rework_requires_complete_evidence" in item["code"] for item in gap_decision["issues"]),
        "rework_rerun_only_accepts_environment_uncertain": rerun_only_decision["status"] == "pass"
        and rerun_only_decision["summary"]["disposition"] == "rework"
        and [node["id"] for node in rerun_only_followup["nodes"]]
        == ["confirm-code-verification", "acceptance-reducer-r2"]
        and rerun_only_fleet_check["status"] == "ok",
        "rework_rejects_uncertain_outside_confirmation": uncovered_uncertain_decision["status"] == "fail"
        and any("rework_requires_complete_evidence" in item["code"] for item in uncovered_uncertain_decision["issues"]),
        "followup_contains_repair_confirmation_reducer": [node["id"] for node in followup["nodes"]]
        == ["repair-l1", "confirm-code-verification", "acceptance-reducer-r2"],
        "followup_fleet_passes_manifest_check": followup_fleet_check["status"] == "ok",
        "followup_carries_only_prior_passes": two_item_followup["nodes"][-1]["seed"]["contract"]["carried_acceptance_ids"]
        == ["AC-02"],
        "review_round_limit_is_enforced": round_limit_rejected,
        "followup_round_two_without_history_compiles": followup_without_previous["run_id"].endswith("-r3"),
        "converging_followup_compiles": converging_followup["run_id"].endswith("-r3"),
        "non_shrinking_followup_compiles": non_shrinking_followup["run_id"].endswith("-r3"),
    }
    return {
        "tool": "acceptance_contract_check",
        "check": "self_test",
        "status": "pass" if all(checks.values()) else "fail",
        "exit_code": 0 if all(checks.values()) else 1,
        "checks": checks,
    }


if __name__ == "__main__":
    result = self_test()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(result["exit_code"])
