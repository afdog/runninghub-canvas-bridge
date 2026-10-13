#!/usr/bin/env node
// Supervise a user-configured official tunnel manager. Never print its raw output.
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// runtime status in some tunnel-client releases reports local readiness without
// fetching the live control-plane snapshot. Read the loopback health endpoint.
export async function readTunnelHealth(runtime,{fetchImpl=fetch,timeoutMs=3000}={}){
 const candidate=runtime.ui_url || runtime.mcp_health_url || runtime.local?.effective_health?.mcp_health_url;
 try{
  const url=new URL(candidate);
  if(url.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password)return null;
  url.pathname='/health';url.search='details=true';url.hash='';
  const response=await fetchImpl(url,{signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
  if(!response.ok)return null;
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>256*1024){await reader.cancel();return null;}chunks.push(value);}}
  finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }catch{return null;}
}

export function tunnelPollState(snapshot,now=Date.now()){
 const snapshotAt=Date.parse(snapshot?.snapshot_at);
 if(!Number.isFinite(snapshotAt) || now-snapshotAt>30000 || snapshotAt-now>5000)return 'poll-health-unavailable';
 const poll=snapshot.components?.['control-plane'];
 if(!poll)return 'poll-health-unavailable';
 const details=poll.details || {},lastSuccess=Date.parse(details.last_success),deadline=details.deadline_seconds;
 if(snapshot.live!==true || snapshot.ready!==true)return 'waiting-for-health';
 if(poll.status!=='ok' || poll.state!=='polling' || details.consecutive_failures!==0)return 'poll-degraded';
 if(!Number.isFinite(lastSuccess) || !Number.isFinite(deadline) || deadline<0)return 'poll-health-unavailable';
 if(now-lastSuccess>Math.max(30000,(deadline+15)*1000))return 'poll-stalled';
 return 'polling';
}
export function createTunnelSupervisor({status,connect,now=Date.now,report=()=>{}}){
 let pending=null,nextAttempt=0,failures=0,lastState;
 const emit=state=>{if(state!==lastState){lastState=state;report({state,time:new Date(now()).toISOString()});}};
 const tick=()=>{
  if(pending)return pending;
  pending=(async()=>{
   let s;try{s=await status();}catch{emit('status-unavailable');return;}
   if(s.process_running===true && s.healthy===true && s.ready===true){
    const state=s.health_snapshot?tunnelPollState(s.health_snapshot,now()):'local-ready';
    if(state==='polling' || state==='local-ready'){failures=0;nextAttempt=0;}
    emit(state);return;
   }
   // A running process with unhealthy network must not be killed by this watcher.
   if(s.process_running!==false){emit('waiting-for-health');return;}
   if(now()<nextAttempt){emit('reconnect-backoff');return;}
   emit('reconnecting');failures++;nextAttempt=now()+Math.min(300000,15000*2**Math.min(failures-1,5));
   try{await connect();emit('awaiting-health');}catch{emit('connect-failed');}
  })().finally(()=>{pending=null;});return pending;
 };
 return {tick};
}
function runManager(path,action){return new Promise((done,reject)=>{
 const child=spawn(process.execPath,[path,action],{stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',size=0;
 const timer=setTimeout(()=>child.kill(),45000);
 child.stdout.on('data',b=>{size+=b.length;if(size>2*1024**2)child.kill();else out+=b;});child.stderr.resume();
 child.on('error',()=>{clearTimeout(timer);reject(new Error('MANAGER_START_FAILED'));});
 child.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw new Error();done(JSON.parse(out));}catch{reject(new Error('MANAGER_RESULT_UNAVAILABLE'));}});
 });}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const manager=process.argv[2];if(!manager)throw new Error('Usage: node tunnel-watchdog.mjs /absolute/path/to/manager.mjs');
 const supervisor=createTunnelSupervisor({status:async()=>{
  const runtime=await runManager(manager,'status');
  const snapshot=await readTunnelHealth(runtime);
  // Missing live evidence must not be presented as a healthy cloud connection.
  return {...runtime,health_snapshot:snapshot || {}};
 },connect:()=>runManager(manager,'connect'),report:event=>console.log(JSON.stringify(event))});
 for(;;){await supervisor.tick();await new Promise(r=>setTimeout(r,15000));}
}
