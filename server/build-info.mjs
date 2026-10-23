import {readFileSync,readdirSync} from 'node:fs';
import {readFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const ROOT=new URL('../',import.meta.url);
export const EXTENSION_FILES=['background.js','bridge-main.js','browser-pump.js','keepalive.js','site-policy.js'];
const hash=parts=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
// These modules are imported into MCP processes; served page scripts are tracked by runtime freshness.
export const SHARED_SERVER_FILES=['canvas-features.js','production-features.js','layout-template.js','canvas-cleanup.js'];
const codeNames=names=>['package.json','extension/site-policy.js',...names.filter(n=>n.endsWith('.mjs')||SHARED_SERVER_FILES.includes(n)).sort().map(n=>'server/'+n)];
export function captureBuild(root=ROOT){
 const files=codeNames(readdirSync(new URL('server/',root))),parts=files.map(name=>[name,readFileSync(new URL(name,root),'utf8')]);
 return {version:JSON.parse(parts[0][1]).version,fingerprint:hash(parts)};
}
export const ACTIVE_BUILD=captureBuild();
const diskBuilds=new Map();
export async function inspectBuild(active=ACTIVE_BUILD,root=ROOT){
 const files=codeNames(await readdir(new URL('server/',root)));
 const signature=JSON.stringify(await Promise.all(files.map(async name=>{const s=await stat(new URL(name,root),{bigint:true});return [name,String(s.size),String(s.ino),String(s.mtimeNs),String(s.ctimeNs)];})));
 const key=String(root),prior=diskBuilds.get(key);let pending=prior?.signature===signature?prior.promise:null;
 if(!pending){
  pending=Promise.all(files.map(async name=>[name,await readFile(new URL(name,root),'utf8')])).then(parts=>({version:JSON.parse(parts[0][1]).version,fingerprint:hash(parts)}));
  diskBuilds.set(key,{signature,promise:pending});if(diskBuilds.size>32)diskBuilds.delete(diskBuilds.keys().next().value);
 }
 try{const disk=await pending;return {active,disk,needsRestart:active.fingerprint!==disk.fingerprint};}
 catch(error){if(diskBuilds.get(key)?.promise===pending)diskBuilds.delete(key);throw error;}
}
export async function extensionBuild(root=ROOT){
 const parts=await Promise.all(EXTENSION_FILES.map(async name=>[name,(await readFile(new URL('extension/'+name,root),'utf8')).replaceAll('codex-browser','browser-extension')]));
 return {version:JSON.parse(await readFile(new URL('extension/manifest.json',root),'utf8')).version,fingerprint:hash(parts)};
}
export function deploymentActions({backend,mcp,extension,runtime,available}={}){
 const actions=[];
 if(available===false)actions.push("Restart the bridge from the current installation to enable build diagnostics.");
 if(backend?.needsRestart)actions.push('Restart the bridge to load the installed backend build.');
 if(mcp?.needsRestart)actions.push('Reconnect this MCP client to load the installed tools; existing OAuth grants can be reused.');
 if(extension?.observed?.some(v=>v.version!==extension.expected?.version || v.fingerprint&&v.fingerprint!==extension.expected?.fingerprint))actions.push('Reload the outdated browser extension when current jobs finish.');
 if(runtime?.some(v=>v.freshness==='stale'))actions.push('Refresh the listed stale canvas pages to load the current runtime.');
 return actions;
}
