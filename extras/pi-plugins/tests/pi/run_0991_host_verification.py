"""Repeat the isolated host acceptance checks and leave the candidate fully patched."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

PROJECT = Path(__file__).resolve().parents[2]
EVIDENCE = PROJECT / "test-results/pi-0991-upgrade/host"
REQUIRED_TESTS = [
    "tests/pi/test_pi_codex_attribution.py",
    "tools/pi-codex-attribution/test_verification_runner.py",
    "tests/pi/pi_0991_ws_runtime.test.mjs",
    "tests/pi/pi_ws_recovery_state.test.mjs",
    "tests/pi/pi_0991_bundle_entries.test.mjs",
    "tests/pi/prompt_stability_custom_run_abort.test.mjs",
    "tools/pi-prompt-stability/test.mjs",
]


def preflight_tests():
    missing = [path for path in REQUIRED_TESTS if not (PROJECT / path).is_file()]
    if missing:
        raise RuntimeError(f"Required host tests missing before candidate changes: {', '.join(missing)}")


def core_counts(output, kind):
    if kind == "node":
        passed = re.search(r"^# pass (\d+)\s*$", output, re.MULTILINE)
        skipped = re.search(r"^# skipped (\d+)\s*$", output, re.MULTILINE)
        counts = {"passed": int(passed[1]) if passed else 0,
                  "skipped": int(skipped[1]) if skipped else 0}
    else:
        ran = re.search(r"Ran (\d+) tests?", output)
        skipped = re.search(r"OK \(skipped=(\d+)\)", output)
        total = int(ran[1]) if ran else 0
        skips = int(skipped[1]) if skipped else 0
        counts = {"passed": total - skips, "skipped": skips}
    if counts["passed"] <= 0:
        raise RuntimeError(f"Core {kind} tests executed no passing tests (zero execution or all skipped): {counts}")
    return counts


def immutable_hashes():
    paths = [PROJECT / f"tools/{name}/manifest.json" for name in ["pi-codex-attribution", "pi-prompt-stability"]]
    for name in ["pi-codex-attribution", "pi-prompt-stability"]:
        runtime = PROJECT / ".runtime" / name
        paths.extend(p for p in runtime.rglob("*") if p.is_file() and "0.99.1" not in p.relative_to(runtime).parts)
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_relative_to((PROJECT / "tmp/pi-0991-upgrade/runtime").resolve()):
        parser.error("Use an isolated installation under tmp/pi-0991-upgrade/runtime")
    # Missing tests must be reported before any manager can mutate the candidate.
    preflight_tests()
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    env = {key: value for key, value in os.environ.items()
           if key not in ("SUBAGENT_RUNTIME_ROOT", "SUBAGENT_TASK_ROOT")}
    env.update({"PI_0991_TEST_ROOT": str(root),
                "PI_WS_TEST_PI_AI_ROOT": str(root / "node_modules/@earendil-works/pi-ai")})
    records = []

    def run(name, command, extra=None, core=None):
        result = subprocess.run(command, cwd=PROJECT, env={**env, **(extra or {})},
                                capture_output=True, text=True, timeout=180)
        output = result.stdout + result.stderr
        log = EVIDENCE / f"acceptance-{name}.log"
        log.write_text(output, encoding="utf-8")
        record = {"command": command, "cwd": str(PROJECT), "exit_code": result.returncode, "log": str(log)}
        records.append(record)
        try:
            if result.returncode:
                raise RuntimeError(f"{name} exited {result.returncode}: {log}")
            if core:
                record["coreTests"] = core_counts(output, core)
        except RuntimeError as error:
            record["failure"] = str(error)
            raise
        finally:
            (EVIDENCE / "acceptance-commands.json").write_text(json.dumps(records, indent=2), encoding="utf-8")

    before = immutable_hashes()
    attr = ["python", "-B", "tools/pi-codex-attribution/manage.py"]
    prompt = ["python", "-B", "tools/pi-prompt-stability/manage.py"]
    root_args = ["--root", str(root)]
    try:
        run("verification-gates", ["python", "-B", "tools/pi-codex-attribution/test_verification_runner.py"], core="python")
        run("overlay-rollback", prompt + ["rollback"] + root_args + ["--host-only"])
        run("attribution-rollback", attr + ["rollback"] + root_args)
        run("managers", ["python", "-B", "tests/pi/test_pi_codex_attribution.py"], core="python")
        run("identity", ["node", "tools/pi-codex-attribution/verify-installed.mjs"] + root_args + ["--agent-dir", str(EVIDENCE / "agent")])
        for bundled in [False, True]:
            for outcome in ["success", "failure", "cancel"]:
                name = f'{"bundle" if bundled else "sdk"}-{outcome}'
                run(name, ["node", "tools/pi-prompt-stability/verify-installed.mjs"] + root_args +
                    ["--agent-dir", str(EVIDENCE / name), "--compaction", outcome] + (["--bundle"] if bundled else []))
            run(f'ws-{"bundle" if bundled else "sdk"}', ["node", "--test", "--test-reporter=tap", "tests/pi/pi_0991_ws_runtime.test.mjs"],
                {"PI_0991_WS_BUNDLE": "1" if bundled else ""}, core="node")
        for name, path in [
            ("ws-state", "tests/pi/pi_ws_recovery_state.test.mjs"),
            ("entries", "tests/pi/pi_0991_bundle_entries.test.mjs"),
            ("preparation-abort", "tests/pi/prompt_stability_custom_run_abort.test.mjs"),
            ("extensions", "tools/pi-prompt-stability/test.mjs"),
        ]:
            run(name, ["node", "--test", "--test-reporter=tap", path], core="node")
        run("attribution-status", attr + ["status"] + root_args)
        run("prompt-status", prompt + ["status"] + root_args + ["--host-only", "--agent-dir", str(EVIDENCE / "agent")])
        run("ws-status", ["node", "tools/pi-ws-recovery/manage-pi-ws-recovery.mjs", "status", "--json",
                          "--target", f'candidate-ai={root / "node_modules/@earendil-works/pi-ai"}', "--bundle-target", f"candidate={root}"])
    finally:
        after = immutable_hashes()
        (EVIDENCE / "legacy-immutability.json").write_text(json.dumps({"unchanged": before == after, "before": before, "after": after}, indent=2), encoding="utf-8")
        if before != after:
            raise RuntimeError("Legacy payloads, manifests or backups changed")
    print(json.dumps({"pass": True, "commands": len(records), "candidate": str(root), "legacyArtifactsUnchanged": True}))


if __name__ == "__main__":
    main()
