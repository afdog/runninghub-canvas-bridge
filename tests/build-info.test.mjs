import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {captureBuild,inspectBuild,extensionBuild,deploymentActions,EXTENSION_FILES} from '../server/build-info.mjs';
import {BrowserBroker} from '../server/browser-broker.mjs';
test('same-version source changes distinguish loaded and disk builds; no private configuration hashed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rh-build with spaces-'));t.after(()=>rm(root,{recursive:true,force:true}));const url=pathToFileURL(root+'/');
 await mkdir(join(root,'server'));await mkdir(join(root,'extension'));await writeFile(join(root,'package.json'),'{"version":"0.10.3"}');await writeFile(join(root,'extension/site-policy.js'),'policy');await writeFile(join(root,'server/server.mjs'),'before');
 const active=captureBuild(url);assert.equal((await inspectBuild(active,url)).needsRestart,false);await writeFile(join(root,'oauth-state.json'),'secret');assert.equal((await inspectBuild(active,url)).needsRestart,false);
 await writeFile(join(root,'server/server.mjs'),'after');const result=await inspectBuild(active,url);assert.equal(result.needsRestart,true);assert.equal(result.active.version,result.disk.version);assert.equal(deploymentActions({backend:result}).length,1);
});
test('extension fingerprint matches browser implementation for both browser packages',async()=>{
 const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),code=source.slice(0,source.indexOf('const delay='));
 const expected=await extensionBuild();
 for(const provider of ['browser-extension','codex-browser']){
  const ctx={crypto:webcrypto,TextEncoder,importScripts(){},chrome:{runtime:{getURL:name=>name}},fetch:async name=>({ok:true,text:async()=>(await readFile(new URL('../extension/'+name,import.meta.url),'utf8')).replaceAll('browser-extension',provider)})};
  const actual=await vm.runInNewContext(code.replaceAll('browser-extension',provider)+'\nactiveBuild',ctx);assert.equal(actual,expected.fingerprint);
 }
 assert.equal(EXTENSION_FILES.length,5);
});
test('diagnosis reports individual extension instances and actionable build differences',()=>{
 const b=new BrowserBroker();b.poll('browser-extension','0.10.3','a'.repeat(64),'one');b.poll('browser-extension','0.10.3','b'.repeat(64),'two');assert.equal(b.status().extensionVersions.length,2);
 const actions=deploymentActions({extension:{expected:{version:'0.10.3',fingerprint:'a'.repeat(64)},observed:b.status().extensionVersions},mcp:{needsRestart:true},runtime:[{freshness:'stale'}]});assert.equal(actions.length,3);assert.ok(actions.some(s=>s.includes('OAuth')));
});

test('all MCP-imported shared JS changes invalidate build, while page-only scripts stay in runtime diagnostics',async t=>{
 const {SHARED_SERVER_FILES}=await import('../server/build-info.mjs');
 const root=await mkdtemp(join(tmpdir(),'rh-shared-build-'));t.after(()=>rm(root,{recursive:true,force:true}));const url=pathToFileURL(root+'/');
 await mkdir(join(root,'server'));await mkdir(join(root,'extension'));await writeFile(join(root,'package.json'),'{"version":"0.10.3"}');await writeFile(join(root,'extension/site-policy.js'),'policy');await writeFile(join(root,'server/mcp.mjs'),'mcp');
 for(const name of SHARED_SERVER_FILES)await writeFile(join(root,'server',name),'before');
 for(const name of SHARED_SERVER_FILES){const active=captureBuild(url);await writeFile(join(root,'server',name),'after');assert.equal((await inspectBuild(active,url)).needsRestart,true,name);assert.equal((await inspectBuild(captureBuild(url),url)).needsRestart,false);}
 const active=captureBuild(url);await writeFile(join(root,'server/bridge-runtime.js'),'page-only');assert.equal((await inspectBuild(active,url)).needsRestart,false);
 const source=await readFile(new URL('../server/mcp-production.mjs',import.meta.url),'utf8');
 for(const match of source.matchAll(/import ['"]\.\/(.+\.js)['"]/g))assert.ok(SHARED_SERVER_FILES.includes(match[1]),'untracked imported JS: '+match[1]);
});
