# Pi 0.99.1 isolated host patches

The 0.99.1 manifests select separate payloads for WS recovery, Codex attribution (including WS recovery), and the prompt-stability host overlay. The 0.87.1 manifests, payloads and rollback backups remain in their original locations. This procedure changes an isolated installation only; it does not deploy extensions or restart production processes.

## Inputs and build

Fixed upstream: `v0.99.1`, commit `d86654abb8862e201933517d6f1fce9f88dd117f`. The offline source archive is `tmp/pi-upstream-review-20260930/pi-0.99.1`; keep that download baseline unchanged. Start with a pristine **real npm 0.99.1 installation**, including its nested dependencies, under `tmp/pi-0991-upgrade/runtime/`. Package version substitution is not a build input.

Start with an empty `tmp/pi-0991-host-build` directory. From the repository root, copy the fixed source into it, then initialize that directory as its own Git repository. Git otherwise silently skips patches when this ignored directory is inside the parent repository. Run the following in PowerShell, before applying anything to the pristine npm installation:

```powershell
$root = 'E:/Pi_Coding_Agent/tmp/pi-0991-upgrade/runtime/node_modules/@earendil-works/pi-coding-agent'
$npm = 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js'
New-Item -ItemType Directory -Force tmp/pi-0991-host-build | Out-Null
Copy-Item tmp/pi-upstream-review-20260930/pi-0.99.1/* tmp/pi-0991-host-build -Recurse -Force
Get-ChildItem tmp/pi-upstream-review-20260930/pi-0.99.1 -Force | Where-Object { $_.Name.StartsWith('.') } | Copy-Item -Destination tmp/pi-0991-host-build -Recurse -Force
git -C tmp/pi-0991-host-build init
python -B tools/pi-codex-attribution/package-0991.py baseline --root $root
Push-Location tmp/pi-0991-host-build
node $npm ci --include=dev --ignore-scripts --cache E:/Pi_Coding_Agent/tmp/pi-0991-host-build/.npm-cache
git -c core.autocrlf=false apply --ignore-space-change ../../tools/pi-ws-recovery/pi-ai-ws-recovery-0.99.1.patch
node $npm run build:offline
Pop-Location
python -B tools/pi-codex-attribution/package-0991.py ws
Push-Location tmp/pi-0991-host-build
git -c core.autocrlf=false apply --reverse --ignore-space-change ../../tools/pi-ws-recovery/pi-ai-ws-recovery-0.99.1.patch
git -c core.autocrlf=false apply --ignore-space-change ../../tools/pi-codex-attribution/pi-0.99.1-attribution.patch
git -c core.autocrlf=false apply --ignore-space-change ../../tools/pi-codex-attribution/ws-recovery-0.99.1-after-attribution.patch
node $npm run build:offline
Pop-Location
python -B tools/pi-codex-attribution/package-0991.py attribution
Push-Location tmp/pi-0991-host-build
git -c core.autocrlf=false apply --ignore-space-change ../../tools/pi-prompt-stability/pi-0.99.1-custom-run-preparation.patch
git -c core.autocrlf=false apply --ignore-space-change ../../tools/pi-prompt-stability/pi-0.99.1-context-usage.patch
node $npm run build:offline
Pop-Location
python -B tools/pi-codex-attribution/package-0991.py prompt
python -B tools/pi-codex-attribution/package-0991.py package
```

The baseline snapshot also copies the actual release's model-data directory into the source build. `build:offline` validates that data and avoids live model-catalog regeneration. Each npm build compiles the SDK and rebuilds the official CLI/RPC bundle. Compare generated hashes before distributing new payloads; the manifests are build-specific.

The packager writes `manifest-0.99.1.json` in each tool directory, `.runtime/pi-codex-attribution/0.99.1/{payload.json.gz,ws-payload.json.gz}`, and `.runtime/pi-prompt-stability/0.99.1/host-payload.json.gz`. Replaced chunks are retained until rollback, so each overlay removes only the files it added.

## Isolated application and rollback

Confirm `$root/package.json` says 0.99.1 and both `node_modules/@earendil-works/{pi-ai,pi-agent-core}` exist. Check the untouched installation before application:

```powershell
python -B tools/pi-codex-attribution/manage.py status --root $root
python -B tools/pi-codex-attribution/manage.py apply --root $root
python -B tools/pi-prompt-stability/manage.py apply --root $root --host-only
python -B tools/pi-codex-attribution/manage.py status --root $root
python -B tools/pi-prompt-stability/manage.py status --root $root --host-only
node tools/pi-ws-recovery/manage-pi-ws-recovery.mjs status --bundle-target "candidate=$root" --target "candidate-ai=$root/node_modules/@earendil-works/pi-ai" --json
```

Expected final attribution state: `patched+prompt-stability`; prompt host and both WS targets: `patched`. Do not apply the standalone WS payload before attribution: attribution's baseline is the pristine release, while its payload already includes WS recovery. Standalone WS application/rollback remains available with the explicit two targets above.

Roll back in reverse overlay order:

```powershell
python -B tools/pi-prompt-stability/manage.py rollback --root $root --host-only
python -B tools/pi-codex-attribution/manage.py rollback --root $root
```

Backups for 0.99.1 are version- and installation-keyed. Existing 0.87.1 command defaults and backup paths remain valid. New-version host operations use no extension entries; production user extensions remain outside this migration.

## Offline acceptance

`pi-0.99.1-context-usage.patch` 保留已测量前缀的用量，仅重新估算其后的编辑消息；编辑已测量前缀或压缩历史仍会使旧用量失效。回归覆盖取消与失败请求的空消息删除、尾部编辑、前缀编辑和压缩。

```powershell
$env:PI_TEST_PACKAGE_ROOT = $root
node --test tests/pi/projected_context_usage.test.mjs
Remove-Item Env:PI_TEST_PACKAGE_ROOT
python -B tests/pi/run_0991_host_verification.py --root $root
python -B tools/pi-codex-attribution/prepare-installed-tests.py --root $root
Push-Location tmp/pi-0991-host-build/packages/ai
node ../../node_modules/vitest/vitest.mjs run test/installed-openai-codex-attribution.test.ts test/installed-openai-codex-stream.test.ts test/installed-openai-compatible-codex-attribution.test.ts
Pop-Location
```

The runner checks required test files before changing the candidate and rejects core suites with zero passing tests, including all-skipped suites. It exercises real npm files: standalone WS and combined-overlay lifecycle, idempotence, unknown-content refusal, SDK and bundle identities, turn-state, success/failure/cancel compaction windows, named sections and custom wakes, preparation cancellation with zero provider calls in both SDK and bundle, offline WS/SSE recovery and 1009 gating, and a local RPC `get_state`. It leaves the candidate fully patched and writes command/exit-code logs under `test-results/pi-0991-upgrade/host/`. Settings, sessions and credentials are in memory or isolated scratch directories. The fixtures make no external model requests.

This coverage establishes protocol and host behavior, not cache-hit improvement, token-cost savings, live OAuth compatibility, or Web integration. Those require separate authorized validation.
