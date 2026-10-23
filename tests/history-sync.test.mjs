import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{HistorySync}from'../server/history-sync.mjs';
test('history reconciliation survives restart, retries only index reads/writes, and never opens a canvas',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-history-')),calls=[];let pending=true,now=1;
 const bridgeFactory=()=>({select:async(...a)=>calls.push(['select',...a]),command:async(type,args)=>{calls.push([type,args]);return{result:pending?{pending:true,reason:'TASK_RUNNING'}:{result:{nodeId:'node-a',changed:true,historyStorage:{resultCount:2}}}};}});
 try{
 const worker=new HistorySync({root,bridgeFactory,now:()=>now});await worker.init();
 const record={type:'canvas.runNode',nodeId:'node-a',canvasUrl:'https://www.runninghub.ai/project/canvas/canvas-a'},event={ok:true,result:{submitted:true,task:{taskId:'task-1'}}};
 await worker.accept(record,{...event,result:{submitted:false}});assert.equal(worker.jobs.size,0);
 await worker.accept(record,event);await worker.accept(record,event);assert.equal(worker.jobs.size,1);
 await worker.tick();assert.equal(worker.status()[0].state,'waiting');
 const resumed=new HistorySync({root,bridgeFactory,now:()=>now});await resumed.init();pending=false;now=20000;await resumed.tick();assert.equal(resumed.status()[0].state,'complete');
 const count=calls.length;await resumed.tick();assert.equal(calls.length,count);
 assert.ok(calls.every(c=>c[0]==='select'||c[0]==='canvas.platformWrite'&&c[1].operation==='syncNodeHistory'));assert.equal(calls.find(c=>c[0]==='canvas.platformWrite')[1].body.taskId,'task-1');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('unknown generation is not queued; generation wrapper and transient reconciliation failures retain the exact identity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-history-'));try{const w=new HistorySync({root,now:()=>1,bridgeFactory:()=>({select:async()=>{throw Error('CANVAS_NOT_CONNECTED')}})});await w.init();
 const record={type:'canvas.generateVideoNode',nodeId:'node-a',canvasUrl:'https://www.runninghub.ai/project/canvas/canvas-a'};
 await w.accept(record,{ok:true,result:{run:{submitted:false,submissionState:'unknown'}}});assert.equal(w.jobs.size,0);
 await w.accept(record,{ok:true,result:{run:{submitted:true,task:{taskId:'real-task'}}}});await w.tick();const j=w.status()[0];assert.equal(j.taskId,'real-task');assert.equal(j.state,'waiting');assert.match(j.error,/NOT_CONNECTED/);assert.ok(j.nextAttemptAt>1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('permanent conflicts are blocked once, persisted across restart, and resumed only explicitly',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-history-'));let calls=0,now=1;
 const bridgeFactory=()=>({select:async()=>{},command:async()=>{calls++;return{ok:false,requestId:'same-history-receipt',errorCode:'COMMAND_FAILED',error:'Error: HISTORY_EMBEDDED_ENTRY_CONFLICT\n at merge'};}});
 try{
  const w=new HistorySync({root,bridgeFactory,now:()=>now});await w.init();await w.accept({type:'canvas.runNode',nodeId:'n',canvasUrl:'https://www.runninghub.ai/project/canvas/c'},{ok:true,result:{submitted:true,task:{taskId:'t'}}});
  await w.tick();now+=600000;await w.tick();assert.equal(calls,1);assert.equal(w.status()[0].state,'blocked');assert.equal(w.status()[0].blockedReason,'HISTORY_EMBEDDED_ENTRY_CONFLICT');
  const restored=new HistorySync({root,bridgeFactory,now:()=>now});await restored.init();await restored.tick();assert.equal(calls,1);
  await restored.resume({canvasUrl:'https://www.runninghub.ai/project/canvas/other',nodeId:'n'});await restored.tick();assert.equal(calls,1);
  await restored.resume({canvasUrl:'https://www.runninghub.ai/project/canvas/c',nodeId:'n',taskId:'t'});await restored.tick();assert.equal(calls,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('transient retries have a budget and old conflicting jobs stop before another command',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rh-history-'));let now=1,calls=0;
 try{
  const w=new HistorySync({root,maxFailures:2,now:()=>now,bridgeFactory:()=>({select:async()=>{},command:async()=>{calls++;throw Error('fetch failed');}})});await w.init();
  const j=await w.accept({type:'canvas.runNode',nodeId:'n',canvasUrl:'https://www.runninghub.ai/project/canvas/c'},{ok:true,result:{submitted:true,task:{taskId:'t'}}});await w.tick();now+=600000;await w.tick();now+=600000;await w.tick();assert.equal(calls,2);assert.equal(j.state,'blocked');
  j.state='waiting';j.error='COMMAND_FAILED';j.failureReceipt={ok:false,requestId:'older-receipt',errorCode:'COMMAND_FAILED',error:'Error: HISTORY_EMBEDDED_ENTRY_CONFLICT'};await w.save(j);
  const restored=new HistorySync({root,bridgeFactory:w.bridgeFactory});await restored.init();assert.equal(restored.status()[0].state,'blocked');await restored.tick();assert.equal(calls,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
