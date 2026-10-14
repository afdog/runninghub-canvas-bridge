import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer, BridgeClient } from '../server/mcp.mjs';
import { fileURLToPath } from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

test('MCP defaults old focus callers to connect and reserves show for explicit presentation',async t=>{
 const calls=[];
 const server=createMcpServer({open:async(...args)=>{calls.push(args);return {ok:true};},request:async()=>({})});
 const client=new Client({name:'presentation-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 t.after(async()=>{await client.close();await server.close();});
 const args={canvasUrl:'https://rhtv.runninghub.ai/project/canvas/123',focus:true};
 assert.equal((await client.callTool({name:'rh_open_canvas',arguments:args})).isError,undefined);
 assert.equal(calls[0][4],'connect');
 assert.equal((await client.callTool({name:'rh_open_canvas',arguments:{...args,intent:'show'}})).isError,undefined);
 assert.equal(calls[1][4],'show');
 assert.match(client.getInstructions(),/not browser foreground tabs/);
});

test('modern stdio discovery and overlapping calls work without initialize; invalid openings are rejected',async t=>{
 const source=`import {serveStdio} from '@modelcontextprotocol/server/stdio';import {createMcpServer} from ${JSON.stringify(new URL('../server/mcp.mjs',import.meta.url).href)};serveStdio(()=>createMcpServer({status:async()=>({ok:true,source:'fixture'})}));`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:['pipe','pipe','pipe']});
 const pending=new Map();let id=0;child.stderr.resume();
 const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{const message=JSON.parse(line),waiter=pending.get(message.id);if(waiter){pending.delete(message.id);clearTimeout(waiter.timer);waiter.resolve(message);}});
 child.on('error',error=>{for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(error);}pending.clear();});
 t.after(()=>{for(const waiter of pending.values())clearTimeout(waiter.timer);lines.close();child.kill();});
 const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'modern-test',version:'1'}};
 const request=(method,params={},envelope=meta)=>new Promise((resolve,reject)=>{const requestId=++id;const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('MCP test response timeout'));},5000);pending.set(requestId,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params:{...params,_meta:envelope}})+'\n');});
 const unsupported=await request('tools/list',{}, {...meta,'io.modelcontextprotocol/protocolVersion':'2099-01-01'});assert.equal(unsupported.error?.code,-32022);
 const malformed=await request('tools/call',{name:'rh_status',arguments:{}},{...meta,'io.modelcontextprotocol/clientCapabilities':null});assert.equal(malformed.error?.code,-32602);
 const discover=await request('server/discover');assert.equal(discover.result.resultType,'complete');assert.ok(discover.result.supportedVersions.includes('2026-07-28'));
 const responses=await Promise.all([request('tools/list'),...Array.from({length:4},()=>request('tools/call',{name:'rh_status',arguments:{}}))]);
 assert.equal(responses[0].result.tools.length,73);
 for(const response of responses.slice(1)){assert.equal(response.result.resultType,'complete');assert.equal(response.result.structuredContent.ok,true);assert.equal(response.result.structuredContent.source,'fixture');}
 const invalid=await request('tools/call',{name:'rh_move_nodes',arguments:{positions:[{nodeId:'A',x:'bad',y:0}]}});assert.equal(invalid.result.isError,true);
});

test('MCP handshake, typed tools, prompts and request IDs survive transport', async t => {
  const calls=[];
  const bridge={status:async()=>({ok:true}),select:async()=>({ok:true}),command:async(type,args,options)=>{ calls.push({type,args,options});return {result:{ok:true}};}};
  const server=createMcpServer(bridge);
  const client=new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  t.after(async()=>{await client.close();await server.close();});
  assert.match(client.getInstructions(),/Lumen/);
  const {tools}=await client.listTools();
  assert.equal(tools.length,73);
  assert.equal(tools.some(t=>/eval|api_post/.test(t.name)),false);
  assert.equal(tools.find(t=>t.name==='rh_run_node').annotations.readOnlyHint,false);
  const prompt='角色甲……请完整保留这句测试文本，包括停顿，只要——';
  const result=await client.callTool({name:'rh_update_params',arguments:{nodeId:'example-node',params:{prompt},dryRun:true}});
  assert.equal(result.isError,undefined);
  assert.equal(calls[0].args.params.prompt,prompt);
  await client.callTool({name:'rh_run_node',arguments:{nodeId:'example-node',requestId:'same-request-001',dryRun:true}});
  assert.equal(calls[1].options.id,'same-request-001');
  assert.equal(calls[1].args.dryRun,true);
  const invalid=await client.callTool({name:'rh_move_nodes',arguments:{positions:[{nodeId:'A',x:'bad',y:0}]}});
  assert.equal(invalid.isError,true);
  assert.equal(calls.length,2);
});

test('real stdio process initializes and lists tools without bridge availability',async t=>{
  const client=new Client({name:'stdio-check',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../server/mcp.mjs',import.meta.url))],stderr:'pipe'});
  t.after(()=>client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length,73);
});

test('MCP requires exact canvas selection and loopback bridge',async()=>{
  assert.throws(()=>new BridgeClient('https://example.com'),/loopback/);
  await assert.rejects(new BridgeClient().command('canvas.summary'),/SELECT_CANVAS_FIRST/);
});

test('generation persists its archive binding before submission and stops when registration fails',async t=>{
  const calls=[];
  let registrationFails=false;
  const destination={kind:'asset',project_id:'project',work_id:'registered-work'};
  const bridge={canvasUrl:'https://www.runninghub.ai/project/canvas/test',target:async()=>{},
    request:async(path,args)=>{
      calls.push({path,args});
      if(path.startsWith('/archives/binding'))return {target:destination};
      if(registrationFails)throw new Error('Lumen unavailable');
      return {archiveId:args.archiveId};
    },
    command:async(type,args,options)=>{
      calls.push({type,args,options});
      return type==='canvas.getElement'?{result:{element:{data:{generateNum:2}}}}:{ok:true,result:{task:{taskId:'new-task'}}};
    }};
  const server=createMcpServer(bridge),client=new Client({name:'archive-hook-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  t.after(async()=>{await client.close();await server.close();});
  const invoke=args=>client.callTool({name:'rh_run_node',arguments:{nodeId:'node',requestId:'stable-generation-id',...args}});
  assert.equal((await invoke({})).isError,undefined);
  assert.deepEqual(calls.map(c=>c.type || c.path.split('?')[0]),['/archives/binding','canvas.getElement','/archives','canvas.runNode']);
  assert.equal(calls[2].args.expectedOutputs,2);
  assert.deepEqual(calls[2].args.target,destination);
  assert.equal(calls[2].args.submissionRequestId,calls[3].options.id);
  calls.length=0;registrationFails=true;
  assert.equal((await invoke({archiveTarget:destination})).isError,true);
  assert.equal(calls.some(c=>c.type==='canvas.runNode'),false);
  calls.length=0;
  assert.equal((await invoke({archiveTarget:{kind:'asset',project_id:'project'}})).isError,true);
  assert.equal(calls.length,0);
  assert.equal((await invoke({dryRun:true})).isError,undefined);
  assert.deepEqual(calls.map(c=>c.type),['canvas.runNode']);
});
