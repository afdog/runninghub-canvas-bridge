import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {applyUpdate,atomicJson,fingerprint,latestRelease,validateManifest,withUpdateLock,swapFiles} from '../scripts/rh-update.mjs';
import {extractPackage} from '../scripts/update-archive.mjs';
import {UpdateMaintenance} from '../server/update-maintenance.mjs';

const tar=({name='package/file.txt',type='0',body='content'}={})=>{
 const data=Buffer.from(body),header=Buffer.alloc(512);header.write(name);header.write('0000644',100);header.write(data.length.toString(8).padStart(11,'0'),124);header.fill(32,148,156);header.write(type,156);
 header.write(header.reduce((sum,b)=>sum+b,0).toString(8).padStart(6,'0')+'\0 ',148);
 return gzipSync(Buffer.concat([header,data,Buffer.alloc((512-data.length%512)%512+1024)]));
};
async function fixture(t){
 const base=await mkdtemp(join(tmpdir(),'rh-update-路径 '));t.after(()=>rm(base,{recursive:true,force:true}));
 const root=join(base,'app'),data=join(base,'private');await mkdir(root);await mkdir(data);
 const make=async(path,version)=>{await mkdir(join(path,'scripts'),{recursive:true});await writeFile(join(path,'package.json'),JSON.stringify({name:'runninghub-canvas-bridge',version}));for(const file of ['rh-update.mjs','update-host.mjs','update-archive.mjs'])await writeFile(join(path,'scripts',file),'// '+version);};
 await make(root,'0.9.0');await writeFile(join(root,'cloudflared.exe'),'unchanged third-party executable');
 await writeFile(join(data,'oauth-state.json'),'current OAuth grants');await writeFile(join(data,'config.json'),'current preferences');
 const config={enabled:true,root,data,node:process.execPath,bridgeUrl:'http://127.0.0.1:1',fingerprint:await fingerprint(root)};
 const release={available:true,version:'0.9.1',manifest:{format:1,version:'0.9.1',stateSchema:1,minNodeMajor:20,archive:{name:'runninghub-canvas-bridge-0.9.1.tgz',bytes:1,sha256:'a'.repeat(64)}}};
 const calls=[];
 const hooks={prepare:async(c,r,b,stage)=>{const path=join(stage,'package');await make(path,r.version);return path;},discover:async()=>[{name:'bridge'}],acquire:async()=>{},stop:async()=>calls.push('stop'),start:async()=>calls.push('start'),ready:async()=>{}};
 return {base,root,data,config,release,hooks,calls};
}
test('stable release selection ignores GitHub latest ordering, drafts and prereleases',async()=>{
 const manifest={format:1,version:'0.9.1',stateSchema:1,minNodeMajor:20,archive:{name:'runninghub-canvas-bridge-0.9.1.tgz',bytes:1,sha256:'a'.repeat(64)}};
 const result=await latestRelease('0.9.0',async url=>url.endsWith('update.json')?manifest:[{tag_name:'v0.1.0'},{tag_name:'v0.9.1',assets:[{name:'update.json'}]},{tag_name:'v1.0.0',prerelease:true},{tag_name:'v2.0.0',draft:true}]);
 assert.equal(result.version,'0.9.1');assert.ok(result.url.startsWith('https://github.com/limyum-creator/'));
 assert.throws(()=>validateManifest({...manifest,stateSchema:2},'0.9.1'),/INVALID_UPDATE_MANIFEST/);
 assert.throws(()=>validateManifest({...manifest,archive:{...manifest.archive,name:'../secret'}},'0.9.1'),/INVALID_UPDATE_MANIFEST/);
});
test('archive extraction rejects traversal, links and platform-specific unsafe names before writing',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rh-tar-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const name of ['package/../outside','package/C:/bad','package/CON.txt','package/trailing.','package/a\\b'])await assert.rejects(extractPackage(tar({name}),root),/INVALID_ARCHIVE_PATH/);
 await assert.rejects(extractPackage(tar({type:'2'}),root),/ARCHIVE_LINKS_NOT_ALLOWED/);
 await extractPackage(tar(),root);assert.equal(await readFile(join(root,'file.txt'),'utf8'),'content');
});
test('update replaces code while leaving configuration, live OAuth and extra executables intact',async t=>{
 const f=await fixture(t);
 f.hooks.ready=async()=>{await writeFile(join(f.data,'oauth-state.json'),'grant refreshed during new version');};
 const result=await applyUpdate(f.config,{release:f.release,bytes:Buffer.from('x'),hooks:f.hooks});
 assert.equal(result.updated,true);assert.equal(JSON.parse(await readFile(join(f.root,'package.json'))).version,'0.9.1');
 assert.equal(await readFile(join(f.data,'oauth-state.json'),'utf8'),'grant refreshed during new version');
 assert.equal(await readFile(join(f.data,'config.json'),'utf8'),'current preferences');
 assert.equal(await readFile(join(f.root,'cloudflared.exe'),'utf8'),'unchanged third-party executable');
 assert.deepEqual(f.calls,['stop','start']);
});
test('failed health rolls code back without rolling OAuth refreshes back, then blocks that release',async t=>{
 const f=await fixture(t);f.hooks.ready=async(c,version)=>{if(version==='0.9.1'){await writeFile(join(f.data,'oauth-state.json'),'rotated refresh token');throw Error('HEALTH_FAILED');}};
 const result=await applyUpdate(f.config,{release:f.release,bytes:Buffer.from('x'),hooks:f.hooks});
 assert.equal(result.rolledBack,true);assert.equal(JSON.parse(await readFile(join(f.root,'package.json'))).version,'0.9.0');
 assert.equal(await readFile(join(f.data,'oauth-state.json'),'utf8'),'rotated refresh token');
 assert.equal((await applyUpdate(f.config,{release:f.release,bytes:Buffer.from('x'),hooks:f.hooks})).reason,'VERSION_PREVIOUSLY_ROLLED_BACK');
});
test('busy bridge defers before service stop; local edits and downgrade are rejected',async t=>{
 const f=await fixture(t);f.hooks.acquire=async()=>{throw Error('BRIDGE_BUSY');};
 assert.equal((await applyUpdate(f.config,{release:f.release,bytes:Buffer.from('x'),hooks:f.hooks})).reason,'BRIDGE_BUSY');assert.deepEqual(f.calls,[]);
 await assert.rejects(applyUpdate(f.config,{release:{...f.release,version:'0.8.2'},bytes:Buffer.from('x'),hooks:f.hooks}),/DOWNGRADE/);
 await writeFile(join(f.root,'scripts/rh-update.mjs'),'user edit');
 await assert.rejects(applyUpdate(f.config,{release:f.release,bytes:Buffer.from('x'),hooks:f.hooks}),/LOCAL_FILES_CHANGED/);
});
test('checksum failure never stops a running service',async t=>{
 const f=await fixture(t);delete f.hooks.prepare;
 await assert.rejects(applyUpdate(f.config,{release:f.release,bytes:Buffer.from('x'),hooks:f.hooks}),/ARCHIVE_CHECKSUM_MISMATCH/);assert.deepEqual(f.calls,[]);
});
test('single updater lock prevents parallel swaps',async t=>{
 const f=await fixture(t);const dir=join(f.data,'updater');
 await withUpdateLock(dir,async()=>assert.equal((await withUpdateLock(dir,()=>assert.fail())).reason,'UPDATER_ALREADY_RUNNING'));
});
test('interrupted rename recovers using the durable plan before checking releases',async t=>{
 const f=await fixture(t);const stage=join(f.base,'.rh-update-crash'),staged=join(stage,'package.json'),backup=join(stage,'backup.json');await mkdir(stage);await writeFile(staged,'new partial data');
 const entry={target:join(f.root,'package.json'),staged,backup,existed:true};
 const journal={phase:'prepared',previous:'0.9.0',version:'0.9.1',stage,services:[{name:'bridge'}],entries:[entry]};
 await atomicJson(join(f.data,'updater/transaction.json'),journal);await rename(entry.target,backup);
 const result=await applyUpdate(f.config,{hooks:f.hooks});assert.equal(result.recovered,true);
 assert.equal(JSON.parse(await readFile(entry.target)).version,'0.9.0');assert.equal(f.config.fingerprint,await fingerprint(f.root));
});
test('maintenance lease excludes new work, waits for requests/downloads and expires safely',()=>{
 let now=0,busy=1,paused=false;const m=new UpdateMaintenance({busy:()=>({downloads:busy}),now:()=>now,pause:()=>paused=true,resume:()=>paused=false});
 const id=randomUUID();assert.equal(m.acquire(id).reason,'BRIDGE_BUSY');busy=0;m.requests=1;assert.equal(m.acquire(id).reason,'BRIDGE_BUSY');m.requests=0;
 assert.equal(m.acquire(id).ok,true);assert.equal(paused,true);assert.equal(m.acquire(randomUUID()).reason,'UPDATE_ALREADY_PENDING');
 m.release(randomUUID());assert.equal(m.status().maintenance,true);now=120001;assert.equal(m.status().maintenance,false);assert.equal(paused,false);
});
