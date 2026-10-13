import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/browser-pump.js';
test('one failed lane cannot overlap active jobs; a new wake recovers after transport failure',async()=>{
 let release, polls=0,queued,executions=0;const gate=new Promise(r=>release=r);
 const pump=globalThis.createRHBrowserPump({poll:async()=>{polls++;if(polls===1)throw new Error('offline');if(polls===2){await gate;return {id:'one'};}return null;},execute:async()=>{executions++;return {ok:true};},complete:async()=>{},schedule:fn=>(queued=fn,1),cancel:()=>{}});
 const first=pump.wake();await new Promise(r=>setImmediate(r));assert.equal(pump.isRunning(),true);assert.equal(pump.wake(),first);assert.equal(polls,4);
 release();await first;assert.equal(executions,1);assert.equal(pump.isRunning(),false);await queued();assert.equal(polls,8);pump.stop();
});
