import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import '../server/canvas-features.js';
import '../server/layout-template.js';
import '../server/production-features.js';
const P=globalThis.RHProductionFeatures;
const toY=(_,v)=>{if(Array.isArray(v)){const a=new Y.Array();a.push(v.map(x=>toY(_,x)));return a;}if(v&&typeof v==='object'){const m=new Y.Map();for(const[k,x]of Object.entries(v))m.set(k,toY(_,x));return m;}return v;};
const app=(id='original',p='EP01/P001')=>({id,type:'rh-ai',position:{x:720,y:430},data:{title:'P001 current',bridgeProductionKey:p,aiApp:{id:'app',inputNodes:[{nodeId:'1',fieldName:'prompt',fieldType:'STRING',fieldValue:'original'}]},historyStorage:{source:'remote',historyId:'own-index',revision:'4',resultCount:4},output:[{url:'https://example.test/current.mp4',taskId:'own-task'}],taskId:'own-task',adopted:true,selectedHistoryOutputId:'own-output',status:'idle'}});
function harness(t,s={nodes:[],edges:[]}){const doc=new Y.Doc(),nodes=doc.getArray('nodes'),edges=doc.getArray('edges'),requests=[];nodes.push(s.nodes.map(n=>toY(Y,n)));edges.push(s.edges.map(n=>toY(Y,n)));t.after(()=>doc.destroy());const snapshot=()=>({nodes:nodes.toJSON(),edges:edges.toJSON()});const tools=P.create({toYValue:toY,readSnapshot:async()=>snapshot(),withMutation:async(c,fn)=>fn({Y,doc,nodes,edges}),api:async(path)=>{requests.push(path);return {name:'Fixture',inputNodes:[]};}});return {tools,snapshot,requests};}
test('same P returns its original app even with a new requested ID, preserving all historical and current data',async t=>{
 const a=app(),h=harness(t,{nodes:[a,{id:'ref',type:'rh-image',data:{},position:{x:0,y:0}}],edges:[{id:'e',source:'ref',target:a.id}]}),before=h.snapshot();
 for(const nodeId of ['new-attempt','original']){const r=await h.tools.createApp({appId:'app',nodeId,productionKey:'EP01/P001',title:'must not overwrite',x:0,y:0});assert.equal(r.reused,true);assert.equal(r.nodeId,'original');assert.deepEqual(h.snapshot(),before);}
 assert.equal(h.requests.length,0);
});
test('new P creates once, simultaneous duplicate preparation resolves to the first node, and independent P stays separate',async t=>{
 const h=harness(t),base={appId:'app',productionKey:'EP01/P001',x:0,y:0};
 const result=await Promise.all(['one','two'].map(nodeId=>h.tools.createApp({...base,nodeId})));
 assert.equal(h.snapshot().nodes.length,1);assert.equal(result[0].reused,false);assert.equal(result[1].reused,true);assert.equal(result[1].nodeId,result[0].nodeId);
 await h.tools.createApp({...base,nodeId:'next',productionKey:'EP01/P002'});assert.equal(h.snapshot().nodes.length,2);
});
test('conflicting app, occupied target, ambiguous production identity and invalid keys fail before changing the graph',async t=>{
 const h=harness(t,{nodes:[app(),app('second','EP01/P002')],edges:[]}),before=h.snapshot();
 for(const c of [{appId:'other',nodeId:'new',productionKey:'EP01/P001'},{appId:'app',nodeId:'second',productionKey:'EP01/P001'},{appId:'app',nodeId:'original',productionKey:'EP01/P003'},{appId:'app',nodeId:'new',productionKey:' '}])await assert.rejects(h.tools.createApp({...c,x:0,y:0}),/MISMATCH|CONFLICT|INVALID/);
 assert.deepEqual(h.snapshot(),before);assert.equal(h.requests.length,0);
 const duplicate=harness(t,{nodes:[app(),app('duplicate')],edges:[]});await assert.rejects(duplicate.tools.createApp({appId:'app',nodeId:'new',productionKey:'EP01/P001'}),/AMBIGUOUS/);assert.equal(duplicate.snapshot().nodes.length,2);
});
test('an exact old app can be tagged while revising inputs, preserving history, output, connections and adoption',async t=>{
 const a=app();delete a.data.bridgeProductionKey;const h=harness(t,{nodes:[a],edges:[{id:'external-reference',source:'ref',target:a.id}]}),before=h.snapshot();
 await h.tools.configureApp({nodeId:a.id,productionKey:'EP01/P001',inputs:[{nodeId:'1',fieldName:'prompt',value:'revised'}]});
 const expected=structuredClone(before);expected.nodes[0].data.bridgeProductionKey='EP01/P001';expected.nodes[0].data.aiApp.inputNodes[0].fieldValue='revised';assert.deepEqual(h.snapshot(),expected);
 const bound=h.snapshot();await assert.rejects(h.tools.configureApp({nodeId:a.id,productionKey:'EP01/P002',inputs:[{nodeId:'1',fieldName:'prompt',value:'bad'}]}),/CONFLICT/);assert.deepEqual(h.snapshot(),bound);
});
test('copying an explicitly separate P clears its production and native history identities without touching the original',()=>{
 const a=app(),before=structuredClone(a),n=P.cloneGraph({nodes:[a],edges:[]},{prefix:'new-P',keepOutputs:true}).nodes[0];assert.equal(n.data.bridgeProductionKey,undefined);assert.equal(n.data.historyStorage,undefined);assert.equal(n.data.bridgeSource.nodeId,a.id);assert.deepEqual(a,before);
});
