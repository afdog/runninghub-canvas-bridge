import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../extension/bridge-main.js',import.meta.url),'utf8');
const policySource=await readFile(new URL('../extension/site-policy.js',import.meta.url),'utf8');
const key='__RUNNINGHUB_CANVAS_BRIDGE_LOADER__';
const origin='https://rhtv.runninghub.cn';
const canvas=id=>origin+'/project/canvas/'+id;
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function fixture({href=origin+'/',body={},fetchResult}={}){
  const intervals=[],events=new Map(),requests=[],executions=[];let clock=1000;
  const listen=(name,fn)=>{const handlers=events.get(name)||[];handlers.push(fn);events.set(name,handlers);};
  const window={addEventListener:listen};
  const context={window,URL,location:{href},document:{body,addEventListener:listen},AbortSignal,
    Date:{now:()=>clock},console:{warn(){}},setInterval:fn=>{intervals.push(fn);return intervals.length;},
    Function:function(code){return ()=>executions.push(code);},
    fetch:async(...args)=>{requests.push(args);return fetchResult?fetchResult(...args):{ok:true,text:async()=>'/* fixture runtime */'};}};
  runInNewContext(policySource,context);runInNewContext(source,context);
  return {context,requests,executions,intervals,get state(){return window[key];},
    async tick(){for(const fn of intervals)void fn();await flush();},
    async navigate(href,{event}={}){context.location.href=href;if(event)for(const fn of events.get(event)||[])void fn();else for(const fn of intervals)void fn();await flush();},
    async ready(){context.document.body={};for(const fn of events.get('DOMContentLoaded')||[])fn();await flush();},
    advance(ms){clock+=ms;},inject(){runInNewContext(source,context);}};
}

test('both extension scripts cover home-to-canvas navigation within existing host permissions',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  const sites=['https://www.runninghub.ai/*','https://rhtv.runninghub.ai/*','https://www.runninghub.cn/*','https://rhtv.runninghub.cn/*'];
  for(const script of manifest.content_scripts)for(const site of sites){assert.ok(script.matches.includes(site));assert.ok(manifest.host_permissions.includes(site));}
  assert.ok(manifest.content_scripts.some(s=>s.js.includes('bridge-main.js')));
  assert.ok(manifest.content_scripts.some(s=>s.js.includes('keepalive.js')));
});
test('a home page stays idle and an in-app canvas transition loads without a document refresh',async()=>{
  const f=fixture();await flush();assert.equal(f.requests.length,0);
  await f.navigate(canvas('123'));assert.equal(f.executions.length,1);assert.equal(f.state.canvasKey,origin+'/123');
  assert.equal(f.requests[0][1].cache,'no-store');assert.ok(f.requests[0][1].signal);
  await f.tick();assert.equal(f.requests.length,1);
});
test('direct canvas load waits until the document body can host the image controls',async()=>{
  const f=fixture({href:canvas('123'),body:null});await flush();
  assert.equal(f.requests.length,1);assert.equal(f.executions.length,0);
  await f.ready();assert.equal(f.executions.length,1);assert.equal(f.state.loading,false);
});
test('duplicate injection keeps one watcher and canvas back/forward navigation remains usable',async()=>{
  const f=fixture({href:canvas('123')});await flush();f.inject();await flush();
  assert.equal(f.intervals.length,1);assert.equal(f.requests.length,1);
  await f.navigate(canvas('456'),{event:'popstate'});assert.equal(f.requests.length,2);assert.equal(f.state.canvasKey,origin+'/456');
  await f.navigate(origin+'/');assert.equal(f.requests.length,2);
  await f.navigate(canvas('123'));assert.equal(f.requests.length,3);
});
test('an in-flight old route response cannot install into another canvas or home page',async()=>{
  let release;let first=true;
  const f=fixture({href:canvas('123'),fetchResult:async()=>{
    if(first){first=false;await new Promise(resolve=>release=resolve);}
    return {ok:true,text:async()=>'/* fixture runtime */'};
  }});
  await flush();await f.navigate(canvas('456'));assert.equal(f.requests.length,1);
  release();await flush();await flush();
  assert.equal(f.requests.length,2);assert.equal(f.executions.length,1);assert.equal(f.state.canvasKey,origin+'/456');
  let finish;
  const home=fixture({href:canvas('123'),fetchResult:()=>new Promise(resolve=>finish=resolve)});
  await home.navigate(origin+'/');finish({ok:true,text:async()=>'/* fixture */'});await flush();
  assert.equal(home.executions.length,0);assert.equal(home.state.loading,false);
});
test('a temporarily unavailable local bridge retries with backoff and recovers on the same page',async()=>{
  let available=false;
  const f=fixture({href:canvas('123'),fetchResult:async()=>{if(!available)throw Error('Local bridge unavailable');return {ok:true,text:async()=>'/* fixture */'};}});
  await flush();assert.equal(f.requests.length,1);assert.match(f.state.error,/Local bridge unavailable/);
  await f.tick();assert.equal(f.requests.length,1);
  f.advance(1000);await f.tick();assert.equal(f.requests.length,2);
  available=true;f.advance(1000);await f.tick();assert.equal(f.requests.length,2);
  f.advance(1000);await f.tick();assert.equal(f.requests.length,3);assert.equal(f.executions.length,1);assert.equal(f.state.error,null);
});
test('failed-route backoff does not delay another canvas and unrelated sites never load the bridge',async()=>{
  let available=false;
  const f=fixture({href:canvas('123'),fetchResult:async()=>({ok:available,status:503,text:async()=>'/* fixture */'})});
  await flush();available=true;await f.navigate(canvas('456'));
  assert.equal(f.requests.length,2);assert.equal(f.executions.length,1);
  await f.navigate('https://example.test/project/canvas/789');assert.equal(f.requests.length,2);
});
