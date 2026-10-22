import test from 'node:test';import assert from 'node:assert/strict';
import {expireQueuedCommands} from '../server/queue-expiry.mjs';
test('offline page queues expire only unsent overdue requests and preserve dispatched/active work',async()=>{
 const queues=new Map([['old',[{id:'read',expiresAt:2},{id:'generation',expiresAt:2},{id:'sent',expiresAt:2},{id:'fresh',expiresAt:200}]]]);
 const records=new Map(['read','generation','sent','fresh'].map(id=>[id,{state:id==='sent'?'dispatched':'queued',mode:id==='generation'?'generate':'read'}])),results=new Map(),persisted=[],notified=[];
 const args={queues,records,results,now:100,persist:async id=>persisted.push(id),notify:id=>{assert.ok(persisted.includes(id));notified.push(id);}};
 assert.deepEqual(await expireQueuedCommands(args),['read','generation']);assert.deepEqual(notified,['read','generation']);assert.equal(records.get('sent').state,'dispatched');assert.equal(records.get('fresh').state,'queued');assert.equal(results.get('generation').submissionState,'not_submitted');assert.equal(results.get('generation').submitted,false);assert.deepEqual(queues.get('old').map(c=>c.id),['sent','fresh']);assert.deepEqual(await expireQueuedCommands(args),[]);
});
