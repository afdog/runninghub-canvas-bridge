import test from 'node:test';import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {BridgeClient,createMcpServer} from '../server/mcp.mjs';
import {recoverReceipt} from '../server/receipt-recovery.mjs';
const canvasUrl='https://www.runninghub.ai/project/canvas/fixture',requestId='rh-'+'a'.repeat(64);
test('both receipt tools recover after restart with an expired scope and no live browser',async()=>{
 const original=BridgeClient.prototype.request,calls=[];
 BridgeClient.prototype.request=async path=>{calls.push(path.split('?')[0]);if(path.startsWith('/sessions'))return{access:null};if(path.startsWith('/command-record'))return{record:{canvasUrl,state:'completed'},result:{ok:true,result:{saved:true}}};throw Error('Unexpected browser dependency');};
 const server=createMcpServer(new BridgeClient()),client=new Client({name:'recovery',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{await server.connect(a);await client.connect(b);
  for(const name of ['rh_command_result','rh_recover_command']){const r=await client.callTool({name,arguments:{requestId,scopeId:'00000000-0000-4000-8000-000000000001'}});assert.equal(r.isError,undefined);assert.equal(r.structuredContent.result.saved,true);assert.equal(r.structuredContent.replayed,false);}
  assert.ok(calls.every(p=>['/sessions','/command-record'].includes(p)));
 }finally{await client.close();await server.close();BridgeClient.prototype.request=original;}
});
test('logical recovery IDs require original canvas identity and reject mismatched records',async()=>{
 const bridge={request:async()=>({record:{canvasUrl,state:'completed'},result:{ok:true}})};
 await assert.rejects(recoverReceipt(bridge,{requestId:'logical-id'}),/RECOVERY_CANVAS_REQUIRED/);
 await assert.rejects(recoverReceipt(bridge,{requestId,canvasUrl:'https://www.runninghub.ai/project/canvas/other'}),/RECEIPT_CANVAS_MISMATCH/);
 const r=await recoverReceipt(bridge,{requestId:'logical-id',canvasUrl});assert.match(r.requestId,/^rh-[a-f0-9]{64}$/);
});
test('permission errors while reading receipts stop immediately and preserve the original submitted identity',async()=>{
 const b=new BridgeClient();b.canvasUrl=canvasUrl;b.target=async()=>({clientId:'c',canvasId:'fixture',canvasOrigin:'https://www.runninghub.ai'});let reads=0,posts=0;
 b.request=async(path,body)=>{if(path==='/command'){posts++;return{id:body.id};}reads++;throw Object.assign(Error('PERMISSION_DENIED'),{status:403});};
 const result=await b.command('canvas.runNode',{nodeId:'n'},{id:'original-run'});assert.equal(posts,1);assert.equal(reads,1);assert.equal(result.requestId,b.wireId('original-run'));assert.equal(result.submissionState,'unknown');assert.equal(result.recoveryErrorCode,'PERMISSION_DENIED');
});
