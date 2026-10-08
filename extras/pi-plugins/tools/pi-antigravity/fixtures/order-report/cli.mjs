import fs from 'node:fs';
import { summarize } from './src/report.mjs';

const args = process.argv.slice(2);
const input = args[0];
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const orders = JSON.parse(fs.readFileSync(input, 'utf8'));
const report = summarize(orders);
const output = JSON.stringify(report, null, 2) + '\n';
const out = option('--out');
if (out) fs.writeFileSync(out, output);
else process.stdout.write(output);
