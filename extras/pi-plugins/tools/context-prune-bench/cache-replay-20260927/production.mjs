// Offline reconstruction. No network, model call, or raw transcript output.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const ai = path.join(root, 'node_modules/@earendil-works/pi-ai/dist');
const { buildSessionContext } = await import(pathToFileURL(path.join(root, 'dist/core/session-manager.js')));
const { convertResponsesMessages } = await import(pathToFileURL(path.join(ai, 'api/openai-responses-shared.js')));
const { normalizeContext } = await import(pathToFileURL(path.join(ai, 'utils/transcript.js')));
const source = path.join(process.env.USERPROFILE, '.pi/agent/sessions/--E--ControlPlane-control_0827--/2026-09-26T18-08-52-258Z_01a0dee7-dc22-7535-9491-f9853120a421.jsonl');
const diag = path.join(process.env.USERPROFILE, '.pi/agent/logs/payload-cache-diag.jsonl');
const parse = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const entries = parse(source);
const logs = parse(diag).filter(r => r.session === '01a0dee7-dc22-7535-9491-f9853120a421');
const model = { id: 'gpt-6-astra', api: 'openai-codex-responses', provider: 'openai-codex', input: ['text', 'image'], reasoning: true };
const eligible = input => input.flatMap((m, i) => {
  if (m.type === 'function_call_output') return input[i+1]?.type === 'function_call_output' ? [] : [i];
  return m.role === 'user' ? [i] : [];
});
const sha = v => createHash('sha256').update(v).digest('hex');
const cuts = [];
for (let n = 0; n < entries.length; n++) {
  const e = entries[n];
  if (e.customType !== 'context-prune-lab-event' || e.data?.event !== 'apply') continue;
  const refs = new Map();
  for (const past of entries.slice(0, n)) if (past.customType === 'context-prune-index') {
    for (const ref of past.data.refs ?? []) refs.set(ref.toolCallId, ref.shortId);
  }
  const context = buildSessionContext(entries.slice(0, n + 1));
  const messages = context.messages.map(m => m.role === 'toolResult' && refs.has(m.toolCallId)
    ? { ...m, content: [{ type: 'text', text: `[pruned:${refs.get(m.toolCallId)}]` }] } : m);
  const input = convertResponsesMessages(model, normalizeContext({ messages }), new Set(['openai-codex']), { includeSystemPrompt: false });
  const time = Date.parse(e.timestamp);
  const at = logs.findIndex(r => r.kind === 'request' && Date.parse(r.time) >= time && Date.parse(r.time) - time < 2000);
  if (at < 0) continue;
  const q = logs[at];
  const u = logs.slice(at+1).find(r => r.kind === 'usage');
  const previous = logs.slice(0,at).findLast(r => r.kind === 'usage');
  const callIds = new Set(e.data.candidateToolCallIds.map(id => id.split('|')[0]));
  const first = input.findIndex(m => m.type === 'function_call_output' && callIds.has(m.call_id));
  const firstOriginal = entries.slice(0,n).find(x => x.message?.role === 'toolResult' && callIds.has(x.message.toolCallId.split('|')[0]));
  const issuing = firstOriginal && entries.slice(0,n).find(x => x.id === firstOriginal.parentId);
  const sizes = input.map(m => JSON.stringify(m).length);
  cuts.push({ line: n+1, time: e.timestamp, userTurn: e.data.userTurn, netEstimate: e.data.netTokens,
    candidateCount: callIds.size, actual: { items: q.items, firstDiff: q.firstDiff, charsBeforeDiff: q.charsBeforeDiff, totalChars: q.totalChars,
      instructionsSame:q.instructionsSame, toolsSame:q.toolsSame, restSame:q.restSame },
    reconstruction: { items: input.length, firstChangedTool: first, charsBeforeFirst:sizes.slice(0,first).reduce((a,b)=>a+b,0),
      totalChars:sizes.reduce((a,b)=>a+b,0), eligibleEndingsFromFirst:eligible(input).filter(i=>i>=first).length,
      shapeAligned:input.length===q.items && first===q.firstDiff },
    firstResultTime:firstOriginal?.timestamp, firstResultAgeSec:firstOriginal ? (time-Date.parse(firstOriginal.timestamp))/1000 : null,
    issuingInput:issuing?.message?.usage?.input, issuingCache:issuing?.message?.usage?.cacheRead,
    beforeCache:previous?.cacheRead, input:u?.input, cacheRead:u?.cacheRead,
    usageTime:u?.time, beforeTransport:q.transportBefore, afterTransport:u?.transportAfter });
}
const out = path.resolve('test-results/cache-replay-20260927');
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'production-audit.json'),JSON.stringify({source, sourceSha256:sha(fs.readFileSync(source)),diag,
  limitations:['Reconstructed input excludes unrecoverable historical extension mutations and generated instructions/tools.',
    'Eligible-message counts are a hypothesis from public API documentation, not a confirmed subscription-backend rule.',
    'netEstimate is plugin estimated release, not provider token usage.'],cuts},null,2));
console.log(JSON.stringify(cuts.map(c=>({line:c.line,time:c.time,hit:c.cacheRead,input:c.input,age:c.firstResultAgeSec,
  exactShape:c.reconstruction.shapeAligned,actualItems:c.actual.items,reconstructed:c.reconstruction.items,
  actualFirst:c.actual.firstDiff,reconstructedFirst:c.reconstruction.firstChangedTool,endings:c.reconstruction.eligibleEndingsFromFirst}))));
