import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {GptImageEngine,validateInput,describeImageFailure,safeErrorText} from './engine.mjs';
import {GptImageAddon,canonicalCanvas} from './routes.mjs';
import {nextImagePosition,imageThumbnailSize} from './canvas.mjs';
import {registerGptImageTools} from './mcp.mjs';

const canvasUrl='https://rhtv.runninghub.cn/project/canvas/1000000000000000001';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const pause=()=>new Promise(r=>setTimeout(r,5));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await pause();}throw Error('test timeout');}
function fixture(root){
  const calls=[],imports=[];
  const rpc={start:async()=>{},close(){},request:async(method,params)=>{
    calls.push({method,params});
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='modelProvider/capabilities/read')return {imageGeneration:true};
    if(method==='thread/start')return {thread:{id:'thread-fixture'}};
    if(method==='turn/start')return {turn:{id:'turn-fixture'}};
    if(method==='turn/interrupt')return {};
    throw Error('unexpected '+method);
  }};
  const canvas={open:async()=>({scopeId:'fixture'}),import:async job=>{imports.push(job.id);return {nodeId:'generated-node',receipt:{ok:true}};},close(){}};
  return {engine:new GptImageEngine({root,rpc,canvas,interImageDelayMs:0,minRequestIntervalMs:0,autoRetryLimit:0,retryJitterMs:0}),calls,imports};
}

test('binds only exact RunningHub canvas URLs',()=>{
  assert.equal(canonicalCanvas(canvasUrl.replace('/project/','/projects/')),canvasUrl);
  for(const url of ['https://evil.test/project/canvas/123','https://www.runninghub.cn.evil.test/project/canvas/123','https://user:pass@rhtv.runninghub.cn/project/canvas/1','https://rhtv.runninghub.cn/'])assert.throws(()=>canonicalCanvas(url));
});
test('validates actual reference bytes and supported image controls',()=>{
  const r=validateInput({prompt:'编辑这张图',ratio:'9:16',transparent:true,references:[{base64:png.toString('base64')}]});
  assert.equal(r.references[0].extension,'png');assert.equal(r.transparent,true);
  for(const value of [{prompt:''},{prompt:'x',ratio:'unsupported'},{prompt:'x',transparent:'true'},{prompt:'x',references:[{base64:'%%%'}]},{prompt:'x',references:[{base64:Buffer.from('not image').toString('base64')}]}])assert.throws(()=>validateInput(value));
});
test('places generated cards in spaced rows below originals',()=>{
  const nodes=[{title:'reference',position:{x:0,y:0},width:1200,height:732}];
  const a=nextImagePosition(nodes);assert.ok(a.y>=952);
  nodes.push({title:'GPT 生图 · one',position:a,width:320,height:180});
  const b=nextImagePosition(nodes);assert.equal(a.y,b.y);assert.ok(b.x-a.x>=520);
  nodes.push({title:'GPT 生图 · two',position:b,width:320,height:180});
  const c=nextImagePosition(nodes);assert.equal(c.y,a.y);assert.ok(c.x>b.x);
});
test('normalizes full-resolution generated images to the native thumbnail sizes',()=>{
  assert.deepEqual(imageThumbnailSize(1254,1254),{width:240,height:240});
  assert.deepEqual(imageThumbnailSize(1920,1080),{width:320,height:180});
  assert.deepEqual(imageThumbnailSize(1080,1920),{width:180,height:320});
  assert.throws(()=>imageThumbnailSize(0,1254));
});
test('native image completion persists verified bytes and imports exactly once',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rh-gpt-image-'));
  try{
    const {engine,calls,imports}=fixture(root);
    const created=await engine.create(canvasUrl,{prompt:'fixture',ratio:'1:1',transparent:false});
    await until(()=>calls.some(c=>c.method==='turn/start'));
    const thread=calls.find(c=>c.method==='thread/start').params;
    assert.equal(thread.sandbox,'read-only');assert.deepEqual(thread.dynamicTools,[]);assert.equal(thread.model,undefined);
    engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',id:'image-fixture',status:'completed',result:png.toString('base64')}}});
    engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}});
    await until(()=>engine.jobs.get(created.id).status==='complete');
    const job=engine.jobs.get(created.id);assert.deepEqual(await readFile(job.outputPath),png);assert.equal(imports.length,1);assert.equal(job.nodeId,'generated-node');
    const saved=JSON.parse(await readFile(join(root,job.id,'job.json'),'utf8'));assert.equal(saved.imageItems,undefined);assert.equal(saved.saving,undefined);
    engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});assert.equal(imports.length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('never imports a model text response as an image',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rh-gpt-image-'));
  try{
    const {engine,calls,imports}=fixture(root),created=await engine.create(canvasUrl,{prompt:'fixture'});
    await until(()=>calls.some(c=>c.method==='turn/start'));
    engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
    await until(()=>engine.jobs.get(created.id).status==='failed');assert.equal(imports.length,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('preserves HTTP 429 from the failed image tool and prevents an immediate duplicate generation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rh-gpt-image-'));
  try{
    const {engine,calls,imports}=fixture(root),created=await engine.create(canvasUrl,{prompt:'一只小狗'});
    await until(()=>calls.some(c=>c.method==='turn/start'));
    engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',id:'failed-native-image',status:'failed',result:''}}});
    engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'agentMessage',text:'生成失败：生图服务返回 429（请求过多），请稍后重试。'}}});
    engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
    await until(()=>engine.jobs.get(created.id).status==='failed');
    const job=engine.jobs.get(created.id);await job.saving;
    assert.equal(job.errorCode,'IMAGE_RATE_LIMITED');assert.match(engine.view(job).error,/HTTP 429/);assert.equal(imports.length,0);
    assert.equal(job.imageDiagnostics[0].status,'failed');assert.equal(job.imageDiagnostics[0].inlineResultLength,0);
    await assert.rejects(()=>engine.create(canvasUrl,{prompt:'一只小狗'}),/刚刚限流/);
    assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
    const restarted=fixture(root);await restarted.engine.list(canvasUrl);assert.ok(restarted.engine.retryNotBefore>Date.now());
  }finally{await rm(root,{recursive:true,force:true});}
});
test('historic generic image failure exposes the original service reason',()=>{
  const {engine}=fixture('/unused');
  const view=engine.view({id:'historic',status:'failed',error:'原生生图没有返回完成的图片。',message:'生图服务返回 429（请求过多），请稍后重试。'});
  assert.equal(view.errorCode,'IMAGE_RATE_LIMITED');assert.match(view.error,/HTTP 429/);
});
test('confirmed gateway rejection can be manually continued but unknown outcomes cannot',()=>{
 const {engine}=fixture('/unused');
 const job={id:'gateway',status:'failed',errorCode:'IMAGE_GATEWAY_REJECTED',dispatchOutcome:'rejected',outputs:[]};
 assert.equal(engine.view(job).canResume,true);
 job.dispatchOutcome='unknown';job.imageDiagnostics=[{status:'failed',hasSavedPath:false,inlineResultLength:0}];
 assert.equal(engine.view(job).canResume,false);
 job.dispatchOutcome='rejected';job.outputs=[{index:0,uploaded:false}];
 assert.equal(engine.view(job).canResume,false);
});
test('structured usage limits are distinguished from a temporary HTTP 429',()=>{
  const failure=describeImageFailure({failure:{type:'usageLimitExceeded',resetsAt:1793629990},message:'HTTP 429'});
  assert.equal(failure.code,'IMAGE_USAGE_LIMIT');assert.equal(failure.resetsAt,1793629990);
});
test('diagnostic text redacts credentials and preserves useful status codes',()=>{
  const text=safeErrorText('HTTP 429 Bearer sample-secret https://example.test/?token=secret&api_key=private sk-test-secret');
  assert.match(text,/HTTP 429/);for(const secret of ['sample-secret','token=secret','api_key=private','sk-test-secret'])assert.equal(text.includes(secret),false);
});
test('rejects files outside generated-image directories before reading them',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rh-gpt-image-'));
  try{
    const {engine}=fixture(root);const outside=join(root,'outside.png');await writeFile(outside,png);await mkdir(join(root,'job'));
    await assert.rejects(()=>engine.completedBytes({id:'job'},{status:'completed',savedPath:outside}),/超出/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('requires ChatGPT sign-in instead of falling back to an API key',async()=>{
  const rpc={start:async()=>{},request:async()=>({account:{type:'apiKey'}})};
  const engine=new GptImageEngine({rpc,canvas:{}});await assert.rejects(()=>engine.status(),/不会改走 API Key/);
});
test('same request ID never starts a second generation, including after restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rh-gpt-image-'));
  try{
    const {engine,calls}=fixture(root),input={requestId:'a0000000-0000-4000-8000-000000000001',prompt:'fixture'};
    const first=await engine.create(canvasUrl,input);await until(()=>calls.some(c=>c.method==='turn/start'));
    await engine.jobs.get(first.id).saving;
    const second=await engine.create(canvasUrl,input);assert.equal(second.id,first.id);assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
    await assert.rejects(()=>engine.create(canvasUrl,{...input,prompt:'different'}),/不同的生图内容/);
    const restarted=fixture(root);const recovered=await restarted.engine.create(canvasUrl,input);
    assert.equal(recovered.id,first.id);assert.equal(recovered.status,'interrupted');assert.equal(restarted.calls.length,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('cancel during canvas connection prevents the image-generation turn',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rh-gpt-image-'));
  try{
    const {engine,calls}=fixture(root);let release;engine.canvas.open=()=>new Promise(r=>{release=r;});
    const created=await engine.create(canvasUrl,{prompt:'fixture'});await until(()=>!!release);
    await engine.stop(engine.jobs.get(created.id));release({});await until(()=>engine.jobs.get(created.id).status==='interrupted');
    assert.equal(calls.some(c=>c.method==='turn/start'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('MCP cannot generate or upload through a read-only canvas scope',async()=>{
  const handlers=new Map();let targetCalls=0;
  registerGptImageTools((name,description,schema,handler)=>handlers.set(name,handler),{request:async()=>({access:{allowWrites:false}}),target:async()=>{targetCalls++;}});
  await assert.rejects(()=>handlers.get('rh_gpt_image_generate')({referencePaths:[],prompt:'fixture'}),/只读/);assert.equal(targetCalls,0);
});
test('HTTP generation requires a scoped token and exact local Origin',async()=>{
  let creates=0;
  const engine={status:async()=>({imageGeneration:true}),list:async()=>[],create:async()=>{creates++;return {id:'fixture'};},jobs:new Map()};
  const addon=new GptImageAddon({engine});
  const server=createServer((req,res)=>addon.handle(req,res,new URL(req.url,'http://127.0.0.1')));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  addon.base='http://127.0.0.1:'+server.address().port;
  try{
    const html=await (await fetch(addon.base+'/gpt-image/ui?canvasUrl='+encodeURIComponent(canvasUrl))).text();
    const token=html.match(/name="gpt-image-token" content="([a-f0-9]+)"/)[1];
    for(const origin of [undefined,'https://evil.test','https://rhtv.runninghub.cn']){
      const r=await fetch(addon.base+'/gpt-image/generate',{method:'POST',headers:{'x-gpt-image-token':token,...(origin?{Origin:origin}:{})},body:'{}'});assert.ok(r.status>=400);
    }
    assert.equal(creates,0);
    const r=await fetch(addon.base+'/gpt-image/generate',{method:'POST',headers:{'x-gpt-image-token':token,Origin:addon.base},body:'{}'});assert.equal(r.status,202);assert.equal(creates,1);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('batch generates sequentially and preserves every completed result',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rh-gpt-batch-'));
  try{
    const {engine,calls,imports}=fixture(root),created=await engine.create(canvasUrl,{prompt:'two variations',count:2});
    for(let index=0;index<2;index++){
      await until(()=>calls.filter(c=>c.method==='turn/start').length===index+1);
      assert.equal(imports.length,index);
      engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',id:'image-'+index,status:'completed',result:png.toString('base64')}}});
      engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
    }
    await until(()=>engine.jobs.get(created.id).status==='complete');
    const j=engine.jobs.get(created.id);assert.equal(j.outputs.length,2);assert.equal(engine.view(j).completedCount,2);assert.notEqual(j.outputs[0].path,j.outputs[1].path);assert.equal(imports.length,2);
    for(const o of j.outputs)assert.deepEqual(await readFile(o.path),png);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('failure during a batch keeps the first image and never starts remaining images',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rh-gpt-partial-'));
  try{
    const {engine,calls,imports}=fixture(root),created=await engine.create(canvasUrl,{prompt:'batch',count:3});
    await until(()=>calls.filter(c=>c.method==='turn/start').length===1);
    engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'completed',result:png.toString('base64')}}});
    engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
    await until(()=>calls.filter(c=>c.method==='turn/start').length===2);
    engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'failed',error:'HTTP 429'}}});
    engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
    await until(()=>engine.jobs.get(created.id).status==='failed');
    assert.equal(imports.length,1);assert.equal(engine.view(engine.jobs.get(created.id)).completedCount,1);assert.equal(calls.filter(c=>c.method==='turn/start').length,2);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('batch count and node identity are validated before dispatch',()=>{
  for(const count of [0,5,1.5,'2'])assert.throws(()=>validateInput({prompt:'x',count}));
  assert.throws(()=>validateInput({prompt:'x',targetNodeId:'ordinary-node'}));
});

test('explicit resume keeps the same batch and does not regenerate its completed image',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-gpt-resume-'));
 try{
  const {engine,calls,imports}=fixture(root),created=await engine.create(canvasUrl,{prompt:'batch',count:2});
  await until(()=>calls.filter(c=>c.method==='turn/start').length===1);
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'completed',result:png.toString('base64')}}});engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
  await until(()=>calls.filter(c=>c.method==='turn/start').length===2);
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'failed',error:'HTTP 429'}}});engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
  const job=engine.jobs.get(created.id);await until(()=>job.status==='failed');assert.equal(engine.view(job).canResume,true);
  await assert.rejects(()=>engine.resume(job),/等待期/);engine.retryNotBefore=0;
  await engine.resume(job);await until(()=>calls.filter(c=>c.method==='turn/start').length===3);
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'completed',result:png.toString('base64')}}});engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
  await until(()=>job.status==='complete');assert.equal(imports.length,2);assert.deepEqual(job.outputs.map(o=>o.index),[0,1]);assert.equal(job.id,created.id);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('cancelling between batch images clears the timer and never starts another image',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-gpt-spacing-'));
 try{
  const {engine,calls}=fixture(root);engine.interImageDelayMs=60000;
  const created=await engine.create(canvasUrl,{prompt:'batch',count:2});await until(()=>calls.some(c=>c.method==='turn/start'));
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'completed',result:png.toString('base64')}}});engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
  const job=engine.jobs.get(created.id);await until(()=>engine.timers.has(job.id));await engine.stop(job);assert.equal(job.status,'interrupted');assert.equal(engine.timers.size,0);assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('completed image imports before assistant turn finishes and late turn events never duplicate it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-gpt-early-'));
 try{
  const {engine,calls,imports}=fixture(root),created=await engine.create(canvasUrl,{prompt:'early'});
  await until(()=>calls.some(c=>c.method==='turn/start'));
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',id:'image',status:'completed',result:png.toString('base64')}}});
  await until(()=>engine.jobs.get(created.id).status==='complete');
  assert.equal(imports.length,1);assert.ok(calls.some(c=>c.method==='turn/interrupt'));
  engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'interrupted',error:{message:'interrupted after image'}}}});
  assert.equal(engine.jobs.get(created.id).status,'complete');assert.equal(imports.length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('known rejected image auto-retries only the unfinished batch index and preserves completed bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-gpt-autoretry-'));
 try{
  const {engine,calls,imports}=fixture(root);engine.autoRetryLimit=2;engine.retryBaseMs=30;
  const created=await engine.create(canvasUrl,{prompt:'batch',count:2}),job=engine.jobs.get(created.id);
  await until(()=>calls.filter(c=>c.method==='turn/start').length===1);
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'completed',result:png.toString('base64')}}});
  await until(()=>calls.filter(c=>c.method==='turn/start').length===2);
  const hash=job.outputs[0].sha256;
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'failed',error:'HTTP 429',result:''}}});
  engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
  await until(()=>job.status==='waiting');assert.equal(job.waitReason,'rate_limit');assert.equal(job.currentIndex,1);assert.equal(job.retryCounts[1],1);
  await until(()=>calls.filter(c=>c.method==='turn/start').length===3);
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'completed',result:png.toString('base64')}}});
  await until(()=>job.status==='complete');assert.equal(imports.length,2);assert.equal(job.outputs[0].sha256,hash);assert.deepEqual(job.outputs.map(o=>o.index),[0,1]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('automatic retry has a hard per-image limit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-gpt-retry-cap-'));
 try{
  const {engine,calls}=fixture(root);engine.autoRetryLimit=2;engine.retryBaseMs=10;
  const {id}=await engine.create(canvasUrl,{prompt:'limited'}),job=engine.jobs.get(id);
  for(let n=1;n<=3;n++){
   await until(()=>calls.filter(c=>c.method==='turn/start').length===n);
   engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'failed',error:'HTTP 429',result:''}}});engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
  }
  await until(()=>job.status==='failed');assert.equal(job.retryCounts[0],2);assert.equal(engine.timers.size,0);assert.equal(calls.filter(c=>c.method==='turn/start').length,3);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('an explicitly authorized single attempt cannot automatically submit again',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-gpt-single-attempt-'));
 try{
  const {engine,calls}=fixture(root);engine.autoRetryLimit=2;
  assert.throws(()=>validateInput({prompt:'x',autoRetryLimit:3}));
  const {id}=await engine.create(canvasUrl,{prompt:'once',autoRetryLimit:0}),job=engine.jobs.get(id);
  await until(()=>calls.some(c=>c.method==='turn/start'));
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'failed',error:'HTTP 429',result:''}}});
  engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
  await until(()=>job.status==='failed');assert.equal(engine.view(job).maxAutoRetries,0);assert.equal(engine.timers.size,0);
  assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('quota, gateway challenge and uncertain failures are never automatically retried',async()=>{
 assert.equal(describeImageFailure({message:'HTTP 429 Cloudflare enable JavaScript and cookies'}).code,'IMAGE_GATEWAY_REJECTED');
 const root=await mkdtemp(join(tmpdir(),'rh-gpt-no-replay-'));
 try{
  const {engine,calls}=fixture(root);engine.autoRetryLimit=2;engine.retryBaseMs=10;
  const {id}=await engine.create(canvasUrl,{prompt:'quota'});await until(()=>calls.some(c=>c.method==='turn/start'));
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'failed',failure:{type:'usageLimitExceeded'}}}});engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
  await until(()=>engine.jobs.get(id).status==='failed');assert.equal(engine.jobs.get(id).errorCode,'IMAGE_USAGE_LIMIT');assert.equal(engine.timers.size,0);
  const job={id,root,status:'running',currentIndex:0,outputs:[],imageItems:[],message:''};engine.active=job;await engine.fail(job,Error('HTTP 429 transport unknown'));assert.equal(job.status,'failed');assert.equal(engine.timers.size,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('pacing counts time already spent generating instead of always sleeping after upload',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-gpt-pacing-'));
 try{
  const {engine,calls}=fixture(root);engine.minRequestIntervalMs=1000;engine.lastDispatchAt=Date.now()-2000;
  const {id}=await engine.create(canvasUrl,{prompt:'no extra delay'});await until(()=>calls.some(c=>c.method==='turn/start'));
  assert.equal(engine.timers.size,0);engine.lastDispatchAt=Date.now()-2000;
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'completed',result:png.toString('base64')}}});await until(()=>engine.jobs.get(id).status==='complete');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('stopping a rate-limit wait clears automatic continuation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-gpt-stop-retry-'));
 try{
  const {engine,calls}=fixture(root);engine.autoRetryLimit=2;
  const {id}=await engine.create(canvasUrl,{prompt:'stop retry'}),job=engine.jobs.get(id);
  await until(()=>calls.some(c=>c.method==='turn/start'));
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'failed',error:'HTTP 429',result:''}}});
  engine.onEvent({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
  await until(()=>engine.timers.has(id));await engine.stop(job);
  assert.equal(job.status,'interrupted');assert.equal(engine.active,null);assert.equal(engine.timers.size,0);assert.equal(job.nextImageAt,null);
  assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a disconnected Codex process is reconnected before the next batch image',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-gpt-reconnect-'));
 try{
  const {engine,calls}=fixture(root);
  engine.canvas.import=async()=>{engine.onEvent({method:'local/disconnected'});return {nodeId:'generated-node',receipt:{ok:true}};};
  const {id}=await engine.create(canvasUrl,{prompt:'batch reconnect',count:2}),job=engine.jobs.get(id);
  await until(()=>calls.filter(c=>c.method==='turn/start').length===1);
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'completed',result:png.toString('base64')}}});
  await until(()=>calls.filter(c=>c.method==='turn/start').length===2);
  assert.equal(calls.filter(c=>c.method==='account/read').length,2);
  engine.onEvent({method:'item/completed',params:{threadId:'thread-fixture',item:{type:'imageGeneration',status:'completed',result:png.toString('base64')}}});
  await until(()=>job.status==='complete');assert.equal(job.outputs.length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
