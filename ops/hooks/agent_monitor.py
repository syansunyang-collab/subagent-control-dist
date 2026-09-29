#!/usr/bin/env python3
"""Codex/Kimi hook guard and immediate context injection."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

from agent_monitor_lib.contexts import (
    build_subagent_dispatch_reminder_context,
    should_inject_subagent_dispatch_reminder,
)
from agent_monitor_lib.event_payload import summarize
from agent_monitor_lib.predicates.session_start import should_inject_compact_agents_reminder
from agent_monitor_lib.predicates.external_truth import should_inject_external_truth_reminder
from agent_monitor_lib.predicates.stop_state_check import should_inject_stop_state_check
from agent_monitor_lib.predicates.subagent_dispatch_gate import subagent_dispatch_block_reason
from agent_monitor_lib.settings import (
    INJECTION_CONFIG_PATH,
    INJECTION_DEFAULTS,
    ROOT,
    injection_enabled,
    injection_limit,
    injection_text,
    injection_prompt_keys,
    injection_unknown_keys,
)
from agent_monitor_lib.hook_event_parser import parse_hook_event
from agent_monitor_lib.text_utils import clip, read_hook_stdin, safe_hook_json_dumps, safe_text

ROOT_FOR_SELFTEST = str(ROOT).replace("\\", "/")


def parse_hook_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Codex/Kimi hook guard and context injection.")
    parser.add_argument("--flavor", choices=("codex", "kimi"), default="codex")
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args(argv)


def normalize_hook_event_for_flavor(event: dict[str, Any], flavor: str) -> dict[str, Any]:
    """flavor 适配层：归一 stdin 载荷差异，判定逻辑不感知 flavor。

    Kimi 载荷字段名与 codex 一致（hook_event_name / tool_name / tool_input / tool_response），
    只需兜底工具名字段别名。事件名差异：Kimi 的 SessionStart matcher 只有 startup|resume（无
    compact），compact 对应独立 PostCompact 事件（matcher manual|auto），在此归一到现有
    SessionStart compact 注入路径（同一注入文本与 additional_context_max_chars 裁剪）。
    Kimi 无 CODEX_THREAD_ID / CODEX_WAKE_THREAD_ID 等 env：hook 主链路不读取这些 env
    （thread id 解析只服务 cockpit 运输侧），天然降级、不报错；未来主链路若引入 env 依赖，
    必须在此按 flavor=kimi 降级跳过。
    """
    if flavor != "kimi":
        return event
    normalized = dict(event)
    if normalized.get("hook_event_name") == "PostCompact":
        normalized["hook_event_name"] = "SessionStart"
        normalized["source"] = "compact"
    if not normalized.get("tool_name") and normalized.get("tool"):
        normalized["tool_name"] = normalized["tool"]
    return normalized


def run_hook_process(args: list[str], payload: dict[str, Any]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(Path(__file__).resolve()), *args],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
        check=False,
    )


def run_self_test() -> int:
    failures: list[str] = []
    for key in injection_prompt_keys():
        text = injection_text(key).strip()
        if not text or text.startswith("hook prompt "):
            failures.append(f"missing prompt: {key}")
    for key in INJECTION_DEFAULTS["limits"]:
        if injection_limit(key) <= 0:
            failures.append(f"non-positive limit: {key}")
    for key in INJECTION_DEFAULTS["toggles"]:
        if not isinstance(injection_enabled(key), bool):
            failures.append(f"non-bool toggle: {key}")
    gate_cases = {
        "stop_check_silent_without_state_terms": not should_inject_stop_state_check(
            {"hook_event_name": "Stop", "last_assistant_message": "本轮已完成。"}
        ),
        "stop_check_triggers_with_state_terms": should_inject_stop_state_check(
            {"hook_event_name": "Stop", "last_assistant_message": "STATUS.md 已同步。"}
        ),
        "compact_agents_reminder_triggers_on_compact": should_inject_compact_agents_reminder(
            {"hook_event_name": "SessionStart", "source": "compact"}
        ),
        "compact_agents_reminder_silent_on_resume": not should_inject_compact_agents_reminder(
            {"hook_event_name": "SessionStart", "source": "resume"}
        ),
        "dispatch_reminder_silent_for_plain_text_mentions": not should_inject_subagent_dispatch_reminder(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "apply_patch",
                "tool_input": {"command": "patch mentions ops/tools/dispatch_prepare.mjs only"},
            },
            "tool_done",
        ),
        "dispatch_reminder_triggers_for_seed_stdin": should_inject_subagent_dispatch_reminder(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "Bash",
                "tool_input": {
                    "command": "node ops/tools/dispatch_prepare.mjs --seed-stdin --format json",
                },
            },
            "tool_done",
        ),
        "pretool_blocks_native_spawn_agent": bool(
            subagent_dispatch_block_reason(
                {"hook_event_name": "PreToolUse", "tool_name": "spawn_agent", "tool_input": {"prompt": "x"}}
            )
        ),
        "pretool_blocks_mcp_named_spawn_agent": bool(
            subagent_dispatch_block_reason(
                {
                    "hook_event_name": "PreToolUse",
                    "tool_name": "mcp__multi_agent__spawn_agent",
                    "tool_input": {"prompt": "x"},
                }
            )
        ),
        "pretool_blocks_tool_namespace_spawn_agent": bool(
            subagent_dispatch_block_reason(
                {
                    "hook_event_name": "PreToolUse",
                    "tool_name": "multi_agent_v1.spawn_agent",
                    "tool_input": {"prompt": "x"},
                }
            )
        ),
        "pretool_allows_native_create_thread": not subagent_dispatch_block_reason(
            {
                "hook_event_name": "PreToolUse",
                "tool_name": "create_thread",
                "tool_input": {"prompt": "x", "target": {"type": "project", "projectId": "E:/other-repo"}},
            }
        ),
        "pretool_allows_tool_namespace_create_thread": not subagent_dispatch_block_reason(
            {
                "hook_event_name": "PreToolUse",
                "tool_name": "codex_app.create_thread",
                "tool_input": {"prompt": "x", "target": {"type": "projectless"}},
            }
        ),
        "pretool_allows_native_fork_thread": not subagent_dispatch_block_reason(
            {
                "hook_event_name": "PreToolUse",
                "tool_name": "fork_thread",
                "tool_input": {"environment": {"type": "same-directory"}},
            }
        ),
        "pretool_allows_tool_namespace_fork_thread": not subagent_dispatch_block_reason(
            {
                "hook_event_name": "PreToolUse",
                "tool_name": "codex_app.fork_thread",
                "tool_input": {"environment": {"type": "same-directory"}},
            }
        ),
        "pretool_allows_send_message_to_thread": not subagent_dispatch_block_reason(
            {
                "hook_event_name": "PreToolUse",
                "tool_name": "send_message_to_thread",
                "tool_input": {"threadId": "t1", "prompt": "停止当前任务"},
            }
        ),
        "external_truth_triggers_on_foreign_governance_read": should_inject_external_truth_reminder(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "Bash",
                "tool_input": {"command": 'Get-Content "E:/some-other-repo/AGENTS.md"'},
            },
            "tool_done",
        ),
        "external_truth_silent_on_relative_read": not should_inject_external_truth_reminder(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "Bash",
                "tool_input": {"command": "Get-Content AGENTS.md"},
            },
            "tool_done",
        ),
        "external_truth_silent_on_own_repo_absolute": not should_inject_external_truth_reminder(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "Bash",
                "tool_input": {"command": f'cat "{ROOT_FOR_SELFTEST}/AGENTS.md"'},
            },
            "tool_done",
        ),
        "pretool_blocks_async_cli_submit": bool(
            subagent_dispatch_block_reason(
                {
                    "hook_event_name": "PreToolUse",
                    "tool_name": "Bash",
                    "tool_input": {"command": "node ops/tools/subagent_service.mjs submit --task-file x"},
                }
            )
        ),
        "pretool_blocks_direct_delivery": bool(
            subagent_dispatch_block_reason(
                {
                    "hook_event_name": "PreToolUse",
                    "tool_name": "Bash",
                    "tool_input": {"command": "node ops/tools/dispatch_prepare.mjs --seed-stdin --delivery direct"},
                }
            )
        ),
        "pretool_blocks_direct_delivery_equals": bool(
            subagent_dispatch_block_reason(
                {
                    "hook_event_name": "PreToolUse",
                    "tool_name": "bash",
                    "tool_input": {"command": "node ops/tools/dispatch_prepare.mjs --seed-stdin --delivery=direct"},
                }
            )
        ),
        "pretool_allows_dispatch_prepare_auto": not subagent_dispatch_block_reason(
            {
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "tool_input": {"command": "node ops/tools/dispatch_prepare.mjs --seed-stdin --format json"},
            }
        ),
    }
    failures.extend(name for name, ok in gate_cases.items() if not ok)

    kimi_gate_cases = {
        "kimi_pretool_blocks_agent": bool(
            subagent_dispatch_block_reason(
                {"hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": {"prompt": "x"}},
                flavor="kimi",
            )
        ),
        "kimi_pretool_blocks_agentswarm": bool(
            subagent_dispatch_block_reason(
                {"hook_event_name": "PreToolUse", "tool_name": "AgentSwarm", "tool_input": {"prompt": "x"}},
                flavor="kimi",
            )
        ),
        "kimi_pretool_blocks_async_cli_submit": bool(
            subagent_dispatch_block_reason(
                {
                    "hook_event_name": "PreToolUse",
                    "tool_name": "Bash",
                    "tool_input": {"command": "node ops/tools/subagent_service.mjs submit --task-file x"},
                },
                flavor="kimi",
            )
        ),
        "kimi_pretool_blocks_direct_delivery": bool(
            subagent_dispatch_block_reason(
                {
                    "hook_event_name": "PreToolUse",
                    "tool_name": "Bash",
                    "tool_input": {"command": "node ops/tools/dispatch_prepare.mjs --seed-stdin --delivery direct"},
                },
                flavor="kimi",
            )
        ),
        "kimi_pretool_allows_dispatch_prepare_auto": not subagent_dispatch_block_reason(
            {
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "tool_input": {"command": "node ops/tools/dispatch_prepare.mjs --seed-stdin --format json"},
            },
            flavor="kimi",
        ),
    }
    failures.extend(name for name, ok in kimi_gate_cases.items() if not ok)

    normalized_postcompact = normalize_hook_event_for_flavor(
        {"hook_event_name": "PostCompact", "session_id": "selftest", "trigger": "manual"},
        "kimi",
    )
    kimi_normalize_cases = {
        "kimi_postcompact_maps_to_session_start": normalized_postcompact.get("hook_event_name") == "SessionStart",
        "kimi_postcompact_maps_source_compact": normalized_postcompact.get("source") == "compact",
        "codex_postcompact_not_normalized": normalize_hook_event_for_flavor(
            {"hook_event_name": "PostCompact", "session_id": "selftest", "trigger": "manual"},
            "codex",
        ).get("hook_event_name")
        == "PostCompact",
    }
    failures.extend(name for name, ok in kimi_normalize_cases.items() if not ok)

    # 进程级契约：kimi 拦截 = exit 2 + stderr 原因；注入 = exit 0 + stdout 纯文本（非 JSON）。
    def check_process(
        name: str,
        args: list[str],
        payload: dict[str, Any],
        *,
        rc: int,
        stderr_non_empty: bool = False,
        stdout_non_empty: bool = False,
        stdout_not_json: bool = False,
        stdout_contains: str = "",
        quiet: bool = False,
    ) -> None:
        try:
            proc = run_hook_process(args, payload)
        except Exception as exc:
            failures.append(f"{name}: subprocess failed: {exc}")
            return
        if proc.returncode != rc:
            failures.append(
                f"{name}: rc={proc.returncode} expected={rc} stderr={proc.stderr.strip()[:200]}"
            )
            return
        if stderr_non_empty and not proc.stderr.strip():
            failures.append(f"{name}: expected stderr block reason, got empty")
        if stdout_non_empty and not proc.stdout.strip():
            failures.append(f"{name}: expected stdout injection, got empty")
        if stdout_not_json and proc.stdout.strip().startswith("{"):
            failures.append(f"{name}: stdout must be plain text for kimi, got JSON")
        if stdout_contains and stdout_contains not in proc.stdout:
            failures.append(f"{name}: stdout missing {stdout_contains!r}")
        if quiet and (proc.stdout.strip() or proc.stderr.strip()):
            failures.append(
                f"{name}: expected no output, got stdout={proc.stdout.strip()[:120]} "
                f"stderr={proc.stderr.strip()[:120]}"
            )

    kimi_pretool = {"hook_event_name": "PreToolUse", "session_id": "selftest", "cwd": ROOT_FOR_SELFTEST}
    check_process(
        "kimi_proc_blocks_agent_exit2",
        ["--flavor", "kimi"],
        {**kimi_pretool, "tool_name": "Agent", "tool_input": {"prompt": "x"}},
        rc=2,
        stderr_non_empty=True,
    )
    check_process(
        "kimi_proc_blocks_agentswarm_exit2",
        ["--flavor", "kimi"],
        {**kimi_pretool, "tool_name": "AgentSwarm", "tool_input": {"prompt": "x"}},
        rc=2,
        stderr_non_empty=True,
    )
    check_process(
        "kimi_proc_blocks_bash_async_submit_exit2",
        ["--flavor", "kimi"],
        {
            **kimi_pretool,
            "tool_name": "Bash",
            "tool_input": {"command": "node ops/tools/subagent_service.mjs submit --task-file x"},
        },
        rc=2,
        stderr_non_empty=True,
    )
    check_process(
        "kimi_proc_blocks_bash_direct_delivery_exit2",
        ["--flavor", "kimi"],
        {
            **kimi_pretool,
            "tool_name": "Bash",
            "tool_input": {"command": "node ops/tools/dispatch_prepare.mjs --seed-stdin --delivery direct"},
        },
        rc=2,
        stderr_non_empty=True,
    )
    check_process(
        "kimi_proc_allows_dispatch_prepare_auto_exit0",
        ["--flavor", "kimi"],
        {
            **kimi_pretool,
            "tool_name": "Bash",
            "tool_input": {"command": "node ops/tools/dispatch_prepare.mjs --seed-stdin --format json"},
        },
        rc=0,
        quiet=True,
    )
    check_process(
        "kimi_proc_session_start_injects_plain_text",
        ["--flavor", "kimi"],
        {"hook_event_name": "SessionStart", "session_id": "selftest", "cwd": ROOT_FOR_SELFTEST, "source": "compact"},
        rc=0,
        stdout_non_empty=True,
        stdout_not_json=True,
    )
    check_process(
        "kimi_proc_stop_injects_plain_text",
        ["--flavor", "kimi"],
        {
            "hook_event_name": "Stop",
            "session_id": "selftest",
            "cwd": ROOT_FOR_SELFTEST,
            "last_assistant_message": "STATUS.md 已同步。",
        },
        rc=0,
        stdout_non_empty=True,
        stdout_not_json=True,
    )
    check_process(
        "kimi_proc_postcompact_injects_plain_text",
        ["--flavor", "kimi"],
        {"hook_event_name": "PostCompact", "session_id": "selftest", "cwd": ROOT_FOR_SELFTEST, "trigger": "manual"},
        rc=0,
        stdout_non_empty=True,
        stdout_not_json=True,
    )
    check_process(
        "codex_proc_postcompact_silent",
        [],
        {"hook_event_name": "PostCompact", "session_id": "selftest", "cwd": ROOT_FOR_SELFTEST, "trigger": "manual"},
        rc=0,
        quiet=True,
    )
    check_process(
        "codex_proc_blocks_spawn_agent_exit0_json",
        [],
        {
            "hook_event_name": "PreToolUse",
            "session_id": "selftest",
            "cwd": ROOT_FOR_SELFTEST,
            "tool_name": "spawn_agent",
            "tool_input": {"prompt": "x"},
        },
        rc=0,
        stdout_contains='"decision": "block"',
    )
    if failures:
        for line in failures:
            print(f"FAIL {line}")
        return 1
    source = "file" if INJECTION_CONFIG_PATH.exists() else "defaults"
    unknown = injection_unknown_keys()
    suffix = f" unknown_keys={','.join(unknown)}" if unknown else ""
    print(f"agent_monitor self-test: pass (config={source}{suffix})")
    return 0


def main() -> int:
    args = parse_hook_args(sys.argv[1:])
    if args.self_test:
        return run_self_test()
    flavor = args.flavor
    raw_input = read_hook_stdin()
    event, parse_mode, parse_error = parse_hook_event(raw_input)
    if event is None:
        _ = (parse_mode, parse_error)
        return 0
    _ = (raw_input, parse_mode, parse_error)
    event = normalize_hook_event_for_flavor(event, flavor)

    hook = event.get("hook_event_name")
    if hook == "PreToolUse":
        try:
            reason = subagent_dispatch_block_reason(event, flavor=flavor)
        except Exception as exc:
            reason = f"子代理派发门禁检查失败，按 fail-closed 处理：{exc}"
        if reason:
            if flavor == "kimi":
                # Kimi 拦截语义：exit 2，stderr 文本作为阻断原因回写给模型。
                print(safe_text(reason), file=sys.stderr)
                return 2
            print(safe_hook_json_dumps({"continue": False, "decision": "block", "reason": reason}))
        return 0

    try:
        state, _tool, _monitor_id, _summary = summarize(event)
    except Exception as exc:
        if event.get("hook_event_name") in ("SessionStart", "Stop"):
            if flavor == "kimi":
                print(safe_text(f"agent_monitor failed: {exc}"))
            else:
                print(safe_hook_json_dumps({"continue": True, "systemMessage": f"agent_monitor failed: {exc}"}))
        return 0

    additional_context_max = injection_limit("additional_context_max_chars")
    if hook == "SessionStart":
        if injection_enabled("compact_agents_reminder") and should_inject_compact_agents_reminder(event):
            if flavor == "kimi":
                # Kimi 注入语义：exit 0，stdout 纯文本直接附加进上下文（不包 JSON）。
                print(clip(injection_text("compact_agents_reminder"), additional_context_max))
            else:
                print(
                    safe_hook_json_dumps(
                        {
                            "continue": True,
                            "hookSpecificOutput": {
                                "hookEventName": hook,
                                "additionalContext": injection_text("compact_agents_reminder"),
                            },
                        },
                        additional_context_max,
                    )
                )
    elif hook == "Stop":
        reminder = injection_text("stop_state_check_reminder") if should_inject_stop_state_check(event) else ""
        if reminder:
            if flavor == "kimi":
                print(safe_text(reminder))
            else:
                print(safe_hook_json_dumps({"continue": True, "systemMessage": reminder}))
    elif hook in {"PostToolUse", "PermissionRequest"}:
        payload: dict[str, Any] = {}
        if should_inject_subagent_dispatch_reminder(event, state):
            payload["continue"] = True
            payload["hookSpecificOutput"] = {
                "hookEventName": hook,
                "additionalContext": build_subagent_dispatch_reminder_context(),
            }
        elif injection_enabled("external_truth_reminder") and should_inject_external_truth_reminder(event, state):
            payload["continue"] = True
            payload["hookSpecificOutput"] = {
                "hookEventName": hook,
                "additionalContext": injection_text("external_truth_reminder"),
            }
        if payload:
            if flavor == "kimi":
                print(clip(payload["hookSpecificOutput"]["additionalContext"], additional_context_max))
            else:
                print(safe_hook_json_dumps(payload, additional_context_max))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
