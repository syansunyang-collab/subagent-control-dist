"""Real 0.99.1 installation round-trip, with legacy manifests left intact.
Run with PI_0991_TEST_ROOT pointing to the isolated npm installation only.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest

PROJECT = Path(__file__).resolve().parents[2]
ROOT = Path(os.environ["PI_0991_TEST_ROOT"]).resolve() if os.environ.get("PI_0991_TEST_ROOT") else None
ATTR = PROJECT / "tools/pi-codex-attribution/manage.py"
PROMPT = PROJECT / "tools/pi-prompt-stability/manage.py"
WS = PROJECT / "tools/pi-ws-recovery/manage-pi-ws-recovery.mjs"


def run(tool, action, ok=True):
    command = (["node", str(tool), action, "--json", "--target", f"candidate-ai={ROOT / 'node_modules/@earendil-works/pi-ai'}",
                "--bundle-target", f"candidate-bundle={ROOT}"] if tool == WS else
               ["python", "-B", str(tool), action, "--root", str(ROOT)] + (["--host-only"] if tool == PROMPT else []))
    result = subprocess.run(command, cwd=PROJECT, capture_output=True, text=True)
    print(json.dumps({"command": command, "cwd": str(PROJECT), "exit_code": result.returncode,
                      "output": result.stdout.strip(), "error": result.stderr.strip()}), flush=True)
    if ok and result.returncode != 0:
        raise AssertionError(result.stderr)
    if not ok and result.returncode == 0:
        raise AssertionError("Unknown content or out-of-order rollback was accepted")
    return json.loads(result.stdout) if ok else result


def contents():
    paths = set()
    for tool in ["pi-codex-attribution", "pi-ws-recovery", "pi-prompt-stability"]:
        manifest = json.loads((PROJECT / f"tools/{tool}/manifest-0.99.1.json").read_text())
        paths.update(e["path"] for e in manifest.get("files", manifest.get("host", {}).get("files", [])))
    return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() if (ROOT / p).exists() else None for p in paths}


@unittest.skipUnless(ROOT, "Set PI_0991_TEST_ROOT to an isolated real 0.99.1 npm installation")
class InstalledRoundTrip(unittest.TestCase):
    def test_real_release_apply_idempotence_inverse_overlay_and_unknown_rejection(self):
        self.assertEqual(json.loads((ROOT / "package.json").read_text())["version"], "0.99.1")
        self.assertTrue((ROOT / "node_modules/@earendil-works/pi-ai/package.json").exists())
        self.assertEqual(run(ATTR, "status")["state"], "baseline")
        baseline = contents()
        run(WS, "apply")
        self.assertTrue(all(not t["changed"] for t in run(WS, "apply")["targets"]))
        run(WS, "rollback")
        run(WS, "rollback")
        self.assertEqual(contents(), baseline)
        self.assertTrue(run(ATTR, "apply")["changed"])
        self.assertFalse(run(ATTR, "apply")["changed"])
        run(PROMPT, "apply")
        self.assertEqual(run(PROMPT, "apply")["host"], "patched")
        self.assertEqual(run(ATTR, "status")["state"], "patched+prompt-stability")
        self.assertTrue(all(t.get("combinedPatch") for t in run(WS, "status")["targets"]))
        self.assertTrue(all(not t["changed"] for t in run(WS, "apply")["targets"]))
        patched = contents()
        run(ATTR, "rollback", ok=False)
        run(WS, "rollback", ok=False)
        self.assertEqual(contents(), patched)
        run(PROMPT, "rollback")
        run(PROMPT, "rollback")
        run(ATTR, "rollback")
        self.assertFalse(run(ATTR, "rollback")["changed"])
        self.assertEqual(contents(), baseline)
        path = ROOT / "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js"
        original = path.read_bytes()
        try:
            path.write_bytes(original + b"\n// unknown installed edit\n")
            unknown = contents()
            run(ATTR, "apply", ok=False)
            run(WS, "apply", ok=False)
            run(PROMPT, "apply", ok=False)
            self.assertEqual(contents(), unknown)
        finally:
            path.write_bytes(original)
        run(ATTR, "apply")
        run(PROMPT, "apply")
        host = ROOT / "dist/core/agent-session.js"
        original = host.read_bytes()
        try:
            host.write_bytes(original + b"\n// unknown overlay edit\n")
            unknown = contents()
            run(PROMPT, "apply", ok=False)
            run(PROMPT, "rollback", ok=False)
            run(ATTR, "rollback", ok=False)
            self.assertEqual(contents(), unknown)
        finally:
            host.write_bytes(original)
        self.assertEqual(run(ATTR, "status")["state"], "patched+prompt-stability")


if __name__ == "__main__":
    unittest.main()
