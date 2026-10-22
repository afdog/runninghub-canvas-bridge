import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/browser-pump.js';
import {BrowserBroker} from '../server/browser-broker.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
test('free lanes accept fifth job while first is slow; repeated wake never duplicates active lanes',async()=>{
 let release,polls=0,active=0,maxActive=0;const gate=new Promise(r=>release=r),timers=new Set(),executed=[];
 const pump=globalThis.createRHBrowserPump({poll:async()=>({id:++polls}),execute:async job=>{executed.push(job.id);maxActive=Math.max(maxActive,++active);if(job.id===1)await gate;active--;return{ok:true};},complete:async()=>{},schedule:fn=>{timers.add(fn);return fn;},cancel:fn=>timers.delete(fn)});
 const first=pump.wake();await tick();assert.equal(polls,4);assert.equal(timers.size,3);
 const fn=[...timers][0];timers.delete(fn);await fn();assert.ok(executed.includes(5));assert.equal(active,1);
 const next=pump.wake();await tick();assert.equal(executed.filter(id=>id===1).length,1);assert.ok(maxActive<=4);
 pump.stop();release();await Promise.all([first,next]);assert.equal(timers.size,0);
});
test('failed receipt retries same result without rerunning job; stop cancels scheduled lanes',async()=>{
 let calls=0,runs=0;const receipts=[],queued=[];
 const pump=globalThis.createRHBrowserPump({poll:async()=>++calls===1?{id:'one'}:null,execute:async()=>{runs++;return{ok:true};},complete:async(job,result)=>{receipts.push({job,result});if(receipts.length===1)throw Error('lost');},schedule:(fn,delay)=>{queued.push(fn);return fn;},cancel:()=>{}});
 await pump.wake();await Promise.all(queued.splice(0).map(fn=>fn()));pump.stop();assert.equal(runs,1);assert.equal(receipts.length,2);assert.deepEqual(receipts[0],receipts[1]);
});
test('browser receipts are idempotent only for same lease and payload',()=>{
 const b=new BrowserBroker(),{id}=b.enqueue({action:'listCanvases'}),j=b.poll();const receipt={id,lease:j.lease,result:{canvases:[],complete:true}};
 b.complete(receipt);assert.equal(b.complete(receipt).duplicate,true);assert.throws(()=>b.complete({...receipt,lease:'wrong'}),/MISMATCH/);assert.throws(()=>b.complete({...receipt,result:{canvases:[],complete:false}}),/MISMATCH/);
});
test('older bridges back off immediate empty responses',()=>{assert.equal(globalThis.nextBrowserPollDelay(null,12),1500);assert.equal(globalThis.nextBrowserPollDelay(null,12000),0);});

test('synchronous poll failure leaves lanes free for a later wake',async()=>{
 let calls=0;const p=globalThis.createRHBrowserPump({poll:()=>{calls++;throw Error('offline');},execute:()=>{},complete:()=>{},schedule:()=>1,cancel:()=>{}});
 await p.wake();assert.equal(p.isRunning(),false);await p.wake();assert.equal(calls,8);p.stop();
});

test('broker restart retires lost read receipts and all four lanes accept new work without replay',async()=>{
 let broker=new BrowserBroker(),polls=0,executions=0,release;const gate=new Promise(r=>release=r),retired=[];
 for(let i=0;i<4;i++)broker.enqueue({action:'listCanvases'});
 const pump=globalThis.createRHBrowserPump({poll:async()=>{polls++;return broker.poll();},execute:async()=>{executions++;await gate;return{canvases:[],complete:true};},complete:async(job,result)=>{try{return broker.complete({id:job.id,lease:job.lease,result});}catch(e){if(e.receipt)return e.receipt;throw e;}},schedule:()=>1,cancel:()=>{},report:(code,receipt)=>{if(code==='BROWSER_RECEIPT_RETIRED')retired.push(receipt);}});
 const first=pump.wake();await tick();broker=new BrowserBroker();const fresh=broker.enqueue({action:'listCanvases'});release();await first;
 assert.equal(retired.length,4);await pump.wake();pump.stop();assert.equal(executions,5);assert.equal(polls,8);assert.equal(broker.result(fresh.id).state,'complete');
});
test('original durable browser lease reconciles a late receipt after restart; mismatched leases retire',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'rh-late-browser-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const b=new BrowserBroker(root),{id}=b.enqueue({action:'manageCanvas',operation:'renameCanvas',requestId:'late-original',body:{id:'fixture',name:'renamed'}}),job=b.poll();
 const restored=new BrowserBroker(root);assert.equal(restored.result(id).state,'unknown');
 assert.throws(()=>restored.complete({id,lease:'foreign',result:{ok:true,data:{}}}),e=>e.receipt?.receiptDisposition==='retired');
 const receipt={id,lease:job.lease,result:{ok:true,data:{id:'fixture'}}};restored.complete(receipt);assert.equal(restored.result(id).state,'complete');assert.equal(restored.complete(receipt).duplicate,true);assert.equal(new BrowserBroker(root).result(id).state,'complete');assert.equal(restored.poll(),null);
});
test('expired browser job receipts retire instead of retrying forever',()=>{
 const b=new BrowserBroker(),{id}=b.enqueue({action:'listCanvases'}),job=b.poll();b.jobs.get(id).created=Date.now()-300001;b.poll();
 assert.throws(()=>b.complete({id,lease:job.lease,result:{canvases:[]}}),e=>e.receipt?.id===id&&e.receipt?.receiptDisposition==='retired');
});

test('extension HTTP adapter accepts only explicit terminal rejections and retries transient transport failures',async()=>{
 const {readFile}=await import('node:fs/promises'),vm=await import('node:vm');const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('async function completeBrowserJob'),source.indexOf('const transport='));let response;
 const ctx={BASE:'http://127.0.0.1',AbortSignal,fetch:async()=>response};vm.runInNewContext(code,ctx);const job={id:'id',lease:'lease'};
 response={ok:false,status:409,json:async()=>({ok:false,id:'id',receiptDisposition:'retired',errorCode:'BROWSER_RECEIPT_MISMATCH'})};assert.equal((await ctx.completeBrowserJob(job,{})).receiptDisposition,'retired');
 for(const bad of [{ok:false,status:503,json:async()=>({error:'offline'})},{ok:false,status:409,json:async()=>({ok:false,id:'foreign',receiptDisposition:'retired',errorCode:'BROWSER_RECEIPT_MISMATCH'})},{ok:true,status:200,json:async()=>({ok:false})}]){response=bad;await assert.rejects(ctx.completeBrowserJob(job,{}),/RECEIPT_FAILED/);}
});

test('invalid result from the original lease leaves an inspectable unknown job, not permanent busy state',()=>{
 const broker=new BrowserBroker(),{id}=broker.enqueue({action:'listCanvases'}),job=broker.poll();
 assert.throws(()=>broker.complete({id,lease:job.lease,result:{unexpected:true}}),e=>e.receipt?.errorCode==='BROWSER_RESULT_INVALID');
 assert.equal(broker.result(id).state,'unknown');assert.equal(broker.status().pending,0);assert.match(broker.result(id).result.error,/do not replay/);
});
