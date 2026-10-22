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

test('scoped command combines session and target lookup, server remains authoritative',async()=>{
 const original=BridgeClient.prototype.request,requests=[];
 try{BridgeClient.prototype.request=async function(path,body){requests.push(path.split('?')[0]);if(path.startsWith('/sessions'))return{access:{origin:'https://www.runninghub.ai',canvasId:'fixture',clientId:'p'},target:{clientId:'p',canvasId:'fixture',canvasOrigin:'https://www.runninghub.ai'}};if(path==='/command')return{id:body.id};if(path.startsWith('/result'))return{ok:true,result:{ok:true}};throw Error(path);};
 const scopes=new TaskScopes(new BridgeClient());await scopes.run('canvas',{scopeId:'scope'},()=>scopes.proxy.command('canvas.summary'));assert.deepEqual(requests,['/sessions','/command','/result']);
 }finally{BridgeClient.prototype.request=original;}
});
