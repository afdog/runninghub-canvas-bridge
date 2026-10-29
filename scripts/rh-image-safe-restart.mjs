// Refuse an update while any native image or canvas operation is active.
// The maintenance lease also prevents a new request between the check and restart.
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const base='http://127.0.0.1:'+(process.env.RH_BRIDGE_PORT||18765);
const lease=randomUUID();
const post=async action=>{
  const r=await fetch(base+'/update/maintenance',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,lease}),signal:AbortSignal.timeout(10000)});
  return {status:r.status,...await r.json()};
};
const health=await(await fetch(base+'/health')).json();
if(!Object.hasOwn(health.update?.activity||{},'gptImageJobs'))throw Error('The running service has no image-job restart protection; no restart was performed.');
const guard=await post('acquire');
if(!guard.ok){console.error(JSON.stringify(guard));process.exitCode=1;}
else {
  try {
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('./rh-service.mjs',import.meta.url)),'restart'],{stdio:'inherit'});
    process.exitCode=result.status??1;
  } finally {await post('release').catch(()=>{});}
}
