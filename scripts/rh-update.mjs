#!/usr/bin/env node
// Opt-in updater. This engine is copied outside the installation before use so
// replacing or rolling back the package cannot remove the recovery executable.
import {readFile,writeFile,mkdir,readdir,lstat,rename,rm,cp,open,unlink,link} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,resolve,relative} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {exists,delay,readJson,run,discoverServices,stopServices,startServices,schedule} from './update-host.mjs';
import {extractPackage} from './update-archive.mjs';

export const REPOSITORY='limyum-creator/runninghub-canvas-bridge';
export const OWNED=['bin','docs','extension','scripts','server','node_modules','package.json','package-lock.json','npm-shrinkwrap.json','README.md','AGENT_INSTALL.md','AGENT_QUICKSTART.md','CONTRIBUTING.md','LICENSE','UPSTREAM.md','CHANGELOG.md'];
const EXTENSION_FILES=['manifest.json','background.js','browser-pump.js','keepalive.js','site-policy.js','bridge-main.js','LICENSE','UPSTREAM.md'];
const ENGINE=['rh-update.mjs','update-host.mjs','update-archive.mjs'];
const hash=b=>createHash('sha256').update(b).digest('hex');
export function compareVersions(a,b){
  const parse=v=>{if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v))throw Error('STABLE_VERSION_REQUIRED');return v.split('.').map(Number);};
  const x=parse(a),y=parse(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return Math.sign(x[i]-y[i]);return 0;
}
export async function atomicJson(path,value){
  await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp';
  const handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
  await rename(temp,path);
}
async function installRecoveryEngine(root,dir){
  const engineDir=join(dir,'engines',randomUUID());await mkdir(engineDir,{recursive:true});
  for(const file of ENGINE)await cp(join(root,'scripts',file),join(engineDir,file));
  // A stable, dependency-free launcher selects a complete engine directory.
  // Updating the pointer is atomic; a power cut cannot mix engine modules.
  const launcher=`import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url));const pointer=JSON.parse(readFileSync(join(dir,'engine.json'),'utf8'));const child=spawnSync(process.execPath,[join(dir,'engines',pointer.id,'rh-update.mjs'),...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});process.exitCode=child.status??1;
`;
  await writeFile(join(dir,'rh-update.mjs'),launcher,{mode:0o600});
  await atomicJson(join(dir,'engine.json'),{id:engineDir.split(/[\\/]/).at(-1)});
}
export async function fingerprint(root){
  const digest=createHash('sha256');
  const walk=async (p,name)=>{const st=await lstat(p);if(st.isSymbolicLink())throw Error('INSTALL_SYMLINK_NOT_SUPPORTED');if(st.isDirectory()){for(const item of (await readdir(p)).sort())await walk(join(p,item),name+'/'+item);}else{digest.update(name+'\0');digest.update(await readFile(p));}};
  for(const name of OWNED.filter(n=>n!=='node_modules'))if(await exists(join(root,name)))await walk(join(root,name),name);
  return digest.digest('hex');
}
async function extensionFingerprint(path){const digest=createHash('sha256');for(const f of EXTENSION_FILES){digest.update(f);digest.update(await readFile(join(path,f)));}return digest.digest('hex');}
async function sourceCheckout(root){let p=resolve(root);while(true){if(await exists(join(p,'.git')))return true;const parent=dirname(p);if(parent===p)return false;p=parent;}}
async function jsonFetch(url,options={}){const response=await fetch(url,{signal:AbortSignal.timeout(30000),...options});if(!response.ok)throw Error('HTTP_'+response.status);return response.json();}
export async function latestRelease(current,fetchJson=jsonFetch){
  // GitHub's "latest" flag can point to an older manually published release.
  const releases=await fetchJson(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`,{headers:{Accept:'application/vnd.github+json','User-Agent':'RunningHub-Update'}});
  const candidates=releases.filter(r=>!r.draft&&!r.prerelease&&/^v\d+\.\d+\.\d+$/.test(r.tag_name));
  candidates.sort((a,b)=>compareVersions(b.tag_name.slice(1),a.tag_name.slice(1)));
  const release=candidates[0];if(!release||compareVersions(release.tag_name.slice(1),current)<=0)return {available:false,current};
  const version=release.tag_name.slice(1),base=`https://github.com/${REPOSITORY}/releases/download/v${version}/`;
  if(!release.assets?.some(a=>a.name==='update.json'))return {available:false,current,latest:version,reason:'RELEASE_HAS_NO_UPDATE_MANIFEST'};
  const manifest=await fetchJson(base+'update.json');validateManifest(manifest,version);
  return {available:true,current,version,manifest,url:base+manifest.archive.name};
}
export function validateManifest(m,version){
  compareVersions(version,version);
  if(m.format!==1||m.version!==version||m.stateSchema!==1||m.archive?.name!==`runninghub-canvas-bridge-${version}.tgz`||! /^[a-f0-9]{64}$/.test(m.archive.sha256)||!Number.isInteger(m.archive.bytes)||m.archive.bytes<1||m.archive.bytes>100*1024*1024)throw Error('INVALID_UPDATE_MANIFEST');
  if(!Number.isInteger(m.minNodeMajor)||m.minNodeMajor<20||Number(process.versions.node.split('.')[0])<m.minNodeMajor)throw Error('NODE_UPGRADE_REQUIRED');
}
export async function withUpdateLock(dir,fn){
  await mkdir(dir,{recursive:true,mode:0o700});const path=join(dir,'update.pid');
  const temp=path+'.'+randomUUID();const handle=await open(temp,'wx',0o600);
  try{await handle.writeFile(JSON.stringify({pid:process.pid}));await handle.sync();}finally{await handle.close();}
  try{
    try{await link(temp,path);}catch(e){
      if(e.code!=='EEXIST')throw e;const old=await readJson(path);let alive=true;
      if(!Number.isInteger(old.pid)||old.pid<1)throw Error('INVALID_UPDATE_LOCK');
      try{process.kill(old.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
      if(alive)return {ok:true,deferred:true,reason:'UPDATER_ALREADY_RUNNING'};
      await unlink(path);await link(temp,path);
    }
  }finally{await unlink(temp).catch(()=>{});}
  try{return await fn();}finally{await unlink(path).catch(()=>{});}
}
export async function rollbackFiles(journal){
  for(const entry of [...journal.entries].reverse()){
    if(await exists(entry.backup)){await rm(entry.target,{recursive:true,force:true});await rename(entry.backup,entry.target);}
    else if(!entry.existed && !await exists(entry.staged))await rm(entry.target,{recursive:true,force:true});
  }
}
export async function swapFiles(journal,journalPath){
  // Persist the complete plan before the first rename. Recovery also works if
  // power is lost between any two filesystem operations.
  await atomicJson(journalPath,journal);
  for(const entry of journal.entries){
    await mkdir(dirname(entry.backup),{recursive:true});
    if(entry.existed)await rename(entry.target,entry.backup);
    if(await exists(entry.staged))await rename(entry.staged,entry.target);
  }
}
async function ready(config,version,services){
  for(let i=0;i<90;i++){
    try{
      const health=await jsonFetch(config.bridgeUrl+'/health',{signal:AbortSignal.timeout(2000)});
      if(health.product!=='runninghub-canvas-bridge'||health.version!==version)throw Error('VERSION_MISMATCH');
      if(config.instanceId && health.instanceId!==config.instanceId)throw Error('INSTANCE_MISMATCH');
      if(services.some(s=>s.name==='remote'||s.label==='cn.runninghub.remote-mcp')){
        const remote=await readJson(join(config.data,'remote/config.json'));
        const r=await jsonFetch(`http://127.0.0.1:${remote.port||18766}/health`,{signal:AbortSignal.timeout(2000)});
        if(!r.ok||r.service!=='runninghub-remote-mcp'||(r.version!==version && !(compareVersions(version,'0.9.0')<0 && !r.version)))throw Error('GATEWAY_NOT_READY');
      }
      return;
    }catch{await delay(500);}
  }
  throw Error('UPDATED_SERVICE_HEALTH_FAILED');
}
async function prepare(config,release,bytes,stage){
  if(bytes.length!==release.manifest.archive.bytes||hash(bytes)!==release.manifest.archive.sha256)throw Error('ARCHIVE_CHECKSUM_MISMATCH');
  const root=join(stage,'package');await mkdir(root,{recursive:true});await extractPackage(bytes,root);
  const pkg=await readJson(join(root,'package.json'));
  if(pkg.name!=='runninghub-canvas-bridge'||pkg.version!==release.version)throw Error('PACKAGE_VERSION_MISMATCH');
  const manifest=await readJson(join(root,'extension/manifest.json'));
  if(manifest.version!==pkg.version)throw Error('EXTENSION_VERSION_MISMATCH');
  for(const file of ['npm-shrinkwrap.json','server/vendor/yjs.js','server/vendor/upload.js',...ENGINE.map(f=>'scripts/'+f)])if(!await exists(join(root,file)))throw Error('INCOMPLETE_RELEASE_PACKAGE');
  const env={...process.env,PATH:dirname(config.node)+(process.platform==='win32'?';':':')+(process.env.PATH||'')};
  const npmArgs=['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'];
  if(process.platform==='win32')await run(config.node,[join(dirname(config.node),'node_modules/npm/bin/npm-cli.js'),...npmArgs],{cwd:root,env});
  else await run('npm',npmArgs,{cwd:root,env});
  // Check dependency loading without starting services, reading credentials or
  // running package lifecycle hooks supplied by dependencies.
  await run(config.node,['--input-type=module','-e',"await import('./server/mcp.mjs');await import('./server/mcp-http.mjs');"],{cwd:root,env});
  for(const file of ['server/server.mjs',...ENGINE.map(f=>'scripts/'+f)])await run(config.node,['--check',join(root,file)]);
  return root;
}
async function download(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error('DOWNLOAD_HTTP_'+response.status);
  let length=0;const chunks=[];for await(const chunk of response.body){length+=chunk.length;if(length>100*1024*1024)throw Error('RELEASE_TOO_LARGE');chunks.push(chunk);}return Buffer.concat(chunks);
}
export async function applyUpdate(config,{release,bytes,bootstrap=false,hooks={}}={}){
  const dir=join(config.data,'updater'),journalPath=join(dir,'transaction.json');
  return withUpdateLock(dir,async()=>{
    const stop=hooks.stop||stopServices,start=hooks.start||startServices,probe=hooks.ready||ready;
    if(await exists(journalPath)){
      const journal=await readJson(journalPath);
      if(journal.phase!=='committed'){
        await stop(journal.services);await rollbackFiles(journal);await start(journal.services);
        await probe(config,journal.previous,journal.services);
        if(config.extension)config.extension.fingerprint=await extensionFingerprint(config.extension.path);
        config.fingerprint=await fingerprint(config.root);config.blockedVersion=journal.version;config.lastInstalled=journal.previous;
        await atomicJson(join(dir,'config.json'),config);
      }
      if(journal.phase==='committed')await installRecoveryEngine(config.root,dir);
      await rm(journal.stage,{recursive:true,force:true});await unlink(journalPath);
      return {ok:true,recovered:true,version:(await readJson(join(config.root,'package.json'))).version};
    }
    if(!config.enabled)return {ok:true,enabled:false};
    if(await sourceCheckout(config.root))throw Error('SOURCE_CHECKOUT_NOT_AUTO_UPDATED');
    if(config.extension && await extensionFingerprint(config.extension.path)!==config.extension.fingerprint)throw Error('LOCAL_EXTENSION_CHANGED');
    if(await fingerprint(config.root)!==config.fingerprint)throw Error('LOCAL_FILES_CHANGED: review local modifications before re-enabling updates');
    const current=(await readJson(join(config.root,'package.json'))).version;
    release ||= await latestRelease(current);if(!release.available)return {ok:true,...release};
    if(compareVersions(release.version,current)<=0)throw Error('DOWNGRADE_OR_SAME_VERSION_REFUSED');
    validateManifest(release.manifest,release.version);
    if(config.blockedVersion===release.version)return {ok:false,reason:'VERSION_PREVIOUSLY_ROLLED_BACK',version:release.version};
    const stage=join(dirname(config.root),'.rh-update-'+randomUUID());await mkdir(stage,{recursive:true,mode:0o700});
    let lease=null,services=[],journal;
    try{
      const staged=await (hooks.prepare||prepare)(config,release,bytes||await download(release.url),stage);
      services=await (hooks.discover||discoverServices)(config);
      if(!services.length) return {ok:true,deferred:true,reason:'NO_MANAGED_RUNNING_SERVICE'};
      lease=randomUUID();
      if(hooks.acquire)await hooks.acquire(lease);
      else{
        const response=await fetch(config.bridgeUrl+'/update/maintenance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lease}),signal:AbortSignal.timeout(5000)});
        if(response.status===404 && bootstrap){
          const health=await jsonFetch(config.bridgeUrl+'/health'),browser=await jsonFetch(config.bridgeUrl+'/browser/status');
          if(health.activeMutations!==0||browser.pending!==0)throw Error('BRIDGE_BUSY');
        }else if(!response.ok)throw Error(response.status===409?'BRIDGE_BUSY':'MAINTENANCE_UNAVAILABLE');
      }
      const entries=[];
      for(const name of OWNED){const target=join(config.root,name);if(await exists(target)||await exists(join(staged,name)))entries.push({target,staged:join(staged,name),backup:join(stage,'backup',name),existed:await exists(target)});}
      if(config.extension){
        const extra=join(stage,'external-extension');await cp(config.extension.path,extra,{recursive:true});
        for(const file of EXTENSION_FILES){let content=await readFile(join(staged,'extension',file),'utf8');
          if(config.extension.codex){if(file==='manifest.json'){const m=JSON.parse(content);m.name='RunningHub Canvas Bridge — Codex';content=JSON.stringify(m,null,2)+'\n';}if(['background.js','bridge-main.js'].includes(file))content=content.replaceAll('browser-extension','codex-browser');}
          await writeFile(join(extra,file),content);
        }
        entries.push({target:config.extension.path,staged:extra,backup:join(stage,'external-extension-backup'),existed:true});
      }
      journal={phase:'prepared',previous:current,version:release.version,stage,services,entries};
      await atomicJson(journalPath,journal);await stop(services);await swapFiles(journal,journalPath);
      await start(services);await probe(config,release.version,services);
      if(config.extension)config.extension.fingerprint=await extensionFingerprint(config.extension.path);
      config.fingerprint=await fingerprint(config.root);config.lastInstalled=release.version;delete config.blockedVersion;
      await atomicJson(join(dir,'config.json'),config);
      journal.phase='committed';await atomicJson(journalPath,journal);
      // Update the durable recovery engine only after health checks passed.
      await installRecoveryEngine(config.root,dir);
      await rm(stage,{recursive:true,force:true});await unlink(journalPath);
      return {ok:true,updated:true,previous:current,version:release.version,authorizationPreserved:true};
    }catch(error){
      if(journal && journal.phase!=='committed'){
        await stop(services);await rollbackFiles(journal);await start(services);await probe(config,current,services);
        if(config.extension)config.extension.fingerprint=await extensionFingerprint(config.extension.path);
        config.fingerprint=await fingerprint(config.root);config.blockedVersion=release.version;
        await atomicJson(join(dir,'config.json'),config);await rm(stage,{recursive:true,force:true});await unlink(journalPath);
        return {ok:false,rolledBack:true,version:current,error:error.message};
      }
      if(error.message==='BRIDGE_BUSY')return {ok:true,deferred:true,reason:'BRIDGE_BUSY'};
      throw error;
    }finally{
      if(lease&&!hooks.acquire)await fetch(config.bridgeUrl+'/update/maintenance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'release',lease}),signal:AbortSignal.timeout(2000)}).catch(()=>{});
      if(!await exists(journalPath))await rm(stage,{recursive:true,force:true});
    }
  });
}

async function main(){
  const [action='status',...args]=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const data=resolve(option('--data')||join(homedir(),'.runninghub-canvas-bridge'));
  const configPath=resolve(option('--config')||join(data,'updater/config.json'));const dir=dirname(configPath);
  if(action==='enable')return withUpdateLock(dir,async()=>{
    const root=resolve(option('--root')||join(dirname(fileURLToPath(import.meta.url)),'..'));
    if(await sourceCheckout(root))throw Error('SOURCE_CHECKOUT_NOT_AUTO_UPDATED: extract a Release package to a dedicated installation directory');
    if(!relative(root,data).startsWith('..'))throw Error('KEEP_PRIVATE_DATA_OUTSIDE_INSTALLATION');
    const pkg=await readJson(join(root,'package.json'));if(pkg.name!=='runninghub-canvas-bridge')throw Error('WRONG_INSTALLATION');
    const prior=await exists(configPath)?await readJson(configPath):{};
    if(prior.root && prior.root!==root)throw Error('ANOTHER_INSTALLATION_ALREADY_MANAGED');
    const health=await jsonFetch((option('--bridge-url')||'http://127.0.0.1:18765')+'/health');
    if(health.product!=='runninghub-canvas-bridge')throw Error('BRIDGE_NOT_READY');
    const config={...prior,format:1,enabled:true,root,node:process.execPath,data,bridgeUrl:option('--bridge-url')||'http://127.0.0.1:18765',instanceId:health.instanceId||null,bridgeTask:option('--bridge-task')||prior.bridgeTask||null,remoteTask:option('--remote-task')||prior.remoteTask||null,fingerprint:await fingerprint(root)};
    if(option('--extension-dir')){
      const path=resolve(option('--extension-dir')),manifest=await readJson(join(path,'manifest.json'));
      if(!manifest.name.startsWith('RunningHub Canvas Bridge'))throw Error('NOT_A_RUNNINGHUB_EXTENSION');
      if(path!==join(root,'extension')){
        if(!relative(root,path).startsWith('..'))throw Error('EXTERNAL_EXTENSION_MUST_BE_OUTSIDE_MANAGED_PACKAGE');
        if((await lstat(path)).isSymbolicLink() || (await lstat(path)).dev!==(await lstat(root)).dev)throw Error('EXTENSION_MUST_BE_ON_SAME_VOLUME');
        config.extension={path,codex:manifest.name.includes('Codex'),fingerprint:await extensionFingerprint(path)};
      }
    }
    if(args.includes('--retry-failed'))delete config.blockedVersion;
    await mkdir(dir,{recursive:true,mode:0o700});
    await installRecoveryEngine(root,dir);
    await atomicJson(configPath,config);await schedule(config,true);
    return {ok:true,enabled:true,intervalHours:6,current:pkg.version,configuration:configPath};
  });
  if(!await exists(configPath))return {ok:true,enabled:false,reason:'NOT_CONFIGURED'};
  const config=await readJson(configPath);
  if(action==='status')return {ok:true,enabled:config.enabled,root:config.root,current:(await readJson(join(config.root,'package.json'))).version,intervalHours:6,blockedVersion:config.blockedVersion||null,last:await exists(join(dir,'status.json'))?await readJson(join(dir,'status.json')):null};
  if(action==='disable')return withUpdateLock(dir,async()=>{await schedule(config,false);config.enabled=false;await atomicJson(configPath,config);return {ok:true,enabled:false};});
  if(action==='check')return {ok:true,...await latestRelease((await readJson(join(config.root,'package.json'))).version)};
  if(action==='apply'){
    let release,bytes;
    if(option('--package')){
      bytes=await readFile(resolve(option('--package')));const sha=option('--sha256'),version=option('--version');
      if(hash(bytes)!==sha)throw Error('ARCHIVE_CHECKSUM_MISMATCH');
      release={available:true,version,manifest:{format:1,version,stateSchema:1,minNodeMajor:22,archive:{name:`runninghub-canvas-bridge-${version}.tgz`,bytes:bytes.length,sha256:sha}}};
    }
    const result=await applyUpdate(config,{release,bytes,bootstrap:args.includes('--bootstrap')});
    await atomicJson(join(dir,'status.json'),{...result,checkedAt:new Date().toISOString()});return result;
  }
  throw Error('Usage: update enable|disable|status|check|apply');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const result=await main();console.log(JSON.stringify(result,null,2));if(result.ok===false)process.exitCode=1;}
  catch(error){
    const result={ok:false,error:String(error.message).replace(/https?:\/\/\S+/g,'[URL]').slice(0,300),checkedAt:new Date().toISOString()};
    // Scheduler runs have no console. Keep a bounded, credential-free result.
    const args=process.argv.slice(2),i=args.indexOf('--config');const dir=i<0?join(homedir(),'.runninghub-canvas-bridge/updater'):dirname(args[i+1]);
    await atomicJson(join(dir,'status.json'),result).catch(()=>{});console.error(JSON.stringify(result));process.exitCode=1;
  }
}
