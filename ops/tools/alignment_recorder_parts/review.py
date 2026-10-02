"""从 alignment_recorder.py 原样搬出的审查查询与绑定。"""

from __future__ import annotations

import sys
import tempfile
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

from _tool_common import ROOT, ToolError, rel, repo_path
from alignment_guard import (
    ALIGNMENT_SURFACES,
    CHALLENGE_SURFACES,
    PROPOSAL_CHALLENGE_VERDICTS,
    RESIDUAL_RISK_DISPOSITIONS,
    REVIEW_ROUND_CAP,
    build_data,
    cross_review_disposition,
    cross_rounds,
    extract_alignment_state,
    index_by,
    is_ref,
    review_rounds,
    surface_review_disposition,
    validate_exit_gate,
)
from alignment_recorder_parts.constants import (
    REVIEW_REPORT_HEADING,
    REVIEW_REPORT_ROOT_KEY,
    REVIEW_SUMMARY_KEYS,
    REVIEW_VERDICTS,
)
from alignment_recorder_parts.io import atomic_write
from alignment_recorder_parts.render import render_spec
from alignment_recorder_parts.stage_nav import next_reads
from alignment_recorder_parts.state import state_version_issue, write_next_action

def review_decision(state: dict[str, Any], surface: str | None, *, kind: str = "surface") -> dict[str, Any]:
    """Round-capped dispatch advice for one review object; never derives anything from content or hashes.

    action: reuse（最新一轮已通过，且未声明 direction_rereview）| dispatch（还有轮次额度）
            | owner_decision（两轮用尽仍未通过）| owner_resolved（challenge 由 owner 看过对比表后裁决）。
    continuation 只消费显式 review_disposition。owner_decision 不改写成 reuse，失败 verdict 留在 latest_verdict。
    不带 surface 的跨面查询额外给出 all_surfaces_action，作为下一次 all_surfaces 派发的触发，不是新调度器。
    """
    reviews = state.get("review_refs") if isinstance(state.get("review_refs"), dict) else {}

    def report_exists(value: Any) -> bool:
        if not isinstance(value, str) or not value.strip():
            return False
        try:
            candidate = repo_path(value.split("#", 1)[0], label="review_report", must_exist=False)
        except ToolError:
            return False
        return candidate.is_file()

    def decide(
        *,
        scope: str,
        rounds: list[dict[str, Any]],
        pass_verdicts: set[str],
        disposition: str | None,
        honor_owner_resolved: bool,
    ) -> dict[str, Any]:
        latest = rounds[-1] if rounds else None
        latest_verdict = latest.get("business_verdict") if isinstance(latest, dict) else None
        latest_report = latest.get("report_ref") if isinstance(latest, dict) else None
        owner_resolved = honor_owner_resolved and is_ref(latest.get("owner_resolution_ref")) if isinstance(latest, dict) else False
        passed = latest_verdict in pass_verdicts and report_exists(latest_report)
        residual = (
            disposition in RESIDUAL_RISK_DISPOSITIONS
            and len(rounds) >= REVIEW_ROUND_CAP
            and not passed
        )
        continuation = None
        rereview_blocked = None
        if passed and disposition == "direction_rereview" and len(rounds) < REVIEW_ROUND_CAP:
            action = "dispatch"
            continuation = "direction_rereview"
        elif passed:
            action = "reuse"
            if disposition == "direction_rereview" and len(rounds) >= REVIEW_ROUND_CAP:
                rereview_blocked = "round_cap"
        elif owner_resolved:
            action = "owner_resolved"
        elif residual:
            action = "owner_decision"
            continuation = disposition
        elif len(rounds) < REVIEW_ROUND_CAP:
            action = "dispatch"
        else:
            action = "owner_decision"
        return {
            "review_scope": scope,
            "rounds_used": len(rounds),
            "round_cap": REVIEW_ROUND_CAP,
            "next_round": len(rounds) + 1 if len(rounds) < REVIEW_ROUND_CAP else None,
            "latest_verdict": latest_verdict,
            "action": action,
            "report_ref": latest_report if action in {"reuse", "owner_resolved"} else None,
            "continuation": continuation,
            "rereview_blocked": rereview_blocked,
        }

    if kind == "challenge":
        if surface not in CHALLENGE_SURFACES:
            raise ToolError(f"only {sorted(CHALLENGE_SURFACES)} can be challenged, got {surface}")
        return decide(
            scope=f"challenge:{surface}",
            rounds=review_rounds(reviews.get("proposal_challenge"), surface),
            pass_verdicts={"proposal_stands"},
            disposition=None,
            honor_owner_resolved=True,
        )
    if surface:
        if not index_by(state.get("surface_previews"), "surface").get(surface):
            raise ToolError(f"surface preview not found: {surface}")
        return decide(
            scope=surface,
            rounds=review_rounds(reviews.get("surface_slice"), surface),
            pass_verdicts={"PASS"},
            disposition=surface_review_disposition(state, surface),
            honor_owner_resolved=False,
        )
    rounds = cross_rounds(reviews)
    decision = decide(
        scope="cross_surface",
        rounds=rounds,
        pass_verdicts={"PASS"},
        disposition=cross_review_disposition(rounds[-1] if rounds else None),
        honor_owner_resolved=False,
    )
    decision.update(review_dispatch_plan(state, decision))
    return decision


def review_dispatch_plan(state: dict[str, Any], cross_decision: dict[str, Any]) -> dict[str, Any]:
    """Advice for the one-shot all_surfaces dispatch (S4). Does not schedule a new reviewer."""
    previews = index_by(state.get("surface_previews"), "surface")
    missing_previews = [surface for surface in ALIGNMENT_SURFACES if not previews.get(surface)]
    surface_decisions = {
        surface: review_decision(state, surface)
        for surface in ALIGNMENT_SURFACES
        if previews.get(surface)
    }
    blocking = [
        surface for surface, item in surface_decisions.items()
        if item["action"] == "owner_decision" and item.get("continuation") not in RESIDUAL_RISK_DISPOSITIONS
    ]
    dispatching = [surface for surface, item in surface_decisions.items() if item["action"] == "dispatch"]
    carried = [surface for surface, item in surface_decisions.items() if item["action"] == "reuse"]
    rereview = [surface for surface, item in surface_decisions.items() if item.get("continuation") == "direction_rereview"]
    adjudicated = [
        surface for surface, item in surface_decisions.items()
        if item.get("continuation") in RESIDUAL_RISK_DISPOSITIONS
    ]
    unsafe = [
        surface for surface, item in surface_decisions.items()
        if item["action"] not in {"reuse", "dispatch"}
    ]
    cross_blocks = (
        cross_decision["action"] == "owner_decision"
        and cross_decision.get("continuation") not in RESIDUAL_RISK_DISPOSITIONS
    )
    cross_needs = cross_decision["action"] == "dispatch"
    needs_round = bool(dispatching) or cross_needs
    batch_blocked = None
    if missing_previews:
        action = "not_ready"
        reason = "none"
        batch_blocked = "surface_preview_missing"
    elif blocking or cross_blocks:
        action = "owner_decision"
        reason = "none"
    elif needs_round and unsafe:
        action = "owner_decision"
        reason = "none"
        batch_blocked = "non_pass_surface_not_carriable"
    elif needs_round:
        action = "dispatch"
        if cross_needs and not dispatching:
            reason = "cross_only"
        elif dispatching and not cross_needs:
            reason = "surface"
        else:
            reason = "mixed"
    else:
        action = "reuse"
        reason = "none"
    # 直接填进 all_surfaces seed 的 contract.surface_rounds；owner_decision 与缺 preview 的面不进表，由 all_surfaces_action 表达。
    surface_rounds = {
        surface: item["next_round"] if item["action"] == "dispatch" else "carried"
        for surface, item in surface_decisions.items()
        if item["action"] in {"dispatch", "reuse"}
    }
    return {
        "all_surfaces_action": action,
        "dispatch_reason": reason,
        "surface_rounds": surface_rounds,
        "carried_surfaces": carried,
        "rereview_surfaces": rereview,
        "owner_pending_surfaces": blocking,
        "adjudicated_surfaces": adjudicated,
        "missing_preview_surfaces": missing_previews,
        "batch_blocked": batch_blocked,
    }


def extract_review_report(path: Path) -> dict[str, Any]:
    """Read the machine-readable `## Alignment Review` block of an all_surfaces report."""
    if yaml is None:
        raise ToolError("PyYAML is required for alignment_recorder.py") from YAML_IMPORT_ERROR
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ToolError(f"cannot read review report {rel(path)}: {exc}") from exc
    lines = text.splitlines()
    heading = next(
        (index for index, line in enumerate(lines) if line.strip().lower() == REVIEW_REPORT_HEADING.lower()),
        None,
    )
    if heading is None:
        raise ToolError(
            f"{rel(path)} has no `{REVIEW_REPORT_HEADING}` section; "
            f"an all_surfaces report must carry the {REVIEW_REPORT_ROOT_KEY} block"
        )
    fence_start = None
    for index in range(heading + 1, len(lines)):
        if lines[index].strip().startswith("```"):
            fence_start = index
            break
        if lines[index].startswith("## "):
            break
    if fence_start is None:
        raise ToolError(f"{rel(path)} `{REVIEW_REPORT_HEADING}` section has no fenced YAML block")
    block_lines: list[str] = []
    closed = False
    for index in range(fence_start + 1, len(lines)):
        if lines[index].strip().startswith("```"):
            closed = True
            break
        block_lines.append(lines[index])
    if not closed:
        raise ToolError(f"{rel(path)} `{REVIEW_REPORT_HEADING}` fenced block is not closed")
    try:
        parsed = yaml.safe_load("\n".join(block_lines))
    except yaml.YAMLError as exc:
        raise ToolError(f"{rel(path)} `{REVIEW_REPORT_HEADING}` block failed to parse: {exc}") from exc
    block = parsed.get(REVIEW_REPORT_ROOT_KEY) if isinstance(parsed, dict) else None
    if not isinstance(block, dict):
        raise ToolError(
            f"{rel(path)} `{REVIEW_REPORT_HEADING}` block must be a mapping rooted at {REVIEW_REPORT_ROOT_KEY}"
        )
    return block


def review_batch_item(
    problems: list[str],
    *,
    scope: str,
    item: Any,
    rounds: list[dict[str, Any]],
    report_ref: str,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Validate one report entry against the rounds already bound.

    Returns (summary binding, new round entry): carried entries keep their bound round and write nothing;
    new entries must declare the round the recorder is about to assign. Invalid entries return (None, None)
    after appending the reason to `problems`.
    """
    if not isinstance(item, dict):
        problems.append(f"{scope} entry must be a mapping")
        return None, None
    verdict = item.get("business_verdict")
    round_value = item.get("round")
    carried = item.get("carried", False)
    if not isinstance(carried, bool):
        problems.append(f"{scope}.carried must be true or false")
        return None, None
    if verdict not in REVIEW_VERDICTS:
        problems.append(f"{scope}.business_verdict is invalid: {verdict!r}")
        return None, None
    if isinstance(round_value, bool) or not isinstance(round_value, int) or round_value < 1:
        problems.append(f"{scope}.round must be an integer >= 1")
        return None, None
    latest = rounds[-1] if rounds else None
    if carried:
        bound_round = int(latest.get("round") or 1) if isinstance(latest, dict) else None
        bound_verdict = latest.get("business_verdict") if isinstance(latest, dict) else None
        if (
            not isinstance(latest, dict)
            or bound_round != round_value
            or bound_verdict != verdict
            or verdict != "PASS"
            or not str(latest.get("report_ref") or "").strip()
        ):
            problems.append(
                f"carried {scope} does not match the bound round: declared round={round_value} verdict={verdict}, "
                f"bound round={bound_round} verdict={bound_verdict}"
            )
            return None, None
        return {"round": round_value, "business_verdict": verdict, "carried": True}, None
    expected = len(rounds) + 1
    if round_value != expected:
        problems.append(f"{scope} round mismatch: report declares {round_value}, current round is {expected}")
        return None, None
    if round_value > REVIEW_ROUND_CAP:
        problems.append(f"review_round_cap: {scope} already has {len(rounds)} review rounds; owner decides now")
        return None, None
    return (
        {"round": round_value, "business_verdict": verdict, "carried": False},
        {"round": round_value, "report_ref": report_ref, "business_verdict": verdict},
    )


def plan_review_batch(state: dict[str, Any], block: dict[str, Any], report_ref: str) -> dict[str, Any]:
    """Validate one all_surfaces report block against current review state; return the single write plan."""
    problems: list[str] = []
    reviews = state.get("review_refs") if isinstance(state.get("review_refs"), dict) else {}
    if not isinstance(state.get("review_refs"), dict):
        problems.append("alignment_state.review_refs must be a mapping")
    entries = block.get("surfaces")
    declared: dict[str, dict[str, Any]] = {}
    if not isinstance(entries, list):
        problems.append(f"{REVIEW_REPORT_ROOT_KEY}.surfaces must be a list")
        entries = []
    for index, item in enumerate(entries):
        if not isinstance(item, dict):
            problems.append(f"{REVIEW_REPORT_ROOT_KEY}.surfaces[{index}] must be a mapping")
            continue
        surface = item.get("surface")
        if not isinstance(surface, str) or surface not in ALIGNMENT_SURFACES:
            problems.append(f"{REVIEW_REPORT_ROOT_KEY}.surfaces[{index}].surface is invalid: {surface!r}")
            continue
        if surface in declared:
            problems.append(f"{REVIEW_REPORT_ROOT_KEY} declares {surface} twice")
            continue
        declared[surface] = item
    previews = index_by(state.get("surface_previews"), "surface")
    for surface in ALIGNMENT_SURFACES:
        if surface not in declared:
            problems.append(f"surface {surface} is missing from the report")
        elif not previews.get(surface):
            problems.append(f"surface preview not found: {surface}")

    bindings: list[dict[str, Any]] = []
    planned: list[dict[str, Any]] = []
    for surface, item in declared.items():
        summary, write = review_batch_item(
            problems,
            scope=surface,
            item=item,
            rounds=review_rounds(reviews.get("surface_slice"), surface),
            report_ref=report_ref,
        )
        if summary is None:
            continue
        bindings.append({"surface": surface, **summary})
        if write is not None:
            planned.append({"surface": surface, **write})

    cross = cross_rounds(reviews)
    cross_declared = block.get("cross_surface")
    cross_write: dict[str, Any] | None = None
    if cross_declared is None:
        problems.append("cross_surface is missing from the report")
    else:
        summary, write = review_batch_item(
            problems,
            scope="cross_surface",
            item=cross_declared,
            rounds=cross,
            report_ref=report_ref,
        )
        if summary is not None:
            bindings.append({"surface": "cross_surface", **summary})
            if write is not None:
                cross_write = write

    if problems:
        raise ToolError(
            "all_surfaces review binding rejected (nothing written): " + "; ".join(problems)
        )

    surface_slice = reviews.get("surface_slice") if isinstance(reviews.get("surface_slice"), list) else []
    newly_bound = {entry["surface"] for entry in planned}
    # 已绑定面（含 carried）保持原相对位置，新登记面按报告声明顺序接在末尾。
    remaining = [
        item for item in surface_slice
        if not (isinstance(item, dict) and item.get("surface") in newly_bound)
    ]
    ordered: list[dict[str, Any]] = []
    for surface in declared:
        if surface not in newly_bound:
            continue
        ordered.extend(review_rounds(surface_slice, surface))
        ordered.extend(entry for entry in planned if entry["surface"] == surface)
    return {
        "surface_slice": remaining + ordered,
        "cross_surface": cross + ([cross_write] if cross_write is not None else []),
        "bindings": bindings,
    }


def commit_review_binding(spec_path: Path, state: dict[str, Any]) -> None:
    """Render the spec with the mutated review metadata, gate it with alignment_guard, then write once."""
    baseline = spec_path.read_text(encoding="utf-8")
    text = render_spec(state, baseline)
    guard_root = ROOT / "tmp"
    guard_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="alignment-review-bind-", dir=guard_root) as name:
        staged = Path(name) / spec_path.name
        staged.write_text(text, encoding="utf-8")
        guard = build_data(staged, "context")
        if guard["status"] != "pass":
            raise ToolError(f"review binding failed guard: {[item['code'] for item in guard['issues']]}")
    atomic_write({"spec": spec_path}, {"spec": text})


def read_v4_state(spec_path: Path) -> dict[str, Any]:
    block, issues = extract_alignment_state(spec_path)
    if issues or not isinstance(block.get("alignment_state"), dict):
        raise ToolError(f"cannot read alignment state from {rel(spec_path)}")
    state = block["alignment_state"]
    version_issue = state_version_issue(state)
    if version_issue or state.get("version") is None:
        raise ToolError(f"{version_issue['code'] if version_issue else 'state_version_invalid'}: {rel(spec_path)} is not a v4 alignment spec")
    return state


def bind_review_batch(spec_path: Path, report_path: Path) -> dict[str, Any]:
    """Bind all three surfaces and the cross surface of one all_surfaces report in a single transaction.

    审查通过或已裁决且无未解决问题时直接出站；保留用户指定的 pause。
    报告块的决策摘要只透传到输出，不写入状态。
    """
    state = read_v4_state(spec_path)
    report_block = extract_review_report(report_path)
    report_ref = rel(report_path)
    plan = plan_review_batch(state, report_block, report_ref)
    reviews = state.setdefault("review_refs", {})
    reviews["surface_slice"] = plan["surface_slice"]
    reviews["cross_surface"] = plan["cross_surface"]
    reviews["latest_report_ref"] = report_ref
    result: dict[str, Any] = {
        "tool": "alignment_recorder",
        "phase": "bind-review",
        "status": "pass",
        "exit_code": 0,
        "review_mode": "all_surfaces",
        "report_ref": report_ref,
        "round_cap": REVIEW_ROUND_CAP,
        "bindings": plan["bindings"],
        "review_summary": {key: report_block[key] for key in REVIEW_SUMMARY_KEYS if key in report_block},
        "planner_allowed": False,
        "files_written": [rel(spec_path)],
        "model_started": False,
    }
    result["exit_blocked"] = advance_after_review(state, report_block)
    commit_review_binding(spec_path, state)
    result["planner_allowed"] = state["locks"].get("planner_allowed", False)
    result["next_action"] = state["next_action"]
    result["reads"] = next_reads(state)
    return result


def bind_review(
    spec_path: Path,
    *,
    surface: str | None,
    report_ref: str | None,
    verdict: str | None,
    kind: str,
    owner_resolution_ref: str | None = None,
    review_disposition: str | None = None,
) -> dict[str, Any]:
    """挑战登记（报告或 owner 裁决）与跨面剩余风险裁决；按面与跨面审查结果只经 --from-report 登记。"""
    state = read_v4_state(spec_path)
    reviews = state.setdefault("review_refs", {})
    written: dict[str, Any]

    if kind == "challenge":
        if surface not in CHALLENGE_SURFACES:
            raise ToolError(f"only {sorted(CHALLENGE_SURFACES)} can be challenged, got {surface}")
        decision = review_decision(state, surface, kind="challenge")
        report = repo_path(report_ref, label="review_report", must_exist=True) if report_ref else None
        rounds = review_rounds(reviews.get("proposal_challenge"), surface)
        others = [item for item in reviews.get("proposal_challenge") or [] if not (isinstance(item, dict) and item.get("surface") == surface)]
        if report is None:
            # 只登记 owner 裁决：owner 看过对比表后拍板，落在最新一轮上。
            if not rounds:
                raise ToolError("no challenge round to attach owner_resolution_ref to")
            if not is_ref(owner_resolution_ref):
                raise ToolError("challenge binding requires --review-report or a non-blank --owner-resolution-ref")
            rounds[-1]["owner_resolution_ref"] = owner_resolution_ref
            written = rounds[-1]
        else:
            if verdict not in PROPOSAL_CHALLENGE_VERDICTS:
                raise ToolError(f"challenge verdict must be one of {sorted(PROPOSAL_CHALLENGE_VERDICTS)}, got {verdict}")
            if len(rounds) >= REVIEW_ROUND_CAP:
                raise ToolError(f"review_round_cap: {surface} already has {len(rounds)} challenge rounds; owner decides now")
            written = {"surface": surface, "round": len(rounds) + 1, "report_ref": rel(report), "business_verdict": verdict}
            if owner_resolution_ref:
                written["owner_resolution_ref"] = owner_resolution_ref
            rounds.append(written)
        reviews["proposal_challenge"] = others + rounds
    elif kind == "cross":
        if surface:
            raise ToolError("cross residual-risk adjudication takes no --surface")
        if review_disposition not in RESIDUAL_RISK_DISPOSITIONS:
            raise ToolError(
                f"cross binding only records a residual-risk adjudication ({sorted(RESIDUAL_RISK_DISPOSITIONS)}); "
                "cross review results are bound with --from-report"
            )
        if report_ref or verdict:
            raise ToolError("cross review_disposition does not accept a new report or verdict")
        if not is_ref(owner_resolution_ref):
            raise ToolError("cross review_disposition requires a non-blank --owner-resolution-ref")
        decision = review_decision(state, None)
        rounds = cross_rounds(reviews)
        latest = rounds[-1] if rounds else None
        if len(rounds) < REVIEW_ROUND_CAP or not isinstance(latest, dict) or latest.get("business_verdict") not in REVIEW_VERDICTS - {"PASS"}:
            raise ToolError("cross residual risk disposition requires a non-PASS round at the cap; the failure verdict is kept")
        latest["review_disposition"] = review_disposition
        latest["owner_resolution_ref"] = owner_resolution_ref
        reviews["cross_surface"] = rounds
        written = latest
    else:
        raise ToolError("per-surface review binding is retired in v4; bind the all_surfaces report with --from-report")

    if kind == "cross":
        advance_after_review(state)
    commit_review_binding(spec_path, state)
    return {
        "tool": "alignment_recorder",
        "phase": "bind-review",
        "status": "pass",
        "exit_code": 0,
        "review_scope": decision["review_scope"],
        "round": written.get("round"),
        "round_cap": REVIEW_ROUND_CAP,
        "report_ref": written.get("report_ref"),
        "business_verdict": written.get("business_verdict"),
        "owner_resolution_ref": written.get("owner_resolution_ref"),
        "review_disposition": written.get("review_disposition"),
        "reads": next_reads(state),
        "files_written": [rel(spec_path)],
        "model_started": False,
    }


def advance_after_review(state: dict[str, Any], block: dict[str, Any] | None = None) -> list[str]:
    """Reuse the exit gate after review or adjudication, preserving an explicit pause."""
    issues: list[dict[str, str]] = []
    validate_exit_gate(issues, state)
    blockers = [item["code"] for item in issues]
    if state.get("current_stage") == "paused" or (state.get("next_action") or {}).get("type") == "pause":
        blockers.append("paused")
    if blockers:
        state.setdefault("locks", {})["planner_allowed"] = False
        return blockers
    cross = cross_rounds(state.get("review_refs") or {})[-1]
    if not cross_review_disposition(cross):
        if block is None:
            # Carried cross reviews can point to an older report than the latest surface revision.
            report_ref = state["review_refs"].get("latest_report_ref", cross["report_ref"])
            block = extract_review_report(repo_path(report_ref, label="review_report", must_exist=True))
        if not isinstance(block.get("unresolved"), list):
            blockers.append("unresolved_missing")
        elif block["unresolved"]:
            blockers.append("unresolved")
    state["locks"]["planner_allowed"] = not blockers
    if not blockers:
        state["current_stage"] = "complete"
        write_next_action(state, "gate", None, "审查通过或已裁决：运行 guard --target planner 与 --emit-planner-seed。")
    return blockers
