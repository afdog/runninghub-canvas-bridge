import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,stat,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ParallelGptImageEngine} from './parallel.mjs';
import {GptImageAddon} from './routes.mjs';

const canvasUrl='https://rhtv.runninghub.cn/project/canvas/1000000000000000001';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const pause=(ms=5)=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<400;i++){if(fn())return;await pause();}throw Error('timeout');}
async function fixture(options={}){
  const root=await mkdtemp(join(tmpdir(),'rh-parallel-')),calls=[],imports=[],patches=[];
  let thread=0;
  const rpc={start:async()=>{},close(){},request:async(method,params)=>{
    calls.push({method,params,at:Date.now()});
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='modelProvider/capabilities/read')return {imageGeneration:true};
    if(method==='thread/start')return {thread:{id:'thread-'+(++thread)}};
    if(method==='turn/start')return {turn:{id:'turn-'+params.threadId}};
    if(method==='turn/interrupt')return {};
    throw Error('unexpected '+method);
  }};
  const canvas={open:async()=>({scopeId:'fixture'}),close(){},import:async task=>{imports.push({index:task.currentIndex,id:task.id,nodeId:task.targetNodeId,path:task.outputPath});return {nodeId:task.targetNodeId||'generated',url:'https://runninghub.cn/image.png',dimensions:{width:1,height:1},receipt:{ok:true}};}};
  const engine=new ParallelGptImageEngine({root,rpc,canvas,maxConcurrentImages:2,autoRetryLimit:0,retryJitterMs:0,retryBaseMs:40,...options});
  engine.nodes.patch=async(url,node,patch)=>{patches.push({url,node,patch});};
  engine.nodes.references=async()=>[{base64:png.toString('base64')}];
  const turns=()=>calls.filter(c=>c.method==='turn/start');
  const send=(n,method,item)=>engine.onEvent({method,params:{threadId:turns()[n].params.threadId,item,turn:{status:'completed'}}});
  const success=(n,bytes=png)=>send(n,'item/completed',{type:'imageGeneration',status:'completed',result:bytes.toString('base64')});
  const fail=(n,message='HTTP 429')=>{send(n,'item/completed',{type:'imageGeneration',status:'failed',error:message,result:''});send(n,'turn/completed');};
  async function cleanup(){engine.close();if([...engine.jobs.values()].every(j=>['complete','failed','interrupted'].includes(j.status)))await until(()=>engine.workers.size===0);await Promise.all([...engine.jobs.values()].map(j=>j.saving?.catch(()=>{})));await rm(root,{recursive:true,force:true});}
  return {engine,root,calls,imports,patches,turns,send,success,fail,cleanup};
}
const node=()=> 'codex-image-'+randomUUID();

test('four nodes start by default before any output exists and the fifth waits for a free slot',async()=>{
  const f=await fixture({maxConcurrentImages:undefined});try{
    assert.equal((await f.engine.status()).concurrency.maxConcurrentImages,4);
    const jobs=[];for(let i=0;i<5;i++)jobs.push(await f.engine.create(canvasUrl,{prompt:'node '+i,targetNodeId:node()}));
    await until(()=>f.turns().length===4);assert.equal(f.imports.length,0);assert.equal(f.engine.workers.size,4);
    assert.equal(f.engine.jobs.get(jobs[4].id).status,'queued');
    assert.equal(new Set(f.turns().map(t=>t.params.threadId)).size,4);
    f.success(3);await until(()=>f.turns().length===5);for(const i of [4,2,0,1])f.success(i);
    await until(()=>f.engine.pendingJobCount===0);
    assert.equal(f.imports.length,5);assert.deepEqual(f.imports.map(x=>x.nodeId).sort(),jobs.map(j=>j.targetNodeId).sort());
  }finally{await f.cleanup();}
});
test('lowering concurrency drains existing images; raising it immediately starts queued nodes',async()=>{
  const f=await fixture({maxConcurrentImages:4});try{
    for(let i=0;i<7;i++)await f.engine.create(canvasUrl,{prompt:'node '+i,targetNodeId:node()});
    await until(()=>f.turns().length===4);await f.engine.setConcurrency(1);assert.equal(f.engine.workers.size,4);
    for(const i of [0,1,2])f.success(i);await until(()=>f.engine.workers.size===1);assert.equal(f.turns().length,4);
    assert.equal(f.calls.filter(c=>c.method==='turn/interrupt').length,3); // Only finished images were interrupted for early delivery.
    await f.engine.setConcurrency(3);await until(()=>f.turns().length===6);assert.equal(f.engine.workers.size,3);
    f.success(3);await until(()=>f.turns().length===7);for(const i of [4,5,6])f.success(i);
    await until(()=>f.engine.pendingJobCount===0);assert.equal(f.imports.length,7);
  }finally{await f.cleanup();}
});
test('settings persist atomically across restarts and simultaneous saves finish in order',async()=>{
  const f=await fixture();try{
    const values=await Promise.all([f.engine.setConcurrency(4),f.engine.setConcurrency(1),f.engine.setConcurrency(3)]);
    assert.deepEqual(values.map(x=>x.maxConcurrentImages),[4,1,3]);assert.ok(values[0].updatedAt<values[1].updatedAt&&values[1].updatedAt<values[2].updatedAt);
    const saved=JSON.parse(await readFile(f.engine.settingsPath));assert.equal(saved.maxConcurrentImages,3);
    if(process.platform!=='win32')assert.equal((await stat(f.engine.settingsPath)).mode&0o777,0o600);
    const restarted=new ParallelGptImageEngine({root:f.root,rpc:{close(){}},canvas:{close(){}}});
    try{await restarted.list(canvasUrl);assert.equal(restarted.schedulerState().maxConcurrentImages,3);}finally{restarted.close();}
    assert.equal(f.turns().length,0);
  }finally{await f.cleanup();}
});
test('invalid settings cannot alter the current selection',async()=>{
  const f=await fixture();try{
    await f.engine.setConcurrency(3);
    for(const v of [0,5,2.5,'4',null,undefined,NaN,Infinity])await assert.rejects(()=>f.engine.setConcurrency(v),/1–4/);
    assert.equal(f.engine.maxConcurrentImages,3);assert.equal(JSON.parse(await readFile(f.engine.settingsPath)).maxConcurrentImages,3);
  }finally{await f.cleanup();}
});
test('corrupt saved preference falls back to one with a warning and can be repaired by the user',async()=>{
  const f=await fixture({maxConcurrentImages:4});try{
    await writeFile(f.engine.settingsPath,'{bad json');await f.engine.loadSettings();
    assert.equal(f.engine.maxConcurrentImages,1);assert.match(f.engine.schedulerState().warning,/重新选择/);
    await f.engine.setConcurrency(4);assert.equal(f.engine.maxConcurrentImages,4);assert.equal(f.engine.schedulerState().warning,null);
  }finally{await f.cleanup();}
});
test('a failed save preserves the current runtime limit and later saves recover',async()=>{
  const f=await fixture();try{
    await f.engine.loadSettings();await mkdir(f.engine.settingsPath);
    await assert.rejects(()=>f.engine.setConcurrency(4),/保存失败/);assert.equal(f.engine.maxConcurrentImages,2);
    await rm(f.engine.settingsPath,{recursive:true});await f.engine.setConcurrency(3);assert.equal(f.engine.maxConcurrentImages,3);
  }finally{await f.cleanup();}
});
test('raising concurrency does not bypass an actual upstream rate-limit cooldown',async()=>{
  const f=await fixture({maxConcurrentImages:1,autoRetryLimit:1,retryBaseMs:200});try{
    await f.engine.create(canvasUrl,{prompt:'first',targetNodeId:node()});await f.engine.create(canvasUrl,{prompt:'second',targetNodeId:node()});
    await until(()=>f.turns().length===1);f.fail(0);await until(()=>f.engine.retryNotBefore>Date.now());
    await f.engine.setConcurrency(4);await pause(25);assert.equal(f.turns().length,1);
    await until(()=>f.turns().length===3);f.success(1);f.success(2);await until(()=>f.engine.pendingJobCount===0);assert.equal(f.imports.length,2);
  }finally{await f.cleanup();}
});
test('settings HTTP changes require a valid scoped token and exact local Origin',async()=>{
  const f=await fixture(),addon=new GptImageAddon({engine:f.engine});
  const server=createServer((req,res)=>addon.handle(req,res,new URL(req.url,'http://127.0.0.1')));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));addon.base='http://127.0.0.1:'+server.address().port;
  try{
    const html=await(await fetch(addon.base+'/gpt-image/node?canvasUrl='+encodeURIComponent(canvasUrl)+'&nodeId='+node())).text();
    const token=html.match(/name="gpt-image-token" content="([a-f0-9]+)"/)[1];
    const post=(t,origin,value=4)=>fetch(addon.base+'/gpt-image/settings',{method:'POST',headers:{'x-gpt-image-token':t,...(origin?{Origin:origin}:{})},body:JSON.stringify({maxConcurrentImages:value})});
    for(const [t,origin] of [['bad',addon.base],[token,undefined],[token,'https://rhtv.runninghub.cn'],[token,'https://evil.test']])assert.ok((await post(t,origin)).status>=400);
    assert.equal(f.engine.maxConcurrentImages,2);assert.equal((await post(token,addon.base,5)).status,400);
    const response=await post(token,addon.base,4);assert.equal(response.status,200);assert.equal((await response.json()).concurrency.maxConcurrentImages,4);
    const loaded=await(await fetch(addon.base+'/gpt-image/settings',{headers:{'x-gpt-image-token':token}})).json();assert.equal(loaded.concurrency.maxConcurrentImages,4);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.cleanup();}
});

test('same node identifiers on different canvases never share reference/config caches or busy state',async()=>{
  const f=await fixture();try{
    const target=node(),other=canvasUrl.replace('1000000000000000001','1000000000000000002');
    f.engine.nodes.read=async(url,nodeId)=>({ctx:{scopeId:url},node:{id:nodeId,data:{title:url,codexImage:{config:{prompt:url}}}}});
    f.engine.canvas.call=async()=>({nodes:[],edges:[]});
    assert.equal((await f.engine.nodes.state(canvasUrl,target)).config.prompt,canvasUrl);
    assert.equal((await f.engine.nodes.state(other,target)).config.prompt,other);
    const first=await f.engine.create(canvasUrl,{prompt:'first',targetNodeId:target});
    assert.equal(f.engine.isNodeBusy(other,target),false);
    const second=await f.engine.create(other,{prompt:'second',targetNodeId:target});
    await until(()=>f.turns().length===2);f.success(0);f.success(1);
    await until(()=>[first,second].every(j=>f.engine.jobs.get(j.id).status==='complete'));
  }finally{await f.cleanup();}
});

test('racing distinct request IDs for one node reserve exactly one batch',async()=>{
  const f=await fixture();try{
    const targetNodeId=node();
    const results=await Promise.allSettled([f.engine.create(canvasUrl,{prompt:'one',targetNodeId}),f.engine.create(canvasUrl,{prompt:'two',targetNodeId})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
    await until(()=>f.turns().length===1);f.success(0);await until(()=>f.engine.pendingJobCount===0);
  }finally{await f.cleanup();}
});

test('two separate nodes dispatch before either image finishes; third queues and all retain identity',async()=>{
  const f=await fixture();try{
    const a=await f.engine.create(canvasUrl,{prompt:'A',targetNodeId:node()}),b=await f.engine.create(canvasUrl,{prompt:'B',targetNodeId:node()}),c=await f.engine.create(canvasUrl,{prompt:'C',targetNodeId:node()});
    await until(()=>f.turns().length===2);
    assert.equal(f.engine.jobs.get(c.id).status,'queued');assert.equal(f.engine.pendingJobCount,3);assert.equal(f.imports.length,0);
    f.success(1);await until(()=>f.turns().length===3);f.success(2);f.success(0);
    await until(()=>[a,b,c].every(j=>f.engine.jobs.get(j.id).status==='complete')&&f.engine.workers.size===0);
    assert.deepEqual(f.imports.map(i=>i.id).sort(),[a.id,b.id,c.id].sort());assert.equal(f.engine.pendingJobCount,0);
  }finally{await f.cleanup();}
});
test('one four-image batch uses two slots, handles out-of-order results, and commits each index once',async()=>{
  const f=await fixture();try{
    const j=await f.engine.create(canvasUrl,{prompt:'four',targetNodeId:node(),count:4}),job=f.engine.jobs.get(j.id);
    await until(()=>f.turns().length===2);assert.equal(f.engine.view(job).runningCount,2);assert.equal(f.engine.view(job).queuedCount,2);
    f.success(1);await until(()=>f.turns().length===3);f.success(0);await until(()=>f.turns().length===4);f.success(3);f.success(2);
    await until(()=>job.status==='complete'&&f.engine.workers.size===0);
    assert.deepEqual(job.outputs.map(o=>o.index),[0,1,2,3]);assert.equal(new Set(job.outputs.map(o=>o.path)).size,4);assert.equal(f.imports.length,4);
    const saved=JSON.parse(await readFile(join(f.root,job.id,'job.json')));assert.equal(saved.items.length,4);assert.equal(saved.outputs.length,4);assert.equal(saved.status,'complete');
    f.success(0);f.send(1,'turn/completed');await pause();assert.equal(f.imports.length,4);
  }finally{await f.cleanup();}
});
test('same-node image commits are serialized while drawing remains concurrent',async()=>{
  const f=await fixture();try{
    let release,inFlight=0,maximum=0;
    f.engine.canvas.import=async task=>{maximum=Math.max(maximum,++inFlight);if(task.currentIndex===0)await new Promise(r=>release=r);--inFlight;return {nodeId:task.targetNodeId,receipt:{ok:true}};};
    const {id}=await f.engine.create(canvasUrl,{prompt:'two',targetNodeId:node(),count:2});await until(()=>f.turns().length===2);
    f.success(0);await until(()=>!!release);f.success(1);await pause(20);assert.equal(maximum,1);release();
    await until(()=>f.engine.jobs.get(id).status==='complete');assert.equal(maximum,1);assert.equal(f.engine.view(f.engine.jobs.get(id)).completedCount,2);
  }finally{await f.cleanup();}
});
test('same-node simultaneous submits are rejected but replaying a request ID is idempotent',async()=>{
  const f=await fixture();try{
    const targetNodeId=node(),input={requestId:randomUUID(),prompt:'one',targetNodeId};
    const [a,b]=await Promise.all([f.engine.create(canvasUrl,input),f.engine.create(canvasUrl,input)]);assert.equal(a.id,b.id);
    await assert.rejects(()=>f.engine.create(canvasUrl,{prompt:'different',targetNodeId}),/此节点已有/);
    await until(()=>f.turns().length===1);f.success(0);await until(()=>f.engine.jobs.get(a.id).status==='complete');
    assert.equal(f.turns().length,1);
  }finally{await f.cleanup();}
});
test('a failed item preserves its successful sibling and manual resume only generates missing indices',async()=>{
  const f=await fixture();try{
    const {id}=await f.engine.create(canvasUrl,{prompt:'three',targetNodeId:node(),count:3}),job=f.engine.jobs.get(id);
    await until(()=>f.turns().length===2);f.fail(0,'HTTP 429 Cloudflare security verification');f.success(1);
    await until(()=>job.status==='failed'&&f.engine.workers.size===0);assert.equal(f.turns().length,2);assert.deepEqual(job.outputs.map(o=>o.index),[1]);assert.equal(f.engine.view(job).canResume,true);
    const sha=job.outputs[0].sha256;await f.engine.resume(job);await until(()=>f.turns().length===4);f.success(3);f.success(2);
    await until(()=>job.status==='complete');assert.equal(job.outputs.find(o=>o.index===1).sha256,sha);assert.equal(f.imports.length,3);
  }finally{await f.cleanup();}
});
test('unknown transport outcome never retries; a sibling image can still finish',async()=>{
  const f=await fixture();try{
    const {id}=await f.engine.create(canvasUrl,{prompt:'two',count:2}),job=f.engine.jobs.get(id);
    await until(()=>f.turns().length===2);
    f.engine.onEvent({method:'turn/completed',params:{threadId:f.turns()[0].params.threadId,turn:{error:{message:'connection lost'}}}});f.success(1);
    await until(()=>job.status==='failed');assert.equal(f.engine.view(job).canResume,false);assert.equal(job.outputs.length,1);assert.equal(f.turns().length,2);
  }finally{await f.cleanup();}
});
test('ordinary 429 pauses new dispatch globally and bounded retry does not duplicate a completed sibling',async()=>{
  const f=await fixture({autoRetryLimit:1,retryBaseMs:80});try{
    const a=await f.engine.create(canvasUrl,{prompt:'batch',count:2}),job=f.engine.jobs.get(a.id);
    const c=await f.engine.create(canvasUrl,{prompt:'queued'});
    await until(()=>f.turns().length===2);f.fail(0);f.success(1);
    await until(()=>job.items[0].status==='waiting');await pause(15);assert.equal(f.turns().length,2);
    await until(()=>f.turns().length===4);f.success(2);f.success(3);
    await until(()=>job.status==='complete'&&f.engine.jobs.get(c.id).status==='complete');assert.equal(f.imports.length,3);assert.equal(job.items[0].retryAttempt,1);
  }finally{await f.cleanup();}
});
test('stopping one queued/running batch never interrupts another node',async()=>{
  const f=await fixture();try{
    const a=await f.engine.create(canvasUrl,{prompt:'keep',targetNodeId:node()}),b=await f.engine.create(canvasUrl,{prompt:'stop',targetNodeId:node(),count:2});
    await until(()=>f.turns().length===2);const stopped=f.engine.jobs.get(b.id);await f.engine.stop(stopped);
    assert.equal(f.calls.filter(c=>c.method==='turn/interrupt').length,1);f.send(1,'turn/completed');f.success(0);
    await until(()=>stopped.status==='interrupted'&&f.engine.jobs.get(a.id).status==='complete');assert.equal(f.turns().length,2);assert.equal(f.imports.length,1);
  }finally{await f.cleanup();}
});
test('cancelling during an upload preserves both its receipt and the sibling generation',async()=>{
  const f=await fixture();try{
    let release;f.engine.canvas.import=async task=>{if(task.prompt==='upload')await new Promise(r=>release=r);return {nodeId:task.targetNodeId,receipt:{ok:true}};};
    const a=await f.engine.create(canvasUrl,{prompt:'upload',targetNodeId:node()}),b=await f.engine.create(canvasUrl,{prompt:'sibling',targetNodeId:node()});
    await until(()=>f.turns().length===2);f.success(0);await until(()=>!!release);await f.engine.stop(f.engine.jobs.get(a.id));release();f.success(1);
    await until(()=>f.engine.jobs.get(a.id).status==='interrupted'&&f.engine.jobs.get(b.id).status==='complete');assert.equal(f.engine.jobs.get(a.id).outputs[0].uploaded,true);
  }finally{await f.cleanup();}
});
test('reference inputs stay frozen and isolated per native thread',async()=>{
  const f=await fixture();try{
    const a=await f.engine.create(canvasUrl,{prompt:'edit',targetNodeId:node(),mode:'reference',count:2});await until(()=>f.turns().length===2);
    for(const turn of f.turns()){const refs=turn.params.input.filter(i=>i.type==='localImage');assert.equal(refs.length,1);assert.match(refs[0].path,new RegExp(a.id));assert.deepEqual(await readFile(refs[0].path),png);}
    f.success(0);f.success(1);await until(()=>f.engine.jobs.get(a.id).status==='complete');
  }finally{await f.cleanup();}
});
test('service restart marks unfinished parallel jobs interrupted and does not replay any image',async()=>{
  const f=await fixture();try{
    const j=await f.engine.create(canvasUrl,{requestId:randomUUID(),prompt:'restart',count:3});await until(()=>f.turns().length===2);
    await f.engine.jobs.get(j.id).saving;
    const restarted=new ParallelGptImageEngine({root:f.root,rpc:{close(){},request(){throw Error('must not replay');}},canvas:{close(){}}});
    const jobs=await restarted.list(canvasUrl);assert.equal(jobs[0].status,'interrupted');assert.equal(jobs[0].canResume,false);assert.equal(restarted.workers.size,0);restarted.close();
    f.success(0);f.success(1);await until(()=>f.turns().length===3);f.success(2);await until(()=>f.engine.jobs.get(j.id).status==='complete');
  }finally{await f.cleanup();}
});
