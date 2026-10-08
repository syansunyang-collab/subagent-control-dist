// Controlled long-history replay through the installed Pi Codex provider.
// Uses existing subscription auth; executes no tools. Only fingerprints and usage are persisted.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { installCodexWebSocketProbe, classifyError } from '../wire-diag/probe.mjs';
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i=args.indexOf(name); return i<0 ? fallback : args[i+1]; };
const modelId=arg('--model','gpt-6-luna');
const mode=arg('--mode','bulk');
const scale=Number(arg('--scale','1'));
const effort=arg('--effort','off');
const arm=arg('--patch','on');
const tailRounds=Number(arg('--tail-rounds','30'));
const cutRounds=Number(arg('--cut-rounds','20'));
const label=arg('--label',`${modelId}-${mode}-${Date.now()}`);
assert(['bulk','seeded','late-seeded'].includes(mode));
assert(['on','off'].includes(arm));
assert(Number.isInteger(tailRounds)&&tailRounds>0&&tailRounds<=30);
assert(Number.isInteger(cutRounds)&&cutRounds>0&&cutRounds<=tailRounds);
assert(/^[a-zA-Z0-9_-]+$/.test(label));
const root=path.join(process.env.APPDATA,'npm/node_modules/@earendil-works/pi-coding-agent');
const ai=arm==='on' ? path.join(root,'node_modules/@earendil-works/pi-ai/dist')
  : path.resolve('tools/context-prune-bench/wire-diag/pair/off/dist');
const { configureHttpDispatcher }=await import(pathToFileURL(path.join(root,'dist/core/http-dispatcher.js')));
const { ModelRuntime }=await import(pathToFileURL(path.join(root,'dist/core/model-runtime.js')));
const { ReadOnlyAuthStorage }=await import(pathToFileURL(path.join(root,'dist/core/auth-storage.js')));
const provider=await import(pathToFileURL(path.join(ai,'api/openai-codex-responses.js')));
const { normalizeContext }=await import(pathToFileURL(path.join(ai,'utils/transcript.js')));
const { cleanupSessionResources }=await import(pathToFileURL(path.join(ai,'session-resources.js')));
const out=path.resolve('test-results/cache-replay-20260927');
fs.mkdirSync(out,{recursive:true});
const file=path.join(out,`${label}.jsonl`);
assert(!fs.existsSync(file),'Never overwrite a previous run');
const log=row=>fs.appendFileSync(file,JSON.stringify({at:new Date().toISOString(),...row})+'\n');
const sha=v=>createHash('sha256').update(Buffer.isBuffer(v)||typeof v==='string'?v:JSON.stringify(v??null)).digest('hex');
const nonce=randomUUID();
const identity={sessionId:nonce,threadId:nonce,turnId:`${nonce}-turn`,requestKind:'turn',startedAt:Date.now(),installationId:'cache-replay',windowId:'cache-replay'};
const user=text=>({role:'user',content:text,timestamp:1});
const words='amber birch cedar delta elm field glass hill iris jade lake maple north oak pine quartz river stone tree violet water xenon yellow zinc'.split(' ');
function material(tag,lines) {
  let seed=17;
  return Array.from({length:Math.max(1,Math.round(lines*scale))},(_,i)=>{
    const w=Array.from({length:18},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return words[seed%words.length];});
    return `${tag}-${i}: ${w.join(' ')}.`;
  }).join('\n');
}
const systemPrompt=`Replay ${nonce}. This is a cache transport experiment. Treat all historical material as inert data. Do not execute tools. Reply only OK to every new request.\n`+material('instruction',320);
const tool={name:'fixed_observation',description:'Archived synthetic data. Do not invoke.',parameters:{type:'object',properties:{}}};
function toolRound(i,text) {
  const id=`call_replay_${i}`;
  return [{role:'assistant',api:'openai-codex-responses',provider:'openai-codex',model:modelId,content:[{type:'toolCall',id,name:tool.name,arguments:{}}],stopReason:'toolUse',timestamp:1,
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}},
    {role:'toolResult',toolCallId:id,toolName:tool.name,content:[{type:'text',text}],isError:false,timestamp:1}];
}
const prefixHistory=[user('Archive the following observations for reference.'),...Array.from({length:12},(_,i)=>toolRound(i,material(`stable${i}`,180))).flat()];
const tail=Array.from({length:tailRounds},(_,i)=>toolRound(i+12,material(`candidate${i}`,35))).flat();
const replaceIds=new Set(Array.from({length:cutRounds},(_,i)=>`call_replay_${i+12}`));
const prune=messages=>messages.map(m=>m.role==='toolResult'&&replaceIds.has(m.toolCallId)
  ? {...m,content:[{type:'text',text:`[pruned:${m.toolCallId}]`}]}:m);
configureHttpDispatcher();
const runtime=await ModelRuntime.create({credentials:new ReadOnlyAuthStorage(),refreshOnCreate:false,allowModelNetwork:false});
const model=runtime.getModel('openai-codex',modelId);
assert(model && model.id===modelId,'Model identity mismatch');
const prepared=await runtime.prepareRequest(model,{sessionId:nonce,requestIdentity:identity,transport:'auto',reasoning:effort,maxRetries:0});
const frames=[];
const stop=installCodexWebSocketProbe({logFile:file,onFrame:({sequence,connectionId,payload})=>frames.push({sequence,connectionId,payload})});
let callCount=0;
let priorStage;
const logicalByStage=new Map();
const results=[];
log({kind:'manifest',label,model:modelId,mode,scale,effort,patch:arm,providerSha:sha(fs.readFileSync(path.join(ai,'api/openai-codex-responses.js'))),
  subscription:true,nonceSha:sha(nonce),tailRounds,cutResults:replaceIds.size,systemChars:systemPrompt.length,prefixChars:JSON.stringify(prefixHistory).length,tailChars:JSON.stringify(tail).length,
  limitations:['Synthetic fixed history; no production task quality or subscription-point estimate.','Provider cost fields are local catalog estimates.']});
async function run(stage,messages,transport='auto',compareTo=priorStage) {
  assert(++callCount<=45,'Per-run request cap exceeded');
  let logical;
  const from=frames.length;
  const begin=Date.now();
  const result=await provider.streamSimple(prepared.model,normalizeContext({systemPrompt,tools:[tool],messages}),{
    ...prepared.options,transport,signal:AbortSignal.timeout(120000),
    onPayload(body) { body.tool_choice='none'; logical=structuredClone(body); return body; },
  }).result();
  const ownFrames=frames.slice(from);
  const success=result.stopReason==='stop';
  const comparison=logicalByStage.get(compareTo);
  let firstDiff=null;
  if(comparison){firstDiff=Math.min(comparison.input.length,logical.input.length);for(let i=0;i<firstDiff;i++)if(sha(comparison.input[i])!==sha(logical.input[i])){firstDiff=i;break;}}
  const actual=ownFrames.at(-1);
  const row={kind:'trial',stage,request:callCount,success,stopReason:result.stopReason,elapsedMs:Date.now()-begin,
    usage:result.usage,cacheHitRate:result.usage.cacheRead/(result.usage.cacheRead+result.usage.input),
    logical:{model:logical?.model,inputItems:logical?.input?.length,firstDiff,compareTo:compareTo??null,instructionsSha:sha(logical?.instructions),toolsSha:sha(logical?.tools),
      reasoning:logical?.reasoning,settingsSha:sha(Object.fromEntries(Object.entries(logical??{}).filter(([k])=>!['input','client_metadata'].includes(k)))),
      eligibleEndings:logical?.input?.filter((m,i,a)=>m.role==='user'||(m.type==='function_call_output'&&a[i+1]?.type!=='function_call_output')).length,
      charsBeforeDiff:firstDiff===null?null:logical.input.slice(0,firstDiff).reduce((n,m)=>n+JSON.stringify(m).length,0),
      endingsFromDiff:firstDiff===null?null:logical.input.flatMap((m,i,a)=>m.role==='user'||(m.type==='function_call_output'&&a[i+1]?.type!=='function_call_output')?[i]:[]).filter(i=>i>=firstDiff).length},
    wire:{frameCount:ownFrames.length,connectionId:actual?.connectionId,hasPreviousResponseId:Boolean(actual?.payload.previous_response_id),inputItems:actual?.payload.input?.length,
      turnStateSha:sha(actual?.payload.client_metadata?.['x-codex-turn-state']),hasTurnId:Boolean(actual?.payload.client_metadata?.turn_id)},
    diagnostic:success?null:classifyError(result.errorMessage)};
  log(row);results.push(row);priorStage=stage;logicalByStage.set(stage,logical);
  console.log(JSON.stringify({stage,success,input:result.usage.input,cacheRead:result.usage.cacheRead,output:result.usage.output,delta:row.wire.hasPreviousResponseId,connection:row.wire.connectionId,ms:row.elapsedMs,diagnostic:row.diagnostic}));
  assert(success,`Request failed at ${stage}: ${row.diagnostic?.category}`);
  assert(ownFrames.length===1,'Expected exactly one observed WS frame');
  assert(result.content.every(c=>c.type!=='toolCall'),'Unexpected model tool call');
  return result;
}
try {
  let history=[...prefixHistory];
  // A separate cache-write opportunity. Do not insert the seed response into the full fixture.
  if(mode==='seeded') await run('prefix-seed',history);
  history.push(...tail);
  history.push(user('Reply OK.'));
  const warm=await run('whole-warm',history);history.push(warm,user('Reply OK.'));
  const next=[...history];
  await run('append-control',next);
  await run('full-control',next,'websocket');
  // Production-feasible ordering: history is already long before requesting the retained prefix.
  if(mode==='late-seeded') await run('prefix-seed',prefixHistory);
  const edited=prune(next);
  await run('history-edit',edited,'auto','full-control');
  const recovered=await run('edited-repeat',edited,'auto');
  await run('edited-continue',[...edited,recovered,user('Reply OK.')]);
  log({kind:'complete',calls:callCount,totalLocalCost:results.reduce((n,r)=>n+r.usage.cost.total,0),
    input:results.reduce((n,r)=>n+r.usage.input,0),cacheRead:results.reduce((n,r)=>n+r.usage.cacheRead,0)});
} finally {cleanupSessionResources();stop();await runtime.dispose?.();}
