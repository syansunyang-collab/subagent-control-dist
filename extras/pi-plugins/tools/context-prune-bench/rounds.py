#!/usr/bin/env python
"""Run live_ab.py rounds with two arms side by side and stop on the quality plan's pre-registered rules.

Every round starts all arms at the same time, so they share the provider's load and time of day, and waits for all
of them. Before the next round it stops when a STOP file exists in the batch dir; when, after round 1, the first arm
resolved at least --ceiling tasks (the task set is too easy to show a difference); or when a run lost its Pi process,
finished fewer tasks than planned, or ended three or more tasks with an agent error.

Writes one JSON line per run to <batch>/rounds.jsonl and the reason for stopping to <batch>/rounds-done.json.

Usage: python tools/context-prune-bench/rounds.py --batch test-results/context-prune-bench/live-20260919-grok
         --model xai/grok-4.6 --plan high,high,high,high,xhigh --instances <ids> [--arms A,P] [--ceiling 16]

Start it outside the Claude desktop app's process tree (for example through WMI Win32_Process.Create): an update of
the app's package terminates every process the app started, including ones launched with Start-Process.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run_summary(run_dir):
    run = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    tasks = run.get("tasks", [])
    return {"run": run_dir.name, "thinking": run.get("thinking"), "tasks": len(tasks),
            "resolved": sum(bool(t.get("score", {}).get("resolved")) for t in tasks),
            "agent_errors": sum(1 for t in tasks if t.get("agent_error")), "aborted": run.get("aborted"),
            "finished": run.get("finished")}


def verdict(n, sums, arms, n_tasks, ceiling):
    """Reason to stop after round n, or None to go on."""
    broken = [a for a, s in sums.items() if s["exit"] or s["aborted"] or s["tasks"] < n_tasks or s["agent_errors"] >= 3]
    if broken:
        return f"round {n}: broken runs {broken}"
    if n == 1 and sums[arms[0]]["resolved"] >= ceiling:
        return f"ceiling: {arms[0]} resolved {sums[arms[0]]['resolved']}/{n_tasks} in round 1"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--plan", required=True, help="thinking level of each round, comma separated")
    ap.add_argument("--instances", required=True)
    ap.add_argument("--arms", default="A,P")
    ap.add_argument("--ceiling", type=int, default=16)
    ap.add_argument("--baseline", help="task pool passed on to live_ab.py")
    ap.add_argument("--first-round", type=int, default=1, help="number of the first round in --plan, to resume a batch")
    args = ap.parse_args()
    batch = Path(args.batch).resolve()
    batch.mkdir(parents=True, exist_ok=True)
    arms = args.arms.split(",")
    n_tasks = len([i for i in args.instances.split(",") if i.strip()])
    reason = "interrupted"
    try:
        for n, thinking in enumerate(args.plan.split(","), args.first_round):
            if (batch / "STOP").exists():
                reason = f"STOP file before round {n}"
                break
            procs = {}
            for arm in arms:
                run_dir = batch / f"r{n}-{arm}"
                log = (batch / f"r{n}-{arm}.log").open("w", encoding="utf-8")
                cmd = [sys.executable, str(HERE / "live_ab.py"), "--arm", arm, "--model", args.model, "--thinking", thinking,
                       "--instances", args.instances, "--run-dir", str(run_dir)] + (["--baseline", args.baseline] if args.baseline else [])
                procs[arm] = (subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT), log, run_dir)
            sums = {}
            for arm, (proc, log, run_dir) in procs.items():
                proc.wait()
                log.close()
                sums[arm] = {"round": n, "arm": arm, "exit": proc.returncode, **run_summary(run_dir)}
                with (batch / "rounds.jsonl").open("a", encoding="utf-8") as f:
                    f.write(json.dumps(sums[arm], ensure_ascii=False) + "\n")
            stop = verdict(n, sums, arms, n_tasks, args.ceiling)
            if stop:
                reason = stop
                break
        else:
            reason = "plan complete"
    finally:
        (batch / "rounds-done.json").write_text(json.dumps({"reason": reason, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")},
                                                           ensure_ascii=False), encoding="utf-8")
        print(reason, flush=True)


if __name__ == "__main__":
    main()
