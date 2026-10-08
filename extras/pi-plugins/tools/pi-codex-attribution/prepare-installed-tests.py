"""Reuse attribution protocol fixtures against the actual installed provider, not TS source."""
import argparse
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, required=True)
args = parser.parse_args()
build = PROJECT / "tmp/pi-0991-host-build"
root = args.root.resolve() / "node_modules/@earendil-works/pi-ai/dist"
for name in ["openai-codex-attribution", "openai-codex-stream", "openai-compatible-codex-attribution"]:
    source = (build / f"packages/ai/test/{name}.test.ts").read_text(encoding="utf-8")
    # Every direct runtime import from ai/src is routed to the npm candidate dist.
    import re
    source = re.sub(r'"\.\./src/([^"\n]+)\.ts"', lambda m: '"' + (root / (m[1] + ".js")).as_uri() + '"', source)
    destination = build / f"packages/ai/test/installed-{name}.test.ts"
    destination.write_text(source, encoding="utf-8", newline="\n")
    print(destination)
