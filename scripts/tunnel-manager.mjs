#!/usr/bin/env node
// Operate an existing Secure MCP Tunnel alias. Never create credentials or tunnels.
import {readFile,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
export const defaultTunnelConfig=()=>join(homedir(),'.runninghub-canvas-bridge/chatgpt-tunnel/config.json');
export function tunnelArguments(action,c){
 if(!['status','connect','stop'].includes(action))throw Error('TUNNEL_ACTION_INVALID');
 if(!/^[\w-]+$/.test(c.alias||'')||!/^tunnel_[\w-]+$/.test(c.tunnelId||'')||!c.profile)throw Error('TUNNEL_CONFIG_INVALID');
 for(const key of ['client','node','root','runtimeKeyFile','profileDir'])if(typeof c[key]!=='string'||!isAbsolute(c[key]))throw Error('TUNNEL_PATH_REQUIRED: '+key);
 if(action!=='connect')return ['runtimes',action,c.alias,'--json'];
 return ['runtimes','connect','--alias',c.alias,'--tunnel-id',c.tunnelId,'--mcp-command',JSON.stringify(c.node)+' '+JSON.stringify(join(c.root,'server/mcp.mjs')),'--runtime-api-key','file:'+c.runtimeKeyFile,'--profile',c.profile,'--profile-dir',c.profileDir,'--json'];
}
export function runTunnelClient(client,args,{env=process.env}={}){return new Promise((done,reject)=>{
 const child=spawn(client,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',size=0;
 const timer=setTimeout(()=>child.kill(),40000);child.stdout.on('data',b=>{size+=b.length;if(size>2*1024**2)child.kill();else out+=b;});child.stderr.resume();
 child.once('error',()=>{clearTimeout(timer);reject(Error('TUNNEL_CLIENT_START_FAILED'));});
 child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('TUNNEL_CLIENT_COMMAND_FAILED'));try{done(JSON.parse(out));}catch{reject(Error('TUNNEL_CLIENT_RESULT_INVALID'));}});
});}
export async function manageTunnel(action,c,{run=runTunnelClient,fetchImpl=fetch,exists=access}={}){
 const args=tunnelArguments(action,c);
 if(action==='connect'){
  await exists(c.runtimeKeyFile);
  const url=new URL(c.bridgeUrl||'http://127.0.0.1:18765');if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)throw Error('LOCAL_BRIDGE_REQUIRED');
  const r=await fetchImpl(new URL('/health',url),{signal:AbortSignal.timeout(3000),redirect:'error'});if(!r.ok)throw Error('BRIDGE_NOT_READY');const health=await r.json();
  if(health.product!=='runninghub-canvas-bridge'||health.update?.maintenance!==false)throw Error('BRIDGE_NOT_READY');
 }
 return run(c.client,args,{env:{...process.env,...c.env}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const action=process.argv[2]||'status',i=process.argv.indexOf('--config'),file=i>=0?process.argv[i+1]:process.env.RH_TUNNEL_CONFIG||defaultTunnelConfig();const config=JSON.parse(await readFile(file,'utf8'));console.log(JSON.stringify(await manageTunnel(action,config)));}
 catch(error){console.error(JSON.stringify({ok:false,error:/^TUNNEL_|^BRIDGE_|^LOCAL_BRIDGE_/.test(error.message)?error.message:'TUNNEL_MANAGER_UNAVAILABLE'}));process.exitCode=1;}
}
