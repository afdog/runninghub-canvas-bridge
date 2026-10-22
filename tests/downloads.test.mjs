import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Downloads} from '../server/downloads.mjs';
function wav(){const b=Buffer.alloc(1644);b.write('RIFF');b.writeUInt32LE(1636,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(1600,40);return b;}
async function settled(d,id){for(let i=0;i<100;i++){const j=d.status(id);if(['failed','complete'].includes(j.state)){await d.running.get(id);return d.status(id);}await new Promise(r=>setTimeout(r,20));}throw new Error('download did not finish');}
test('downloads survive process recreation, verify media, deduplicate and reject unsafe attachment URLs',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'rh-download-')));t.after(()=>rm(root,{recursive:true,force:true}));let count=0;
 const d=new Downloads(join(root,'jobs'),async()=>{count++;return new Response(wav(),{headers:{etag:'"one"'}});});await d.init();
 const input={requestId:'download-test-001',destination:join(root,'中文素材'),files:[{url:'https://rh-hk-canvas-files.xiaoyaoyou.com/test.wav',name:'P001'}]};const first=await d.add(input),done=await settled(d,first.id);assert.equal(done.state,'complete',done.error);assert.equal(done.files[0].mime,'audio/wav');assert.equal((await readFile(done.files[0].path)).length,1644);assert.equal(JSON.stringify(done).includes('https://'),false);
 const restarted=new Downloads(d.root,d.fetcher);await restarted.init();await restarted.add(input);assert.equal(count,1);assert.equal(restarted.status(first.id).state,'complete');await assert.rejects(restarted.add({...input,files:[{url:'https://127.0.0.1/private',chatgpt:true}]}),/HOST/);
 await assert.rejects(restarted.add({...input,destination:join(root,'elsewhere')}),/CONFLICT/);
});
test('failed downloads retain partial bytes and resume using validated range',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'rh-resume-')));t.after(()=>rm(root,{recursive:true,force:true}));let round=0,range;
 const d=new Downloads(join(root,'jobs'),async(url,options)=>{round++;if(round===1){let sent=false;return new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(wav().subarray(0,800));}else c.error(new Error('network drop'));}}),{headers:{etag:'"one"'}});}range=options.headers.Range;return new Response(wav().subarray(range?800:0),{status:range?206:200,headers:{etag:'"one"',...(range?{'content-range':'bytes 800-1643/1644'}:{})}});});await d.init();const j=await d.add({requestId:'resume-test-001',destination:join(root,'out'),files:[{url:'https://hubimgs.com/a.wav'}]});assert.equal((await settled(d,j.id)).state,'failed');await d.retry(j.id);const done=await settled(d,j.id);assert.equal(done.state,'complete',done.error);assert.equal(done.files[0].bytes,1644);
});

test('official ChatGPT regional Azure attachments are accepted; unrelated Azure hosts are rejected',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'rh-chat-file-')));t.after(()=>rm(root,{recursive:true,force:true}));const d=new Downloads(join(root,'jobs'),async()=>new Response(wav()));await d.init();const input={requestId:'chatgpt-file-001',destination:join(root,'out'),files:[{url:'https://oaisdmntprseasia.blob.core.windows.net/file.wav?sig=test',chatgpt:true}]};const job=await d.add(input);assert.equal((await settled(d,job.id)).state,'complete');await assert.rejects(d.add({...input,requestId:'chatgpt-file-002',files:[{url:'https://unrelated.blob.core.windows.net/file',chatgpt:true}]}),/HOST/);
});
