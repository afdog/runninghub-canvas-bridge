import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {BridgeClient} from '../server/bridge-client.mjs';
import {BrowserBroker} from '../server/browser-broker.mjs';

const origin='https://rhtv.runninghub.ai';
const url=id=>`${origin}/project/canvas/${id}`;
const page=(id,source='codex-browser',runtimeFreshness='fresh')=>({clientId:`${source}-${id}`,href:url(id),browserSource:source,runtimeFreshness});
function fixture(pages){
 const client=new BridgeClient(),jobs=[],sessions=[];
 client.request=async(path,body)=>{
  if(path==='/clients')return pages;
  if(path==='/browser/status')return {connected:true,providers:['codex-browser','browser-extension']};
  if(path==='/sessions'){sessions.push(body);return {ok:true,sessionId:`session-${body.clientId}`};}
  throw Error('Unexpected request '+path);
 };
 client.browserJob=async args=>{jobs.push(args);const p=page(new URL(args.canvasUrl).pathname.split('/').at(-1),args.browserSource);pages.push(p);return {ok:true,reused:false,browserSource:args.browserSource};};
 return {client,jobs,sessions};
}

test('interleaved canvas connections ignore legacy focus and do not dispatch any browser job',async()=>{
 const pages=[page('123'),page('456'),page('123','browser-extension')];
 const a=fixture(pages),b=fixture(pages);
 const [first,second]=await Promise.all([a.client.open(url('123'),true,true,'codex-browser'),b.client.open(url('456'),false,true,'codex-browser')]);
 assert.equal(a.jobs.length+b.jobs.length,0);
 assert.equal(a.sessions[0].clientId,'codex-browser-123');
 assert.equal(b.sessions[0].clientId,'codex-browser-456');
 assert.notEqual(first.sessionId,second.sessionId);
 assert.equal(first.presentation.activation,'unchanged');
 assert.equal(first.presentation.legacyFocusIgnored,true);
 assert.equal(second.presentation.activation,'unchanged');
 assert.equal(a.sessions[0].allowWrites,true);
 assert.equal(b.sessions[0].allowWrites,false);
});

test('connected-first routing preserves explicit provider and skips stale or unrelated pages',async()=>{
 const exact=fixture([page('123'),page('123','browser-extension')]);
 await exact.client.open(url('123'),false,false,'browser-extension');
 assert.equal(exact.jobs.length,0);assert.equal(exact.sessions[0].clientId,'browser-extension-123');
 for(const pages of [[page('456')],[page('123','browser-extension')],[page('123','codex-browser','stale')]]){
  const f=fixture(pages);await f.client.open(url('123'),false,true,'codex-browser');
  assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].canvasUrl,url('123'));
  assert.equal(f.jobs[0].browserSource,'codex-browser');assert.equal(f.jobs[0].intent,'connect');
  assert.equal(f.sessions[0].clientId,'codex-browser-123');
 }
});

test('explicit show still dispatches a display request even when the exact page is connected',async()=>{
 const f=fixture([page('123')]);await f.client.open(url('123'),false,false,'codex-browser','show');
 assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].intent,'show');
 await assert.rejects(f.client.open(url('123'),false,false,'codex-browser','typo'),/INVALID_PRESENTATION_INTENT/);
});

test('broker protects existing tabs from old focus=true callers while preserving explicit show',async()=>{
 const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
 const code=source.slice(0,source.indexOf('\nconst transport='));
 for(const intent of [undefined,'connect','show']){
  const broker=new BrowserBroker(),updates=[],created=[];
  const {id}=broker.enqueue({action:'openCanvas',canvasUrl:url('123'),focus:true,...(intent?{intent}:{}),browserSource:'codex-browser'});
  const job=broker.poll('codex-browser');
  const tab={id:3,url:url('123'),status:'complete'};
  const context={job,RHCanvasSitePolicy:globalThis.RHCanvasSitePolicy,importScripts(){},setTimeout,chrome:{
   tabs:{query:async()=>[tab],get:async()=>tab,update:async(id,options)=>{updates.push({id,...options});return tab;},create:async options=>{created.push(options);return tab;}},
   scripting:{executeScript:async()=>[]}
  }};
  const result=await runInNewContext(code+'\nhandle(job)',context);
  broker.complete({id,lease:job.lease,result});
  assert.equal(updates.length,intent==='show'?1:0);assert.equal(created.length,0);
  assert.equal(broker.result(id).result.presentation.activation,intent==='show'?'requested':'unchanged');
 }
});

test('new embedded pages disclose the required foreground creation instead of claiming silent opening',()=>{
 for(const provider of ['codex-browser','browser-extension']){
  const broker=new BrowserBroker(),{id}=broker.enqueue({action:'openCanvas',canvasUrl:url('123'),browserSource:provider});
  const job=broker.poll(provider);broker.complete({id,lease:job.lease,result:{ok:true,reused:false}});
  assert.equal(broker.result(id).result.presentation.activation,provider==='codex-browser'?'required-for-new-tab':'unchanged');
 }
});
