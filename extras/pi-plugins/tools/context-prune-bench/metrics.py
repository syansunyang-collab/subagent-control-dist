#!/usr/bin/env python
"""Extract token/behaviour metrics (M1-M10 of the alignment note) from Pi session JSONL files.

Usage:
  python tools/context-prune-bench/metrics.py <session.jsonl | run-dir> [...]  [--json out.json]

A run-dir (from live_ab.py) is resolved to its sessions/*.jsonl plus run.json scores.
Reads only; prints one Markdown table row per session and optionally writes JSON.
"""
import json
import sys
from collections import Counter
from pathlib import Path


def load(path):
    out = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def session_metrics(path):
    entries = load(path)
    m = Counter()
    tools = Counter()
    read_paths = Counter()
    peak = 0
    first_ts = last_ts = None
    prune = {"flushes": 0, "summarized": 0, "skipped": 0, "raw_chars": 0, "summary_chars": 0, "stats": None}
    compactions = 0
    for e in entries:
        t = e.get("type")
        ts = e.get("timestamp")
        if ts:
            first_ts = first_ts or ts
            last_ts = ts
        if t == "compaction":
            compactions += 1
        elif t == "custom":
            ct = e.get("customType")
            d = e.get("data") or {}
            if ct == "context-prune-frontier":
                prune["flushes"] += 1
                if d.get("outcome") == "summarized":
                    prune["summarized"] += 1
                    prune["raw_chars"] += d.get("rawCharCount", 0) or 0
                    prune["summary_chars"] += d.get("summaryCharCount", 0) or 0
                else:
                    prune["skipped"] += 1
            elif ct == "context-prune-stats":
                prune["stats"] = d
        elif t == "message":
            msg = e.get("message") or {}
            role = msg.get("role")
            if role == "assistant":
                u = msg.get("usage") or {}
                ctx = (u.get("input") or 0) + (u.get("cacheRead") or 0) + (u.get("cacheWrite") or 0)
                if ctx:
                    m["calls"] += 1
                m["input"] += u.get("input") or 0
                m["cacheRead"] += u.get("cacheRead") or 0
                m["cacheWrite"] += u.get("cacheWrite") or 0
                m["output"] += u.get("output") or 0
                m["reasoning"] += u.get("reasoning") or 0
                m["cost"] += (u.get("cost") or {}).get("total") or 0
                peak = max(peak, ctx)
                for c in msg.get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "toolCall":
                        tools[c.get("name")] += 1
                        if c.get("name") == "read":
                            a = c.get("arguments") or {}
                            read_paths[a.get("path") or a.get("file_path") or ""] += 1
    ctx_total = m["input"] + m["cacheRead"] + m["cacheWrite"]
    ps = prune["stats"] or {}
    return {
        "file": str(path),
        "M1_ctx_tokens": ctx_total,
        "M2_uncached_input": m["input"],
        "M3_cache_read": m["cacheRead"],
        "M3_cache_hit": round(m["cacheRead"] / ctx_total, 4) if ctx_total else None,
        "M4_output": m["output"],
        "M4_reasoning": m["reasoning"],
        "M5_summarizer": {"input": ps.get("totalInputTokens", 0), "output": ps.get("totalOutputTokens", 0),
                          "cost": ps.get("totalCost", 0), "calls": ps.get("callCount", 0)},
        "M6_cost_nominal": round(m["cost"], 4),
        "M7_calls": m["calls"],
        "M7_peak_ctx": peak,
        "M7_first_ts": first_ts,
        "M7_last_ts": last_ts,
        "M9_context_tree_query": tools.get("context_tree_query", 0),
        "M9_repeat_reads": sum(n - 1 for n in read_paths.values() if n > 1),
        "M10_prune": {k: v for k, v in prune.items() if k != "stats"},
        "M10_compactions": compactions,
        "tools": dict(tools),
    }


def row(r, score=None):
    p = r["M10_prune"]
    s = r["M5_summarizer"]
    net = r["M1_ctx_tokens"] + s["input"] + s["output"]
    sc = "" if score is None else score
    return (f"| {Path(r['file']).name[:19]} | {r['M7_calls']} | {r['M1_ctx_tokens']:,} | {r['M2_uncached_input']:,} | {r['M3_cache_hit']} | "
            f"{r['M4_output']:,} | {s['input'] + s['output']:,} | {net:,} | {r['M7_peak_ctx']:,} | {p['flushes']}/{p['skipped']} | "
            f"{r['M9_context_tree_query']} | {r['M9_repeat_reads']} | {r['M10_compactions']} | {sc} |")


HEADER = ("| session | calls | M1 ctx | M2 uncached | cache hit | M4 out | M5 summarizer | M1+M5 | peak ctx | flush/skip | tree_query | repeat reads | compactions | resolved |\n"
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")


def main(argv):
    out_json = None
    if "--json" in argv:
        i = argv.index("--json")
        out_json = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    results = []
    print(HEADER)
    for arg in argv:
        p = Path(arg)
        score = None
        files = [p]
        if p.is_dir():
            files = sorted((p / "sessions").glob("**/*.jsonl")) if (p / "sessions").exists() else sorted(p.glob("*.jsonl"))
            rj = p / "run.json"
            if rj.exists():
                run = json.loads(rj.read_text(encoding="utf-8"))
                score = "/".join("1" if t.get("score", {}).get("resolved") else "0" for t in run.get("tasks", []))
                if run.get("sessionFile") and Path(run["sessionFile"]).exists():
                    files = [Path(run["sessionFile"])]  # ignore stale sessions from earlier runs in the same dir
        for f in files:
            r = session_metrics(f)
            r["run_dir"] = str(p) if p.is_dir() else None
            r["resolved"] = score
            results.append(r)
            print(row(r, score))
    if out_json:
        Path(out_json).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])
