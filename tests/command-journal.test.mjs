import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandJournal } from '../server/command-journal.mjs';
import { BridgeClient } from '../server/bridge-client.mjs';
test('durable receipts distinguish never-dispatched requests from uncertain ones across repeated restarts',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rh-回执 with spaces-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const journal=new CommandJournal(root);
  await await journal.save('queued',{state:'queued'});
  await await journal.save('sent',{state:'dispatched',nodeId:'node'});
  await await journal.save('done',{state:'completed'},{ok:true,result:{task:{taskId:'task-1'}}});
  let entries=(await new CommandJournal(root).load());
  assert.equal(entries.find(e=>e.id==='queued').result.errorCode,'COMMAND_NOT_DISPATCHED');
  assert.equal(entries.find(e=>e.id==='sent').record.state,'unknown');
  assert.equal(entries.find(e=>e.id==='done').result.result.task.taskId,'task-1');
  entries=(await new CommandJournal(root).load());assert.equal(entries.find(e=>e.id==='sent').record.state,'unknown');
});
test('logical IDs are stable across reconnects and scoped to exact canvas origin',()=>{
  const a=new BridgeClient(),b=new BridgeClient();
  a.canvasUrl=b.canvasUrl='https://www.runninghub.ai/project/canvas/a';a.sessionId='old';b.sessionId='new';
  assert.equal(a.wireId('same-request'),b.wireId('same-request'));
  b.canvasUrl='https://rhtv.runninghub.ai/project/canvas/a';assert.notEqual(a.wireId('same-request'),b.wireId('same-request'));
  assert.equal(b.wireId(a.wireId('same-request')),a.wireId('same-request'));
});

test('uncertain page write receipts keep their original ID and survive journal reload',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rh-write-unknown-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const journal=new CommandJournal(root),bridge=new BridgeClient();
 bridge.canvasUrl='https://www.runninghub.ai/project/canvas/fixture';
 bridge.target=async()=>({clientId:'page',canvasId:'fixture',canvasOrigin:'https://www.runninghub.ai'});
 let submissions=0;
 const id=bridge.wireId('original-edit');
 const event={ok:false,commandId:id,submissionState:'unknown',errorCode:'CANVAS_WRITE_OUTCOME_UNKNOWN'};
 bridge.request=async path=>{
  if(path==='/command'){submissions++;return{id};}
  assert.ok(path.startsWith('/result?id='+id+'&waitMs='));return event;
 };
 const reply=await bridge.command('canvas.updateNodeText',{nodeId:'n',text:'kept'},{id:'original-edit'});
 assert.equal(submissions,1);assert.equal(reply.ok,false);assert.equal(reply.submissionState,'unknown');assert.equal(reply.requestId,id);
 await journal.save(id,{state:'unknown',nodeId:'n'},event);
 const recovered=(await new CommandJournal(root).load())[0];
 assert.equal(recovered.record.state,'unknown');assert.deepEqual(recovered.result,event);
});

test('corrupt receipt is quarantined, healthy receipts load and identity remains blocked across restarts',async t=>{
 const {writeFile}=await import('node:fs/promises'),{createHash}=await import('node:crypto');
 const root=await mkdtemp(join(tmpdir(),'rh-corrupt-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const j=new CommandJournal(root);await j.save('good',{state:'completed'},{ok:true});
 await writeFile(join(root,createHash('sha256').update('bad').digest('hex')+'.json'),'{');
 assert.equal((await j.load()).length,1);assert.equal(j.isQuarantined('bad'),true);assert.equal(j.status().quarantined,1);
 const restarted=new CommandJournal(root);await restarted.load();assert.equal(restarted.isQuarantined('bad'),true);await assert.rejects(restarted.save('bad',{}),/QUARANTINED/);
});
test('retention drops only old terminal reads and keeps edits, generation and unknown records',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rh-retain-'));t.after(()=>rm(root,{recursive:true,force:true}));const j=new CommandJournal(root),records=new Map(),results=new Map();
 for(const [id,mode,state]of [['old','read','completed'],['new','read','completed'],['uncertain','read','unknown'],['edit','edit','completed'],['generate','generate','completed']]){const r={mode,state,createdAt:id==='new'?999:1};records.set(id,r);results.set(id,{ok:true});await j.save(id,r,results.get(id));}
 await j.prune(records,results,{now:1000,maxAgeMs:100});assert.equal(records.has('old'),false);assert.equal(results.has('old'),false);assert.equal(records.size,4);assert.equal((await j.load()).length,4);
});

test('old receipts are classified for retention without deleting legacy writes or unknown outcomes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rh-legacy-retention-'));t.after(()=>rm(root,{recursive:true,force:true}));const original=new CommandJournal(root);
 for(const [id,type,state] of [['read','canvas.summary','completed'],['write','canvas.runNode','completed'],['unknown','canvas.summary','unknown']])await original.save(id,{type,state,createdAt:1});
 const j=new CommandJournal(root,{classify:r=>r.type==='canvas.summary'?'read':'generate'}),loaded=await j.load(),records=new Map(loaded.map(e=>[e.id,e.record]));await j.prune(records,new Map(),{now:1000,maxAgeMs:10});assert.deepEqual([...records.keys()].sort(),['unknown','write']);
});
