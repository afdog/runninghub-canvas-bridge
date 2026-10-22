import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ResultWaiters} from '../server/result-waiters.mjs';
test('result completion wakes all subscribers, closes and timeouts leave no listeners',async()=>{
 const w=new ResultWaiters(),res=new EventEmitter();let value;
 const a=w.wait('x',()=>value,{waitMs:1000,response:res}),b=w.wait('x',()=>value,{waitMs:1000});value={ok:true};w.notify('x');assert.deepEqual(await a,value);assert.deepEqual(await b,value);assert.equal(w.waiters.size,0);assert.equal(res.listenerCount('close'),0);
 const c=w.wait('none',()=>null,{waitMs:1000,response:res});res.emit('close');assert.equal(await c,null);assert.equal(w.waiters.size,0);
 assert.equal(await w.wait('timeout',()=>null,{waitMs:10}),null);assert.equal(w.waiters.size,0);
 assert.deepEqual(await w.wait('immediate',()=>value,{waitMs:1000}),value);
});
