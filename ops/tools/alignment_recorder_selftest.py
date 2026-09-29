#!/usr/bin/env python3
"""alignment_recorder --self-test 的机械用例集，由 alignment_recorder.self_test 调用。"""

from __future__ import annotations

import argparse
import copy
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.dont_write_bytecode = True

import alignment_recorder as rec
from _tool_common import ROOT, ToolError, rel


def self_test() -> None:
    tmp_root = ROOT / "tmp"
    tmp_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="alignment-recorder-self-test-", dir=tmp_root) as name:
        root = Path(name)
        report = root / "review.md"
        report.write_text("# review\n", encoding="utf-8")
        state = {
            "version": 4,
            "task_slug": "recorder-self-test",
            "current_stage": "intake",
            "active_surface": None,
            "source_context": {"user_request_summary": "test", "canonical_refs": []},
            "locks": {**{f"{surface}_locked": False for surface in rec.ALIGNMENT_SURFACES}, "planner_allowed": False},
            "lock_sources": {},
            "surface_previews": [],
            "confirmations": [],
            "decisions": [],
            "alignment_spec": [],
            "review_refs": {"surface_slice": [], "proposal_challenge": [], "cross_surface": []},
            "open_questions": [rec.question_from("requirements", {"surface_previews": []})],
            "next_action": {"type": "ask_user", "reason": "confirm", "dispatch_seed": None},
            "recording": {"recording_gate": "pass"},
        }
        spec = root / "test-alignment.md"
        spec.write_text(rec.render_spec(state, "# test\n"), encoding="utf-8")
        discussion = root / "test-discussion.md"
        discussion.write_text("# test Discussion Log\n", encoding="utf-8")
        # 记录渲染进 output/ 副本，之后的复跑也以副本为源，确认轮引用指向副本日志。
        round_1 = f"{rel(root / 'output' / discussion.name)}#round-1"
        delta = root / "delta.yaml"
        delta_body = {
            "delta_id": "AD-SELF-TEST-01",
            "stage": "product",
            "active_surface": "requirements",
            "confirmation": {
                "confirmation_ref": round_1,
                "mode": "popup",
                "presented": ["requirements", "D-01"],
                "bulk_accept": False,
                "selected_option": "accept",
            },
            "surface_preview": {
                "surface": "requirements",
                "status": "accepted",
                "locked_statement": "locked statement",
                "in_scope": [],
                "out_of_scope": [],
                "validation_object": "test_object",
                "decision_source": {"type": "user_selected_option", "confirmation_ref": round_1},
                "still_open": [],
                "planner_impact": "test impact",
            },
            "decisions": [{
                "id": "D-01", "topic": "acceptance", "class": "must_ask",
                "question": "验收口径", "selected": "测试通过", "reason": "可机械验证",
                "source": {"type": "user_selected_option", "mode": "popup", "confirmation_ref": round_1},
                "status": "locked",
            }],
            "closed_questions": ["requirements_surface"],
            "open_questions": [],
            "mutation_scope": {
                "alignment_state_paths": [],
                "discussion_log": "append_one_round",
            },
            "coverage_manifest": [{
                "stable_id": "SURFACE-requirements-preview",
                "target_section": "Alignment State",
                "required_fields": ["surface", "status", "locked_statement", "decision_source", "still_open"],
            }],
            "next_step": "ask_user",
        }
        delta.write_text(rec.dump_yaml("alignment_delta", delta_body), encoding="utf-8")
        outputs = {key: root / "output" / path.name for key, path in {
            "spec": spec,
            "discussion_log": discussion,
        }.items()}
        inputs = rec.RecorderInputs(
            delta,
            {"spec": spec, "discussion_log": discussion},
            outputs,
            "tx-self-test",
        )
        pre, _, _ = rec.preflight(inputs)
        if pre["status"] != "pass":
            raise ToolError(f"self-test valid preflight failed: {pre['issues']}")

        def rejected_codes(body: dict, label: str) -> set[str]:
            path = root / f"{label}.yaml"
            path.write_text(rec.dump_yaml("alignment_delta", body), encoding="utf-8")
            probe_inputs = copy.copy(inputs)
            probe_inputs.delta_path = path
            result, _, _ = rec.preflight(probe_inputs)
            if result["status"] != "fail":
                raise ToolError(f"self-test {label} was not rejected")
            return {item["code"] for item in result["issues"]}

        invalid = copy.deepcopy(delta_body)
        invalid["mutation_scope"]["discussion_log"] = "append_round_1"
        invalid_path = root / "bad-delta.yaml"
        invalid_path.write_text(rec.dump_yaml("alignment_delta", invalid), encoding="utf-8")
        bad_inputs = copy.copy(inputs)
        bad_inputs.delta_path = invalid_path
        bad, _, _ = rec.preflight(bad_inputs)
        if not any(
            item["code"] == "discussion_mode_invalid"
            and item.get("hint") == rec.ISSUE_CODE_HINTS["discussion_mode_invalid"]
            for item in bad["issues"]
        ):
            raise ToolError("self-test preflight issue does not carry its ISSUE_CODE_HINTS hint")

        unauthorized = copy.deepcopy(delta_body)
        unauthorized["state_patch"] = {"source_context": {"user_request_summary": "unauthorized"}}
        if "state_patch_outside_mutation_scope" not in rejected_codes(unauthorized, "unauthorized"):
            raise ToolError("self-test unauthorized state_patch was not rejected")

        combined_stage = copy.deepcopy(delta_body)
        combined_stage["stage"] = "solution"
        combined_path = root / "combined-stage.yaml"
        combined_path.write_text(rec.dump_yaml("alignment_delta", combined_stage), encoding="utf-8")
        combined_inputs = copy.copy(inputs)
        combined_inputs.delta_path = combined_path
        if rec.preflight(combined_inputs)[0]["status"] != "pass":
            raise ToolError("self-test mature requirements preview at solution stage was rejected")

        unpresented = copy.deepcopy(delta_body)
        unpresented["confirmation"]["presented"] = ["D-01"]
        if "confirmation_presented_missing_surface" not in rejected_codes(unpresented, "unpresented"):
            raise ToolError("self-test preview accepted by a round that did not present it")

        initial_outputs = {
            "spec": root / "initial" / "new-alignment.md",
            "discussion_log": root / "initial" / "new-discussion.md",
        }
        initial_round = f"{rel(initial_outputs['discussion_log'])}#round-1"
        initial_delta_body = copy.deepcopy(delta_body)
        initial_delta_body["initial_state"] = copy.deepcopy(state)
        initial_delta_body["confirmation"]["confirmation_ref"] = initial_round
        initial_delta_body["surface_preview"]["decision_source"]["confirmation_ref"] = initial_round
        initial_delta_body["decisions"][0]["source"]["confirmation_ref"] = initial_round
        initial_delta = root / "initial-delta.yaml"
        initial_delta.write_text(rec.dump_yaml("alignment_delta", initial_delta_body), encoding="utf-8")
        initial_result = rec.execute(
            rec.RecorderInputs(initial_delta, initial_outputs, initial_outputs, "tx-self-test-initial"),
            "record",
        )
        if initial_result["status"] != "pass" or not all(path.is_file() for path in initial_outputs.values()):
            raise ToolError(f"self-test initial render failed: {initial_result}")
        # 写事务收缩到 canonical 两文件：state_pack/checkpoint 派生产物不再渲染。
        derived_leaks = [
            p for p in initial_outputs["spec"].parent.glob("*")
            if "state-pack" in p.name or "checkpoint" in p.name
        ]
        if derived_leaks:
            raise ToolError(f"self-test derived cache was rendered unexpectedly: {derived_leaks}")
        result = rec.execute(inputs, "record")
        if result["status"] != "pass" or result["model_started"]:
            raise ToolError(f"self-test record failed: {result}")
        if {Path(p).name for p in result["files_written"]} != {outputs["spec"].name, outputs["discussion_log"].name}:
            raise ToolError(f"self-test record wrote an unexpected file set: {result['files_written']}")
        recorded = rec.extract_alignment_state(outputs["spec"])[0]["alignment_state"]
        if recorded.get("version") != 4 or [item.get("ref") for item in recorded.get("confirmations") or []] != [round_1]:
            raise ToolError(f"self-test confirmation round was not recorded: {recorded.get('confirmations')}")
        replay = rec.RecorderInputs(delta, outputs, outputs, "tx-self-test-replay")
        before_bytes = {key: rec.file_bytes(path) for key, path in outputs.items()}
        replay_mode = copy.deepcopy(delta_body)
        replay_mode["mutation_scope"]["discussion_log"] = "replace_confirmation_round"
        delta.write_text(rec.dump_yaml("alignment_delta", replay_mode), encoding="utf-8")
        replay_result = rec.execute(replay, "record")
        if replay_result["status"] != "noop" or before_bytes != {key: rec.file_bytes(path) for key, path in outputs.items()}:
            raise ToolError(f"self-test semantic replay was not a no-op: {replay_result}")
        reordered_delta = root / "reordered-delta.yaml"
        reordered_delta.write_text(
            rec.dump_yaml("alignment_delta", {key: replay_mode[key] for key in reversed(list(replay_mode))}),
            encoding="utf-8",
        )
        reordered = rec.RecorderInputs(reordered_delta, outputs, outputs, "tx-self-test-reordered")
        reordered_result = rec.execute(reordered, "record")
        if reordered_result["status"] != "noop" or before_bytes != {key: rec.file_bytes(path) for key, path in outputs.items()}:
            raise ToolError(f"self-test reordered semantic replay was not a no-op: {reordered_result}")
        rendered_spec = outputs["spec"].read_text(encoding="utf-8")
        if "### 要你拍板" not in rendered_spec or "D-01 [acceptance]" not in rendered_spec:
            raise ToolError("self-test rendered spec lacks the decision ledger")

        # 逐面登记退役；挑战只管 execution，两轮封顶，owner 裁决落在最新一轮。
        try:
            rec.bind_review(outputs["spec"], surface="requirements", report_ref=rel(report), verdict="PASS", kind="surface")
        except ToolError as exc:
            if "--from-report" not in str(exc):
                raise ToolError(f"self-test retired per-surface binding error is unclear: {exc}") from exc
        else:
            raise ToolError("self-test per-surface binding was accepted")
        try:
            rec.bind_review(outputs["spec"], surface="requirements", report_ref=rel(report), verdict="proposal_stands", kind="challenge")
        except ToolError as exc:
            if "can be challenged" not in str(exc):
                raise ToolError(f"self-test non-execution challenge error is unclear: {exc}") from exc
        else:
            raise ToolError("self-test challenge on requirements was accepted")
        challenge_state = rec.extract_alignment_state(outputs["spec"])[0]["alignment_state"]
        if rec.review_decision(challenge_state, "execution", kind="challenge")["action"] != "dispatch":
            raise ToolError("self-test fresh execution challenge should dispatch")
        rec.bind_review(outputs["spec"], surface="execution", report_ref=rel(report), verdict="cheaper_path_exists", kind="challenge")
        rec.bind_review(outputs["spec"], surface="execution", report_ref=rel(report), verdict="cheaper_path_exists", kind="challenge")
        try:
            rec.bind_review(outputs["spec"], surface="execution", report_ref=rel(report), verdict="proposal_stands", kind="challenge")
        except ToolError as exc:
            if "review_round_cap" not in str(exc):
                raise ToolError(f"self-test third challenge round error is unclear: {exc}") from exc
        else:
            raise ToolError("self-test third challenge round was accepted")
        resolved = rec.bind_review(
            outputs["spec"], surface="execution", report_ref=None, verdict=None, kind="challenge",
            owner_resolution_ref=f"{rel(discussion)}#round-2",
        )
        if resolved["owner_resolution_ref"] != f"{rel(discussion)}#round-2" or resolved["round"] != 2:
            raise ToolError(f"self-test owner resolution binding failed: {resolved}")
        challenge_state = rec.extract_alignment_state(outputs["spec"])[0]["alignment_state"]
        if rec.review_decision(challenge_state, "execution", kind="challenge")["action"] != "owner_resolved":
            raise ToolError("self-test owner-resolved challenge not recognized")

        # 重新提交为 proposed 的面机械解锁。
        demote_body = copy.deepcopy(delta_body)
        demote_body["delta_id"] = "AD-SELF-TEST-02"
        demote_body["surface_preview"]["status"] = "proposed"
        demote_body["surface_preview"]["still_open"] = ["awaiting_confirmation"]
        demote_body.pop("confirmation", None)
        demote_body.pop("decisions", None)
        demote_body["closed_questions"] = []
        demote_body["open_questions"] = ["requirements_surface"]
        demote_body["mutation_scope"]["discussion_log"] = "unchanged"
        demote_delta = root / "demote-delta.yaml"
        demote_delta.write_text(rec.dump_yaml("alignment_delta", demote_body), encoding="utf-8")
        demoted = rec.execute(rec.RecorderInputs(demote_delta, outputs, outputs, "tx-self-test-demote"), "record")
        if demoted["status"] != "pass":
            raise ToolError(f"self-test demotion record failed: {demoted}")
        demoted_state = rec.extract_alignment_state(outputs["spec"])[0]["alignment_state"]
        if demoted_state["locks"].get("requirements_locked") is not False or "requirements" in demoted_state.get("lock_sources", {}):
            raise ToolError("self-test proposed preview did not clear the lock")

        # state_patch 不能绕过专用的 preview / review / confirmation 入口。
        forbidden = copy.deepcopy(delta_body)
        forbidden["state_patch"] = {"surface_previews": [], "review_refs": {"surface_slice": []}, "confirmations": []}
        forbidden["mutation_scope"]["alignment_state_paths"] = ["surface_previews", "review_refs", "confirmations"]
        codes = rejected_codes(forbidden, "forbidden")
        if not {"state_patch_touches_surface_previews", "state_patch_touches_review_refs", "state_patch_touches_confirmations"} <= codes:
            raise ToolError(f"self-test forbidden state_patch was not rejected: {sorted(codes)}")

        # version 3 规格冻结：recorder 不写。
        frozen = root / "frozen-alignment.md"
        frozen.write_text(rec.render_spec({**state, "version": 3}, "# frozen\n"), encoding="utf-8")
        frozen_inputs = rec.RecorderInputs(delta, {"spec": frozen, "discussion_log": discussion}, {"spec": frozen, "discussion_log": discussion}, "tx-frozen")
        frozen_result, _, _ = rec.preflight(frozen_inputs)
        if "spec_version_frozen" not in {item["code"] for item in frozen_result["issues"]}:
            raise ToolError("self-test version 3 spec was not frozen")

        lock_target = root / "lock-test" / "alignment.md"
        lock_target.parent.mkdir(parents=True, exist_ok=True)
        lock_target.write_text("before\n", encoding="utf-8")
        lock_outputs = {"spec": lock_target}
        probe = """
import sys
from pathlib import Path
from alignment_recorder import atomic_write
try:
    atomic_write({"spec": Path(sys.argv[1])}, {"spec": "after\\n"})
except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(3)
"""
        env = dict(os.environ)
        env["PYTHONPATH"] = str(ROOT / "ops" / "tools")
        with rec.recorder_lock(lock_outputs):
            conflict = subprocess.run(
                [sys.executable, "-B", "-c", probe, str(lock_target)],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        if conflict.returncode != 3 or "busy" not in conflict.stderr or lock_target.read_text(encoding="utf-8") != "before\n":
            raise ToolError(f"self-test concurrent writer was not rejected: {conflict.stderr}")

        if os.name == "nt":
            acl_target = root / "acl-scope" / "alignment.md"
            acl_target.parent.mkdir(parents=True, exist_ok=True)
            acl_target.write_text("before\n", encoding="utf-8")
            rec.atomic_write({"spec": acl_target}, {"spec": "after\n"})
            # icacls 无 PowerShell 模块依赖(Get-Acl 在部分宿主 autoload 失败会假阴性);
            # 输出含 "(I)" ACE 即继承保持——protected DACL 会剥掉全部继承 ACE。
            acl_probe = subprocess.run(
                ["icacls", str(acl_target)],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            if acl_probe.returncode != 0 or "(I)" not in acl_probe.stdout:
                raise ToolError(
                    "self-test post-replace file lost DACL inheritance "
                    f"(no inherited ACE in icacls output): stdout={acl_probe.stdout!r} stderr={acl_probe.stderr!r}"
                )

        # G3：init 带首轮草案，answer 一次关闭并生成决策；重复提交 noop；关闭后状态只留定稿字段。
        g3_files = {"spec": root / "g3" / "g3-alignment.md", "discussion_log": root / "g3" / "g3-discussion.md"}
        g3_paths = rec.G3Paths(g3_files, g3_files)
        first_round = {"stage": "intake", "mode": "popup", "items": [{
            "kind": "decision", "topic": "acceptance", "question": "验收口径",
            "options": [{"label": "测试通过"}, {"label": "人工确认"}], "recommended": "测试通过", "reason": "可机械验证",
        }]}
        opened = rec.run_init(g3_paths, argparse.Namespace(task_slug="self-test", summary="test"), first_round, "tx-g3", time.perf_counter())
        if opened["status"] != "pass" or opened["round"] != 1:
            raise ToolError(f"self-test G3 init with first round failed: {opened}")
        reply = {"round": 1, "shown_units": ["R1-U1"], "answers": {"D-01": {"choose": "测试通过"}}}
        closed = rec.run_answer(g3_paths, reply, "tx-g3", time.perf_counter())
        if closed["status"] != "pass" or closed["round_status"] != "closed":
            raise ToolError(f"self-test G3 answer did not close the round: {closed}")
        if rec.run_answer(g3_paths, reply, "tx-g3", time.perf_counter())["status"] != "noop":
            raise ToolError("self-test G3 replayed answer was not a noop")
        g3_state = rec.extract_alignment_state(g3_files["spec"])[0]["alignment_state"]
        if set(g3_state["confirmations"][0]) != {"ref", "mode", "presented", "bulk_accept", "status"} or g3_state["decisions"][0]["source"]["type"] != "user_selected_option":
            raise ToolError(f"self-test G3 closed round left progress fields or a wrong source: {g3_state['confirmations']}")

        retired_args = argparse.Namespace(state_pack="legacy-state-pack.yaml", checkpoint=None)
        try:
            rec.reject_retired_cache_args(retired_args)
        except ToolError as exc:
            if "are retired" not in str(exc) or "--state-pack" not in str(exc):
                raise ToolError(f"self-test retired cache argument error is unclear: {exc}") from exc
        else:
            raise ToolError("self-test retired cache argument was silently accepted")

    schema = rec.build_schema()
    if schema["next_step_values"] != list(rec.NEXT_ACTION_MAP.keys()) or schema["stage_values"] != list(rec.STAGE_COMPLETION_STATES):
        raise ToolError("self-test schema closed sets drifted from recorder constants")
    if set(schema["surface_preview_required_fields"]) != set(rec.SURFACE_PREVIEW_REQUIRED_FIELDS):
        raise ToolError("self-test schema surface_preview_required_fields drifted")
    documented = set(schema["issue_codes"])
    emitted = set(re.findall(r'issue\("([a-z_]+)"', Path(rec.__file__).read_text(encoding="utf-8")))
    emitted |= {"initial_state_missing", "baseline_alignment_state_missing"}
    if emitted - documented:
        raise ToolError(f"self-test schema issue_codes missing hints for {sorted(emitted - documented)}")
    if not (ROOT / schema["example_delta"]).is_file():
        raise ToolError("self-test schema example_delta path does not exist")


if __name__ == "__main__":
    self_test()
    print("alignment_recorder self-test: pass")
