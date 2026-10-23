import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer,BridgeClient} from '../server/mcp.mjs';
import {TaskScopes} from '../server/task-scopes.mjs';
import {assertCommandSucceeded,CommandResultError} from '../server/command-result.mjs';
import {MediaOperations} from '../server/media-operations.mjs';
const href='https://www.runninghub.ai/project/canvas/fixture';
async function linked(t,bridge){const server=createMcpServer(bridge),client=new Client({name:'receipt-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});return client;}
test('real BridgeClient to MCP preserves failed and unknown receipts in composed tools without downstream mutations',async t=>{
 let event,commands=[];
 const b=new BridgeClient();b.canvasUrl=href;b.target=async()=>({clientId:'fixture',canvasId:'fixture',canvasOrigin:'https://www.runninghub.ai'});
 b.request=async(path,body)=>{if(path==='/command'){commands.push(body.type);return{id:body.id};}return event;};
 const client=await linked(t,{canvasUrl:href,command:b.command.bind(b),request:async()=>{throw Error('unexpected side effect');}});
 for(const failed of [{ok:false,errorCode:'NODE_NOT_FOUND',error:'Node not found: deleted'},{ok:false,errorCode:'COMMAND_OUTCOME_UNKNOWN',submissionState:'unknown'}]){
  event=failed;
  for(const [name,args]of [['rh_node_result',{nodeId:'deleted'}],['rh_align_nodes',{nodeIds:['a','b'],mode:'left'}],['rh_duplicate_canvas',{name:'copy',requestId:'copy-request'}],['rh_preview_outputs',{nodeId:'deleted'}],['rh_download_task_outputs',{taskId:'task',destination:'/unused',requestId:'download-request'}]]){
   commands=[];const r=await client.callTool({name,arguments:args});assert.equal(r.isError,true,name);const body=r.structuredContent;assert.equal(body.errorCode,failed.errorCode,name);assert.match(body.requestId,/^rh-[a-f0-9]{64}$/);assert.equal(body.canvasUrl,href);assert.equal(body.submissionState,failed.submissionState);assert.equal(commands.length,1,name);assert.ok(!/TypeError|reading 'element'/.test(JSON.stringify(r)));
  }
 }
});
test('HTTP media-plan failure remains structured through BridgeClient and MCP',async t=>{
 const {createServer}=await import('node:http');const receipt={ok:false,requestId:'original-read-request',canvasUrl:href,errorCode:'NODE_NOT_FOUND',error:'missing'};
 const http=createServer((_req,res)=>{res.writeHead(422,{'Content-Type':'application/json'});res.end(JSON.stringify(receipt));});await new Promise(r=>http.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>http.close(r)));
 const b=new BridgeClient('http://127.0.0.1:'+http.address().port);b.canvasUrl=href;
 const client=await linked(t,{canvasUrl:href,sessionId:'scope',clientId:'fixture',target:async()=>({}),request:b.request.bind(b)});
 const result=await client.callTool({name:'rh_plan_media_operation',arguments:{sourceNodeId:'missing',operation:'crop',provider:'canvas-browser',options:{x:0,y:0,width:32,height:32},routingReason:'read only plan'}});assert.equal(result.isError,true);const {recovery,...original}=result.structuredContent;assert.deepEqual(original,receipt);assert.equal(recovery.tool,'rh_get_node');
 const media=new MediaOperations({bridgeFactory:()=>({command:async()=>receipt})});await assert.rejects(media.plan({sourceNodeId:'missing',operation:'crop',provider:'canvas-browser',options:{x:0,y:0,width:32,height:32},routingReason:'read only'}, {canvasUrl:href}),e=>e instanceof CommandResultError&&e.receipt.requestId===receipt.requestId);
});
test('failed composed calls carry the current scope, including after a scope changes',async()=>{
 const scopes=new TaskScopes(new BridgeClient());const selected={sessionId:'new-scope',canvasUrl:href};scopes.resolve=async()=>selected;
 await assert.rejects(scopes.run('canvas',{scopeId:'old-scope'},async()=>assertCommandSucceeded({ok:false,requestId:'original',errorCode:'NODE_NOT_FOUND'})),e=>e.receipt.scopeId==='new-scope'&&e.receipt.canvasUrl===href&&e.receipt.requestId==='original');
});

test('archive and history workers retain original failure receipts without confusing them with later errors',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{ArchiveManager}=await import('../server/archive.mjs'),{HistorySync}=await import('../server/history-sync.mjs');
 const root=await mkdtemp(join(tmpdir(),'rh-worker-receipts-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const receipt={ok:false,requestId:'worker-original',canvasUrl:href,errorCode:'NODE_NOT_FOUND',error:'missing'};let broken=false,now=1;
 const factory=()=>({select:async()=>{if(broken)throw Error('CANVAS_NOT_CONNECTED');},command:async()=>receipt});
 const archives=new ArchiveManager({root:join(root,'archives'),bridgeFactory:factory});await archives.init();await archives.save({archiveId:'fixture-job',canvasUrl:href,taskId:'task',nodeId:'node',expectedOutputs:1,state:'waiting_outputs',files:[]});await archives.tick();assert.deepEqual(archives.status('fixture-job').failureReceipt,receipt);await archives.retry('fixture-job');assert.equal(archives.status('fixture-job').failureReceipt,undefined);
 const h=new HistorySync({root:join(root,'history'),bridgeFactory:factory,now:()=>now});await h.init();await h.accept({type:'canvas.runNode',canvasUrl:href,nodeId:'node'},{ok:true,result:{submitted:true,task:{taskId:'task'}}});await h.tick();assert.deepEqual(h.status()[0].failureReceipt,receipt);assert.equal(h.status()[0].state,'blocked');await h.resume({canvasUrl:href,nodeId:'node'});broken=true;now=1000000;await h.tick();assert.equal(h.status()[0].failureReceipt,undefined);assert.match(h.status()[0].error,/NOT_CONNECTED/);
});
