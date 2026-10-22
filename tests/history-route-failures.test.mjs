import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CommandJournal} from '../server/command-journal.mjs';
import {HistoryRouteFailures} from '../server/history-route-failures.mjs';

test('route failures survive journal restart, isolate node/site, and ignore blocked retries',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rh-route-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const journal=new CommandJournal(root),record={type:'canvas.runNode',mode:'generate',state:'completed',nodeId:'n',mutationKey:'https://www.runninghub.ai/canvas',createdAt:1};
 const rejected={ok:false,errorCode:'HISTORY_ROUTE_CONFLICT',submissionState:'rejected',historyRoute:{historyId:'old',revision:'0'}};
 await journal.save('rejected',record,rejected);
 await journal.save('blocked',{...record,createdAt:2},{...rejected,submissionState:'not_submitted',historyRoute:{historyId:'new'}});
 const entries=await new CommandJournal(root).load(),records=new Map(entries.map(e=>[e.id,e.record])),results=new Map(entries.map(e=>[e.id,e.result])),guard=new HistoryRouteFailures(records,results);
 assert.equal(guard.forNode(record.mutationKey,'n').historyId,'old');assert.equal(guard.forNode(record.mutationKey,'other'),null);assert.equal(guard.forNode('foreign/canvas','n'),null);
 records.set('later',{...record,createdAt:3});results.set('later',{ok:true,result:{submitted:true,task:{taskId:'actual-task'}}});assert.equal(guard.forNode(record.mutationKey,'n'),null);
 records.set('legacy',{...record,createdAt:4});results.set('legacy',{ok:false,errorCode:'COMMAND_FAILED',error:'Error: RUN_REJECTED: 301: 节点历史路由不属于当前画布\n stack'});assert.equal(guard.forNode(record.mutationKey,'n').requestId,'legacy');
 results.set('legacy',{ok:false,error:'Error: RUN_REJECTED: 301: other message'});assert.equal(guard.forNode(record.mutationKey,'n'),null);
});
