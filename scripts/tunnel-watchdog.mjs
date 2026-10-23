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
// Restart only a positively identified, continuously stale cloud runtime, never
// just because a status command failed or a page/browser is disconnected.
export function stalledTunnelEvidence(snapshot,now=Date.now(),staleAfterMs=120000){
 const sampled=Date.parse(snapshot?.snapshot_at),runtimeId=snapshot?.runtime?.instance_id;
 const poll=snapshot?.components?.['control-plane'],details=poll?.details;
 const lastSuccess=Date.parse(details?.last_success),started=Date.parse(snapshot?.runtime?.started_at);
 if(!runtimeId||!Number.isFinite(sampled)||now-sampled>30000||sampled>now+5000||!details)return null;
 const anchor=Number.isFinite(lastSuccess)?lastSuccess:started;
 if(!Number.isFinite(anchor)||now-anchor<staleAfterMs)return null;
 const dispatcher=snapshot.components?.dispatcher?.details,queue=snapshot.components?.queue?.details,delivery=snapshot.components?.['response-delivery']?.details;
 return {runtimeId,lastSuccess:anchor,idle:dispatcher?.active===0&&queue?.depth===0&&delivery?.in_progress===0};
}
export async function bridgeIsIdle({url=process.env.RH_BRIDGE_URL||'http://127.0.0.1:18765',fetchImpl=fetch}={}){
 try{const base=new URL(url);if(base.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(base.hostname)||base.username||base.password)return false;
  const r=await fetchImpl(new URL('/health',base),{redirect:'error',signal:AbortSignal.timeout(3000)});if(!r.ok)return false;const h=await r.json();return h.product==='runninghub-canvas-bridge'&&h.update?.idle===true&&h.update?.maintenance===false;
 }catch{return false;}
}
export function createTunnelSupervisor({status,connect,stop,canRestart=async()=>false,now=Date.now,report=()=>{},staleAfterMs=120000,confirmForMs=30000,maxRestarts=3}){
 let pending=null,nextAttempt=0,failures=0,lastState,stale=null,restarts=0;
 const emit=state=>{if(state!==lastState){lastState=state;report({state,time:new Date(now()).toISOString()});}};
 const tick=()=>{
  if(pending)return pending;
  pending=(async()=>{
   let s;try{s=await status();}catch{stale=null;emit('status-unavailable');return;}
   if(s.process_running===true){
    const state=s.health_snapshot?tunnelPollState(s.health_snapshot,now()):s.healthy===true&&s.ready===true?'local-ready':'waiting-for-health';
    if(state==='polling'){failures=0;nextAttempt=0;stale=null;restarts=0;emit(state);return;}
    if(state==='local-ready'){failures=0;nextAttempt=0;stale=null;emit(state);return;}
    const evidence=stop?stalledTunnelEvidence(s.health_snapshot,now(),staleAfterMs):null;
    if(!evidence){stale=null;emit(state);return;}
    if(!stale||stale.runtimeId!==evidence.runtimeId||stale.lastSuccess!==evidence.lastSuccess)stale={...evidence,since:now()};
    if(now()-stale.since<confirmForMs){emit(state);return;}
    if(restarts>=maxRestarts){emit('restart-limit-reached');return;}
    if(now()<nextAttempt){emit('reconnect-backoff');return;}
    if(!evidence.idle||!await canRestart()){emit('stalled-waiting-for-idle');return;}
    // Re-read after checking the bridge: cloud work may have arrived meanwhile.
    let current;try{current=await status();}catch{stale=null;emit('status-unavailable');return;}
    const latest=stalledTunnelEvidence(current.health_snapshot,now(),staleAfterMs);
    if(current.process_running!==true||!latest||!latest.idle||latest.runtimeId!==evidence.runtimeId||latest.lastSuccess!==evidence.lastSuccess){stale=null;emit('recovery-state-changed');return;}
    restarts++;failures++;nextAttempt=now()+Math.min(300000,15000*2**Math.min(failures-1,5));stale=null;
    try{
     emit('restarting-stalled-runtime');await stop();
     // The manager must stop the existing alias before a replacement is allowed.
     const stopped=await status();if(stopped.process_running!==false){emit('stop-not-confirmed');return;}
     await connect();emit('awaiting-health');
    }catch{emit('restart-failed');}
    return;
   }
   stale=null;
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
 const manager=process.argv[2],restartStalled=process.argv.slice(3).includes('--restart-stalled');if(!manager)throw new Error('Usage: node tunnel-watchdog.mjs /absolute/path/to/manager.mjs [--restart-stalled]');
 const supervisor=createTunnelSupervisor({status:async()=>{
  const runtime=await runManager(manager,'status');
  const snapshot=await readTunnelHealth(runtime);
  // Missing live evidence must not be presented as a healthy cloud connection.
  return {...runtime,health_snapshot:snapshot || {}};
 },connect:()=>runManager(manager,'connect'),...(restartStalled?{stop:()=>runManager(manager,'stop'),canRestart:()=>bridgeIsIdle()}:{}),report:event=>console.log(JSON.stringify(event))});
 for(;;){await supervisor.tick();await new Promise(r=>setTimeout(r,15000));}
}
