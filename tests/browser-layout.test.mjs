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
 assert.equal(a.width,180);assert.equal(a.height,180);assert.equal(a.data.prompt,'完整正文');assert.equal(a.data.taskId,'task');assert.deepEqual(b.data.params,nodes[1].data.params);assert.ok(g.position.y>=1000);assert.ok(b.position.x>a.position.x+a.width);assert.deepEqual(g.data.nodeIds,['a','b']);assert.equal(g.data.nodeOffsets.a.x,a.position.x-g.position.x);
 const again=plan({nodes:[...result.updates,nodes[2]],edges:snapshot.edges},[{id:'g',title:'S01',columns:[['a'],['b']]}]);assert.deepEqual(again.updates,result.updates);
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
 const functionSource=source.slice(source.indexOf('async function listAccountCanvases'),source.indexOf('\nasync function pump'));
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
