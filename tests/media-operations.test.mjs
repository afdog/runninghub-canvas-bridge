import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {MediaConsent,hash,saveJson,ownerHash} from '../server/media-consent.mjs';
import {MediaOperations} from '../server/media-operations.mjs';
import {processingArgs,processLocal,ffmpegPath,nativeMediaRequest} from '../server/media-processing.mjs';
const exec=promisify(execFile);
async function temp(t){const p=await realpath(await mkdtemp(join(tmpdir(),'rh-media-')));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
test('local-only owner key is stable and corrupt remote configuration never silently replaces authorization',async t=>{
 const root=await temp(t),config=join(root,'remote.json');const first=await ownerHash(root,config);assert.equal(await ownerHash(root,config),first);assert.equal(hash((await readFile(join(root,'owner-key.txt'),'utf8')).trim()),first);await writeFile(config,'broken json');await assert.rejects(ownerHash(root,config));assert.equal(hash((await readFile(join(root,'owner-key.txt'),'utf8')).trim()),first);
});
test('paid media requires owner secret, same-origin CSRF and unchanged unexpired plan',async t=>{
 const root=await temp(t),id=randomUUID(),plan={id,digest:'pinned',state:'awaiting_consent',expiresAt:Date.now()+60000,cost:{kind:'unknown'},operation:'image_upscale'};await saveJson(join(root,id+'.json'),plan);
 const consent=new MediaConsent({root,origin:'https://example.test',secretHash:hash('owner-key')}),{csrf,html}=await consent.page(id);assert.match(html,/积分/);assert.match(html,/一次/);
 await assert.rejects(consent.approve(id,{csrf,ownerSecret:'wrong',consent:'yes'},csrf,'https://example.test'),/OWNER_KEY/);
 await assert.rejects(consent.approve(id,{csrf,ownerSecret:'owner-key',consent:'yes'},csrf,'https://evil.test'),/CONSENT/);
 await consent.approve(id,{csrf,ownerSecret:'owner-key',consent:'yes'},csrf,'https://example.test');assert.equal(JSON.parse(await readFile(join(root,id+'.approval.json'),'utf8')).digest,'pinned');
 await assert.rejects(consent.approve(id,{csrf,ownerSecret:'owner-key',consent:'yes'},csrf,'https://example.test'),/CONSENT/);
});
test('unknown-cost canvas jobs cannot self-approve or bypass consent and dispatch once only',async t=>{
 const root=await temp(t),context={canvasUrl:'https://www.runninghub.ai/project/canvas/c',sessionId:'s'},source={id:'source',type:'rh-video',position:{x:0,y:0},data:{output:[{url:'https://example.com/source.mp4'}]}},target={id:'target',type:'rh-video',data:{output:[]}},snapshot={canvasId:'c',nodes:[source,target],edges:[]};let calls=0;
 let jobs;const bridge={wireId:id=>id,command:async(type,args,opts)=>{if(type==='canvas.yjsSnapshot')return{result:structuredClone(snapshot)};jobs.authorizeCommand({...args,type,id:opts.id},context.canvasUrl);calls++;return{result:{taskId:'real-receipt'}};}};
 jobs=new MediaOperations({root,bridgeFactory:()=>bridge});await jobs.init();
 const plan=await jobs.plan({sourceNodeId:'source',processingNodeId:'target',operation:'speed',provider:'canvas-media',options:{rate:2},routingReason:'Native output quality and user workflow'},context);
 await assert.rejects(jobs.execute(plan.id,{...context,userApproved:true}),/CONSENT/);assert.equal(calls,0);
 assert.throws(()=>jobs.authorizeCommand({type:'canvas.runMediaOperation',nodeId:'target',dryRun:false},context.canvasUrl),/CONSENT/);
 assert.throws(()=>jobs.authorizeCommand({type:'canvas.runNode',nodeId:'target'},context.canvasUrl),/CONSENT/);
 await saveJson(join(root,plan.id+'.approval.json'),{digest:plan.digest,expiresAt:Date.now()+60000});
 source.data.changed=true;await assert.rejects(jobs.execute(plan.id,context),/SOURCE_CHANGED/);delete source.data.changed;
 await jobs.execute(plan.id,context);for(let i=0;i<100&&jobs.active.size;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(jobs.status(plan.id,context.canvasUrl).state,'submitted');await jobs.execute(plan.id,context);assert.equal(calls,1);
 const restarted=new MediaOperations({root,bridgeFactory:()=>bridge});await restarted.init();await restarted.execute(plan.id,context);assert.equal(calls,1);
});
test('local filters reject injection, out-of-range geometry and excessive reverse memory',()=>{
 const media={kind:'video',width:320,height:240,duration:2,channels:2};
 assert.throws(()=>processingArgs('speed',{rate:'2;exec'},media,'in','out'),/INVALID/);
 assert.throws(()=>processingArgs('crop',{x:300,y:0,width:100,height:100},media,'in','out'),/BOUNDS/);
 assert.throws(()=>processingArgs('reverse',{}, {...media,duration:1000},'in','out'),/MEMORY_LIMIT/);
 assert.match(processingArgs('speed',{rate:4},media,'in','out').join(' '),/atempo=2,atempo=2/);
 assert.equal(nativeMediaRequest({canvasId:'c',nodeId:'n',url:'https://example.com/a.mp4',operation:'trim',options:{start:0,end:1}}).operateType,'CROP_DURATION');
});
test('unknown browser receipt is reconciled by status without replaying a command',async t=>{
 const root=await temp(t),id=randomUUID(),canvasUrl='https://www.runninghub.ai/project/canvas/c';let reads=0;
 await saveJson(join(root,id+'.json'),{id,canvasUrl,provider:'canvas-browser',state:'unknown',commandRequestId:'same-request',cost:{kind:'free'}});
 const jobs=new MediaOperations({root,bridgeFactory:()=>({request:async path=>{assert.equal(path,'/result?id=same-request');reads++;return {ok:true,result:{primaryReference:{nodeId:'already-created'}}};},command:()=>{throw Error('MUST_NOT_REPLAY');}})});await jobs.init();
 assert.equal((await jobs.refreshStatus(id,{canvasUrl})).state,'complete');await jobs.refreshStatus(id,{canvasUrl});assert.equal(reads,1);
});
test('real local FFmpeg video/image processing creates verified results without modifying input',async t=>{
 const root=await temp(t);let binary;try{binary=await ffmpegPath();}catch{return t.skip('FFmpeg not installed on this host');}
 const input=join(root,'input.mp4');await exec(binary,['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=12','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',input]);const before=hash(await readFile(input));
 for(const [op,options]of [['capture_frame',{time:0.5}],['trim',{start:0.2,end:1.2}],['crop',{x:0,y:0,width:160,height:120}],['speed',{rate:2}],['rotate',{degrees:90}],['extract_audio',{}],['reverse',{}]]){
  const directory=join(root,op);await mkdir(directory);const r=await processLocal({operation:op,options,input,directory});assert.ok(r.media.size>0);if(op==='crop')assert.equal(r.media.width,160);if(op==='speed')assert.ok(r.media.duration<1.3);if(op==='extract_audio')assert.equal(r.media.kind,'audio');
 }
 const directory=join(root,'image');await mkdir(directory);const r=await processLocal({operation:'resize',options:{width:80,height:60},input:join(root,'capture_frame','result.png'),directory});assert.equal(r.media.width,80);assert.equal(hash(await readFile(input)),before);
});
