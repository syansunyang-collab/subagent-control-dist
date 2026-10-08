#!/usr/bin/env python
"""Recompute replay totals from <tag>.calls.json files (no model calls).

Two chars->tokens calibrations are reported per session and the more conservative
(smaller saving) is used as the headline:
  fit   : tokens = a + b*chars, least squares over the session's real calls
  ratio : per-call tokens_B = tokens_A * chars_B / chars_A
B's uncached input at a prune call is max(real uncached, b * chars after the bust).

Usage: python tools/context-prune-bench/rescore.py <replay-out-dir> [...]
"""
import json
import sys
from pathlib import Path


def fit(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx if sxx else 0
    a = my - b * mx
    ssr = sum((y - (a + b * x)) ** 2 for x, y in zip(xs, ys))
    syy = sum((y - my) ** 2 for y in ys)
    return a, b, (1 - ssr / syy) if syy else 0


def rescore(calls_path):
    calls = json.loads(Path(calls_path).read_text(encoding="utf-8"))
    valid = [c for c in calls if c["input"] + c["cacheRead"] + c["cacheWrite"] > 0]
    a, b, r2 = fit([c["aChars"] for c in valid], [c["input"] + c["cacheRead"] + c["cacheWrite"] for c in valid])
    A = {"ctx": 0, "uncached": 0}
    B = {"fit": {"ctx": 0, "uncached": 0}, "ratio": {"ctx": 0, "uncached": 0}}
    prunes = 0
    for c in valid:
        aT = c["input"] + c["cacheRead"] + c["cacheWrite"]
        A["ctx"] += aT
        A["uncached"] += c["input"]
        for mode in ("fit", "ratio"):
            if mode == "fit":
                bT = max(0, round(a + b * c["bChars"]))
                bust = round(b * c["bAfterBust"])
            else:
                bT = round(aT * c["bChars"] / c["aChars"]) if c["aChars"] else aT
                bust = round(aT * c["bAfterBust"] / c["aChars"]) if c["aChars"] else 0
            bU = c["input"]
            if c["bust"] == "prune":
                bU = max(c["input"], bust)
            B[mode]["ctx"] += bT
            B[mode]["uncached"] += min(bU, bT)
        if c["bust"] == "prune":
            prunes += 1
    return {"calls": len(valid), "fit": {"a": round(a), "b": round(b, 4), "r2": round(r2, 4)}, "A": A, "B": B, "prunes": prunes}


def main(dirs):
    rows = []
    for d in dirs:
        for calls_path in sorted(Path(d).glob("*.calls.json")):
            tag = calls_path.name[: -len(".calls.json")]
            res_path = calls_path.with_name(tag + ".result.json")
            summ = json.loads(res_path.read_text(encoding="utf-8"))["summarizer"] if res_path.exists() else {"tokens": 0, "skipped": 0, "calls": 0, "ratioP50": None}
            r = rescore(calls_path)
            S = summ["tokens"]
            out = {"tag": tag, **r, "summarizer": summ}
            for mode in ("fit", "ratio"):
                out[f"ctxReductionPct_{mode}"] = round((1 - r["B"][mode]["ctx"] / r["A"]["ctx"]) * 100, 2)
                out[f"netSavingPct_{mode}"] = round((r["A"]["ctx"] - r["B"][mode]["ctx"] - S) / r["A"]["ctx"] * 100, 2)
                out[f"uncachedDeltaPct_{mode}"] = round((r["B"][mode]["uncached"] - r["A"]["uncached"]) / r["A"]["ctx"] * 100, 2)
            out["netSavingPct_conservative"] = min(out["netSavingPct_fit"], out["netSavingPct_ratio"])
            calls_path.with_name(tag + ".rescored.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
            rows.append(out)
    print("| session | calls | A ctx | B ctx (fit) | B ctx (ratio) | net↓% fit | net↓% ratio | uncached Δ% fit | prunes | skipped | ratio p50 | fit R² |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for o in rows:
        s = o["summarizer"]
        print(f"| {o['tag'][:38]} | {o['calls']} | {o['A']['ctx']:,} | {o['B']['fit']['ctx']:,} | {o['B']['ratio']['ctx']:,} | {o['netSavingPct_fit']} | {o['netSavingPct_ratio']} | {o['uncachedDeltaPct_fit']:+} | {o['prunes']} | {s['skipped']}/{s['calls']} | {s['ratioP50'] and round(s['ratioP50'], 2)} | {o['fit']['r2']} |")
    if rows:
        A = sum(o["A"]["ctx"] for o in rows)
        for mode in ("fit", "ratio"):
            Bt = sum(o["B"][mode]["ctx"] for o in rows)
            S = sum(o["summarizer"]["tokens"] for o in rows)
            print(f"Total ({mode}): A={A:,} B={Bt:,} summarizer={S:,} net↓ {(A - Bt - S) / A * 100:.2f}%")


if __name__ == "__main__":
    main(sys.argv[1:])
