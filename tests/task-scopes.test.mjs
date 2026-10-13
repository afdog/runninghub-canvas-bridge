import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskScopes} from '../server/task-scopes.mjs';
import {BridgeClient} from '../server/bridge-client.mjs';
test('interleaved tasks retain independent clients and never overwrite selection',async()=>{
 const scopes=new TaskScopes(new BridgeClient());
 const a={sessionId:'A',canvasUrl:'canvas-A'},b={sessionId:'B',canvasUrl:'canvas-B'};
 scopes.resolve=async id=>id==='A'?a:b;
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const results=await Promise.all([scopes.run('canvas',{scopeId:'A'},async()=>{await wait(30);return {seen:scopes.proxy.canvasUrl};}),scopes.run('canvas',{scopeId:'B'},async()=>{await wait(5);return {seen:scopes.proxy.canvasUrl};})]);
 assert.equal(results[0].seen,'canvas-A');assert.equal(results[1].seen,'canvas-B');assert.equal(scopes.base.canvasUrl,null);
 await assert.rejects(scopes.run('canvas',{},async()=>({})),/TASK_SCOPE_REQUIRED/);
});

test('pinned page never falls back to another browser showing the same canvas',async()=>{
 const client=new BridgeClient();client.canvasUrl='https://rhtv.runninghub.ai/project/canvas/123';client.pinnedClientId='internal';
 client.request=async()=>[{clientId:'external',href:client.canvasUrl,runtimeFreshness:'fresh'},{clientId:'internal',href:client.canvasUrl,runtimeFreshness:'fresh'}];
 assert.equal((await client.target()).clientId,'internal');
 const scopes=new TaskScopes(client);const original=BridgeClient.prototype.request;
 try{BridgeClient.prototype.request=async()=>({access:{origin:'https://rhtv.runninghub.ai',canvasId:'123',clientId:'internal'}});assert.equal((await scopes.resolve('scope')).pinnedClientId,'internal');}finally{BridgeClient.prototype.request=original;}
});
