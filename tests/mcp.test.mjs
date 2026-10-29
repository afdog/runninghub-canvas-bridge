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
 assert.equal(responses[0].result.tools.length,87);
 for(const response of responses.slice(1)){assert.equal(response.result.resultType,'complete');assert.equal(response.result.structuredContent.ok,true);assert.equal(response.result.structuredContent.source,'fixture');assert.equal(response.result.structuredContent.deployment.mcp.tools.count,87);assert.match(response.result.structuredContent.deployment.mcp.tools.fingerprint,/^[a-f0-9]{64}$/);assert.equal(response.result.structuredContent.deployment.mcp.needsRestart,false);}
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
  assert.match(client.getInstructions(),/Route by intent/);
  assert.doesNotMatch(client.getInstructions(),/Always read rh_get_layout_template/);
  const {tools}=await client.listTools();
  assert.equal(tools.length,87);
  for(const name of ['rh_gpt_image_create_node','rh_gpt_image_generate','rh_gpt_image_status','rh_gpt_image_commit_output'])assert.ok(tools.some(tool=>tool.name===name));
  assert.equal(tools.some(t=>/eval|api_post/.test(t.name)),false);
  assert.equal(tools.find(t=>t.name==='rh_run_node').annotations.readOnlyHint,false);
  assert.match(tools.find(t=>t.name==='rh_get_layout_template').description,/only before adding or arranging/);
  assert.match(tools.find(t=>t.name==='rh_upload_media').description,/rh_upload_image/);
  assert.equal(tools.find(t=>t.name==='rh_canvas_summary').inputSchema.properties.includeRevision.type,'boolean');
  assert.equal(tools.find(t=>t.name==='rh_get_node').inputSchema.properties.nodeIds.type,'array');
  assert.equal((await client.callTool({name:'rh_get_node',arguments:{}})).isError,true);
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
  assert.equal((await client.listTools()).tools.length,87);
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

test('shot preparation submits archive bindings together and keeps prepared nodes when one destination fails',async t=>{
 const calls=[];
 const bridge={canvasUrl:'https://www.runninghub.ai/project/canvas/test',
  command:async(type,args)=>{calls.push({type,args});return args.dryRun?{ok:true,dryRun:true}:{ok:true,prepared:args.shots.length};},
  request:async(path,args)=>{calls.push({path,args});return {ok:true,results:args.bindings.map((binding,index)=>({nodeId:binding.nodeId,ok:index===0,error:index===0?undefined:'LUMEN_PROJECT_UNAVAILABLE',target:binding.target}))};}};
 const server=createMcpServer(bridge),client=new Client({name:'prepare-shots-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 t.after(async()=>{await client.close();await server.close();});
 const shot=(nodeId,project)=>({nodeId,templateNodeId:'template',title:nodeId,prompt:'look',archiveTarget:{kind:'asset',project_id:project}});
 const dry=await client.callTool({name:'rh_prepare_shots',arguments:{shots:[shot('shot-1','project')],dryRun:true}});
 assert.equal(dry.isError,undefined);assert.deepEqual(calls.map(c=>c.type),[ 'canvas.prepareShots' ]);
 calls.length=0;
 const prepared=await client.callTool({name:'rh_prepare_shots',arguments:{shots:[shot('shot-1','project'),shot('shot-2','missing')]}});
 assert.equal(prepared.isError,true);
 assert.equal(prepared.structuredContent.canvasPrepared,true);
 assert.equal(prepared.structuredContent.prepared,2);
 assert.deepEqual(calls.map(c=>c.type||c.path),['canvas.prepareShots','/archives/bindings']);
 assert.deepEqual(calls[1].args.bindings.map(binding=>binding.nodeId),['shot-1','shot-2']);
 assert.deepEqual(prepared.structuredContent.archiveBindings.map(binding=>({nodeId:binding.nodeId,ok:binding.ok})),[{nodeId:'shot-1',ok:true},{nodeId:'shot-2',ok:false}]);
});


test('MCP transports stable P identity and group-row options without creating another tool or submitting generation',async t=>{
 const calls=[];const server=createMcpServer({command:async(type,args)=>{calls.push({type,args});return {ok:true,result:{nodeId:'canonical',reused:true}};},request:async(path,body)=>{calls.push({path,body});return {ok:true};}}),client=new Client({name:'production-policy',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});
 assert.match(client.getInstructions(),/non-temporary RunningHub projects/);assert.match(client.getInstructions(),/one application node per P/);
 const args={appId:'app',nodeId:'existing-P',productionKey:'EP01/P001',x:0,y:0,dryRun:true};const created=await client.callTool({name:'rh_create_app',arguments:args});assert.equal(created.isError,undefined);assert.equal(calls[0].args.productionKey,args.productionKey);
 await client.callTool({name:'rh_configure_app',arguments:{nodeId:'existing-P',productionKey:'EP01/P001',inputs:[{nodeId:'1',fieldName:'prompt',value:'revised'}],dryRun:true}});assert.equal(calls[1].args.nodeId,'existing-P');
 await client.callTool({name:'rh_set_layout_template',arguments:{options:{groupColumns:3,maxColumns:4}}});assert.equal(calls[2].body.options.groupColumns,3);
 const bad=await client.callTool({name:'rh_set_layout_template',arguments:{options:{groupColumns:0}}});assert.equal(bad.isError,true);assert.equal(calls.length,3);assert.equal((await client.listTools()).tools.length,87);
});


test('model discovery accepts common categories and exact modes; recovery returns the original structured rejection',async t=>{
 const calls=[],failure={ok:false,errorCode:'HISTORY_ROUTE_CONFLICT',submitted:false,submissionState:'rejected',retryable:false,platformCode:301,historyRoute:{historyId:'owned'}};
 const server=createMcpServer({canvasUrl:'https://www.runninghub.ai/project/canvas/fixture',command:async(type,args)=>{calls.push({type,args});return {result:{models:[]}};},request:async()=>({record:{canvasUrl:'https://www.runninghub.ai/project/canvas/fixture',state:'completed'},result:failure})});
 const client=new Client({name:'model-alias',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});
 for(const types of [['video'],['VIDEO'],['image-video','text_video',' video ']])assert.notEqual((await client.callTool({name:'rh_list_models',arguments:{types}})).isError,true);
 assert.ok(calls[0].args.types.includes('MULTIMODAL_VIDEO'));assert.ok(calls[0].args.types.includes('VIDEO_EDIT'));assert.ok(!calls[0].args.types.includes('VIDEO'));assert.deepEqual(calls[0].args.types,calls[1].args.types);assert.equal(new Set(calls[2].args.types).size,calls[2].args.types.length);
 const n=calls.length;assert.equal((await client.callTool({name:'rh_list_models',arguments:{types:['bogus']}})).isError,true);assert.equal(calls.length,n);
 const receipt=(await client.callTool({name:'rh_command_result',arguments:{requestId:'original-request'}})).structuredContent;assert.equal(receipt.submissionState,'rejected');assert.deepEqual(receipt.historyRoute,failure.historyRoute);assert.equal(receipt.retryable,false);
});

test('MCP preserves native expected identities and rejects unknown expectation fields and string booleans',async t=>{
 const calls=[],server=createMcpServer({command:async(type,args)=>{calls.push({type,args});return {result:{ok:true}};}}),client=new Client({name:'native-expected',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});
 const expected={prompt:'exact',promptField:{nodeId:'263',fieldName:'text'},appInputs:[{nodeId:'263',fieldName:'text',value:'exact',sourceNodeId:null}],references:[]};
 assert.equal((await client.callTool({name:'rh_preflight',arguments:{nodeId:'outer',expected}})).isError,undefined);assert.deepEqual(calls[0].args.expected,expected);
 for(const args of [{nodeId:'outer',expected:{unsupported:true}},{nodeId:'outer',expected:{appInputs:[{nodeId:'263',fieldName:'text',value:'exact',unknown:true}]}}])assert.equal((await client.callTool({name:'rh_preflight',arguments:args})).isError,true);
 assert.equal((await client.callTool({name:'rh_configure_app',arguments:{nodeId:'outer',inputs:[{nodeId:'263',fieldName:'text',value:'x'}],dryRun:'True'}})).isError,true);assert.equal(calls.length,1);
});
