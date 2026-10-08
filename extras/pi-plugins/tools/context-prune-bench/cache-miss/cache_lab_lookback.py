"""Probe how far back the Codex backend reuses a prefix that exists only inside a later request.

40 fast tool rounds. From request 20 on, output #4 is stubbed in every request, so every request end written
before request 20 no longer matches the prefix. Requests 24, 28, 32, 36 and 40 additionally stub output #18, #15,
#12, #9 and #6 once. Any reuse between output #4 and the edited output can only come from inside a request made
at or after request 20; the logged endingsAfterEdit gives the distance in message endings.

Usage: python cache_lab_lookback.py <out dir> [--model gpt-6-luna]
"""
import json, os, random, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
out = os.path.abspath(sys.argv[1])
model = sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else "gpt-6-luna"
work = os.path.join(out, "work")
os.makedirs(work, exist_ok=True)
random.seed(13)
words = "alpha beta gamma delta epsilon zeta theta kappa lambda sigma omega river stone cloud ember maple".split()
for i in range(1, 41):
    with open(os.path.join(work, f"f{i:02d}.txt"), "w") as fh:
        fh.write("\n".join(f"{i:02d}-{n:03d} " + " ".join(random.choice(words) for _ in range(12)) for n in range(70)) + "\n")
cmd = ["node", os.path.join(HERE, "cache_lab.mjs"), "--out", out, "--provider", "openai-codex", "--model", model,
       "--thinking", "low", "--persist", json.dumps([[20, 4]]),
       "--once", json.dumps([[24, 18], [28, 15], [32, 12], [36, 9], [40, 6]])]
p = subprocess.Popen(cmd, cwd=work, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(out, "stderr.txt"), "w"),
                     text=True, encoding="utf-8", errors="replace", bufsize=1)
settled = threading.Event()
def read():
    with open(os.path.join(out, "rpc.jsonl"), "w", encoding="utf-8") as log:
        for line in p.stdout:
            log.write(line)
            if '"agent_settled"' in line:
                settled.set()
threading.Thread(target=read, daemon=True).start()
p.stdin.write(json.dumps({"type": "prompt", "id": "1", "message": (
    "Process f01.txt through f40.txt in order. For EACH file make exactly one separate bash call `cat fNN.txt` "
    "(one file per call, never batch, never parallel) and after each result state its first word in a few words "
    "before the next call. After f40 reply DONE.")}) + "\n")
p.stdin.flush()
print("settled", settled.wait(1800))
time.sleep(2)
p.stdin.close()
try:
    p.wait(30)
except subprocess.TimeoutExpired:
    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"])
