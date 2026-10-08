// Maintains the two-file diagnostic extension without changing Pi settings or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(source, '../..');
const target = path.join(homedir(), '.pi/agent/extensions');
const files = ['payload-cache-diag.ts', 'cache-wire-observer.mjs'];
const recordFile = path.join(repo, 'runs/native-pi-runtime-20260813/cache-wire-xai-20260928.json');
const digest = file => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const status = () => files.map(name => ({ name, source: digest(path.join(source, name)), installed: digest(path.join(target, name)) }));
const action = process.argv[2] ?? 'status';

if (action === 'install') {
  const before = status();
  if (before.every(row => row.source === row.installed)) {
    console.log(JSON.stringify({ status: 'already-installed', files: before }));
  } else {
    const backup = path.join(repo, '.runtime/cache-wire-observer', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backup, { recursive: true });
    for (const row of before) if (row.installed) fs.copyFileSync(path.join(target, row.name), path.join(backup, row.name));
    const record = { status: 'planned', at: new Date().toISOString(), target, backup, files: before,
      scope: 'Codex and xAI Responses transport fingerprints and usage only; no new model requests, settings or credentials changes.',
      tests: ['node --test tests/pi/cache_wire_observer.test.mjs', 'formal SDK reload test with --wire'],
      lifecycle: 'Requires extension reload; observer is a process singleton, existing observer code updates require host restart.' };
    // Inventory precedes the first user-level file change.
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n');
    for (const name of files) fs.copyFileSync(path.join(source, name), path.join(target, name));
    record.status = 'installed-awaiting-load';
    record.after = status();
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify({ status: record.status, files: record.after }));
  }
} else if (action === 'rollback') {
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  if (record.status === 'rolled-back') {
    console.log(JSON.stringify({ status: record.status }));
  } else {
    // The planned inventory already contains before and intended-source hashes, even if copy failed.
    for (const row of record.files) {
      const actual = digest(path.join(target, row.name));
      if (actual !== row.installed && actual !== row.source) throw new Error(`Installed ${row.name} changed since this deployment`);
    }
    for (const row of record.files) {
      const destination = path.join(target, row.name);
      if (digest(destination) === row.installed) continue;
      if (row.installed) fs.copyFileSync(path.join(record.backup, row.name), destination);
      else fs.unlinkSync(destination);
    }
    record.status = 'rolled-back';
    record.rolledBackAt = new Date().toISOString();
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify({ status: record.status, files: status() }));
  }
} else if (action === 'status') {
  console.log(JSON.stringify({ files: status() }));
} else {
  throw new Error('Usage: node manage-cache-diag.mjs status|install|rollback');
}
