import {failurePolicy} from './failure-policy.mjs';
import {assertCommandSucceeded,failureReceipt} from './command-result.mjs';
// Generation receipts schedule index reconciliation, never another generation.
import {mkdir,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {BridgeClient} from './bridge-client.mjs';
export class HistorySync {
 constructor({root=join(homedir(),'.runninghub-canvas-bridge','history-sync'),bridgeFactory=()=>new BridgeClient(),now=Date.now,maxFailures=5,maxPendingMs=86400000}={}){Object.assign(this,{root,bridgeFactory,now,maxFailures,maxPendingMs});this.jobs=new Map();this.running=false;}
 async init(){await mkdir(this.root,{recursive:true,mode:0o700});for(const name of await readdir(this.root)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const j=JSON.parse(await readFile(join(this.root,name),'utf8'));this.jobs.set(j.id,j);if(j.state==='waiting'&&j.error){const policy=failurePolicy(j.failureReceipt||{message:j.error});if(policy.category==='blocked'||policy.category==='unknown'){j.state='blocked';j.blockedReason=policy.code;j.nextAction=policy.action;await this.save(j);}}}}
 async save(j){const file=join(this.root,j.id+'.json'),temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(j),{mode:0o600});await rename(temp,file);this.jobs.set(j.id,j);}
 async accept(record,event){
  if(!event?.ok || !['canvas.runNode','canvas.generateVideoNode'].includes(record?.type))return;
  const run=record.type==='canvas.generateVideoNode'?event.result?.run:event.result;
  if(!run?.submitted || !run.task?.taskId || !record.nodeId)return;
  const canvasUrl=record.canvasUrl || event.href;
  if(!globalThis.RHCanvasSitePolicy.parseCanvas(canvasUrl))return;
  const taskId=String(run.task.taskId),id=createHash('sha256').update(canvasUrl+'\n'+record.nodeId+'\n'+taskId).digest('hex');
  if(this.jobs.has(id))return this.jobs.get(id);
  const job={id,canvasUrl,nodeId:record.nodeId,taskId,state:'waiting',createdAt:this.now(),attempts:0,nextAttemptAt:0};await this.save(job);return job;
 }
 status(){return [...this.jobs.values()].map(({id,canvasUrl,nodeId,taskId,state,attempts,nextAttemptAt,result,error,failureReceipt,blockedReason,nextAction,waitingFor})=>({id,canvasUrl,nodeId,taskId,state,attempts,nextAttemptAt,result,error,failureReceipt,blockedReason,nextAction,waitingFor}));}
 async resume({canvasUrl,nodeId,taskId}){const resumed=[];for(const j of this.jobs.values()){if(j.state!=='blocked'||j.canvasUrl!==canvasUrl||j.nodeId!==nodeId||(taskId&&j.taskId!==taskId))continue;Object.assign(j,{state:'waiting',consecutiveFailures:0,nextAttemptAt:0,resumedAt:this.now()});delete j.blockedReason;delete j.nextAction;j.lastFailure=j.failureReceipt||{error:j.error};delete j.error;delete j.failureReceipt;await this.save(j);resumed.push(j.id);}return {resumed};}
 start(){if(!this.timer){this.timer=setInterval(()=>this.tick().catch(()=>{}),10000);this.timer.unref?.();}}
 stop(){clearInterval(this.timer);this.timer=null;}
 async tick(){
  if(this.running)return;this.running=true;
  try{for(const j of this.jobs.values()){
   if(j.state==='complete'||j.state==='blocked'||j.nextAttemptAt>this.now())continue;
   if(this.now()-(j.resumedAt??j.createdAt)>this.maxPendingMs){j.state='blocked';j.blockedReason='HISTORY_SYNC_DEADLINE';j.nextAction='inspect';await this.save(j);continue;}
   try{
    const b=this.bridgeFactory();
    // select uses connected pages only. Background maintenance never opens/focuses a tab.
    if(j.waitingFor==='connection' && b.request){const clients=await b.request('/clients');if(!clients.some(c=>globalThis.RHCanvasSitePolicy.parseCanvas(c.href)?.key===globalThis.RHCanvasSitePolicy.parseCanvas(j.canvasUrl)?.key)){j.nextAttemptAt=this.now()+30000;continue;}}
    await b.select(j.canvasUrl,true);delete j.waitingFor;
    const receipt=await b.command('canvas.platformWrite',{operation:'syncNodeHistory',body:{nodeId:j.nodeId,taskId:j.taskId}});
    assertCommandSucceeded(receipt);
    const value=receipt.result?.result??receipt.result;
    if(!value || (!value.pending && !value.nodeId))throw Error('HISTORY_SYNC_RECEIPT_INVALID');
    j.result=value;j.state=value.pending?'waiting':'complete';delete j.error;delete j.failureReceipt;j.consecutiveFailures=0;
   }catch(e){
    const receipt=failureReceipt(e),policy=failurePolicy(receipt||e);
    j.error=policy.code;j.consecutiveFailures=(j.consecutiveFailures||0)+1;delete j.failureReceipt;if(receipt)j.failureReceipt={...receipt,errorCode:policy.code};
    if(policy.category==='connection'){j.state='waiting';j.waitingFor='connection';}
    else if(!policy.retryable || j.consecutiveFailures>=this.maxFailures){j.state='blocked';j.blockedReason=policy.code;j.nextAction=policy.action==='retry_read'?'inspect_connection':policy.action;}
    else j.state='waiting';
   }
   j.attempts++;j.nextAttemptAt=j.state==='blocked'?0:this.now()+(j.error?Math.min(300000,10000*2**Math.min(j.attempts,5)):15000);await this.save(j);
  }}finally{this.running=false;}
 }
}
