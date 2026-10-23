import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const featureSource=await readFile(new URL('../server/canvas-features.js',import.meta.url),'utf8'),layoutSource=await readFile(new URL('../server/layout-template.js',import.meta.url),'utf8');
test('indexed revisions preserve hashes including self edges and ignored selection fields',async()=>{
 const ctx={crypto:webcrypto,TextEncoder};vm.runInNewContext(featureSource,ctx);const f=ctx.RHCanvasFeatures;
 const raw={nodes:Array.from({length:1000},(_,i)=>({id:String(i),selected:true,data:{text:'hello'}})),edges:Array.from({length:999},(_,i)=>({id:'e'+i,source:String(i),target:String(i+1)}))};raw.edges.push({id:'self',source:'1',target:'1'});
 const indexed=f.indexSnapshot(raw),before=await f.revision(raw,'1');raw.nodes.find=()=>{throw Error('linear node scan');};raw.edges.filter=()=>{throw Error('linear edge scan');};
 assert.equal(await f.revision(indexed,'1'),before);assert.equal(f.indexedNode(indexed,'missing'),undefined);assert.equal(f.nodeState(indexed,'1').edges.length,3);
});
test('dimension requests share an in-flight decode and cache; new output and URL invalidate it',async()=>{
 let loads=0,fail=false,now=1000;const ctx={setTimeout,clearTimeout,Date:{now:()=>now},document:{createElement:()=>({naturalWidth:1080,naturalHeight:1920,set src(v){loads++;queueMicrotask(()=>fail?this.onerror?.():this.onload?.());},removeAttribute(){}})}};
 vm.runInNewContext(layoutSource,ctx);const layout=ctx.RHLayoutTemplate;
 const nodes=['a','b'].map(id=>({id,type:'rh-image',data:{imageUrl:'https://example.invalid/portrait.png'}}));
 const read=()=>layout.resolveMediaSizes({nodes},['a','b']);await Promise.all([read(),read()]);assert.equal(loads,1);await read();assert.equal(loads,1);
 nodes[1].data.imageUrl='https://example.invalid/new.png';await read();assert.equal(loads,2);
 now+=600001;await read();assert.equal(loads,4);
 nodes[1].data.output=[{url:'https://example.invalid/new.png',outputId:'v2'}];await read();assert.equal(loads,5);
 fail=true;nodes[1].data.output[0].url='https://example.invalid/fail.png';await read();await read();assert.equal(loads,7);
});

test('new portrait outputs and history selections override old unbound node dimensions',async()=>{
 let loads=0;
 const ctx={setTimeout,clearTimeout,structuredClone,document:{createElement:()=>({videoWidth:1080,videoHeight:1920,naturalWidth:1080,naturalHeight:1920,set src(v){loads++;queueMicrotask(()=>this.onloadedmetadata?.());},removeAttribute(){},load(){}})}};
 vm.runInNewContext(layoutSource,ctx);const l=ctx.RHLayoutTemplate;
 for(const kind of ['video','image']){
  const node={id:kind,type:'rh-'+kind,data:{[kind+'Width']:1920,[kind+'Height']:1080,[kind+'Url']:'https://example.invalid/original-'+kind,output:[{url:'https://example.invalid/new-'+kind,outputType:kind,outputId:'new'}]}};
  let result=await l.resolveMediaSizes({nodes:[node]},[kind]);assert.equal(result.sizes[kind].width,1080);assert.equal(result.sizes[kind].height,1920);
  const normalized=l.normalize(node,result.sizes[kind]);assert.equal(normalized.width,180);assert.equal(normalized.height,320);
  node.data.output=[{url:'https://example.invalid/landscape-'+kind,outputType:kind,outputId:'first',width:1920,height:1080},{url:'https://example.invalid/history-'+kind,outputType:kind,outputId:'portrait'}];node.data.selectedHistoryOutputId='portrait';
  result=await l.resolveMediaSizes({nodes:[node]},[kind]);assert.equal(result.sizes[kind].height,1920);assert.equal(l.normalize(node,result.sizes[kind]).height,320);
 }
 assert.equal(loads,4);
});
test('decode failure reports unresolved media instead of treating old node dimensions as intrinsic',async()=>{
 const ctx={setTimeout,clearTimeout,structuredClone,document:{createElement:()=>({set src(v){queueMicrotask(()=>this.onerror?.());},removeAttribute(){},load(){}})}};
 vm.runInNewContext(layoutSource,ctx);const l=ctx.RHLayoutTemplate,node={id:'x',type:'rh-video',data:{videoUrl:'https://example.invalid/replaced.mp4',videoWidth:1920,videoHeight:1080,params:{aspectRatio:'9:16'}}};
 const result=await l.resolveMediaSizes({nodes:[node]},['x']);assert.equal(result.sizes.x,undefined);assert.deepEqual([...result.unresolved],['x']);assert.equal(l.aspect(node).source,'parameters');
 node.data.output=[{url:'https://example.invalid/known.mp4',width:1080,height:1920}];const known=await l.resolveMediaSizes({nodes:[node]},['x']);assert.equal(known.sizes.x.height,1920);
});
test('execution revisions include real upstream bindings but ignore layout and unrelated work',async()=>{
 const ctx={crypto:webcrypto,TextEncoder};vm.runInNewContext(featureSource,ctx);const f=ctx.RHCanvasFeatures;
 const s={nodes:[{id:'app',position:{x:1,y:2},data:{aiApp:{inputNodes:[{binding:{sourceNodeId:'ref'}}]}}},{id:'ref',data:{output:[{url:'https://example.test/a.png'}]}},{id:'other',data:{status:'running'}}],edges:[{id:'ref-app',source:'ref',target:'app'}]};
 const before=f.canonical(f.executionState(s,'app'));s.nodes[2].data.status='finished';s.nodes[0].position.x=30;assert.equal(f.canonical(f.executionState(s,'app')),before);
 s.nodes[1].data.output[0].url='https://example.test/b.png';assert.notEqual(f.canonical(f.executionState(s,'app')),before);
 s.nodes[1].data.output[0].url='https://example.test/a.png';s.edges=[];assert.notEqual(f.canonical(f.executionState(s,'app')),before);
});
test('metadata reads coalesce, expire, refresh and isolate account contexts without sharing mutable results',async()=>{
 const ctx={crypto:webcrypto,TextEncoder};vm.runInNewContext(featureSource,ctx);let calls=0,now=0,account='A',fail=false;
 const api=async()=>{calls++;if(fail)throw Error('offline');return [{type:'TEXT_VIDEO',modelList:[{modelCode:'fixture',config:[{paramName:'prompt',paramValue:'initial'}]}]}];};
 const f=ctx.RHCanvasFeatures.create({api,now:()=>now,getMetadataContext:()=>account,metadataTtlMs:100});
 const args={modelCode:'fixture',types:['TEXT_VIDEO']};
 const [first,second]=await Promise.all([f.modelSchema(args),f.modelSchema(args)]);assert.equal(calls,1);assert.equal(second.cache.hit,true);first.models[0].parameters[0].raw.paramValue='mutated';
 assert.equal((await f.modelSchema(args)).models[0].parameters[0].raw.paramValue,'initial');assert.equal(calls,1);
 await f.modelSchema({...args,refresh:true});assert.equal(calls,2);now=200;await f.modelSchema(args);assert.equal(calls,3);
 account='B';await f.modelSchema(args);assert.equal(calls,4);fail=true;await assert.rejects(f.modelSchema({...args,refresh:true}));fail=false;await f.modelSchema(args);assert.equal(calls,6);
});
test('metadata in flight is rejected when the account or team changes',async()=>{
 const ctx={crypto:webcrypto,TextEncoder};vm.runInNewContext(featureSource,ctx);let context='A',finish;
 const f=ctx.RHCanvasFeatures.create({api:()=>new Promise(r=>finish=r),getMetadataContext:()=>context});
 const pending=f.listModels({types:['video']});await Promise.resolve();context='B';finish([]);await assert.rejects(pending,/METADATA_CONTEXT_CHANGED/);
});
test('input projection retains complete prompt text without expanding saved history',()=>{
 const ctx={};vm.runInNewContext(featureSource,ctx);const f=ctx.RHCanvasFeatures;
 const node={id:'n',data:{params:{prompt:'完整对白'.repeat(2000)},output:[{url:'result'}],nodeOutputHistory:[{old:true}],bridgeHistoryRecovery:{privateHistory:true}}};
 const projected=f.nodeView(node,'inputs');assert.equal(projected.data.params.prompt,node.data.params.prompt);assert.equal(projected.data.nodeOutputHistory,undefined);assert.equal(projected.data.bridgeHistoryRecovery,undefined);assert.equal(f.nodeView(node,'outputs').data.output[0].url,'result');assert.equal(f.nodeView(node,'full'),node);
});
