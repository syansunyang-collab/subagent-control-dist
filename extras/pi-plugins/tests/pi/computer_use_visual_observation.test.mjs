import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const root=resolve(process.env.CU_CANDIDATE_DIR??resolve(homedir(),'.pi/agent/npm/node_modules/@injaneity/pi-computer-use'));
const source=readFileSync(resolve(root,'src/bridge.ts'),'utf8');
const start=source.indexOf('async function performDesktopTransaction(');
assert.ok(start>=0);
const code=source.slice(start,source.indexOf('\n}\n',start)+3);

async function refreshOptions(pictureOnly){
 const captures=[];
 const target={pid:1,appName:'fixture',windowTitle:'fixture'};
 const state={currentCapture:{stateId:'before'},currentOutline:{},currentNote:undefined};
 const look={image:{width:1600,height:960},parsedOutline:{root:{pictureOnly}}};
 const context={
  AUTO_IMAGE_MAX_DIMENSION:900,currentPlatformBackend:{name:'windows'},
  operationState:()=>state,validateStateId:()=>{},currentLookOrThrow:()=>look,
  ensureTargetWindowId:async t=>t,resolveCurrentTarget:async()=>target,
  withWindowWriteLock:async(_target,work)=>work(),getComputerUseConfig:()=>({headless:false}),
  dispatchUiTransaction:async()=>({outcome:'unknown',actionCount:1}),sleep:async()=>{},settleMsForExecution:()=>0,
  captureCurrentTarget:async(...args)=>{captures.push(args);return {outline:{},look:{},target,capture:{stateId:'after'}};},
  outcomeAfterObservedValues:o=>o,noteAfterAct:()=>undefined,noteWindowForTarget:()=>({}),
  buildToolResult:async()=>({completed:true}),terminalDesktopActionResult:async(_target,_state,_execution,error)=>{throw error;},
 };
 vm.createContext(context);
 vm.runInContext(`${stripTypeScriptTypes(code)}\nthis.run=performDesktopTransaction;`,context);
 const result=await context.run({stateId:'before'},[{action:'click',x:100,y:100}]);
 assert.equal(result.completed,true);
 return captures[0];
}

test('Windows visual click refresh skips UIA and preserves the screenshot scale',async()=>{
 const args=await refreshOptions(true);
 assert.equal(args[5],false);
 assert.equal(args[4],true);
 assert.equal(args[2],1600);
});

test('semantic click refresh retains UIA and the existing automatic image budget',async()=>{
 const args=await refreshOptions(false);
 assert.equal(args[5],true);
 assert.equal(args[2],900);
});

const outlineSource=readFileSync(resolve(root,'src/outline.ts'),'utf8');
const outlineContext=vm.createContext({});
vm.runInContext(stripTypeScriptTypes(outlineSource.replace(/\bexport /g,''))+'\nthis.parse=parseLookResponse;',outlineContext);

test('Windows look parsing retains the selected capture source',()=>{
 for(const captureMethod of ['window','screen-region']){
  const parsed=outlineContext.parse({lookId:'l-fixture',image:{jpegBase64:'png',width:10,height:10,mimeType:'image/png',captureMethod}});
  assert.equal(parsed.image.captureMethod,captureMethod);
 }
 assert.equal(outlineContext.parse({lookId:'l-fixture',image:{jpegBase64:'png'}}).image.captureMethod,undefined);
});

test('tool details expose captureMethod without changing the target identity',async()=>{
 const functionStart=source.indexOf('async function buildToolResult(');
 const functionEnd=source.indexOf('\n}\n',functionStart)+3;
 assert.ok(functionStart>=0 && functionEnd>functionStart);
 const context=vm.createContext({
  operationState:()=>({}),imageFallbackReason:()=>undefined,foldToBudget:()=>({text:'',nodeCount:1}),
  renderNote:()=>'',serializeOutline:()=>({}),getComputerUseConfig:()=>({headless:false}),
  runtimeState:{},currentPlatformBackend:{isChromeFamilyApp:()=>false},rootDeltaLines:()=>[],
 });
 vm.runInContext(stripTypeScriptTypes(source.slice(functionStart,functionEnd))+'\nthis.build=buildToolResult;',context);
 const target={pid:123,appName:'fixture',windowTitle:'owned',windowId:42};
 for(const captureMethod of ['window','screen-region']){
  const result=await context.build('observe_ui','observed',{
   target,capture:{stateId:'s-owned',width:10,height:10},outline:{},
   look:{image:{captureMethod},lookId:'l-owned'},activation:{},
  },{});
  assert.equal(result.details.capture.captureMethod,captureMethod);
  assert.equal(result.details.target.windowId,42);
  assert.equal(result.details.target.pid,123);
 }
});

test('native capture_failed remains identifiable in the Windows frontend',async()=>{
 const helper=readFileSync(resolve(root,'src/platform/windows/helper.ts'),'utf8');
 const methodStart=helper.indexOf('private onStdout(');
 const methodEnd=helper.indexOf('\n\tasync command<',methodStart);
 assert.ok(methodStart>=0 && methodEnd>methodStart);
 const context=vm.createContext({WINDOWS_HELPER_PROTOCOL_VERSION:4,clearTimeout});
 vm.runInContext(stripTypeScriptTypes('class Client {buffer="";pending=new Map();'+helper.slice(methodStart,methodEnd)+'}\nthis.Client=Client;'),context);
 const client=new context.Client();
 const pending=new Promise((resolve,reject)=>client.pending.set('capture-1',{resolve,reject,timer:undefined}));
 client.onStdout(JSON.stringify({protocolVersion:4,id:'capture-1',ok:false,
  error:{code:'capture_failed',message:'Background PrintWindow capture failed'}})+'\n');
 await assert.rejects(pending,error=>error.code==='capture_failed');
 assert.equal(client.pending.size,0);
});
