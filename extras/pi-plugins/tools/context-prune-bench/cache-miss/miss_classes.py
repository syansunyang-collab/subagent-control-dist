"""Classify full-history cache misses in one Pi session file and estimate their list-price cost.

Usage: python miss_classes.py <session.jsonl>

A request counts as a miss when the previous request had > 50K input and cacheRead fell below
half of min(current, previous) input. Classes:
  A apply          context-prune apply between the two requests
  B relocation     the request right after an apply miss, Pi >= 0.87.1 (summary moved, see notes)
  turn-start tools turn-start request that only hit ~8-13K (tool list changed at turn start)
  structural       compaction / model change / thinking change
  idle>=30min      gap of 30 minutes or more
  cr=0             nothing cached, isolated
  second / other   remaining
Cost uses Astra list price: (input - cacheRead) = $9/M, doubled above 272K.
"""
import collections
import json
import sys
from datetime import datetime

PI_0871_INSTALLED = "2026-09-23T16:10"  # UTC; 2026-09-24 00:10 +08:00
DISPATCH = {"dispatch_prepare", "subagent_dispatch", "subagent_submit_prepared", "fleet_start", "delegate_work"}


def load_branch(path):
    entries, order = {}, []
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if "id" in e:
            entries[e["id"]] = e
            order.append(e["id"])
    chain, cur = [], order[-1]
    while cur in entries:
        chain.append(entries[cur])
        cur = entries[cur].get("parentId")
    return chain[::-1]


def requests(chain):
    ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    rows, ev = [], []
    for e in chain:
        t, m, d = e.get("type"), e.get("message") or {}, e.get("data") or {}
        if e.get("customType") == "context-prune-lab-event" and d.get("event") == "apply":
            ev.append("apply")
        elif t == "custom_message":
            ev.append("cmsg:" + str(e.get("customType")))
        elif t in ("compaction", "model_change", "thinking_level_change"):
            ev.append(t)
        elif t == "message" and m.get("role") == "user":
            ev.append("user")
        elif t == "message" and m.get("role") == "assistant":
            u = m.get("usage") or {}
            total = u.get("input", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0)
            calls = [c.get("name") for c in (m.get("content") or []) if isinstance(c, dict) and c.get("type") == "toolCall"]
            if total:
                rows.append(dict(ts=e["timestamp"], t=ts(e["timestamp"]), model=m.get("model"), U=total,
                                 cr=u.get("cacheRead", 0), stop=m.get("stopReason"), calls=calls, ev=ev))
            ev = []
    for i, r in enumerate(rows):
        p = rows[i - 1] if i else None
        r["gap"] = r["t"] - p["t"] if p else 0
        r["miss"] = bool(p and p["U"] > 50000 and r["cr"] < 0.5 * min(r["U"], p["U"]))
    return rows


def classify(rows, i):
    r, p = rows[i], rows[i - 1]
    ev = r["ev"]
    if "apply" in ev:
        return "A apply"
    if any(x in ev for x in ("compaction", "model_change", "thinking_level_change")):
        return "structural"
    if p["miss"] and "apply" in p["ev"] and r["ts"] >= PI_0871_INSTALLED:
        return "B relocation"
    if p["stop"] != "toolUse" and 8000 <= r["cr"] <= 13000:
        return "turn-start tools"
    if p["miss"]:
        return "second"
    if r["gap"] >= 1800:
        return "idle>=30min"
    if r["cr"] == 0:
        return "cr=0"
    return "other"


def main(path):
    rows = requests(load_branch(path))
    agg = collections.defaultdict(lambda: [0, 0.0])
    for i in range(1, len(rows)):
        r, p = rows[i], rows[i - 1]
        if not r["miss"]:
            continue
        lost = max(0, min(r["U"], p["U"]) - r["cr"])
        rate = 18 if r["U"] > 272000 else 9
        k = classify(rows, i)
        agg[k][0] += 1
        agg[k][1] += lost * rate / 1e6 if "astra" in (r["model"] or "") else 0
    print(f"requests {len(rows)}  misses {sum(r['miss'] for r in rows)}  span {rows[0]['ts'][:10]} ~ {rows[-1]['ts'][:10]}")
    for k, (n, usd) in sorted(agg.items(), key=lambda x: -x[1][1]):
        print(f"  {k:18s} n={n:4d}  astra ${usd:7.1f}")

    # Apply followed by a second miss, before and after Pi 0.87.1.
    pair = collections.Counter()
    for i in range(len(rows) - 1):
        a, b = rows[i], rows[i + 1]
        if "apply" not in a["ev"] or a["model"] != b["model"] or "apply" in b["ev"]:
            continue
        era = "pi>=0.87.1" if a["ts"] >= PI_0871_INSTALLED else "pi<0.87.1"
        pair[(era, "applies")] += 1
        pair[(era, "A miss")] += a["miss"]
        pair[(era, "A+B miss")] += a["miss"] and b["cr"] < 0.5 * b["U"]
    print("apply pairs", dict(pair))

    # Turn-start hit level vs. a subagent dispatch in the previous turn.
    turns = []
    for r in rows:
        if not turns or turns[-1][-1]["stop"] != "toolUse":
            turns.append([])
        turns[-1].append(r)
    tab = collections.Counter()
    for i in range(1, len(turns)):
        first, prev = turns[i][0], turns[i - 1]
        if first["model"] != prev[-1]["model"] or prev[-1]["U"] < 50000:
            continue
        if any(x in first["ev"] for x in ("apply", "compaction", "model_change", "thinking_level_change")):
            continue
        level = "hit" if first["cr"] >= 0.5 * first["U"] else "~10K" if 8000 <= first["cr"] <= 13000 else "other"
        dispatched = any(c in DISPATCH for r in prev for c in r["calls"])
        tab[("dispatch in previous turn" if dispatched else "no dispatch", level)] += 1
    print("turn starts", dict(sorted(tab.items())))


if __name__ == "__main__":
    main(sys.argv[1])
