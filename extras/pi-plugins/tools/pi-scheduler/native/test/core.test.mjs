import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import core from '../extensions/scheduler/core.cjs';
import shell from '../extensions/scheduler/shell.cjs';
import live from '../extensions/scheduler/liveness.cjs';
const now = new Date('2026-09-21T00:00:00Z');
const due = new Date(now.getTime()+1000);
const context = {sessionFile:'test-session', idle:true};
function task(extra={}) { const r=core.createTask({kind:'wake',after:'1s',reason:'检查结果',sessionFile:context.sessionFile,...extra},now); assert.equal(r.ok,true,r.error); return r.task; }
function fixture(t, value=task()) {const dir=mkdtempSync(join(tmpdir(),'native-scheduler-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=core.createStateStore({stateFile:join(dir,'tasks.json')});store.updateSync(s=>s.tasks.push(value));return {store,value};}
test('busy wake has one pending delivery, idle delivery advances finite repeat',async t=>{const {store,value}=fixture(t,task({repeat:'1s',maxRuns:2})); await core.runDueTaskOnce({store,taskId:value.id,now:due});for(let i=0;i<3;i++)await core.runDueTaskOnce({store,taskId:value.id,now:due});const x=store.loadSync().tasks[0];assert.equal(x.runCount,1);assert.equal(core.planDelivery([x],{...context,idle:false}),null);const p=core.planDelivery([x],context);assert.ok(p);core.markDelivered(x,p.deliveryId,due);assert.equal(x.status,'pending');});
test('cancel clears pending event',()=>{const x=task();core.applyRunOutcome(x,{kind:'wake'},due);core.cancelTask(x,due);assert.equal(core.planDelivery([x],context),null);assert.equal(x.status,'cancelled');});
test('update invalidates old event without leaving task stuck waiting',()=>{const x=task();core.applyRunOutcome(x,{kind:'wake'},due);core.updateTask(x,{reason:'新内容'},due);assert.equal(x.pendingDelivery,null);assert.equal(x.status,'pending');});
test('invalid update is atomic',()=>{const x=task();const before=structuredClone(x);assert.equal(core.updateTask(x,{after:'2s',reason:''},due).ok,false);assert.deepEqual(x,before);});
test('cancel during command prevents completion resurrecting task',async t=>{const {store,value}=fixture(t,task({kind:'command',command:'echo test',wakeOn:'always'}));await core.runDueTaskOnce({store,taskId:value.id,now:due,execute:async()=>{store.updateSync(s=>core.cancelTask(s.tasks[0],due));return {ok:true,code:0};}});assert.equal(store.loadSync().tasks[0].status,'cancelled');});
test('competing runners execute once and state survives reopen',async t=>{const {store,value}=fixture(t,task({kind:'command',command:'echo test',wakeOn:'never'}));let count=0;const run=()=>core.runDueTaskOnce({store,taskId:value.id,now:due,execute:async()=>{count++;await new Promise(r=>setTimeout(r,15));return {ok:true,code:0};}});await Promise.all([run(),run()]);assert.equal(count,1);assert.equal(core.createStateStore({stateFile:store.stateFile}).loadSync().tasks[0].status,'done');});
test('shellPath is passed from settings to SDK resolver',async()=>{let selected;const config=shell.resolveShellConfig({cwd:'.',projectTrusted:true,settingsManagerClass:{create:()=>({getShellPath:()=> 'C:/Git/bin/bash.exe'})},getShellConfig:p=>{selected=p;return {shell:p,args:['-c']};}});assert.equal(selected,'C:/Git/bin/bash.exe');const out=await shell.executeShellCommand({shellConfig:config,command:'echo ok',cwd:'.',exec:async(p,args)=>{assert.equal(p,selected);assert.deepEqual(args,['-c','echo ok']);return {code:0,stdout:'ok'};}});assert.equal(out.ok,true);});
test('liveness registers and releases without null sessionFile',()=>{let provider,removed=false;const g={[Symbol.for(live.REGISTRY_KEY)]:{version:1,register:p=>{provider=p;assert.equal(p.sessionFile,undefined);return()=>removed=true;},hasActiveProvider:()=>true}};const r=live.registerLivenessProvider({name:'test',sessionId:'id',isActive:()=>true},{globalObject:g});assert.equal(r.supported,true);assert.equal(provider.isActive(),true);r.release();assert.equal(removed,true);});
