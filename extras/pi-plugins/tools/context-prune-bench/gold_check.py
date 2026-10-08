#!/usr/bin/env python
"""Validate the task pool without a model: apply each task's gold patch and run it through the same scorer.

A task whose gold patch does not score as resolved cannot be solved by any agent in this environment (wrong Python
for that Django version, a test id the log parser cannot see, ...). Such tasks only burn tokens in an A/B run.

Each job checks its tasks out in its own git worktree of the base repo (<work>-<n>). The tests do not look at the
history, so the history-free trees the agents get are not needed here, and switching commits in a worktree takes
seconds instead of minutes.

Usage: python tools/context-prune-bench/gold_check.py [--tasks <json>] [--jobs 4] [--work C:/pib/goldcheck-wt/django]
         [--out test-results/context-prune-bench/gold-check.json]
"""
import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live_ab  # noqa: E402


def git(args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def check(inst, work, args):
    iid = inst["instance_id"]
    out_dir = Path(args.out).parent / Path(args.out).stem / iid
    out_dir.mkdir(parents=True, exist_ok=True)
    co = git(["checkout", "-q", "-f", "--detach", inst["base_commit"]], work)
    git(["clean", "-qfdx"], work)
    (out_dir / "gold.diff").write_text(inst["patch"], encoding="utf-8", newline="\n")
    ap_res = git(["apply", "--whitespace=nowarn", str(out_dir / "gold.diff")], work)
    row = {"instance": iid, "version": inst.get("version"), "difficulty": inst.get("difficulty"),
           "gold_applied": co.returncode == 0 and ap_res.returncode == 0}
    if row["gold_applied"]:
        sc = live_ab.score(inst, work, args.python, out_dir)
        row.update({k: sc.get(k) for k in ("resolved", "f2p_pass", "f2p_total", "p2p_pass", "p2p_total",
                                           "f2p_missing", "p2p_missing", "test_exit", "test_seconds")})
    else:
        row["apply_stderr"] = (co.stderr + ap_res.stderr)[-400:]
    print(f"{iid}: gold_applied={row['gold_applied']} resolved={row.get('resolved')} "
          f"f2p={row.get('f2p_pass')}/{row.get('f2p_total')} p2p={row.get('p2p_pass')}/{row.get('p2p_total')}", flush=True)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default=str(live_ab.BASELINE), help="task list: a JSON list or {\"instances\": [...]}")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--work", default="C:/pib/goldcheck-wt/django")
    ap.add_argument("--out", default=str(live_ab.REPO / "test-results/context-prune-bench/gold-check.json"))
    ap.add_argument("--base-repo", default=str(live_ab.REPO / "tmp/context-prune-bench/django-base"))
    ap.add_argument("--python", default="C:/pib/venv/Scripts/python.exe")
    args = ap.parse_args()
    args.out = str(Path(args.out).resolve())  # patches are applied from inside the work tree

    data = json.loads(Path(args.tasks).read_text(encoding="utf-8"))
    items = data if isinstance(data, list) else data.get("instances", data)
    works = [Path(f"{args.work}-{n}") for n in range(args.jobs)]
    for w in works:  # one after another: concurrent `worktree add` on the same repo can trip over its lock
        if not (w / ".git").exists():
            w.parent.mkdir(parents=True, exist_ok=True)
            r = git(["worktree", "add", "-f", "--detach", str(w), items[0]["base_commit"]], args.base_repo)
            if r.returncode:
                sys.exit(r.stderr)

    def run_slice(n):
        return [check(inst, works[n], args) for inst in items[n::args.jobs]]

    with ThreadPoolExecutor(args.jobs) as pool:
        rows = {r["instance"]: r for part in pool.map(run_slice, range(args.jobs)) for r in part}
    results = [rows[inst["instance_id"]] for inst in items]
    Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    bad = [r["instance"] for r in results if not r.get("resolved")]
    print(f"\nsolvable: {len(results) - len(bad)}/{len(results)}; not solvable here: {bad}")


if __name__ == "__main__":
    main()
