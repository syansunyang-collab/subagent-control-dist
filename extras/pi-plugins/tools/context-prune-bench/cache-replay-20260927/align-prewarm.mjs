// Offline alignment of two production cuts. No model request or production mutation.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root=path.join(process.env.APPDATA,'npm/node_modules/@earendil-works/pi-coding-agent');
const { buildSessionContext }=await import(pathToFileURL(path.join(root,'dist/core/session-manager.js')));
const { normalizeContext }=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-ai/dist/utils/transcript.js')));
const { convertResponsesMessages }=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js')));
const { collectLabToolTurns, toolResultIds }=await import(pathToFileURL(path.resolve('tmp/context-prune-pause-fix/dist/lab-exports.js')));
const source=path.join(process.env.USERPROFILE,'.pi/agent/sessions/--E--ControlPlane-control_0827--/2026-09-26T18-08-52-258Z_01a0dee7-dc22-7535-9491-f9853120a421.jsonl');
const bytes=fs.readFileSync(source);
const rows=bytes.toString('utf8').trim().split('\n').map(JSON.parse);
const model={id:'gpt-6-astra',api:'openai-codex-responses',provider:'openai-codex',input:['text','image'],reasoning:true};
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
function snapshot(n) {
  const past=rows.slice(0,n), byId=new Map(past.filter(r=>r.id).map(r=>[r.id,r]));
  const branch=[];
  for(let r=past.at(-1);r;r=byId.get(r.parentId)) branch.unshift(r);
  const archives=branch.filter(r=>r.customType==='context-prune-index');
  const refs=new Map(archives.flatMap(r=>(r.data.refs??[]).map(x=>[x.toolCallId,x.shortId])));
  const released=new Set([...refs.keys(),...archives.flatMap(r=>(r.data.toolCalls??[]).map(x=>x.toolCallId))]);
  const messages=buildSessionContext(past).messages.map(m=>m.role==='toolResult'&&refs.has(m.toolCallId)
    ? {...m,content:[{type:'text',text:`[pruned:${refs.get(m.toolCallId)}]`}]}:m);
  return {messages,refs,released,branch};
}
const first=snapshot(880), visible=toolResultIds(first.messages);
// Predict the next batch start before its recent/unread results become eligible.
// Use the installed release's protected-result and complete-turn rules.
const nextCandidate=collectLabToolTurns(first.branch).filter(t=>t.complete).flatMap(t=>t.toolCalls)
  .find(c=>visible.has(c.toolCallId)&&!first.released.has(c.toolCallId)&&c.toolName!=='context_tree_query');
if(!nextCandidate) throw new Error('No remaining prunable result');
const id=nextCandidate.toolCallId;
function prefix(messages) {
  const owner=messages.findIndex(m=>m.role==='assistant'&&Array.isArray(m.content)&&m.content.some(c=>c.type==='toolCall'&&c.id===id));
  if(owner<0) throw new Error('Owning tool-call message missing');
  const input=convertResponsesMessages(model,normalizeContext({messages:messages.slice(0,owner)}),new Set(['openai-codex']),{includeSystemPrompt:false});
  return {ownerMessageIndex:owner,inputItems:input.length,serializedChars:JSON.stringify(input).length,
    sha256:hash(input),lastInputType:input.at(-1)?.type??input.at(-1)?.role};
}
const second=snapshot(935), p1=prefix(first.messages), p2=prefix(second.messages);
const result={source,sourceSha256:hash(bytes.toString('utf8')),selectionUsesOnlyEntriesThroughLine:880,
  selectionRule:'Oldest visible unarchived result in a complete turn, excluding protected results and context_tree_query; recent/unread protection is retained until actual pruning.',
  selectedToolCallId:id,toolName:nextCandidate.toolName,shortIdAssignedLater:second.refs.get(id),
  firstCutAt:rows[879].timestamp,secondCutAt:rows[934].timestamp,
  firstCutReleased:rows[878].data.refs.map(x=>x.shortId),
  nextCutFirstToolMatches:rows[934].data.candidateToolCallIds[0]===id,
  prefixAfterFirstCut:p1,prefixAtSecondCut:p2,reconstructedPrefixEqual:p1.sha256===p2.sha256,
  limitations:['Offline production transcript alignment only; no new model request or cache benefit measurement.',
    'Historical generated instructions/tools and eight earlier injected items are not reconstructable; equality covers the reconstructable message prefix, not the full wire body.',
    'Short ID is assigned later and used for display only; selection uses the already-existing tool-call ID.',
    'A predicted next batch can change with branching, compaction, tool protection or configuration changes.']};
fs.writeFileSync('test-results/cache-replay-20260927/production-prewarm-alignment.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
