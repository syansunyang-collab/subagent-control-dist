#!/usr/bin/env python
"""Summarize a rounds.py batch: per-task solve matrix, tokens, list-price cost and behaviour per run.

Cost uses the provider's list price, including long-context tiers: when a request's prompt reaches the threshold, the
whole request is billed at the higher rate. Pi's own `usage.cost` has a single tier and undercounts such requests.
Models missing from PRICES fall back to Pi's `usage.cost`. The summarizer's spend is taken from the pruner's stats.

Usage: python tools/context-prune-bench/batch_report.py test-results/context-prune-bench/live-20260919-grok [--json out.json]
"""
import json
import statistics
import sys
from datetime import datetime
from pathlib import Path

# model id -> (threshold prompt tokens, (input, cached input, output) below, same at or above), USD per 1M tokens.
# grok-4.6: https://docs.x.ai/developers/pricing, checked 2026-09-19.
PRICES = {"grok-4.6": (200_000, (2.0, 0.5, 6.0), (4.0, 1.0, 12.0))}
TASK_PREFIX = "当前目录是 django/django 仓库"


def load(path):
    out = []
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def run_report(run_dir):
    run = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    session = run.get("sessionFile")
    if not session or not Path(session).exists():
        session = sorted((run_dir / "sessions").glob("**/*.jsonl"))[-1]
    r = {"run": run_dir.name, "thinking": run["thinking"], "resolved": {t["instance"]: bool(t["score"].get("resolved")) for t in run["tasks"]},
         "calls": 0, "ctx": 0, "uncached": 0, "cached": 0, "output": 0, "peak": 0, "tier2_calls": 0, "cost": 0.0, "cost_pi": 0.0,
         "compactions": 0, "tree_query": 0, "edits": 0, "edit_errors": 0, "summarizer_tokens": 0, "summarizer_cost": 0.0,
         "minutes": round((datetime.fromisoformat(run["finished"]) - datetime.fromisoformat(run["started"])).total_seconds() / 60)}
    depth, task_calls, seen_edit, edit_ids = [], None, False, set()
    for e in load(session):
        if e.get("type") == "compaction":
            r["compactions"] += 1
        if e.get("type") == "custom" and e.get("customType") == "context-prune-stats":
            d = e.get("data") or {}
            r["summarizer_tokens"] = max(r["summarizer_tokens"], (d.get("totalInputTokens") or 0) + (d.get("totalOutputTokens") or 0))
            r["summarizer_cost"] = max(r["summarizer_cost"], d.get("totalCost") or 0)
        m = e.get("message") or {}
        role = m.get("role")
        if role == "user":
            text = m.get("content") if isinstance(m.get("content"), str) else " ".join(
                c.get("text", "") for c in m.get("content") or [] if isinstance(c, dict))
            if text.startswith(TASK_PREFIX):
                if task_calls is not None:
                    depth.append(task_calls)
                task_calls, seen_edit = 0, False
        elif role == "assistant":
            u = m.get("usage") or {}
            prompt = (u.get("input") or 0) + (u.get("cacheRead") or 0) + (u.get("cacheWrite") or 0)
            if prompt:
                r["calls"] += 1
            r["ctx"] += prompt
            r["uncached"] += u.get("input") or 0
            r["cached"] += u.get("cacheRead") or 0
            r["output"] += u.get("output") or 0
            r["peak"] = max(r["peak"], prompt)
            r["cost_pi"] += (u.get("cost") or {}).get("total") or 0
            price = PRICES.get(m.get("model"))
            if price:
                high = prompt >= price[0]
                pin, pc, pout = price[2] if high else price[1]
                r["tier2_calls"] += high
                r["cost"] += (((u.get("input") or 0) + (u.get("cacheWrite") or 0)) * pin + (u.get("cacheRead") or 0) * pc
                              + (u.get("output") or 0) * pout) / 1e6
            else:
                r["cost"] += (u.get("cost") or {}).get("total") or 0
            for c in m.get("content") or []:
                if not (isinstance(c, dict) and c.get("type") == "toolCall"):
                    continue
                name = c.get("name")
                r["tree_query"] += name == "context_tree_query"
                if name == "edit":
                    r["edits"] += 1
                    edit_ids.add(c.get("id"))
                if task_calls is not None and not seen_edit:
                    if name in ("edit", "write"):
                        seen_edit = True
                    else:
                        task_calls += 1
        elif role == "toolResult" and m.get("toolCallId") in edit_ids and m.get("isError"):
            r["edit_errors"] += 1
    if task_calls is not None:
        depth.append(task_calls)
    r["first_edit_depth_median"] = statistics.median(depth) if depth else None
    r["total_cost"] = r["cost"] + r["summarizer_cost"]
    return r


def main(argv):
    out_json = None
    if "--json" in argv:
        out_json = argv[argv.index("--json") + 1]
        argv = [a for a in argv if a not in ("--json", out_json)]
    batch = Path(argv[0])
    rows = [json.loads(line) for line in (batch / "rounds.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    reports = [run_report(batch / row["run"]) for row in rows]
    tasks = list(reports[0]["resolved"])
    print("| task | " + " | ".join(r["run"] for r in reports) + " |")
    print("|---" * (len(reports) + 1) + "|")
    for t in tasks:
        print(f"| {t.split('-')[-1]} | " + " | ".join("1" if r["resolved"].get(t) else "0" for r in reports) + " |")
    print()
    print("| run | thinking | resolved | calls | ctx tokens | uncached | cache hit | peak | calls >= tier | compactions | tree_query "
          "| first-edit depth (median) | edit errors | summarizer tok | cost list price | cost Pi nominal | minutes |")
    print("|---" * 17 + "|")
    for r in reports:
        print(f"| {r['run']} | {r['thinking']} | {sum(r['resolved'].values())} | {r['calls']} | {r['ctx'] + r['summarizer_tokens']:,} | "
              f"{r['uncached']:,} | {r['cached'] / r['ctx']:.1%} | {r['peak']:,} | {r['tier2_calls']} | {r['compactions']} | {r['tree_query']} | "
              f"{r['first_edit_depth_median']} | {r['edit_errors']}/{r['edits']} | {r['summarizer_tokens']:,} | ${r['total_cost']:.2f} | "
              f"${r['cost_pi'] + r['summarizer_cost']:.2f} | {r['minutes']} |")
    if out_json:
        Path(out_json).write_text(json.dumps(reports, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])
