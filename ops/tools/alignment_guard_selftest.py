#!/usr/bin/env python3
"""alignment_guard --self-test 的机械用例集，由 alignment_guard.run_self_test 调用。"""

from __future__ import annotations

import copy
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

sys.dont_write_bytecode = True

import alignment_guard as ag
from _tool_common import ROOT, ToolError, rel

try:
    import yaml
except ImportError as exc:  # pragma: no cover
    raise ToolError("PyYAML is required for alignment_guard self-test") from exc


def round_ref(log: str, number: int) -> str:
    return f"{log}#round-{number}"


def decision(log: str, decision_id: str, topic: str, *, source_type: str = "user_selected_option", mode: str = "popup", ref: int = 2) -> dict[str, Any]:
    must_ask = topic in ag.MUST_ASK_TOPICS
    item = {
        "id": decision_id, "topic": topic, "class": "must_ask" if must_ask else "disclosed_default",
        "question": f"{topic} 拍板点", "selected": f"{topic} 选择", "reason": "推荐理由",
        "source": {"type": source_type, "mode": mode, "confirmation_ref": round_ref(log, ref)},
        "status": "locked",
    }
    if not must_ask:
        item["override_cost"] = "改一处配置"
    return item


def preview(log: str, surface: str, ref: int) -> dict[str, Any]:
    item: dict[str, Any] = {
        "surface": surface, "status": "accepted", "locked_statement": f"{surface} 锁定句",
        "in_scope": [], "out_of_scope": [], "validation_object": f"{surface}_object",
        "decision_source": {"type": "user_selected_option", "confirmation_ref": round_ref(log, ref)},
        "still_open": [], "planner_impact": "约束 planner",
    }
    if surface == "product_experience":
        item["product_surface"] = "cli"
    if surface == "execution":
        item["sections"] = {
            "tech": {"route": "沿用", "wheel": "not_needed: 不新写组件", "user_constraints_ref": round_ref(log, 4)},
            "landing": "改一个文件", "quality": "not_needed: 无破坏性动作",
            "validation": "pytest 回归", "structure": "not_needed: 不新增目录",
        }
    return item


def final_state(log: str, report: str) -> dict[str, Any]:
    surfaces = list(ag.ALIGNMENT_SURFACES)
    return {
        "version": 4,
        "task_slug": "guard-self-test",
        "current_stage": "complete",
        "active_surface": None,
        "source_context": {"user_request_summary": "test", "canonical_refs": []},
        "locks": {**{f"{surface}_locked": True for surface in surfaces}, "planner_allowed": True},
        "lock_sources": {
            surface: {"decision_source": {"type": "user_selected_option", "confirmation_ref": round_ref(log, ref)}}
            for surface, ref in zip(surfaces, (2, 3, 5))
        },
        "surface_previews": [preview(log, surface, ref) for surface, ref in zip(surfaces, (2, 3, 5))],
        "confirmations": [
            {"ref": round_ref(log, 1), "mode": "conversation", "presented": ["D-01"], "bulk_accept": False},
            {"ref": round_ref(log, 2), "mode": "popup", "presented": ["requirements", "D-02"], "bulk_accept": False},
            {"ref": round_ref(log, 3), "mode": "popup", "presented": ["product_experience", "D-03"], "bulk_accept": True},
            {"ref": round_ref(log, 4), "mode": "conversation", "presented": ["user_constraints"], "bulk_accept": False},
            {"ref": round_ref(log, 5), "mode": "popup", "presented": ["execution"], "bulk_accept": False},
        ],
        "decisions": [
            decision(log, "D-01", "goal_scope", source_type="user_explicit", mode="conversation", ref=1),
            decision(log, "D-02", "acceptance", ref=2),
            decision(log, "D-03", "naming", source_type="user_bulk_accepted", ref=3),
        ],
        "alignment_spec": [{"spec_id": "AS-01", "statement": "做成", "acceptance": ["可观察"], "validation_object": "behavior"}],
        "open_questions": [],
        "review_refs": {
            "surface_slice": [{"surface": surface, "round": 1, "report_ref": report, "business_verdict": "PASS"} for surface in surfaces],
            "proposal_challenge": [],
            "cross_surface": [{"round": 1, "report_ref": report, "business_verdict": "PASS"}],
        },
        "next_action": {"type": "enter_planner", "reason": "出站", "dispatch_seed": {"route": "planner-agent", "capability": "plan-authoring"}},
        "recording": {"recording_gate": "pass"},
    }


def card(decisions: list[dict[str, Any]], **overrides: Any) -> dict[str, Any]:
    body = {
        "task_slug": "card-self-test", "kind": "deliver", "confirm_mode": "card", "goal": "改一处",
        "not_doing": [], "acceptance": [{"check": "pytest -q", "pass_when": "全过"}],
        "stop_when": ["测试红两次"], "decisions": decisions, "wheel": "not_needed: 不新写组件",
        "write_scope": ["ops/tools/example.py"], "status": "confirmed",
    }
    body.update(overrides)
    return body


def write_state(directory: Path, name: str, state: dict[str, Any]) -> Path:
    path = directory / name
    path.write_text("# case\n\n## Alignment State\n\n```yaml\n" + yaml.safe_dump({"alignment_state": state}, allow_unicode=True, sort_keys=False) + "```\n", encoding="utf-8")
    return path


def write_card(directory: Path, name: str, body: dict[str, Any]) -> Path:
    path = directory / name
    path.write_text("# card\n\n## Task Card\n\n```yaml\n" + yaml.safe_dump({"task_card": body}, allow_unicode=True, sort_keys=False) + "```\n", encoding="utf-8")
    return path


def expect(context: Path, target: str, status: str, required: set[str], name: str) -> None:
    data = ag.build_data(context, target)
    found = {issue["code"] for issue in data["issues"]}
    if data["status"] != status:
        raise ToolError(f"self-test {name}: expected {status}, got {data['status']} {sorted(found)}")
    if required - found:
        raise ToolError(f"self-test {name}: missing issue codes {sorted(required - found)}; got {sorted(found)}")


def run_self_test() -> None:
    tmp_root = ROOT / "tmp"
    tmp_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="alignment-guard-", dir=tmp_root) as tmp:
        directory = Path(tmp)
        report = directory / "review.md"
        report.write_text("# review\n", encoding="utf-8")
        log = rel(directory / "discussion.md")
        base = final_state(log, rel(report))

        empty = directory / "empty.md"
        empty.write_text("# empty\n\n## Alignment State\n```yaml\n```\n", encoding="utf-8")
        expect(empty, "context", "fail", {"empty_alignment_state_yaml"}, "empty Alignment State")
        heading = directory / "heading.md"
        heading.write_text("# no state\n", encoding="utf-8")
        expect(heading, "context", "fail", {"missing_alignment_state_heading"}, "missing heading")

        expect(write_state(directory, "valid.md", base), "planner", "pass", set(), "valid v4 state passes planner")
        expect(write_state(directory, "frozen.md", {**base, "version": 3}), "context", "fail", {"state_version_frozen"}, "version 3 is frozen")
        interview = copy.deepcopy(base)
        interview["confirmations"][0]["presented"].append("user_constraints")
        interview["surface_previews"][2]["sections"]["tech"]["user_constraints_ref"] = round_ref(log, 1)
        expect(write_state(directory, "interview.md", interview), "planner", "pass", set(), "interview constraints support execution")
        combined = copy.deepcopy(interview)
        combined["confirmations"][1]["presented"].extend(["product_experience", "execution"])
        for surface in ag.ALIGNMENT_SURFACES:
            combined["lock_sources"][surface]["decision_source"]["confirmation_ref"] = round_ref(log, 2)
        for item in combined["surface_previews"]:
            item["decision_source"]["confirmation_ref"] = round_ref(log, 2)
        expect(write_state(directory, "combined.md", combined), "planner", "pass", set(), "mature surfaces share a confirmation")

        def mutated(name: str, change: Callable[[dict[str, Any]], None], required: set[str], target: str = "context") -> None:
            state = copy.deepcopy(base)
            change(state)
            expect(write_state(directory, f"{name}.md", state), target, "fail", required, name)

        mutated("retired-lock-plan", lambda s: s.update(lock_plan={"required_surfaces": []}), {"retired_field"})
        mutated("dispatch-fact-without-route", lambda s: s.update(current_stage="solution", next_action={"type": "dispatch_fact"}, locks={**s["locks"], "planner_allowed": False}), {"dispatch_fact_route_missing"})
        mutated("must-ask-bulk-in-popup", lambda s: s["decisions"][1]["source"].update(type="user_bulk_accepted"), {"must_ask_bulk_outside_card"})
        mutated("decision-not-presented", lambda s: s["confirmations"][1]["presented"].remove("D-02"), {"not_presented_in_confirmation_round"})
        mutated("default-without-override-cost", lambda s: s["decisions"][2].pop("override_cost"), {"decision_override_cost_missing"})
        mutated("agent-default-in-ledger", lambda s: s["decisions"][2]["source"].update(type="agent_default_reported"), {"decision_not_presented"})
        mutated("class-topic-mismatch", lambda s: s["decisions"][2].update(topic="design_point"), {"decision_class_topic_mismatch"})
        mutated("solution-before-product", lambda s: s["locks"].update(product_experience_locked=False), {"solution_before_product"})

        def tech_route(state: dict[str, Any]) -> None:
            state["decisions"].append(decision(log, "D-04", "tech_route", ref=5))
            state["confirmations"][4]["presented"].append("D-04")
        mutated("tech-route-without-challenge", tech_route, {"execution_locked_without_challenge", "tech_route_without_wheel_discovery", "proposal_challenge_not_passed"})
        mutated("cross-review-missing", lambda s: s["review_refs"].update(cross_surface=[]), {"cross_surface_review_not_passed"}, "planner")
        mutated("open-question-at-exit", lambda s: s.update(open_questions=[{"id": "Q-01"}]), {"open_questions_not_empty"})

        def open_round(number: int, items: list[str], *, shown: bool = True) -> dict[str, Any]:
            return {
                "ref": round_ref(log, number), "mode": "popup", "status": "open", "presented": list(items),
                "bulk_accept": False, "items": [], "units": [{"unit_id": f"R{number}-U1", "items": items, "bulk_covers": []}],
                "shown_units": [f"R{number}-U1"] if shown else [], "answers": {}, "pending": [],
            }

        mutated("decision-cites-open-round", lambda s: s["confirmations"][1].update(open_round(2, ["requirements", "D-02"])), {"confirmation_round_not_closed"})
        mutated("open-round-at-exit", lambda s: s["confirmations"].append(open_round(6, ["D-09"])), {"open_round_pending"}, "planner")
        mutated("two-open-rounds", lambda s: s["confirmations"].extend([open_round(6, ["D-09"]), open_round(7, ["D-10"])]), {"open_round_duplicate"})
        mutated("presented-not-shown", lambda s: s["confirmations"].append(open_round(6, ["D-09"], shown=False)), {"presented_outside_shown_units"})

        confirmed = [
            decision(log, "D-01", "goal_scope", source_type="user_bulk_accepted", mode="card", ref=1),
            decision(log, "D-02", "parameter", source_type="user_bulk_accepted", mode="card", ref=1),
        ]
        expect(write_card(directory, "card.md", card(confirmed)), "card", "pass", set(), "confirmed card passes")
        expect(write_card(directory, "card-popup-bulk.md", card(confirmed, confirm_mode="popup")), "card", "fail", {"must_ask_bulk_outside_card"}, "popup card cannot bulk-accept must-ask")
        expect(write_card(directory, "card-empty.md", card(confirmed, acceptance=[], write_scope=[])), "card", "fail", {"task_card_acceptance_empty", "task_card_write_scope_empty"}, "card acceptance and write_scope")
        draft = card([{**confirmed[0], "source": None}], status="draft")
        expect(write_card(directory, "card-draft.md", draft), "card", "pass", set(), "draft card skips source checks")


if __name__ == "__main__":
    run_self_test()
    print("alignment_guard self-test: pass")
