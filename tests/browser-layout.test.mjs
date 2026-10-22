import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserBroker} from '../server/browser-broker.mjs';
import {LayoutStore} from '../server/layout-store.mjs';
import '../server/layout-template.js';
const {plan}=globalThis.RHLayoutTemplate;
test('browser jobs whitelist destinations and require matching receipts',()=>{
 const b=new BrowserBroker();assert.throws(()=>b.enqueue({action:'openCanvas',canvasUrl:'https://evil.test/a'}),/INVALID/);
 assert.throws(()=>b.enqueue({action:'listCanvases',scope:'team'}),/TEAM_ID/);
 const {id}=b.enqueue({action:'listCanvases'}),j=b.poll();assert.equal(j.id,id);
 assert.throws(()=>b.complete({id,lease:'wrong',result:{}}),/MISMATCH/);
 b.complete({id,lease:j.lease,result:{complete:true,canvases:[{id:'1',name:'A',url:'https://rhtv.runninghub.ai/project/canvas/1',token:'never return this'},{id:'2',url:'https://evil.test/2'}]}});
 assert.equal(b.result(id).result.canvases.length,1);assert.equal(JSON.stringify(b.result(id)).includes('token'),false);
});
test('layout preference survives a new session and isolates canvas overrides',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rh-layout-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new LayoutStore(join(dir,'prefs.json')),url='https://rhtv.runninghub.ai/project/canvas/1';
 await store.set({options:{gap:80}});await store.set({canvasUrl:url,options:{gap:120}});
 const fresh=new LayoutStore(store.path);assert.equal((await fresh.get()).options.gap,80);assert.equal((await fresh.get(url)).options.gap,120);assert.equal((await fresh.get()).template.id,'scene-columns-v1');
});
test('scene layout preserves content, edges, grouping and aspect ratio while avoiding obstacles',()=>{
 const nodes=[{id:'a',type:'rh-image',position:{x:0,y:0},width:800,height:800,data:{prompt:'完整正文',taskId:'task',output:[{url:'https://media.test/1'}]}},{id:'b',type:'rh-video',position:{x:900,y:0},width:640,height:360,data:{params:{prompt:'原台词'}}},{id:'obstacle',position:{x:0,y:0},width:1000,height:1000,data:{}}];
 const snapshot={nodes,edges:[{id:'e',source:'a',target:'b'}]};const before=JSON.stringify(snapshot);
 const result=plan(snapshot,[{id:'g',title:'S01',columns:[['a'],['b']]}]);
 assert.equal(JSON.stringify(snapshot),before);assert.equal(result.deletedNodes,0);assert.equal(result.edgesChanged,0);
 const a=result.updates.find(n=>n.id==='a'),g=result.updates.find(n=>n.id==='g'),b=result.updates.find(n=>n.id==='b');
 assert.equal(a.width,240);assert.equal(a.height,240);assert.equal(a.data.prompt,'完整正文');assert.equal(a.data.taskId,'task');assert.deepEqual(b.data.params,nodes[1].data.params);assert.ok(g.position.y>=1000);assert.ok(b.position.x>a.position.x+a.width);assert.deepEqual(g.data.nodeIds,['a','b']);assert.equal(g.data.nodeOffsets.a.x,a.position.x-g.position.x);
 const again=plan({nodes:[...result.updates,nodes[2]],edges:snapshot.edges},[{id:'g',title:'S01',columns:[['a'],['b']]}]);assert.deepEqual(again.updates,result.updates);
});

test('layout converts parent-relative members onto the canvas grid',()=>{
 const parent={id:'old',type:'group',position:{x:500,y:400},width:400,height:300,parentId:'outer',data:{nodeIds:['a'],nodeOffsets:{a:{x:20,y:30}},title:'旧组'}};
 const a={id:'a',type:'rh-text',position:{x:20,y:30},parentId:'old',extent:'parent',positionAbsolute:{x:1,y:1},data:{text:'完整对白',groupId:'old'}};
 const other={id:'other',type:'group',position:{x:0,y:0},data:{nodeIds:[]}};
 const borrowed={id:'borrowed',type:'rh-text',position:{x:10,y:10},parentId:'other',data:{}};
 const edges=[{id:'e',source:'a',target:'a'}];
 const before=JSON.stringify({nodes:[parent,a],edges});
 assert.throws(()=>plan({nodes:[other,borrowed],edges:[]},[{id:'g',title:'S01',nodeIds:['borrowed']}]),/SOURCE_GROUP/);
 const result=plan({nodes:[parent,a],edges},[{id:'old',title:'S01',nodeIds:['a']}]);
 assert.equal(JSON.stringify({nodes:[parent,a],edges}),before);
 const moved=result.updates.find(n=>n.id==='a'),group=result.updates.find(n=>n.id==='old');
 assert.equal(moved.parentId,undefined);assert.equal(moved.parentNode,undefined);assert.equal(moved.extent,undefined);assert.equal(moved.positionAbsolute,undefined);
 assert.equal(moved.data.text,'完整对白');assert.equal(moved.data.groupId,'old');
 assert.equal(group.parentId,undefined);assert.equal(group.data.title,'旧组');
 assert.equal(group.data.nodeOffsets.a.x,moved.position.x-group.position.x);
 const far={id:'far',position:{x:0,y:2000},width:100,height:100,data:{}};
 const child={id:'child',position:{x:0,y:0},width:80,height:80,parentId:'far',data:{}};
 const free={id:'free',type:'rh-text',position:{x:0,y:0},parentId:'missing',data:{prompt:'保留'}};
 const placed=plan({nodes:[far,child,free],edges:[]},[{id:'g',title:'S',nodeIds:['free']}]);
 const card=placed.updates.find(n=>n.id==='free'),box=placed.updates.find(n=>n.id==='g');
 assert.equal(card.parentId,undefined);assert.equal(card.data.prompt,'保留');assert.ok(box.position.y<500);
});

test('layout requires every native child before moving its parent and preserves unrelated nodes',()=>{
 for(const field of ['parentId','parentNode']){
  const g={id:'g',type:'group',position:{x:1000,y:1000},data:{}};
  const a={id:'a',type:'rh-text',[field]:'g',position:{x:10,y:10},data:{text:'keep a'}};
  const b={id:'b',type:'rh-text',[field]:'g',position:{x:100,y:100},data:{text:'keep b'}};
  const fixed={id:'fixed',type:'rh-text',position:{x:3000,y:3000},data:{text:'untouched'}};
  const snapshot={nodes:[g,a,b,fixed],edges:[{id:'e',source:'a',target:'b'}]},before=JSON.stringify(snapshot);
  assert.throws(()=>plan(snapshot,[{id:'g',title:'G',nodeIds:['a']}]),/LAYOUT_INCLUDE_ALL_GROUP_MEMBERS/);
  const result=plan(snapshot,[{id:'g',title:'G',nodeIds:['a','b']}]);
  const merged=snapshot.nodes.map(n=>result.updates.find(u=>u.id===n.id)||n);
  assert.equal(JSON.stringify(snapshot),before);
  assert.deepEqual(merged.find(n=>n.id==='fixed'),fixed);
  assert.ok(merged.filter(n=>['a','b'].includes(n.id)).every(n=>!n.parentId&&!n.parentNode&&n.data.groupId==='g'));
  assert.equal(globalThis.RHLayoutTemplate.check({nodes:merged,edges:snapshot.edges}).passes,true);
 }
});

test('flattening an inner group removes old parent metadata without moving its siblings',()=>{
 const outer={id:'outer',type:'group',position:{x:1000,y:1000},width:1000,height:1000,data:{nodeIds:['g','sibling'],nodeOffsets:{g:{x:20,y:20},sibling:{x:600,y:600}},title:'Keep outer'}};
 const g={id:'g',type:'group',parentId:'outer',position:{x:20,y:20},data:{groupId:'outer',nodeIds:['a']}};
 const a={id:'a',type:'rh-text',parentId:'g',position:{x:10,y:10},data:{groupId:'g',text:'keep'}};
 const sibling={id:'sibling',type:'rh-text',parentId:'outer',position:{x:600,y:600},width:100,height:100,data:{groupId:'outer',text:'unchanged'}};
 const snapshot={nodes:[outer,g,a,sibling],edges:[]},before=JSON.stringify(snapshot);
 const result=plan(snapshot,[{id:'g',title:'Inner',nodeIds:['a']}]);
 const merged=snapshot.nodes.map(n=>result.updates.find(u=>u.id===n.id)||n),parent=merged.find(n=>n.id==='outer');
 assert.equal(JSON.stringify(snapshot),before);
 assert.deepEqual(parent.position,outer.position);assert.equal(parent.width,outer.width);assert.equal(parent.data.title,'Keep outer');
 assert.deepEqual(parent.data.nodeIds,['sibling']);assert.deepEqual(parent.data.nodeOffsets,{sibling:{x:600,y:600}});
 assert.deepEqual(merged.find(n=>n.id==='sibling'),sibling);
 assert.equal(merged.find(n=>n.id==='g').data.groupId,undefined);
 assert.equal(globalThis.RHLayoutTemplate.check({nodes:merged,edges:[]}).passes,true);
 const again=plan({nodes:merged,edges:[]},[{id:'g',title:'Inner',nodeIds:['a']}]);
 assert.deepEqual(again.updates,result.updates.filter(n=>n.id!=='outer'));
});

test('layout rejects duplicate nodes and partial groups before mutation',()=>{
 const snapshot={nodes:[{id:'a',data:{groupId:'old'}},{id:'b'},{id:'old',type:'group',data:{nodeIds:['a','b']}}],edges:[]};
 assert.throws(()=>plan(snapshot,[{id:'g',title:'new',columns:[['a']]}]),/SOURCE_GROUP/);
 assert.throws(()=>plan(snapshot,[{id:'old',title:'old',columns:[['a']]}]),/ALL_GROUP_MEMBERS/);
 assert.throws(()=>plan(snapshot,[{id:'g',title:'new',columns:[['b','b']]}]),/DUPLICATE/);
});

test('account discovery exhausts pages and nested folders without exporting credentials',async()=>{
 const {readFile}=await import('node:fs/promises');const {runInNewContext}=await import('node:vm');
 const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
 const functionSource=source.slice(source.indexOf('async function listAccountCanvases'),source.indexOf('\nconst transport='));
 const requests=[];
 const context={location:{origin:'https://rhtv.runninghub.ai'},document:{cookie:'Rh-Accesstoken=test-secret'},localStorage:{getItem:()=>null},atob,AbortSignal,URL,
  fetch:async(url,options)=>{const body=JSON.parse(options.body);requests.push({url,body,headers:options.headers});
   const records=body.folderId==='folder'?[{id:'nested',name:'Nested',type:'CANVAS'}]:body.page===1?[{id:'folder',name:'Folder',type:'FOLDER'},{id:'root',name:'Root',type:'CANVAS'}]:[{id:'last',name:'Last',type:'CANVAS'}];
   return {ok:true,json:async()=>({code:0,data:{records,pages:body.folderId?1:2}})};
  }};
 const result=await runInNewContext(functionSource+'\nlistAccountCanvases({origin:location.origin,scope:"personal"})',context);
 assert.equal(result.complete,true);assert.equal(result.canvases.length,3);assert.equal(result.canvases.find(c=>c.id==='nested').folderPath,'Folder');assert.equal(requests.length,3);assert.ok(requests.every(r=>!r.headers['X-Team-Id']));assert.equal(JSON.stringify(result).includes('test-secret'),false);
});

test('account mutation receipts survive restart without replaying uncertain writes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rh-browser-receipts-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input={action:'manageCanvas',operation:'renameCanvas',requestId:'durable-browser-001',body:{id:'123',name:'fixture'}};
 const first=new BrowserBroker(root),job=first.enqueue(input);first.poll();
 const restored=new BrowserBroker(root);assert.equal(restored.result(job.id).state,'unknown');assert.equal(restored.poll(),null);assert.equal(restored.enqueue(input).id,job.id);
 assert.throws(()=>restored.enqueue({...input,body:{id:'456',name:'fixture'}}),/CONFLICT/);
});

test('browser jobs stay with the explicitly requested browser provider',()=>{
 const b=new BrowserBroker();const j=b.enqueue({action:'openCanvas',canvasUrl:'https://rhtv.runninghub.ai/project/canvas/123',browserSource:'codex-browser'});
 assert.equal(b.poll('browser-extension'),null);assert.equal(b.poll('codex-browser').id,j.id);
 assert.deepEqual(b.status().providers,['browser-extension','codex-browser']);
});

test('Codex new tabs satisfy the host active-tab requirement; normal browser tabs keep focus preference',async()=>{
 const {readFile}=await import('node:fs/promises');const {runInNewContext}=await import('node:vm');const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
 for(const provider of ['codex-browser','browser-extension']){
  let options;const url='https://rhtv.runninghub.ai/project/canvas/123';
  const context={crypto:{randomUUID:()=>"fixture"},RHCanvasSitePolicy:globalThis.RHCanvasSitePolicy,importScripts(){},setTimeout,chrome:{tabs:{query:async()=>[],create:async o=>{options=o;if(provider==='codex-browser'&&!o.active)throw Error('host requires active tab');return {id:1};},get:async()=>({id:1,url,status:'complete'})},scripting:{executeScript:async()=>[]}}};
  const code=source.slice(0,source.indexOf('\nconst transport=')).replace("const BROWSER_SOURCE='browser-extension'",`const BROWSER_SOURCE='${provider}'`);
  const result=await runInNewContext(code+`\nhandle({action:'openCanvas',canvasUrl:${JSON.stringify(url)},focus:false})`,context);assert.equal(result.ok,true);assert.equal(options.active,provider==='codex-browser');
 }
});

test('first account request waits for an embedded tab to register and dispatches the API action only once',async()=>{
 const {readFile}=await import('node:fs/promises');const {runInNewContext}=await import('node:vm');const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
 const origin='https://rhtv.runninghub.ai',url=origin+'/projects/canvas/me';
 for(const action of ['listCanvases','manageCanvas']){
  let created=0,gets=0,dispatched=0;
  const context={crypto:{randomUUID:()=>"fixture"},RHCanvasSitePolicy:globalThis.RHCanvasSitePolicy,importScripts(){},setTimeout:fn=>setTimeout(fn,0),chrome:{
   tabs:{query:async()=>created?[{id:2,url,status:'complete'}]:[],create:async o=>{assert.equal(o.active,true);created++;return {id:1,url};},get:async id=>{gets++;if(id===1 || gets<3)throw Error('No tab with id: '+id+'.');return {id:2,url,status:'complete'};}},
   scripting:{executeScript:async o=>{assert.equal(o.target.tabId,2);dispatched++;return [{result:{ok:true}}];}}
  }};
  const code=source.slice(0,source.indexOf('\nconst transport=')).replace("const BROWSER_SOURCE='browser-extension'","const BROWSER_SOURCE='codex-browser'");
  const result=await runInNewContext(code+`\nhandle({action:${JSON.stringify(action)},origin:${JSON.stringify(origin)},operation:'renameCanvas',scope:'personal',body:{id:'123',name:'fixture'}})`,context);
  assert.equal(result.ok,true);assert.equal(created,1);assert.equal(dispatched,1);assert.equal(gets,3);
 }
});


test('sections form aligned rows and columns with mixed portrait and landscape P nodes, preserving history and repeatability',()=>{
 const nodes=Array.from({length:17},(_,i)=>({id:'grid-'+i,type:'rh-ai',position:{x:5000,y:5000},data:{bridgeProductionKey:'EP01/P'+i,params:{ratio:i%2?'9:16':'16:9'},historyStorage:{historyId:'own-'+i,resultCount:3},adopted:true}}));
 const groups=Array.from({length:5},(_,i)=>({id:'section-'+i,title:'Section '+i,nodeIds:nodes.slice(i*4,(i+1)*4).map(n=>n.id)}));
 const s={nodes,edges:[]},before=structuredClone(s),p=plan(s,groups),g=id=>p.updates.find(n=>n.id===id);
 assert.equal(g('section-0').position.y,g('section-1').position.y);assert.ok(g('section-1').position.x>g('section-0').position.x+g('section-0').width);
 assert.equal(g('section-0').position.x,g('section-2').position.x);assert.ok(g('section-2').position.y>=g('section-0').position.y+g('section-0').height+160);assert.ok(g('section-4').position.y>g('section-2').position.y);
 assert.equal(globalThis.RHLayoutTemplate.check({nodes:p.updates,edges:[]}).passes,true);assert.deepEqual(s,before);for(const n of nodes){assert.deepEqual(g(n.id).data.historyStorage,n.data.historyStorage);assert.equal(g(n.id).data.bridgeProductionKey,n.data.bridgeProductionKey);assert.equal(g(n.id).data.adopted,true);}
 assert.deepEqual(plan({nodes:p.updates,edges:[]},groups).updates,p.updates);
 const three=plan(s,groups,{groupColumns:3});assert.equal(three.updates.find(n=>n.id==='section-2').position.y,three.updates.find(n=>n.id==='section-0').position.y);
 const stack=plan(s,groups,{groupColumns:1});assert.equal(new Set(stack.updates.filter(n=>n.type==='group').map(n=>n.position.x)).size,1);
 for(const groupColumns of [0,1.5,13,NaN])assert.throws(()=>plan(s,groups,{groupColumns}),/GROUP_COLUMNS/);
});
test('an obstacle under one section shifts the whole row together and keeps the following row clear',()=>{
 const nodes=['a','b','c'].map(id=>({id,type:'rh-image',position:{x:0,y:0},data:{params:{ratio:'16:9'}}})),groups=nodes.map(n=>({id:'g-'+n.id,title:n.id,nodeIds:[n.id]}));
 const first=plan({nodes,edges:[]},groups),b=first.updates.find(n=>n.id==='g-b');const obstacle={id:'fixed',position:{x:b.position.x+30,y:10},width:120,height:900,data:{}};
 const p=plan({nodes:[...nodes,obstacle],edges:[]},groups),g=id=>p.updates.find(n=>n.id===id);
 assert.equal(g('g-a').position.y,g('g-b').position.y);assert.ok(g('g-a').position.y>=1070);assert.equal(globalThis.RHLayoutTemplate.check({nodes:[...p.updates,obstacle],edges:[]}).passes,true);assert.equal(p.updates.some(n=>n.id==='fixed'),false);
});
test('legacy preferences receive new grid defaults without rewriting stored settings or canvas overrides',async t=>{
 const {writeFile,readFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'rh-pref-v3-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'layout.json'),original=JSON.stringify({version:1,default:{templateId:'scene-columns-v1',options:{gap:90,maxColumns:3}},canvases:{}});await writeFile(path,original);const store=new LayoutStore(path),v=await store.get();assert.equal(v.options.groupColumns,2);assert.equal(v.options.maxColumns,3);assert.equal(v.template.version,3);assert.equal(await readFile(path,'utf8'),original);
 await store.set({options:{groupColumns:3,maxColumns:5}});assert.equal((await new LayoutStore(path).get()).options.groupColumns,3);await assert.rejects(store.set({options:{groupColumns:0}}),/INVALID/);
});
