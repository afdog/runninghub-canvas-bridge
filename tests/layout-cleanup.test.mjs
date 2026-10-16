import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import '../server/layout-template.js';
import '../server/canvas-cleanup.js';
import '../server/canvas-features.js';
import '../server/production-features.js';
const L=globalThis.RHLayoutTemplate,C=globalThis.RHCanvasCleanup;
const node=(id,data={})=>({id,type:'rh-video',position:{x:0,y:0},width:380,height:240,data:{width:380,height:240,...data}});
test('portrait result metadata wins over stale landscape parameters and all dimension fields agree',()=>{
 const original=node('v',{params:{aspect_ratio:'16:9'},output:[{url:'https://example.test/a.mp4',width:1080,height:1920}]});original.measured={width:380,height:240};
 const n=L.normalize(original);assert.equal(n.width,180);assert.equal(n.height,320);assert.equal(n.measured.height,320);assert.equal(n.data.height,320);assert.equal(n.style.height,320);assert.equal(n.data.opResize,true);assert.deepEqual(n.data.params,original.data.params);assert.equal(original.height,240);
});
test('app ratio labels and portrait images get stable native locks without changing input parameters',()=>{
 const app={...node('app'),type:'rh-ai',data:{aiApp:{inputNodes:[{fieldName:'aspect_ratio',fieldValue:'9:16 (Portrait Widescreen)'}]}}};const n=L.normalize(app);assert.equal(n.width,180);assert.equal(n.height,320);assert.equal(n.data.imageDisplaySizeLocked,true);assert.deepEqual(n.data.aiApp,app.data.aiApp);
 const image=L.normalize({...app,type:'rh-image',data:{output:[{width:1920,height:1080}]}});assert.equal(image.width,320);assert.equal(image.height,180);assert.equal(image.data.imageDisplaySizeLocked,true);
});
test('grids wrap to four aligned columns and reserve the tallest mixed-orientation member in each row',()=>{
 const nodes=Array.from({length:9},(_,i)=>node('n'+i,{params:{ratio:i%2?'16:9':'9:16'}})),s={nodes,edges:[]},p=L.plan(s,[{id:'g',title:'Shots',nodeIds:nodes.map(n=>n.id)}]);
 const get=id=>p.updates.find(n=>n.id===id);assert.equal(get('n0').position.y,get('n3').position.y);assert.equal(get('n0').position.x,get('n4').position.x);assert.equal(get('n4').position.y,get('n0').position.y+320+60);assert.equal(L.check({nodes:p.updates,edges:[]}).passes,true);
 assert.deepEqual(L.plan({nodes:p.updates,edges:[]},[{id:'g',title:'Shots',nodeIds:nodes.map(n=>n.id)}]).updates,p.updates);
 assert.throws(()=>L.plan(s,[{id:'g',title:'Bad',columns:[nodes.map(n=>n.id)]}]),/LONG_COLUMN/);
 assert.doesNotThrow(()=>L.plan(s,[{id:'g',title:'Explicit',columns:[nodes.map(n=>n.id)],layoutMode:'stack'}]));
});
test('checker detects same-group overlap, wrong offsets, portrait mismatch and missing members',()=>{
 const a=node('a',{groupId:'g',params:{ratio:'9:16'},output:[{url:'https://example.test/a.mp4'}]}),b=node('b',{groupId:'g'}),g={id:'g',type:'group',position:{x:0,y:0},width:1000,height:1000,data:{nodeIds:['a','b','missing'],nodeOffsets:{}}};
 const issues=L.check({nodes:[a,b,g],edges:[]}).issues;for(const code of ['OVERLAP','GROUP_OFFSET_MISMATCH','MEDIA_ASPECT_MISMATCH','PREVIEW_RESIZE_RISK','MISSING_MEMBER'])assert.ok(issues.some(i=>i.code===code),code);
});
test('cleanup never infers rejection from titles; explicitly rejected unreferenced node is removable',()=>{
 const n=node('past',{title:'PASS',output:[{url:'https://example.test/v.mp4'}],historyStorage:{historyId:'own'}}),s={nodes:[n],edges:[]};assert.equal(C.inspect(s).selected.length,0);
 const entries=[{nodeId:'past',reason:'user_rejected',decisionNote:'User explicitly discarded this result'}];assert.equal(C.inspect(s,entries).canApply,true);const before=structuredClone(s);C.remove(s,entries);assert.equal(s.nodes.length,0);assert.equal(before.nodes[0].data.historyStorage.historyId,'own');
});
test('cleanup protects running, adopted, bound and URL-referenced nodes even without an edge',()=>{
 const source=node('src',{output:[{url:'https://example.test/v.mp4'}]}),entry={nodeId:'src',reason:'user_rejected',decisionNote:'discard'};
 for(const other of [node('keep',{params:{video:'https://example.test/v.mp4'}}),node('keep',{aiApp:{inputNodes:[{binding:{sourceNodeId:'src'}}]}})])assert.equal(C.inspect({nodes:[source,other],edges:[]},[entry]).blocked[0].reason,'STILL_REFERENCED');
 for(const data of [{status:'running'},{adopted:true},{accepted:true}])assert.equal(C.inspect({nodes:[node('src',data)],edges:[]},[entry]).blocked[0].reason,'ADOPTED_RUNNING_OR_GROUP');
});
const toY=(_,v)=>{if(Array.isArray(v)){const a=new Y.Array();a.push(v.map(x=>toY(_,x)));return a;}if(v&&typeof v==='object'){const m=new Y.Map();for(const[k,x]of Object.entries(v))m.set(k,toY(_,x));return m;}return v;};
function harness(snapshot){const doc=new Y.Doc(),nodes=doc.getArray('nodes'),edges=doc.getArray('edges');nodes.push(snapshot.nodes.map(n=>toY(Y,n)));edges.push(snapshot.edges.map(e=>toY(Y,e)));return {doc,nodes,edges,tools:globalThis.RHProductionFeatures.create({toYValue:toY,withMutation:async(c,fn)=>fn({Y,doc,nodes,edges})})};}
test('configuring an app removes only empty unbound native inputs, keeps user media and required bindings',async()=>{
 const fields=[{nodeId:'1',fieldName:'image',fieldType:'IMAGE',fieldValue:'',binding:{sourceNodeId:'empty'}},{nodeId:'2',fieldName:'prompt',fieldType:'STRING',fieldValue:'x'}];
 const s={nodes:[{...node('app'),type:'rh-ai',data:{aiApp:{id:'app-id',inputNodes:fields},output:[]}},{...node('empty'),type:'rh-image',data:{autoCreatedByAiApp:true}},{...node('used'),type:'rh-image',data:{autoCreatedByAiApp:true,sourceObjects:['https://example.test/source.png']}}],edges:[{id:'e',source:'empty',target:'app'},{id:'e2',source:'used',target:'app'}]};
 const h=harness(s);try{const r=await h.tools.configureApp({nodeId:'app',inputs:[{nodeId:'1',fieldName:'image',value:''}]});assert.deepEqual(r.cleanup.selected.map(n=>n.nodeId),['empty']);assert.deepEqual(h.nodes.toJSON().map(n=>n.id),['app','used']);assert.equal(h.edges.toJSON().length,1);}finally{h.doc.destroy();}
 const keep=harness(s);try{await keep.tools.configureApp({nodeId:'app',inputs:[{nodeId:'2',fieldName:'prompt',value:'changed'}]});assert.ok(keep.nodes.toJSON().some(n=>n.id==='empty'));}finally{keep.doc.destroy();}
});
test('cleanup checks the whole graph again before mutation and updates native groups',async()=>{
 const n=node('reject',{groupId:'g'}),g={id:'g',type:'group',position:{x:0,y:0},data:{nodeIds:['reject'],nodeOffsets:{reject:{x:0,y:0}}}},s={nodes:[n,g],edges:[]},entries=[{nodeId:'reject',reason:'user_rejected',decisionNote:'User discarded'}];const h=harness(s);
 try{await assert.rejects(h.tools.cleanupNodes({entries,expected:{...s,edges:[{id:'new'}]}}),/EDIT_CONFLICT/);assert.equal(h.nodes.length,2);await h.tools.cleanupNodes({entries,expected:s});assert.equal(h.nodes.length,0);}finally{h.doc.destroy();}
});

test('native-created empty text inputs are recognized without treating user text as disposable',()=>{
 const n={...node('text'),type:'rh-text',data:{autoCreatedByAiApp:false,labelLocked:true,_originalLabel:'Text',text:'  '}};assert.equal(C.placeholder(n),true);assert.equal(C.placeholder({...n,data:{...n.data,text:'keep this prompt'}}),false);assert.equal(C.placeholder({...n,data:{text:''}}),false);
});

test('layout check uses decoded current output instead of stale generation ratio',()=>{
 const n=L.normalize(node('v',{params:{ratio:'16:9'},output:[{url:'https://example.test/a.mp4'}]}),{width:1080,height:1920});
 assert.equal(L.check({nodes:[n],edges:[]},{mediaSizes:{v:{width:1080,height:1920}}}).passes,true);
});
