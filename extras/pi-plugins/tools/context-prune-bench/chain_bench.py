#!/usr/bin/env python
"""Dependency-chain check for the context pruner.

SWE-bench tasks are independent of each other, so they cannot show whether pruning loses a detail that a later step
needs. Here every chain plants a detail in a tool result, lets the session move on, then asks for it. Four chains
cannot be answered by looking again (the command prints a fresh value on every run, or the file changed in between),
so the original tool output is the only source; two chains allow re-reading and measure the route taken instead.

One Pi session per run: six plants, three unrelated filler prompts, six probes. Values are random per run.

Usage: python tools/context-prune-bench/chain_bench.py --arm P --run-dir test-results/context-prune-bench/chain-<date>/r1-P
"""
import argparse
import json
import random
import re
import string
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live_ab  # noqa: E402

LEVELS = ["INFO", "DEBUG", "WARN"]


def token(rng, n=10):
    return "".join(rng.choice(string.ascii_lowercase + string.digits) for _ in range(n))


# ~14k characters of output with the value about a third of the way in: inside the summarizer's 8000-character
# view of a tool result, and long enough that a summary is shorter than the original so the result gets pruned.
MINT = """import secrets
mods = "asyncio base64 collections contextlib dataclasses functools hashlib heapq itertools json logging math pathlib queue random re secrets socket sqlite3 ssl".split()
print("mint: environment probe")
for i in range(1, 41):
    print(f"[probe {i:03d}] module {mods[i % len(mods)]}: import ok, loader=SourceFileLoader, cached=yes, abi=cp312, resolved in 0.0{i % 90:02d}s")
print("build-id: " + secrets.token_hex(6))
for i in range(1, 121):
    print(f"[link {i:03d}] {mods[i % len(mods)]} -> toolchain manifest entry {i * 7 % 97:02d}, signature ok, no drift detected")
print("mint: environment ok")
"""

# ~17k characters of output with the value at the end: past the summarizer's 8000-character view of a tool result.
DUMP = """import secrets
for i in range(1, 181):
    print(f"[stage {i:03d}] replayed segment {i * 37 % 1000:04d} from journal, checksum verified, 0 conflicts, continuing")
print("checkpoint token: " + secrets.token_hex(6))
print("replay finished")
"""

# ~12k characters of per-suite detail around the two verdict lines, so a summary is shorter than the original and
# the result gets pruned. Only the two verdicts carry "<name> ... FAIL"; the detail lines must never spell it.
CHECKS = """import random
names = ["check_" + w for w in "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango".split()]
failed = set(random.SystemRandom().sample(names, 2))
for idx, n in enumerate(names, 1):
    print("-" * 72)
    print(f"[{idx:02d}/{len(names)}] suite {n}: fixture seeded, workspace isolated, 3 handles open")
    for step in range(1, 5):
        print(f"    step {step}/4 {n[6:]}: prepared {step * 17 % 53:02d} records, asserted {step * 29 % 41:02d} invariants, elapsed {step * 13}ms")
    print(f"    teardown {n[6:]}: released 3 handles, flushed journal, no leaks")
    print(n + " ... " + ("FAIL" if n in failed else "ok"))
print("-" * 72)
print(str(len(names) - 2) + " passed, 2 failed")
"""


def build_fixture(work, rng):
    facts = {"max_connections_old": rng.randint(200, 900), "error_code": f"E-{rng.randint(1000, 9999)}",
             "fields": {f"{n}_{token(rng, 4)}": t for n, t in
                        [("order", "string"), ("amount", "number"), ("placed", "string"), ("priority", "number"), ("gift", "boolean")]}}
    facts["max_connections_new"] = facts["max_connections_old"] + rng.randint(50, 99)
    for d in ("tools", "config", "logs", "docs", "src", "out"):
        (work / d).mkdir(parents=True, exist_ok=True)
    (work / "tools/mint.py").write_text(MINT, encoding="utf-8")
    (work / "tools/dump.py").write_text(DUMP, encoding="utf-8")
    (work / "tools/run_checks.py").write_text(CHECKS, encoding="utf-8")
    (work / "config/limits.toml").write_text(
        f"[pool]\nmax_connections = {facts['max_connections_old']}\nidle_timeout_s = 30\nretry_budget = 4\n\n[queue]\ndepth = 128\n", encoding="utf-8")
    lines = [f"2026-09-01T10:{i // 60:02d}:{i % 60:02d}Z {rng.choice(LEVELS)} worker {rng.randint(1, 16)} handled batch {i}" for i in range(400)]
    lines[rng.randint(150, 350)] = f"2026-09-01T10:03:11Z ERROR {facts['error_code']} payment gateway timeout at worker 12"
    (work / "logs/app.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
    rows = "\n".join(f"| `{k}` | {v} |" for k, v in facts["fields"].items())
    (work / "docs/schema.md").write_text(
        f"# Records\n\n## Order\n\n| field | type |\n|---|---|\n{rows}\n\n## Refund\n\n| field | type |\n|---|---|\n| `refund_ref` | string |\n", encoding="utf-8")
    (work / "src/util.py").write_text(
        "import re\n\n\ndef slugify(s):\n    # TODO: unicode\n    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')\n", encoding="utf-8")
    (work / "src/pool.py").write_text("class Pool:\n    # TODO: metrics\n    def __init__(self, size):\n        self.size = size\n", encoding="utf-8")
    (work / "src/notes.txt").write_text("TODO: write notes\n", encoding="utf-8")
    return facts


PLANTS = [
    ("mint", "Run `python tools/mint.py` exactly once. Reply with one word only: ok if it exited cleanly, failed otherwise."),
    ("dump", "Run `python tools/dump.py` exactly once. Reply with only the number of `[stage` lines it printed."),
    ("stale", "Read config/limits.toml with the read tool. Reply with only the number of keys it defines across all sections."),
    ("needle", "Read logs/app.log in full with the read tool (not wc or grep). Reply with only the distinct log levels that appear, comma separated."),
    ("schema", "Read docs/schema.md. Reply with only the number of fields the Order record has."),
    ("checks", "Run `python tools/run_checks.py` exactly once. Reply with only the number of failed checks."),
]
FILLERS = [
    "List the files under src/ and reply with how many of them are Python files.",
    "What does slugify in src/util.py do? One sentence.",
    "How many TODO markers are there under src/? Reply with the number.",
]
PROBES = [
    ("mint", "Earlier you ran tools/mint.py once. What build-id did that run print? Running it again prints a different id, so that will not help. Reply with the id only."),
    ("dump", "Earlier you ran tools/dump.py once. What checkpoint token did that run print near the end? Running it again prints a different token. Reply with the token only."),
    ("stale", "config/limits.toml has been changed by someone else since you read it. Reply in the form `before=<n> now=<n>` with max_connections as it was when you first read it, and as it is now."),
    ("needle", "What was the error code on the single ERROR line of logs/app.log? Reply with the code only."),
    ("schema", "Write out/order.json: one sample Order record as a JSON object containing exactly the fields of the Order record in docs/schema.md, with values of the right types. Reply with done."),
    ("checks", "Earlier you ran tools/run_checks.py once. Which checks failed in that run? Running it again fails different ones. Reply with the two names only."),
]
REREAD_OK = {"needle", "schema"}  # looking again is a legitimate route for these; for the rest it cannot produce the answer


def planted_from_events(events_path):
    """Values that only exist in the first tool output of each command."""
    found = {}
    for line in events_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if '"tool_execution_end"' not in line:
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        text = " ".join(c.get("text", "") for c in (ev.get("result") or {}).get("content", []) if isinstance(c, dict))
        for key, rx in (("mint", r"build-id: ([0-9a-f]{12})"), ("dump", r"checkpoint token: ([0-9a-f]{12})")):
            m = re.search(rx, text)
            if m and key not in found:
                found[key] = m.group(1)
        fails = sorted(re.findall(r"(check_\w+) \.\.\. FAIL", text))  # the script source mentions "2 failed" too; only real output has FAIL lines
        if "checks" not in found and len(fails) == 2:
            found["checks"] = fails
    return found


def tool_calls_since(events_path, offset):
    names = []
    with events_path.open("rb") as f:
        f.seek(offset)
        for raw in f:
            if b'"tool_execution_start"' in raw:
                try:
                    names.append(json.loads(raw.decode("utf-8", errors="replace")).get("toolName"))
                except ValueError:
                    pass
    return names


def check(key, reply, facts, planted, work):
    r = reply or ""
    if key in ("mint", "dump"):
        return bool(planted.get(key)) and planted[key] in r
    if key == "checks":
        return bool(planted.get(key)) and set(re.findall(r"check_[a-z]+", r)) == set(planted[key])
    if key == "stale":
        m = re.search(r"before\s*=\s*(\d+).*?now\s*=\s*(\d+)", r, re.S)
        return bool(m) and (int(m.group(1)), int(m.group(2))) == (facts["max_connections_old"], facts["max_connections_new"])
    if key == "needle":
        return facts["error_code"] in r
    if key == "schema":
        try:
            obj = json.loads((work / "out/order.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        types = {"string": str, "number": (int, float), "boolean": bool}
        return isinstance(obj, dict) and set(obj) == set(facts["fields"]) and all(
            isinstance(obj[k], types[t]) and not (t == "number" and isinstance(obj[k], bool)) for k, t in facts["fields"].items())
    raise KeyError(key)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True, choices=["A", "P"])
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--work-root", default="C:/pib/chain")
    ap.add_argument("--model", default="opencode-go/deepseek-v4.1-flash")
    ap.add_argument("--thinking", default="medium")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--home", help="passed through to live_ab.PiRpc")
    ap.add_argument("--agent-dir", help="passed through to live_ab.PiRpc")
    args = ap.parse_args()

    run_dir = Path(args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(10 ** 9)
    rng = random.Random(seed)
    work = Path(args.work_root).resolve() / run_dir.parent.name / run_dir.name / "proj"
    if work.exists():
        sys.exit(f"work dir exists, pick a new run dir: {work}")
    facts = build_fixture(work, rng)
    (work / ".pi").mkdir()
    (work / ".pi/settings.json").write_text(json.dumps({"packages": [  # keep the user-wide pruner out of every arm; P loads its own copy
        {"source": live_ab.PRUNER_SOURCE, "extensions": [], "skills": [], "prompts": [], "themes": []}]}, indent=1), encoding="utf-8")
    exts = live_ab.ARMS[args.arm][0]
    run = {"arm": args.arm, "model": args.model, "thinking": args.thinking, "seed": seed, "work": str(work), "facts": facts,
           "extensions": [str(e) for e in exts], "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "chains": {}}
    events = run_dir / "rpc.jsonl"
    rpc = live_ab.PiRpc(work, run_dir / "sessions", args, run_dir, exts, approve=True)

    def ask(ident, text):
        offset = events.stat().st_size
        rpc.prompt_and_settle(ident, text, args.timeout)
        reply = rpc.command("get_last_assistant_text", ident + "-text").get("text")
        return reply, tool_calls_since(events, offset)

    try:
        for key, text in PLANTS:
            reply, calls = ask(f"plant-{key}", text)
            run["chains"][key] = {"plant_reply": reply, "plant_calls": calls}
        planted = planted_from_events(events)
        run["planted"] = planted
        for key, value in planted.items():  # a plant reply that repeats the value keeps it in context regardless of pruning
            vals = value if isinstance(value, list) else [value]
            run["chains"][key]["leaked"] = any(v in (run["chains"][key]["plant_reply"] or "") for v in vals)
        limits = work / "config/limits.toml"
        limits.write_text(limits.read_text(encoding="utf-8").replace(
            f"max_connections = {facts['max_connections_old']}", f"max_connections = {facts['max_connections_new']}"), encoding="utf-8")
        for n, text in enumerate(FILLERS, 1):
            ask(f"filler-{n}", text)
        for key, text in PROBES:
            reply, calls = ask(f"probe-{key}", text)
            c = run["chains"][key]
            c.update({"probe_reply": reply, "probe_calls": calls, "correct": check(key, reply, facts, planted, work),
                      "queried": calls.count("context_tree_query"), "other_calls": len([x for x in calls if x != "context_tree_query"]),
                      "reread_ok": key in REREAD_OK})
            print(f"[{args.arm}] {key}: correct={c['correct']} query={c['queried']} other_calls={c['other_calls']} leaked={c.get('leaked', False)}", flush=True)
            (run_dir / "run.json").write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
        run["sessionFile"] = rpc.command("get_state", "state1").get("sessionFile")
    finally:
        rpc.close()
        run["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        done = [c for c in run["chains"].values() if "correct" in c]
        run["score"] = {"correct": sum(c["correct"] for c in done), "total": len(done),
                        "original_only_correct": sum(c["correct"] for c in done if not c["reread_ok"]),
                        "original_only_total": sum(1 for c in done if not c["reread_ok"])}
        (run_dir / "run.json").write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[{args.arm}] {run['score']}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
