import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import '../server/canvas-features.js';
import '../server/production-features.js';
const F=globalThis.RHProductionFeatures;
test('copy isolates native history and adoption while preserving inputs and media provenance',()=>{
 const input={canvasId:'original-canvas',nodes:[{id:'ref',position:{x:1,y:2},data:{output:[{url:'https://example.com/a.png',taskId:'old'}]}},{id:'app',position:{x:5,y:6},data:{taskId:'task',historyStorage:{historyId:'foreign'},nodeOutputHistory:[{}],selectedHistoryOutputId:'old',accepted:true,status:'running',params:{prompt:'unchanged'},aiApp:{inputNodes:[{binding:{sourceNodeId:'ref'}}]},output:[{url:'https://example.com/a.mp4',taskId:'task',historyOutputId:'old'}]}}],edges:[{id:'e',source:'ref',target:'app'}]};
 const original=structuredClone(input),copy=F.cloneGraph(input,{prefix:'new',sourceCanvasId:input.canvasId});
 assert.deepEqual(input,original);const app=copy.nodes[1];assert.equal(app.id,'new-1');assert.equal(app.data.historyStorage,undefined);assert.equal(app.data.taskId,undefined);assert.equal(app.data.accepted,undefined);assert.equal(app.data.status,'idle');assert.equal(app.data.params.prompt,'unchanged');assert.deepEqual(app.data.output,[{url:'https://example.com/a.mp4'}]);assert.equal(app.data.bridgeSource.taskId,'task');assert.equal(app.data.aiApp.inputNodes[0].binding.sourceNodeId,'new-0');assert.equal(copy.edges[0].target,'new-1');assert.deepEqual(F.cloneGraph(input,{prefix:'empty',keepOutputs:false}).nodes[1].data.output,[]);
});
test('history output-only selection preserves params; restore follows native hidden-prompt semantics without adoption',()=>{
 const current={params:{prompt:'current',protected:'private'},accepted:true};
 const batch={batchId:'batch',taskId:'task',paramsSnapshot:{prompt:'past',protected:'[HIDDEN_SYSTEM_PROMPT_APPLIED]'},nodeConfigSnapshot:{modelCode:'native',accepted:false}};
 const output={outputId:'o',url:'https://example.com/v.mp4',outputType:'mp4',thumbnailUrl:'https://example.com/t.jpg'};
 const result=F.historyPatch(batch,output,current,false);assert.equal(result.params,undefined);assert.equal(result.selectedHistoryOutputId,'o');assert.equal(result.output[0].taskId,'task');assert.equal(result.accepted,undefined);
 const restored=F.historyPatch(batch,output,current,true);assert.deepEqual(restored.params,{prompt:'past',protected:'private'});assert.equal(restored.modelCode,'native');assert.equal(restored.accepted,undefined);
 assert.throws(()=>F.historyPatch({...batch,paramsSnapshot:null},output,current,true),/UNAVAILABLE/);
});
test('workflow application uses new native ownership and rewrites edges',async()=>{
 const doc=new Y.Doc(),nodes=doc.getArray('nodes'),edges=doc.getArray('edges');
 const toYValue=(_,v)=>{if(Array.isArray(v)){const a=new Y.Array();a.push(v.map(x=>toYValue(_,x)));return a;}if(v&&typeof v==='object'){const m=new Y.Map();for(const[k,x]of Object.entries(v))m.set(k,toYValue(_,x));return m;}return v;};
 const graph={nodes:[{id:'a',position:{x:0,y:0},data:{taskId:'old',historyStorage:{historyId:'old'},output:[{url:'https://example.com/a.png'}]}}],edges:[]};
 const tools=F.create({api:async()=>({workflowContent:graph}),toYValue,withMutation:async(c,fn)=>fn({Y,doc,nodes,edges})});
 await tools.applyWorkflow({prefix:'copy',x:10,y:20});assert.equal(nodes.toJSON()[0].data.historyStorage,undefined);assert.equal(nodes.toJSON()[0].position.x,10);doc.destroy();
});
test('application history restores real fields only for the same app and handles bound inputs explicitly',()=>{
 const current={aiApp:{id:'app',inputNodes:[{nodeId:'1',fieldName:'prompt',fieldType:'STRING',fieldValue:'now',binding:{sourceNodeId:'shared'}}]}};
 const batch={batchId:'b',taskId:'t',paramsSnapshot:{nodeInfoList:[{nodeId:'1',fieldName:'prompt',fieldValue:'past'}]},nodeConfigSnapshot:{modelCode:'app'}};
 const output={outputId:'o',url:'https://example.com/a.mp4'};
 assert.throws(()=>F.historyPatch(batch,output,current,true),/BOUND_INPUT_CONFLICT/);
 const p=F.historyPatch(batch,output,current,true,'detach_changed');assert.equal(p.params,undefined);assert.equal(p.aiApp.inputNodes[0].fieldValue,'past');assert.equal(p.aiApp.inputNodes[0].binding,undefined);assert.equal(current.aiApp.inputNodes[0].binding.sourceNodeId,'shared');
 assert.throws(()=>F.historyPatch({...batch,nodeConfigSnapshot:{modelCode:'foreign'}},output,current,true,'detach_changed'),/SCHEMA_MISMATCH/);
});
