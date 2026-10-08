"""管理已验收的 Windows helper 与前端源码安装、状态和回滚。"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import psutil

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['apply', 'status', 'rollback'])
parser.add_argument('--candidate', type=Path)
parser.add_argument('--frontend-candidate', type=Path)
parser.add_argument('--record', type=Path, required=True)
parser.add_argument('--patch', type=Path, default=Path(__file__).with_name('native.patch'))
parser.add_argument('--agent-home', type=Path, default=Path.home() / '.pi' / 'agent')
args = parser.parse_args()
home = args.agent_home.resolve()
package = home / 'npm/node_modules/@injaneity/pi-computer-use'
crate = package / 'native/windows/bridge-rs'
runtime = home / 'helpers/pi-computer-use/windows-bridge.exe'
bundled = package / 'prebuilt/windows/windows-bridge.exe'
record_path = args.record.resolve()
patch = args.patch.resolve()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(record):
    record_path.parent.mkdir(parents=True, exist_ok=True)
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def stop_installed_helpers():
    stopped = []
    for process in psutil.process_iter(['name', 'exe', 'create_time']):
        if (process.info['name'] or '').lower() != 'windows-bridge.exe':
            continue
        if not process.info['exe'] or Path(process.info['exe']).resolve() != runtime:
            continue
        identity = {'pid': process.pid, 'createdAt': process.info['create_time'], 'exe': process.info['exe']}
        process.terminate()
        process.wait(timeout=10)
        stopped.append(identity)
    return stopped


if args.action == 'status':
    record = json.loads(record_path.read_text(encoding='utf-8'))
    rolled_back = record['status'] in ('rolled-back-awaiting-fresh-session',
                                       'rolled-back-awaiting-host-restart')
    states = []
    for item in record['files']:
        actual = digest(item['path']) if Path(item['path']).is_file() else None
        expected = item['before'] if rolled_back else item['after']
        states.append({'path': item['path'], 'sha256': actual,
                       'matchesDeployment': actual == item['after'],
                       'matchesExpectedState': actual == expected,
                       'actualState': ('after' if actual == item['after'] else
                                       'before' if actual == item['before'] else
                                       'missing' if actual is None else 'drifted')})
    print(json.dumps({'recordStatus': record['status'], 'files': states,
                     'settingsUnchangedSinceApply': digest(home / 'settings.json') == record['settingsBefore']},
                    ensure_ascii=False, indent=2))
    raise SystemExit(0 if all(state['matchesExpectedState'] for state in states) else 1)

if args.action == 'rollback':
    record = json.loads(record_path.read_text(encoding='utf-8'))
    for item in record['files']:
        if digest(item['path']) not in (item['before'], item['after']):
            raise RuntimeError('安装文件已有后续变更，停止回滚：' + item['path'])
        if digest(item['backup']) != item['before']:
            raise RuntimeError('备份哈希不匹配：' + item['backup'])
    stopped = [] if record.get('frontendOnly') else stop_installed_helpers()
    for item in record['files']:
        shutil.copy2(item['backup'], item['path'])
        assert digest(item['path']) == item['before']
    record['status'] = ('rolled-back-awaiting-fresh-session' if record.get('frontendOnly')
                        else 'rolled-back-awaiting-host-restart')
    record['rollbackStoppedHelpers'] = stopped
    save(record)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    raise SystemExit(0)

if (args.candidate is None) == (args.frontend_candidate is None):
    parser.error('apply 需要且只能指定 --candidate 或 --frontend-candidate')
if record_path.exists():
    parser.error('部署记录已存在；使用新的 --record 路径')
if json.loads((package / 'package.json').read_text(encoding='utf-8'))['version'] != '0.5.1':
    raise RuntimeError('仅支持已验收的 pi-computer-use 0.5.1')
frontend_only = args.frontend_candidate is not None
candidate = (args.frontend_candidate if frontend_only else args.candidate).resolve()
if frontend_only:
    build = json.loads((candidate / 'frontend-build.json').read_text(encoding='utf-8'))
    for relative, expected in build['sourceHashes'].items():
        if digest(package / relative) != expected:
            raise RuntimeError('安装前端源码已偏离构建基线：' + relative)
        if digest(candidate / relative) != build['candidateHashes'][relative]:
            raise RuntimeError('候选前端源码与构建记录不一致：' + relative)
    changes = [(package / relative, candidate / relative) for relative in build['sourceHashes']]
else:
    build = json.loads((candidate / 'candidate-build.json').read_text(encoding='utf-8'))
    if digest(patch) != build['patchSha256']:
        raise RuntimeError('补丁与候选构建记录不一致')
    for relative, expected in build['sourceHashes'].items():
        if digest(crate / relative) != expected:
            raise RuntimeError('安装源码已偏离构建基线：' + relative)
    binary = candidate / 'target/release/windows-bridge.exe'
    if digest(binary) != build['candidateSha256']:
        raise RuntimeError('候选 binary 与构建记录不一致')
    relative_paths = [line.split(' b/', 1)[1] for line in patch.read_text(encoding='utf-8').splitlines()
                      if line.startswith('diff --git ')]
    for relative in relative_paths:
        if digest(candidate / relative) != build['candidateHashes'][relative]:
            raise RuntimeError('候选原生源码与构建记录不一致：' + relative)
    changes = [(crate / relative, candidate / relative) for relative in relative_paths]
    changes.extend([(bundled, binary), (runtime, binary)])
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
backup = home / 'state/deploy' / ('pi-computer-use-qt-' + now.strftime('%Y%m%d-%H%M%S'))
backup.mkdir(parents=True, exist_ok=False)
files = []
for index, (destination, source) in enumerate(changes):
    saved = backup / f'{index:02d}-{destination.name}'
    shutil.copy2(destination, saved)
    files.append({'path': str(destination), 'source': str(source), 'backup': str(saved),
                  'before': digest(destination), 'after': digest(source)})
shutil.copy2(home / 'settings.json', backup / 'settings.json.snapshot')
shutil.copy2(package / 'package.json', backup / 'package.json.snapshot')
if frontend_only:
    shutil.copy2(candidate / 'frontend-build.json', backup / 'frontend-build.json')
else:
    shutil.copy2(patch, backup / 'native.patch')
    shutil.copy2(binary, backup / 'candidate-windows-bridge.exe')
record = {'recordedAt': now.isoformat(), 'status': 'backed-up-before-apply', 'packageVersion': '0.5.1',
          'candidateDirectory': str(candidate), 'frontendOnly': frontend_only,
          'candidateSha256': build.get('candidateSha256'), 'patchSha256': build.get('patchSha256'),
          'backupPath': str(backup), 'settingsBefore': digest(home / 'settings.json'), 'files': files}
save(record)
record['stoppedHelpers'] = [] if frontend_only else stop_installed_helpers()
for destination, source in (changes if frontend_only else changes[:-1]):
    shutil.copy2(source, destination)
if not frontend_only:
    subprocess.run(['node', str(package / 'scripts/setup-helper.mjs'), '--platform', 'windows', '--runtime'],
                   env={**os.environ, 'PI_COMPUTER_USE_WINDOWS_HELPER_PATH': str(runtime)}, check=True)
for item in files:
    assert digest(item['path']) == item['after'], item['path']
assert digest(home / 'settings.json') == record['settingsBefore']
record['status'] = 'installed-awaiting-fresh-session' if frontend_only else 'installed-awaiting-host-restart'
save(record)
print(json.dumps(record, ensure_ascii=False, indent=2))
