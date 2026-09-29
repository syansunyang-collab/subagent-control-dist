#!/usr/bin/env python3
"""config_snapshot --self-test 的机械用例集，由 config_snapshot.cmd_self_test 调用。"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import config_snapshot as cs


def _self_test_plan(root: Path) -> cs.ScanPlan:
    collection_root = root / "extensions"
    return cs.ScanPlan(
        scope="config-snapshot-self-test/v1",
        static_files=(
            cs.FileTarget("file://fixture/controlled.json", root / "controlled.json"),
            cs.FileTarget("file://fixture/removable.json", root / "removable.json"),
            cs.FileTarget("file://fixture/missing.json", root / "missing.json"),
        ),
        collections=(
            cs.FileCollection(
                "collection://fixture/extensions/*/config.json",
                collection_root,
                "*/config.json",
                "file://fixture/extensions",
            ),
        ),
    )


def cmd_self_test() -> int:
    failures: list[str] = []
    checks = 0

    def expect(condition: bool, name: str) -> None:
        nonlocal checks
        checks += 1
        if not condition:
            failures.append(name)

    with tempfile.TemporaryDirectory(prefix="config-snapshot-self-test-") as raw:
        root = Path(raw)
        controlled = root / "controlled.json"
        removable = root / "removable.json"
        extension = root / "extensions" / "sample" / "config.json"
        extension.parent.mkdir(parents=True)

        original = 'API_KEY="LEAK_SENTINEL_ALPHA_7f2c91"\n'
        changed = 'API_KEY="LEAK_SENTINEL_BETA_4a8d63"\n'
        removable_text = "REMOVABLE_SECRET_91bc4e\n"
        extension_text = "EXTENSION_SECRET_62fa0d\n"
        controlled.write_text(original, encoding="utf-8")
        removable.write_text(removable_text, encoding="utf-8")
        extension.write_text(extension_text, encoding="utf-8")

        plan = _self_test_plan(root)
        baseline = cs.build_snapshot(plan)
        serialized = json.dumps(baseline, ensure_ascii=False, sort_keys=True)
        expect(baseline["status"] == "pass", "baseline scan should pass")
        expect(
            not any(
                secret in serialized
                for secret in (
                    original.strip(),
                    "LEAK_SENTINEL_ALPHA_7f2c91",
                    removable_text.strip(),
                    extension_text.strip(),
                )
            ),
            "snapshot leaked fixture plaintext",
        )
        by_id = {row["id"]: row for row in baseline["items"]}
        expect(
            by_id["file://fixture/missing.json"]["state"] == "absent",
            "missing path was not recorded as absent",
        )

        snapshot_path = root / "snapshot.json"
        payload = cs._atomic_write_json(snapshot_path, baseline)
        expect(
            not any(
                secret.encode("utf-8") in payload
                for secret in (
                    original.strip(),
                    "LEAK_SENTINEL_ALPHA_7f2c91",
                    removable_text.strip(),
                    extension_text.strip(),
                )
            ),
            "persisted snapshot leaked fixture plaintext",
        )
        loaded = cs._load_snapshot(snapshot_path, expected_scope=plan.scope)
        expect(loaded["items"] == baseline["items"], "snapshot persistence or validation mismatch")
        extension.write_text("changed extension\n", encoding="utf-8")
        collection_diff = cs.compare_items(baseline["items"], cs.build_snapshot(plan)["items"])
        expect(
            len(collection_diff) == 1 and collection_diff[0]["id"] == "file://fixture/extensions/sample/config.json",
            "one child change must not create a parent content_changed event",
        )
        extension.write_text(extension_text, encoding="utf-8")

        controlled.write_text(changed, encoding="utf-8")
        modified = cs.build_snapshot(plan)
        modified_differences = cs.compare_items(baseline["items"], modified["items"])
        expect(
            any(
                row["id"] == "file://fixture/controlled.json"
                and row["change"] == "content_changed"
                for row in modified_differences
            ),
            "content modification was not identified",
        )
        modified_report_text = json.dumps(
            modified_differences, ensure_ascii=False, sort_keys=True
        )
        expect(
            "LEAK_SENTINEL_BETA_4a8d63" not in modified_report_text,
            "compare report leaked changed plaintext",
        )

        controlled.write_text(original, encoding="utf-8")
        restored = cs.build_snapshot(plan)
        expect(
            cs.compare_items(baseline["items"], restored["items"]) == [],
            "restored content did not compare clean",
        )

        missing = root / "missing.json"
        missing.write_text("ABSENT_TO_PRESENT_SECRET_5d31aa\n", encoding="utf-8")
        absent_to_present = cs.compare_items(
            baseline["items"], cs.build_snapshot(plan)["items"]
        )
        expect(
            any(
                row["id"] == "file://fixture/missing.json"
                and row["change"] == "absent_to_present"
                for row in absent_to_present
            ),
            "absent-to-present transition was not identified",
        )
        missing.unlink()

        removable.unlink()
        present_to_absent = cs.compare_items(
            baseline["items"], cs.build_snapshot(plan)["items"]
        )
        expect(
            any(
                row["id"] == "file://fixture/removable.json"
                and row["change"] == "present_to_absent"
                for row in present_to_absent
            ),
            "present-to-absent transition was not identified",
        )
        removable.write_text(removable_text, encoding="utf-8")

        new_extension = root / "extensions" / "new-extension" / "config.json"
        new_extension.parent.mkdir(parents=True)
        new_extension.write_text("DYNAMIC_SECRET_3fc12b\n", encoding="utf-8")
        dynamic_differences = cs.compare_items(
            baseline["items"], cs.build_snapshot(plan)["items"]
        )
        expect(
            any(
                row["id"] == "file://fixture/extensions/new-extension/config.json"
                and row["change"] == "absent_to_present"
                for row in dynamic_differences
            ),
            "new wildcard match was not identified",
        )
        new_extension.unlink()
        new_extension.parent.rmdir()

        extension.unlink()
        dynamic_removal = cs.compare_items(
            baseline["items"], cs.build_snapshot(plan)["items"]
        )
        expect(
            any(
                row["id"] == "file://fixture/extensions/sample/config.json"
                and row["change"] == "present_to_absent"
                for row in dynamic_removal
            ),
            "removed wildcard match was not identified",
        )
        extension.write_text(extension_text, encoding="utf-8")
        expect(
            cs.compare_items(baseline["items"], cs.build_snapshot(plan)["items"]) == [],
            "fully restored fixture did not compare clean",
        )

        first_registry_hash = cs._registry_digest("REGISTRY_SECRET_A", 1)
        second_registry_hash = cs._registry_digest("REGISTRY_SECRET_B", 1)
        expect(
            first_registry_hash != second_registry_hash
            and "REGISTRY_SECRET_A" not in first_registry_hash,
            "registry value hashing is not content-sensitive and hash-only",
        )

        quoted_executable, _ = cs._extract_executable(
            '"C:\\Program Files\\Svc\\Svc.exe" --service'
        )
        plain_executable, _ = cs._extract_executable(r"C:\ProgramData\Svc\Svc.exe")
        expect(
            quoted_executable == r"C:\Program Files\Svc\Svc.exe"
            and plain_executable == r"C:\ProgramData\Svc\Svc.exe",
            "WinSW ImagePath parsing failed",
        )

    if failures:
        print(f"config_snapshot self-test: FAIL ({checks - len(failures)}/{checks})")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print(f"config_snapshot self-test: pass ({checks}/{checks})")
    return 0
