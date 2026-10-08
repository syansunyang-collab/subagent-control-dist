"""Regression checks for host acceptance preflight and non-empty core suites."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[2] / "tests/pi/run_0991_host_verification.py"
spec = importlib.util.spec_from_file_location("host_verification", PATH)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class VerificationGates(unittest.TestCase):
    def test_missing_test_stops_before_candidate_mutation(self):
        root = runner.PROJECT / "tmp/pi-0991-upgrade/runtime/preflight-fixture"
        with patch.object(runner, "REQUIRED_TESTS", ["tests/pi/missing-host-test.mjs"]), \
                patch("sys.argv", [str(PATH), "--root", str(root)]), \
                patch.object(runner.subprocess, "run") as command:
            with self.assertRaises(RuntimeError):
                runner.main()
            command.assert_not_called()

    def test_existing_test_preflight_accepts(self):
        with patch.object(runner, "REQUIRED_TESTS", ["tests/pi/run_0991_host_verification.py"]):
            runner.preflight_tests()

    def test_empty_and_all_skipped_suites_are_rejected(self):
        for kind, output in [
            ("node", "# tests 0\n# pass 0\n# skipped 0\n"),
            ("node", "# tests 2\n# pass 0\n# skipped 2\n"),
            ("python", "Ran 0 tests in 0.000s\nOK\n"),
            ("python", "Ran 1 test in 0.000s\nOK (skipped=1)\n"),
        ]:
            with self.subTest(kind=kind, output=output), self.assertRaises(RuntimeError):
                runner.core_counts(output, kind)

    def test_real_execution_counts_accept_partial_skips(self):
        self.assertEqual(runner.core_counts("# pass 2\n# skipped 1\n", "node"),
                         {"passed": 2, "skipped": 1})
        self.assertEqual(runner.core_counts("Ran 2 tests in 0.1s\nOK (skipped=1)\n", "python"),
                         {"passed": 1, "skipped": 1})


if __name__ == "__main__":
    unittest.main()
