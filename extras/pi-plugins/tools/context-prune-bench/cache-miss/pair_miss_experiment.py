"""Reproduce the second full miss after a context-prune apply (summary relocation, Pi >= 0.87.1).

Runs an isolated Pi RPC process that loads only the production context-prune package and the
payload-cache-diag extension, on gpt-6-luna, with the production policy-lab.json. The agent cats
twelve ~3.5K-token files one per turn, so budget-summary (trigger 6000, keep 2 turns) prepares
and applies at least once. The process gets HOME=<scratch>/home with a copy of the production
policy-lab.json whose triggerTokens is 6000 (the plugin reads $HOME first; Pi's own agent dir
follows USERPROFILE and is unchanged). Prints the diag timeline merged with the plugin's lab events.

Usage: python pair_miss_experiment.py <scratch dir>
Expected: the apply request has firstDiff at a stubbed function_call_output; the request right
after it has appendOnly=false with firstDiff at the position where the summary had been injected.
"""
import glob
import json
import os
import random
import subprocess
import sys
import threading
import time

HOME = os.path.expanduser("~")
DIAG_LOG = os.path.join(HOME, ".pi/agent/logs/payload-cache-diag.jsonl")


def make_files(work):
    random.seed(7)
    words = ("alpha beta gamma delta epsilon zeta theta kappa lambda sigma omega river stone cloud "
             "ember maple cedar harbor lantern meadow").split()
    for i in range(1, 13):
        lines = [f"{i:02d}-{n:04d} " + " ".join(random.choice(words) for _ in range(14)) for n in range(160)]
        with open(os.path.join(work, f"f{i:02d}.txt"), "w") as fh:
            fh.write("\n".join(lines) + "\n")


def run(root):
    work, sessions = os.path.join(root, "work"), os.path.join(root, "sessions")
    os.makedirs(work, exist_ok=True)
    os.makedirs(sessions, exist_ok=True)
    make_files(work)
    home = os.path.join(root, "home")
    config_dir = os.path.join(home, ".pi", "agent", "context-prune")
    os.makedirs(config_dir, exist_ok=True)
    with open(os.path.join(HOME, ".pi/agent/context-prune/policy-lab.json"), encoding="utf-8") as fh:
        config = json.load(fh)
    config["triggerTokens"] = 6000
    with open(os.path.join(config_dir, "policy-lab.json"), "w", encoding="utf-8") as fh:
        json.dump(config, fh, indent=2)
    cmd = [os.path.expandvars(r"%APPDATA%\npm\pi.cmd"), "--mode", "rpc", "--session-dir", sessions,
           "--provider", "openai-codex", "--model", "gpt-6-luna", "--thinking", "low", "--tools", "bash",
           "--no-extensions",
           "-e", HOME + "/.pi/agent/local-packages/pi-context-prune",
           "-e", HOME + "/.pi/agent/extensions/payload-cache-diag.ts"]
    p = subprocess.Popen(cmd, cwd=work, env={**os.environ, "HOME": home}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, encoding="utf-8", errors="replace", bufsize=1)
    settled = threading.Event()

    def read():
        with open(os.path.join(root, "rpc.jsonl"), "w", encoding="utf-8") as log:
            for line in p.stdout:
                log.write(line)
                if '"agent_settled"' in line:
                    settled.set()

    threading.Thread(target=read, daemon=True).start()
    msg = ("Process files f01.txt through f12.txt in order. For EACH file make exactly one separate bash tool call "
           "`cat fNN.txt` (one file per call, never batch, never parallel), and after each result state the file's "
           "first word in one short sentence before the next call. After f12, reply DONE.")
    p.stdin.write(json.dumps({"type": "prompt", "id": "1", "message": msg}) + "\n")
    p.stdin.flush()
    print("settled", settled.wait(600))
    time.sleep(2)
    p.stdin.close()
    try:
        p.wait(20)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"])
    return glob.glob(os.path.join(sessions, "*.jsonl"))[0]


def timeline(session_file):
    entries = [json.loads(line) for line in open(session_file, encoding="utf-8")]
    sid = entries[0]["id"]
    events = []
    for line in open(DIAG_LOG, encoding="utf-8"):
        d = json.loads(line)
        if d["session"] != sid:
            continue
        if d["kind"] == "request":
            text = (f"REQ items={d['items']} firstDiff={d['firstDiff']} appendOnly={d['appendOnly']} "
                    f"{d['diffItemType']} instructionsSame={d['instructionsSame']} toolsSame={d['toolsSame']}")
        else:
            text = f"    usage input={d['input']} cacheRead={d['cacheRead']}"
        events.append((d["time"], text))
    for e in entries:
        d = e.get("data") or {}
        if e.get("customType") == "context-prune-lab-event":
            events.append((e["timestamp"], f"  >> {d.get('event')} phase={d.get('phase')} "
                                           f"n={len(d.get('candidateToolCallIds') or [])} net={d.get('netTokens')}"
                                           + (f" config={d['config']}" if d.get("config") else "")))
        elif e.get("type") == "custom_message":
            events.append((e["timestamp"], f"  >> custom_message {e.get('customType')}"))
    for t, text in sorted(events):
        print(t[11:23], text)


if __name__ == "__main__":
    timeline(run(sys.argv[1]))
