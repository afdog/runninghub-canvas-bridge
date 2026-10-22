import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import '../server/canvas-features.js';
import '../extension/site-policy.js';
import '../server/production-features.js';
globalThis.location=new URL('https://www.runninghub.ai/project/canvas/canvas-a');
const clone=structuredClone;
const toYValue=(Y,v)=>{if(Array.isArray(v)){const a=new Y.Array();a.push(v.map(x=>toYValue(Y,x)));return a;}if(v&&typeof v==='object'){const m=new Y.Map();for(const[k,x]of Object.entries(v))m.set(k,toYValue(Y,x));return m;}return v;};
function fixture({pages,alterTask,changeBeforeWrite,unavailable=[],existingHistory,embedded}={}){
 const original={id:'node-a',type:'rh-video',position:{x:4,y:9},data:{taskId:'task-2',output:[{url:'https://example.com/2.mp4',taskId:'task-2'}],params:{prompt:'keep',seed:42},references:['ref'],accepted:true,nodeOutputHistory:[{id:'legacy'}],selectedOutputHistoryId:'legacy'}};
 if(existingHistory)original.data.historyStorage=existingHistory;
 if(embedded!==undefined)original.data.nodeOutputHistory=embedded;
 const doc=new Y.Doc(),nodes=doc.getArray('nodes'),edges=doc.getArray('edges');edges.push([toYValue(Y,{id:'edge',source:'ref',target:'node-a'})]);nodes.push([toYValue(Y,original)]);
 const page={schemaVersion:1,canvasId:'canvas-a',nodeId:'node-a',historyId:'own-history',revision:'0',resultCount:2,totalBatchCount:2,pageNum:1,hasNext:false,batches:[1,2].map(i=>({batchId:'batch-'+i,taskId:'task-'+i,outputs:[{outputId:'output-'+i,url:`https://example.com/${i}.mp4`}]}))};
 const calls=[];const api=async(path,body)=>{calls.push({path,body});if(path==='/canvas/node-history/page')return clone(pages?.[body.pageNum-1]||page);if(path==='/canvas/task/batchStatus')return {tasks:body.taskIds.filter(id=>!unavailable.includes(id)).map(id=>{const task={taskId:id,canvasId:'canvas-a',status:'SUCCESS',plans:[{nodeId:'node-a',outputs:[{url:`https://example.com/${id.slice(-1)}.mp4`}]}]};alterTask?.(task);return task;})};throw Error('Unexpected API '+path);};
 const tools=globalThis.RHProductionFeatures.create({api,toYValue,readSnapshot:async()=>({nodes:nodes.toJSON(),edges:edges.toJSON()}),withMutation:async(c,fn)=>{changeBeforeWrite?.(nodes.get(0).get('data'));if(c.dryRun){const preview=new Y.Doc();Y.applyUpdate(preview,Y.encodeStateAsUpdate(doc));try{return {applied:false,result:fn({Y,doc:preview,nodes:preview.getArray('nodes'),edges:preview.getArray('edges')})};}finally{preview.destroy();}}return {applied:true,result:fn({Y,doc,nodes,edges})};}});
 return {tools,nodes,doc,original,page,calls};
}
test('native index repair changes only historyStorage; exact counts, task/output bindings and idempotency',async()=>{
 const f=fixture(),before=f.nodes.toJSON();
 const preview=await f.tools.syncNodeHistory({nodeId:'node-a',dryRun:true});assert.equal(preview.applied,false);assert.deepEqual(f.nodes.toJSON(),before);
 const r=await f.tools.syncNodeHistory({nodeId:'node-a'});assert.equal(r.result.verifiedTasks,2);assert.equal(r.result.historyStorage.revision,'0');
 const after=f.nodes.toJSON();assert.equal(after[0].data.historyStorage.resultCount,2);delete after[0].data.historyStorage;assert.deepEqual(after,before);
 assert.equal((await f.tools.syncNodeHistory({nodeId:'node-a'})).result.changed,false);assert.equal(f.calls.some(x=>x.path.includes('/run')),false);f.doc.destroy();
});
test('history ownership, task output and count mismatches never write',async()=>{
 for(const mutate of [p=>p.nodeId='other',p=>p.canvasId='other',p=>p.resultCount=3,p=>p.batches.push(p.batches[0])]){
  const seed=fixture(),page=clone(seed.page);seed.doc.destroy();mutate(page);const f=fixture({pages:[page]}),before=f.nodes.toJSON();await assert.rejects(f.tools.syncNodeHistory({nodeId:'node-a'}),/HISTORY_/);assert.deepEqual(f.nodes.toJSON(),before);f.doc.destroy();
 }
 for(const alterTask of [t=>t.canvasId='foreign',t=>t.plans[0].nodeId='foreign',t=>t.plans[0].outputs=[]]){
  const f=fixture({alterTask}),before=f.nodes.toJSON();await assert.rejects(f.tools.syncNodeHistory({nodeId:'node-a'}),/HISTORY_TASK_/);assert.deepEqual(f.nodes.toJSON(),before);f.doc.destroy();
 }
});
test('paginated reads carry knownRevision; concurrent history changes fail closed',async()=>{
 const seed=fixture(),first={...seed.page,batches:seed.page.batches.slice(0,1),hasNext:true},second={...seed.page,batches:seed.page.batches.slice(1),pageNum:2};seed.doc.destroy();
 const f=fixture({pages:[first,second]});await f.tools.syncNodeHistory({nodeId:'node-a'});assert.equal(f.calls.filter(c=>c.path.endsWith('/page'))[1].body.knownRevision,'0');f.doc.destroy();
 const conflict=fixture({pages:[first,{...second,revision:'1'}]});await assert.rejects(conflict.tools.syncNodeHistory({nodeId:'node-a'}),/HISTORY_CHANGED/);conflict.doc.destroy();
 const race=fixture({changeBeforeWrite:d=>d.set('taskId','new-task')});await assert.rejects(race.tools.syncNodeHistory({nodeId:'node-a'}),/EDIT_CONFLICT/);assert.equal(race.nodes.toJSON()[0].data.historyStorage,undefined);race.doc.destroy();
});
test('running jobs wait, and a single real result never receives a fabricated second entry',async()=>{
 const running=fixture({alterTask:t=>t.status='RUNNING'});assert.equal((await running.tools.syncNodeHistory({nodeId:'node-a',taskId:'task-2'})).reason,'TASK_RUNNING');assert.equal(running.nodes.toJSON()[0].data.historyStorage,undefined);running.doc.destroy();
 const seed=fixture(),page={...seed.page,resultCount:1,totalBatchCount:1,batches:[seed.page.batches[0]]};seed.doc.destroy();const f=fixture({pages:[page]});assert.equal((await f.tools.syncNodeHistory({nodeId:'node-a'})).result.historyButtonEligible,false);f.doc.destroy();
});


test('archived tasks do not block an already-owned native index; missing or foreign pointers cannot claim them',async()=>{
 const owned={source:'remote',schemaVersion:1,historyId:'own-history',revision:'0',resultCount:1};
 const f=fixture({unavailable:['task-1'],existingHistory:owned});const r=await f.tools.syncNodeHistory({nodeId:'node-a',taskId:'task-2'});assert.equal(r.result.verifiedTasks,1);assert.equal(r.result.archivedTasks,1);assert.equal(r.result.historyStorage.resultCount,2);f.doc.destroy();
 for(const existingHistory of [undefined,{...owned,historyId:'foreign'}]){const x=fixture({unavailable:['task-1'],existingHistory});await assert.rejects(x.tools.syncNodeHistory({nodeId:'node-a'}),/HISTORY_TASK_UNAVAILABLE/);x.doc.destroy();}
});

test('apply native history restores only chosen state, preserves links/adoption and rejects changed revisions',async()=>{
 const seed=fixture(),page=structuredClone(seed.page);seed.doc.destroy();page.batches[0].paramsSnapshot={prompt:'past',seed:7};
 const f=fixture({pages:[page]}),before=f.nodes.toJSON()[0],args={nodeId:'node-a',historyId:'own-history',knownRevision:'0',outputId:'output-1',restoreParams:false};
 await f.tools.applyNodeHistory({...args,dryRun:true});assert.deepEqual(f.nodes.toJSON()[0],before);
 await f.tools.applyNodeHistory(args);let after=f.nodes.toJSON()[0];assert.equal(after.data.output[0].url,'https://example.com/1.mp4');assert.deepEqual(after.data.params,before.data.params);assert.equal(after.data.accepted,true);assert.deepEqual(after.data.references,before.data.references);assert.deepEqual(after.position,before.position);
 await f.tools.applyNodeHistory({...args,restoreParams:true});after=f.nodes.toJSON()[0];assert.deepEqual(after.data.params,{prompt:'past',seed:7});assert.equal(after.data.taskId,'task-2','native selected output is separate from latest submitted task');
 await assert.rejects(f.tools.applyNodeHistory({...args,knownRevision:'changed'}),/REVISION_CONFLICT/);await assert.rejects(f.tools.deleteNodeHistory(args),/CURRENT_OUTPUT/);assert.ok(f.calls.every(x=>!x.path.includes('/run')));f.doc.destroy();
});
test('an authoritative empty native index clears the displayed count without altering current media',async()=>{
 const seed=fixture(),page={...seed.page,batches:[],resultCount:0,totalBatchCount:0,revision:'next'};seed.doc.destroy();
 const f=fixture({pages:[page],existingHistory:{source:'remote',schemaVersion:1,historyId:'own-history',revision:'0',resultCount:2}}),before=f.nodes.toJSON()[0].data.output;
 await f.tools.syncNodeHistory({nodeId:'node-a'});assert.equal(f.nodes.toJSON()[0].data.historyStorage.resultCount,0);assert.deepEqual(f.nodes.toJSON()[0].data.output,before);f.doc.destroy();
});


test('route diagnosis preserves unresolved history and only synchronizes a verified replacement index',async t=>{
 const owned={source:'remote',schemaVersion:1,historyId:'own-history',revision:'0',resultCount:2};
 for(const historyId of ['own-history',null]){
  const f=fixture({existingHistory:owned});t.after(()=>f.doc.destroy());const before=f.nodes.toJSON();
  const r=await f.tools.syncNodeHistory({nodeId:'node-a',historyRouteFailure:{requestId:'rejected',historyId}});
  assert.equal(r.ok,false);assert.equal(r.changed,false);assert.equal(r.historyRoute.blocked,true);assert.deepEqual(f.nodes.toJSON(),before);
 }
 const f=fixture({existingHistory:{...owned,historyId:'rejected-route'}});t.after(()=>f.doc.destroy());
 const historyRouteFailure={requestId:'rejected',historyId:'rejected-route'};
 const before=f.nodes.toJSON();assert.equal((await f.tools.inspectHistoryRoute({nodeId:'node-a',historyRouteFailure})).synchronized,false);
 const r=await f.tools.syncNodeHistory({nodeId:'node-a',historyRouteFailure});assert.equal(r.result.historyRoute.recovered,true);assert.equal(r.result.verifiedTasks,2);
 const after=f.nodes.toJSON();after[0].data.historyStorage=before[0].data.historyStorage;assert.deepEqual(after,before);
 assert.equal((await f.tools.inspectHistoryRoute({nodeId:'node-a',historyRouteFailure})).synchronized,true);assert.equal(f.calls.some(c=>c.path.endsWith('/run')),false);
});


test('explicit route repair preserves exact native identities and original media; preview is inert and repeated repair idempotent',async t=>{
 const old={source:'remote',schemaVersion:1,historyId:'own-history',revision:'0',resultCount:2};
 const f=fixture({existingHistory:old,embedded:[]});t.after(()=>f.doc.destroy());const before=f.nodes.toJSON();
 const args={nodeId:'node-a',repairRoute:true,historyRouteFailure:{requestId:'original-rejection',historyId:'own-history'}};
 const preview=await f.tools.syncNodeHistory({...args,dryRun:true});assert.deepEqual(f.nodes.toJSON(),before);assert.equal(preview.result.preservedResults,2);
 await assert.rejects(f.tools.syncNodeHistory(args),/REVISION_REQUIRED/);
 const fixed=await f.tools.syncNodeHistory({...args,expectedRevisions:preview.result.expectedRevisions});assert.equal(fixed.result.routeRepaired,true);assert.equal(fixed.result.generationTriggered,false);
 const after=f.nodes.toJSON(),data=after[0].data;assert.equal(data.historyStorage.source,'embedded');assert.equal(data.historyStorage.historyId,undefined);assert.deepEqual(data.bridgeHistoryRecovery.original.batches,f.page.batches);
 assert.deepEqual(data.nodeOutputHistory.map(b=>b.taskId).sort(),['task-1','task-2']);assert.deepEqual(data.nodeOutputHistory.flatMap(b=>b.outputs.map(o=>o.historyOutputId)).sort(),['output-1','output-2']);
 data.historyStorage=before[0].data.historyStorage;data.nodeOutputHistory=before[0].data.nodeOutputHistory;delete data.bridgeHistoryRecovery;assert.deepEqual(after,before);
 const repeat=await f.tools.syncNodeHistory({...args,expectedRevisions:preview.result.expectedRevisions});assert.equal(repeat.result.changed,false);
 const route=await f.tools.inspectHistoryRoute(args);assert.equal(route.blocked,false);assert.equal(route.synchronized,true);assert.ok(f.calls.every(c=>!c.path.endsWith('/run')));
});

test('route repair refuses missing receipts, unverifiable tasks, damaged embedded data and concurrent edits',async t=>{
 const own={source:'remote',schemaVersion:1,historyId:'own-history',revision:'0',resultCount:2};
 const args={nodeId:'node-a',repairRoute:true,dryRun:true,historyRouteFailure:{requestId:'reject',historyId:'own-history'}};
 for(const options of [{unavailable:['task-1']},{alterTask:x=>x.canvasId='other'},{embedded:[{id:'legacy'}]},{changeBeforeWrite:d=>d.set('params',toYValue(Y,{prompt:'changed'}))}]){
  const f=fixture({existingHistory:own,embedded:[],...options});t.after(()=>f.doc.destroy());await assert.rejects(f.tools.syncNodeHistory(args),/HISTORY_|EDIT_CONFLICT/);assert.equal(f.nodes.toJSON()[0].data.bridgeHistoryRecovery,undefined);
 }
 const f=fixture({existingHistory:own,embedded:[]});t.after(()=>f.doc.destroy());await assert.rejects(f.tools.syncNodeHistory({...args,historyRouteFailure:null}),/RECEIPT_REQUIRED/);
});

test('later remote history cannot hide preserved generations; old outputs remain readable and selectable',async t=>{
 const seed=fixture(),first=structuredClone(seed.page);seed.doc.destroy();const pages=[first];
 const f=fixture({pages,embedded:[],existingHistory:{source:'remote',schemaVersion:1,historyId:first.historyId,revision:'0',resultCount:2}});t.after(()=>f.doc.destroy());
 const args={nodeId:'node-a',repairRoute:true,historyRouteFailure:{requestId:'reject',historyId:first.historyId}};
 const pre=await f.tools.syncNodeHistory({...args,dryRun:true});await f.tools.syncNodeHistory({...args,expectedRevisions:pre.result.expectedRevisions});
 const batch={batchId:'batch-3',taskId:'task-3',createdAt:3,outputs:[{outputId:'output-3',url:'https://example.com/3.mp4'}]};
 pages[0]={...first,historyId:'new-history',resultCount:1,totalBatchCount:1,batches:[batch]};
 // Simulate a native result replacing the display pointer and removing old embedded entries.
 f.nodes.get(0).get('data').set('historyStorage',toYValue(Y,{source:'remote',schemaVersion:1,historyId:'new-history',resultCount:1,revision:'0'}));f.nodes.get(0).get('data').set('nodeOutputHistory',toYValue(Y,[]));
 const sync=await f.tools.syncNodeHistory({nodeId:'node-a',taskId:'task-3'});assert.equal(sync.result.preservedResults,3);assert.equal(f.nodes.toJSON()[0].data.historyStorage.source,'embedded');
 const read=await f.tools.platformRead({operation:'nodeHistory',body:{nodeId:'node-a'}});assert.equal(read.resultCount,1);assert.equal(read.preservedHistory.resultCount,2);assert.equal(read.combinedLocalResultCount,3);
 const batch4={batchId:'batch-4',taskId:'task-4',createdAt:4,outputs:[{outputId:'output-4',url:'https://example.com/4.mp4'}]};pages[0]={...first,historyId:'third-history',resultCount:1,totalBatchCount:1,batches:[batch4]};
 f.nodes.get(0).get('data').set('nodeOutputHistory',toYValue(Y,[]));
 const second=await f.tools.syncNodeHistory({nodeId:'node-a',taskId:'task-4'});assert.equal(second.result.preservedResults,4);
 const all=await f.tools.platformRead({operation:'nodeHistory',body:{nodeId:'node-a'}});assert.equal(all.preservedHistories.length,3);assert.equal(all.embeddedHistory.length,4);
 await f.tools.applyNodeHistory({nodeId:'node-a',historyId:'new-history',knownRevision:'0',outputId:'output-3',restoreParams:false});assert.equal(f.nodes.toJSON()[0].data.output[0].url,'https://example.com/3.mp4');

 await f.tools.applyNodeHistory({nodeId:'node-a',historyId:'own-history',knownRevision:'0',outputId:'output-1',restoreParams:false});assert.equal(f.nodes.toJSON()[0].data.output[0].url,'https://example.com/1.mp4');assert.equal(f.nodes.toJSON()[0].data.accepted,true);
 const damaged=f.nodes.get(0).get('data');damaged.set('nodeOutputHistory',toYValue(Y,[]));await assert.rejects(f.tools.inspectHistoryRoute(args),/CONTENT_MISSING/);
});
