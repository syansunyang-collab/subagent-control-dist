"""Drive cache_lab.mjs through three probes on the Codex backend and write <out>/lab.jsonl.

A  rounds back: 40 fast tool rounds (one `cat` per call); requests 10, 14, ... 38 stub the tool output
   3, 6, 9, 12, 15, 18, 21, 25 rounds back. All rounds are seconds apart, so only the count varies.
B  accepted fields, one short request each: explicit breakpoint mode (breakpoint on the first user
   message), prompt_cache_options.ttl 30m, max_output_tokens 16, prompt_cache_retention 24h.
C  age: after 3, 8, 15 and 30 more idle minutes, one request stubs an output 3, 5, 7, 9 rounds back,
   each a boundary no earlier request reused.

Usage: python cache_lab_run.py <out dir> [--model gpt-6-luna] [--skip-c]
"""
import json
import os
import random
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
out = os.path.abspath(sys.argv[1])
model = sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else "gpt-6-luna"
work = os.path.join(out, "work")
os.makedirs(work, exist_ok=True)
random.seed(11)
words = "alpha beta gamma delta epsilon zeta theta kappa lambda sigma omega river stone cloud ember maple".split()
for i in range(1, 41):
    with open(os.path.join(work, f"f{i:02d}.txt"), "w") as fh:
        fh.write("\n".join(f"{i:02d}-{n:03d} " + " ".join(random.choice(words) for _ in range(12)) for n in range(70)) + "\n")

schedule = [[10 + 4 * j, back] for j, back in enumerate([3, 6, 9, 12, 15, 18, 21, 25])]
cmd = ["node", os.path.join(HERE, "cache_lab.mjs"), "--out", out, "--provider", "openai-codex", "--model", model,
       "--thinking", "low", "--schedule", json.dumps(schedule)]
p = subprocess.Popen(cmd, cwd=work, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(out, "stderr.txt"), "w"),
                     text=True, encoding="utf-8", errors="replace", bufsize=1)
settled = threading.Event()


def read():
    with open(os.path.join(out, "rpc.jsonl"), "w", encoding="utf-8") as log:
        for line in p.stdout:
            log.write(line)
            log.flush()
            if '"agent_settled"' in line:
                settled.set()


threading.Thread(target=read, daemon=True).start()


def note(text):
    with open(os.path.join(out, "driver.log"), "a", encoding="utf-8") as fh:
        fh.write(time.strftime("%H:%M:%S ") + text + "\n")


def prompt(message, nxt=None, timeout=900):
    if nxt:
        with open(os.path.join(out, "next.json"), "w") as fh:
            json.dump(nxt, fh)
    settled.clear()
    p.stdin.write(json.dumps({"type": "prompt", "id": str(time.time()), "message": message}) + "\n")
    p.stdin.flush()
    note(f"prompt {message[:40]!r} next={nxt} settled={settled.wait(timeout)}")


prompt("Process f01.txt through f40.txt in order. For EACH file make exactly one separate bash call `cat fNN.txt` "
       "(one file per call, never batch, never parallel) and after each result state its first word in a few words "
       "before the next call. After f40 reply DONE.", timeout=1800)
prompt("Reply with just OK.", {"extra": {"prompt_cache_options": {"mode": "explicit"}}, "breakpointOnFirstUser": True})
prompt("Reply with just OK.", {"extra": {"prompt_cache_options": {"ttl": "30m"}}})
prompt("Write the numbers 1 to 200 separated by spaces.", {"extra": {"max_output_tokens": 16}})
prompt("Reply with just OK.", {"extra": {"prompt_cache_retention": "24h"}})
if "--skip-c" not in sys.argv:
    for wait, back in [(3, 3), (8, 5), (15, 7), (30, 9)]:
        note(f"idle {wait} min")
        time.sleep(wait * 60)
        prompt("Reply with just OK.", {"back": back})
p.stdin.close()
try:
    p.wait(30)
except subprocess.TimeoutExpired:
    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"])
note("done")
