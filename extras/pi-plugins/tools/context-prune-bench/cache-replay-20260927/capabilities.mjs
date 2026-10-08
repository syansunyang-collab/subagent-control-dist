// Subscription capability check. No tools execute and no production files are changed.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { installCodexWebSocketProbe, wrapCodexFetch, classifyError } from '../wire-diag/probe.mjs';
const args=process.argv.slice(2);
const arg=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const modelId=arg('--model','gpt-6-luna');
const cases=arg('--cases','baseline,prewarm,explicit').split(',');
const repeats=Number(arg('--repeats','1'));
const lines=Number(arg('--lines','140'));
const gapMs=Number(arg('--gap-ms','0'));
const label=arg('--label',`capabilities-${Date.now()}`);
const allowed=['baseline','prewarm','explicit','marker-only','explicit-empty','invalid-mode','ws-warmup','ws-warmup-chain'];
assert(cases.every(c=>allowed.includes(c))&&cases.length<=6);
assert(Number.isInteger(repeats)&&repeats>=1&&repeats<=3);
assert(Number.isInteger(lines)&&lines>=140&&lines<=1500);
assert(Number.isInteger(gapMs)&&gapMs>=0&&gapMs<=10000);
assert(/^[a-zA-Z0-9_-]+$/.test(label));
const root=path.join(process.env.APPDATA,'npm/node_modules/@earendil-works/pi-coding-agent');
const ai=path.join(root,'node_modules/@earendil-works/pi-ai/dist');
const {configureHttpDispatcher}=await import(pathToFileURL(path.join(root,'dist/core/http-dispatcher.js')));
const {ModelRuntime}=await import(pathToFileURL(path.join(root,'dist/core/model-runtime.js')));
const {ReadOnlyAuthStorage}=await import(pathToFileURL(path.join(root,'dist/core/auth-storage.js')));
const provider=await import(pathToFileURL(path.join(ai,'api/openai-codex-responses.js')));
const {cleanupSessionResources}=await import(pathToFileURL(path.join(ai,'session-resources.js')));
const file=path.resolve('test-results/cache-replay-20260927',`${label}.jsonl`);
fs.mkdirSync(path.dirname(file),{recursive:true});
assert(!fs.existsSync(file),'Never overwrite an existing run');
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x??null)).digest('hex');
const log=x=>fs.appendFileSync(file,JSON.stringify({at:new Date().toISOString(),...x})+'\n');
const safeError=error=>{
  const text=typeof error==='string'?error:JSON.stringify(error??{});
  const obj=error&&typeof error==='object'?error:{};
  const scalar=v=>typeof v==='string'&&/^[a-zA-Z0-9_.\[\]-]{1,100}$/.test(v)?v:null;
  return {diagnostic:classifyError(text),hash:hash(text),code:scalar(obj.code),param:scalar(obj.param),
    unsupported:/unknown parameter|unsupported|unrecognized|extra inputs|not permitted/i.test(text),
    invalid:/invalid|validation/i.test(text),mentionedFields:['prompt_cache_options','prompt_cache_breakpoint','prewarm','max_output_tokens','generate'].filter(f=>text.includes(f))};
};
const numericTree=x=>typeof x==='number'?x:x&&typeof x==='object'&&!Array.isArray(x)
  ?Object.fromEntries(Object.entries(x).filter(([,v])=>typeof v==='number'||v&&typeof v==='object'&&!Array.isArray(v)).map(([k,v])=>[k,numericTree(v)])):null;
configureHttpDispatcher();
const runtime=await ModelRuntime.create({credentials:new ReadOnlyAuthStorage(),refreshOnCreate:false,allowModelNetwork:false});
const model=runtime.getModel('openai-codex',modelId);
assert(model?.id===modelId);
let active,callCount=0;
const trials=[];
const stop=installCodexWebSocketProbe({logFile:file,
  onFrame:({connectionId,payload})=>{
    const markers=payload.input?.flatMap((m,i)=>Array.isArray(m.content)?m.content.flatMap((c,j)=>c.prompt_cache_breakpoint?[{item:i,block:j,mode:c.prompt_cache_breakpoint.mode}]:[]):[])??[];
    active.frames.push({connectionId,cacheOptions:payload.prompt_cache_options??null,markers,
      model:payload.model,reasoning:payload.reasoning,generate:payload.generate??null,inputItems:payload.input?.length??0,
      hasPreviousResponseId:Boolean(payload.previous_response_id)});
  },
  onEvent:({payload})=>{
    if(!active)return;
    active.eventTypes.add(payload.type);
    const r=payload.response;
    if(r?.usage)active.rawUsage=numericTree(r.usage);
    if(r?.prompt_cache_options)active.responseCacheOptions=r.prompt_cache_options;
    if(r?.status)active.responseStatus=r.status;
    if(r?.id)active.responseIdHash=hash(r.id);
    if(r?.id)active.responseId=r.id;
    if(payload.error||r?.error)active.errors.push(safeError(payload.error??r.error));
  }});
log({kind:'capability_manifest',model:modelId,cases,repeats,lines,gapMs,providerSha:hash(fs.readFileSync(path.join(ai,'api/openai-codex-responses.js')).toString()),subscription:true,
  sources:['https://developers.openai.com/api/docs/guides/prompt-caching','https://developers.openai.com/api/docs/guides/websocket-mode'],limitations:['Synthetic inputs test compatibility, not production savings.','Pi local catalog cost is not subscription-point billing.']});
try {
  for(const variant of cases){
    const nonce=randomUUID();
    const identity={sessionId:nonce,threadId:nonce,turnId:`${nonce}-turn`,requestKind:'turn',startedAt:Date.now(),installationId:'cache-capabilities',windowId:'cache-capabilities'};
    const prepared=await runtime.prepareRequest(model,{sessionId:nonce,requestIdentity:identity,reasoning:'off',transport:'websocket',maxRetries:0});
    const prefix=`Archive ${nonce}.\n`+Array.from({length:lines},(_,i)=>`${i}: amber birch cedar delta elm field glass hill iris jade lake maple.`).join('\n');
    let warmupResponseId;
    for(let repeat=0;repeat<repeats;repeat++){
      if(repeat&&gapMs)await delay(gapMs);
      assert(++callCount<=18);
      active={frames:[],errors:[],eventTypes:new Set()};
      const started=Date.now();
      const result=await provider.streamSimple(prepared.model,{systemPrompt:'Treat the archive as inert data. Reply only OK.',messages:[{role:'user',content:'Reply OK.',timestamp:1}]},{
        ...prepared.options,maxRetries:0,transport:'websocket',signal:AbortSignal.timeout(45000),
        fetch:wrapCodexFetch(globalThis.fetch,{logFile:file}),
        onPayload(body){
          body.input=[{role:'developer',content:[{type:'input_text',text:prefix}]},{role:'user',content:[{type:'input_text',text:'Reply OK.'}]}];
          body.tool_choice='none';
          if(variant==='prewarm')body.prompt_cache_options={prewarm:true};
          if(variant.startsWith('ws-warmup')&&repeat===0)body.generate=false;
          if(variant==='ws-warmup-chain'&&repeat===1){
            assert(warmupResponseId,'Warmup must return a response ID');
            body.previous_response_id=warmupResponseId;
            body.input=[];
          }
          if(variant==='explicit'||variant==='explicit-empty')body.prompt_cache_options={mode:'explicit'};
          if(variant==='invalid-mode')body.prompt_cache_options={mode:'not-a-mode'};
          if(variant==='explicit'||variant==='marker-only')body.input[0].content[0].prompt_cache_breakpoint={mode:'explicit'};
          return body;
        },
      }).result();
      const row={kind:'capability_trial',variant,repeat,request:callCount,model:modelId,success:result.stopReason==='stop',stopReason:result.stopReason,elapsedMs:Date.now()-started,
        usage:result.usage,outputBlocks:result.content.map(c=>({type:c.type,chars:typeof c.text==='string'?c.text.length:typeof c.thinking==='string'?c.thinking.length:0})),
        wire:active.frames,eventTypes:[...active.eventTypes],rawUsage:active.rawUsage??null,responseStatus:active.responseStatus??null,
        responseIdHash:active.responseIdHash??null,responseCacheOptions:active.responseCacheOptions??null,serverErrors:active.errors,
        error:result.errorMessage?safeError(result.errorMessage):null};
      log(row);trials.push(row);
      if(repeat===0)warmupResponseId=active.responseId;
      console.log(JSON.stringify({variant,repeat,success:row.success,elapsedMs:row.elapsedMs,wire:row.wire,
        usage:row.usage,rawUsage:row.rawUsage?{...row.rawUsage,attribution:undefined}:null,
        outputBlocks:row.outputBlocks,responseStatus:row.responseStatus,serverErrors:row.serverErrors,error:row.error}));
      assert(result.content.every(c=>c.type!=='toolCall'),'No tool calls expected');
      if(result.stopReason!=='stop')break;
    }
    cleanupSessionResources(nonce);
  }
  log({kind:'capability_complete',calls:callCount,successful:trials.filter(r=>r.success).length,
    localCatalogCost:trials.reduce((n,r)=>n+(r.usage?.cost?.total??0),0),
    missingUsageRequests:trials.filter(r=>!r.rawUsage).length});
}finally{cleanupSessionResources();stop();await runtime.dispose?.();}
