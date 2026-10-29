import test from 'node:test';
import assert from 'node:assert/strict';
import {nodeConfig,checkedMediaUrl,CanvasNodes} from './nodes.mjs';
import {ImageCanvas} from './canvas.mjs';
const url='https://rhtv.runninghub.cn/project/canvas/123';
const id='codex-image-00000000-0000-4000-8000-000000000001';
test('exposes real native controls without invented model or quality overrides',()=>{
 assert.deepEqual(nodeConfig({prompt:'test',ratio:'16:9',count:3,mode:'reference',quality:'max',model:'gpt-image-2.5'}),{prompt:'test',ratio:'16:9',count:3,mode:'reference',transparent:false});
});
test('reference fetch accepts known canvas storage and rejects local or arbitrary targets',()=>{
 assert.equal(checkedMediaUrl('https://rh-canvas-files.xiaoyaoyou.com/test.png'),'https://rh-canvas-files.xiaoyaoyou.com/test.png');
 for(const u of ['http://127.0.0.1/secret','https://localhost/x','https://xiaoyaoyou.com.evil.test/x','https://u:p@rh-canvas-files.xiaoyaoyou.com/x','https://rh-canvas-files.xiaoyaoyou.com:18765/x'])assert.throws(()=>checkedMediaUrl(u));
});
test('create uses original request ID and avoids existing node geometry',async()=>{
 const calls=[];let exists=false;
 const canvas={open:async()=>({scopeId:'scope'}),call:async(name,args)=>{calls.push({name,args});if(name==='rh_canvas_summary')return {result:{nodes:exists?[{id}]:[{id:'original',position:{x:100,y:100},width:480,height:620}]}};return {};}};
 const nodes=new CanvasNodes({canvas});
 await nodes.create(url,{requestId:id.slice(12),x:100,y:100});
 const create=calls.find(c=>c.name==='rh_gpt_image_create_node');assert.equal(create.args.nodeId,id);assert.ok(create.args.x>=740);exists=true;
 await nodes.create(url,{requestId:id.slice(12),x:100,y:100});assert.equal(calls.filter(c=>c.name==='rh_gpt_image_create_node').length,1);
});
test('node import commits and verifies the original node without creating or resizing cards',async()=>{
 const canvas=new ImageCanvas(),calls=[];canvas.open=async()=>({scopeId:'scope'});canvas.call=async(name,args)=>{calls.push({name,args});return name==='rh_get_node'?{result:{element:{data:{codexImage:{history:[{jobId:'job',index:1,sha256:'hash'}]}}}}}:{result:{url:'https://rh-canvas-files.xiaoyaoyou.com/image.png',dimensions:{width:1024,height:1024}}};};
 const result=await canvas.import({id:'job',targetNodeId:id,canvasUrl:url,currentIndex:1,prompt:'test',outputPath:'/image.png',sha256:'hash',uploadRequestId:'stable'});
 assert.equal(result.nodeId,id);assert.deepEqual(calls.map(c=>c.name),['rh_gpt_image_commit_output','rh_get_node']);assert.equal(calls[0].args.requestId,'stable');
});
test('output switching uses only this node history and preserves configuration',async()=>{
 const config={prompt:'keep',ratio:'1:1',count:2,mode:'text',transparent:false};
 const history=[{jobId:'job',index:0,url:'https://rh-canvas-files.xiaoyaoyou.com/first.png',width:1024,height:1024}];
 const calls=[];const engine={canvas:{open:async()=>({scopeId:'scope'}),call:async(name,args)=>{calls.push({name,args});return name==='rh_get_node'?{result:{revision:'r1',element:{id,data:{codexImage:{version:1,config,history}}}}}:{};}}};
 const nodes=new CanvasNodes(engine);
 await assert.rejects(()=>nodes.selectOutput(url,id,{jobId:'other',index:0}),/不在/);assert.equal(calls.filter(c=>c.name==='rh_update_node').length,0);
 await nodes.selectOutput(url,id,{jobId:'job',index:0});const update=calls.find(c=>c.name==='rh_update_node').args;
 assert.deepEqual(update.data.codexImage.config,config);assert.deepEqual(update.data.codexImage.history,history);assert.deepEqual(update.data.sourceObjects,[history[0].url]);assert.equal(update.expectedRevisions[id],'r1');
 engine.active={targetNodeId:id};await assert.rejects(()=>nodes.selectOutput(url,id,{jobId:'job',index:0}),/等待/);
});
test('canvas scope is shared across concurrent polls and isolated between canvases',async()=>{
 const c=new ImageCanvas();let opens=0;c.call=async(name,args)=>{assert.equal(name,'rh_open_canvas');opens++;await new Promise(r=>setTimeout(r,10));return {scopeId:args.canvasUrl};};
 const values=await Promise.all([c.open(url),c.open(url),c.open(url)]);assert.equal(opens,1);assert.ok(values.every(v=>v===values[0]));
 await c.open(url);assert.equal(opens,1);await c.open(url+'4');assert.equal(opens,2);
 c.scopes.get(url).expires=0;await c.open(url);assert.equal(opens,3);
});
test('expired cached scopes refresh read calls once without replaying writes',async()=>{
 const c=new ImageCanvas(),calls=[];let serial=0,expire=true;c.connect=async()=>{};
 c.client={callTool:async({name,arguments:args})=>{
  calls.push({name,args});
  if(name==='rh_open_canvas')return {structuredContent:{scopeId:'scope-'+(++serial)}};
  if(expire){expire=false;return {isError:true,structuredContent:{ok:false,errorCode:'SCOPE_EXPIRED'}};}
  return {structuredContent:{result:{ok:true}}};
 }};
 const context=await c.open(url);await c.call('rh_get_node',{scopeId:context.scopeId,nodeId:id});
 assert.equal(context.scopeId,'scope-2');assert.equal(calls.filter(x=>x.name==='rh_get_node').length,2);
 expire=true;await assert.rejects(()=>c.call('rh_update_node',{scopeId:context.scopeId,nodeId:id}),/SCOPE_EXPIRED/);
 assert.equal(calls.filter(x=>x.name==='rh_update_node').length,1);assert.equal(serial,2);
});
