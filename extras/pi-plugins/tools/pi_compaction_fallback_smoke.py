#!/usr/bin/env python3
"""Run an isolated live Pi compaction fallback smoke test.

The probe keeps production sessions and settings untouched. It copies credentials
and model metadata into a temporary agent directory, makes the dedicated
OpenRouter preset fail with a unique non-existent slug, and requires native compaction
to succeed through the active OpenAI Codex 500K alias.

The command performs real provider calls and therefore requires valid local
OpenRouter and OpenAI Codex authentication.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

MISSING_PRESET_PREFIX = "pi-compaction-fallback-smoke-missing"


def default_pi_root() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA is not set; pass --pi-root explicitly")
    return Path(appdata) / "npm/node_modules/@earendil-works/pi-coding-agent"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi-root", type=Path, default=default_pi_root())
    parser.add_argument("--agent-dir", type=Path, default=Path.home() / ".pi/agent")
    parser.add_argument("--main-model", default="openai-codex/gpt-5.6-sol-500k")
    parser.add_argument("--thinking", default="max")
    parser.add_argument("--timeout", type=int, default=420)
    return parser.parse_args()


def copy_probe_configuration(
    source_agent: Path, probe_agent: Path, missing_model_id: str
) -> None:
    auth = source_agent / "auth.json"
    models_path = source_agent / "models.json"
    if not auth.is_file() or not models_path.is_file():
        raise RuntimeError(f"Missing auth.json or models.json under {source_agent}")
    shutil.copy2(auth, probe_agent / "auth.json")

    models = json.loads(models_path.read_text(encoding="utf-8"))
    openrouter_models = (
        models.setdefault("providers", {})
        .setdefault("openrouter", {})
        .setdefault("models", [])
    )
    if not any(model.get("id") == missing_model_id for model in openrouter_models):
        openrouter_models.append(
            {
                "id": missing_model_id,
                "name": "Intentional Missing Preset (Fallback Smoke)",
                "api": "openai-completions",
                "reasoning": True,
                "input": ["text"],
                "contextWindow": 1048575,
                "maxTokens": 384000,
                "compat": {
                    "supportsDeveloperRole": False,
                    "thinkingFormat": "openrouter",
                    "requiresReasoningContentOnAssistantMessages": True,
                },
            }
        )
    (probe_agent / "models.json").write_text(
        json.dumps(models, indent=2) + "\n", encoding="utf-8"
    )

    settings = {
        "quietStartup": True,
        "compaction": {
            "enabled": True,
            "reserveTokens": 16384,
            "keepRecentTokens": 4,
        },
        "retry": {
            "enabled": False,
            "provider": {"timeoutMs": 60000, "maxRetries": 0},
        },
        "compactionModel": {
            "model": f"openrouter/{missing_model_id}",
            "thinkingLevel": "high",
            "reasons": ["manual"],
        },
    }
    (probe_agent / "settings.json").write_text(
        json.dumps(settings, indent=2) + "\n", encoding="utf-8"
    )


def text_content(message: dict[str, Any]) -> str:
    return "".join(
        block.get("text", "")
        for block in message.get("content", [])
        if block.get("type") == "text"
    )


def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    pi_root = args.pi_root.resolve()
    source_agent = args.agent_dir.resolve()
    cli = pi_root / "dist/cli.js"
    compaction_extension = (
        source_agent / "npm/node_modules/pi-compaction-model/src/index.ts"
    )
    alias_extension = source_agent / "extensions/openai-codex-sol-context-alias.ts"
    for required in (cli, compaction_extension, alias_extension):
        if not required.is_file():
            raise RuntimeError(f"Required file not found: {required}")

    temp_root = Path(tempfile.mkdtemp(prefix="pi-compaction-fallback-smoke-"))
    probe_agent = temp_root / "agent"
    work = temp_root / "work"
    probe_agent.mkdir()
    work.mkdir()
    process: subprocess.Popen[str] | None = None
    try:
        missing_preset = f"{MISSING_PRESET_PREFIX}-{os.getpid()}-{int(time.time())}"
        missing_model_id = f"deepseek/deepseek-v4-flash-0731@preset/{missing_preset}"
        copy_probe_configuration(source_agent, probe_agent, missing_model_id)
        provider, _, model_id = args.main_model.partition("/")
        if not provider or not model_id:
            raise RuntimeError("--main-model must be provider/model")

        node = shutil.which("node")
        if not node:
            raise RuntimeError("node is not available on PATH")
        command = [
            node,
            str(cli),
            "--mode",
            "rpc",
            "--no-session",
            "--model",
            args.main_model,
            "--thinking",
            args.thinking,
            "--no-extensions",
            "--extension",
            str(compaction_extension),
            "--extension",
            str(alias_extension),
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-builtin-tools",
            "--approve",
        ]
        environment = os.environ.copy()
        environment["PI_CODING_AGENT_DIR"] = str(probe_agent)
        process = subprocess.Popen(
            command,
            cwd=work,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        if process.stdin is None or process.stdout is None or process.stderr is None:
            raise RuntimeError("Failed to open Pi RPC pipes")

        stdout_queue: queue.Queue[str | None] = queue.Queue()
        stderr_lines: list[str] = []

        def read_stdout() -> None:
            assert process is not None and process.stdout is not None
            for line in process.stdout:
                stdout_queue.put(line)
            stdout_queue.put(None)

        def read_stderr() -> None:
            assert process is not None and process.stderr is not None
            for line in process.stderr:
                stderr_lines.append(line.rstrip())

        threading.Thread(target=read_stdout, daemon=True).start()
        threading.Thread(target=read_stderr, daemon=True).start()

        def send(payload: dict[str, Any]) -> None:
            assert process is not None and process.stdin is not None
            process.stdin.write(json.dumps(payload) + "\n")
            process.stdin.flush()

        def read_until(
            predicate: Callable[[dict[str, Any]], bool], timeout: int
        ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
            deadline = time.monotonic() + timeout
            events: list[dict[str, Any]] = []
            while time.monotonic() < deadline:
                remaining = max(0.1, deadline - time.monotonic())
                try:
                    line = stdout_queue.get(timeout=min(1.0, remaining))
                except queue.Empty:
                    if process is not None and process.poll() is not None:
                        raise RuntimeError(
                            f"Pi exited {process.returncode}: {' | '.join(stderr_lines[-8:])}"
                        )
                    continue
                if line is None:
                    raise RuntimeError(
                        f"Pi RPC stdout closed: {' | '.join(stderr_lines[-8:])}"
                    )
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                events.append(event)
                if predicate(event):
                    return event, events
            raise TimeoutError(f"RPC timeout: {' | '.join(stderr_lines[-8:])}")

        send({"id": "state", "type": "get_state"})
        state, _ = read_until(
            lambda event: (
                event.get("type") == "response" and event.get("id") == "state"
            ),
            30,
        )

        facts = "\n".join(
            f"fallback_probe_fact_{index:03d}: synthetic_value_{index:03d}; preserve this item."
            for index in range(1, 81)
        )
        send(
            {
                "id": "prompt",
                "type": "prompt",
                "message": (
                    "Isolated fallback smoke. Do not use tools. Read these facts, then reply "
                    "with this sentence exactly: FALLBACK PROBE ACTIVE AND READY FOR CONTROLLED "
                    f"COMPACTION TEST.\n{facts}"
                ),
            }
        )
        _, prompt_events = read_until(
            lambda event: event.get("type") == "agent_settled", args.timeout
        )
        assistant_messages = [
            event.get("message", {})
            for event in prompt_events
            if event.get("type") == "message_end"
            and event.get("message", {}).get("role") == "assistant"
        ]
        assistant_text = "".join(
            text_content(message) for message in assistant_messages
        )
        assistant_error = next(
            (
                message.get("errorMessage")
                for message in assistant_messages
                if message.get("stopReason") == "error"
            ),
            None,
        )
        if not assistant_text or assistant_error:
            raise RuntimeError(
                f"Main-model setup turn failed: {assistant_error or 'empty output'}"
            )

        send(
            {
                "id": "compact",
                "type": "compact",
                "customInstructions": (
                    "Preserve the fallback_probe marker and identify this as an isolated fallback smoke."
                ),
            }
        )
        response, compact_events = read_until(
            lambda event: (
                event.get("type") == "response" and event.get("id") == "compact"
            ),
            args.timeout,
        )
        time.sleep(0.2)
        dedicated_warning = next(
            (
                line
                for line in stderr_lines
                if "[pi-compaction-model] Compaction with" in line
                and missing_preset in line
            ),
            None,
        )
        data = response.get("data") or {}
        summary = data.get("summary") or ""
        compaction_end = next(
            (
                event
                for event in compact_events
                if event.get("type") == "compaction_end"
            ),
            None,
        )
        model = (state.get("data") or {}).get("model") or {}
        result = {
            "status": "pass"
            if (
                dedicated_warning
                and response.get("success") is True
                and compaction_end
                and "fallback_probe" in summary
            )
            else "fail",
            "activeModel": {
                "provider": model.get("provider"),
                "id": model.get("id"),
            },
            "thinkingLevel": (state.get("data") or {}).get("thinkingLevel"),
            "mainModelSetupSucceeded": True,
            "dedicatedFailureObserved": bool(dedicated_warning),
            "dedicatedFailure": dedicated_warning,
            "compactSuccess": response.get("success"),
            "compactError": response.get("error"),
            "compactionEndObserved": bool(compaction_end),
            "summaryChars": len(summary),
            "summaryHasProbeMarker": "fallback_probe" in summary,
            "summaryPreview": summary[:180].replace("\n", " "),
        }
        if result["status"] != "pass":
            raise RuntimeError(json.dumps(result, ensure_ascii=False))
        return result
    finally:
        if process is not None:
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
        shutil.rmtree(temp_root, ignore_errors=True)


def main() -> int:
    try:
        result = run_probe(parse_args())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print(
            json.dumps(
                {"status": "error", "error": str(error)}, ensure_ascii=False, indent=2
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
