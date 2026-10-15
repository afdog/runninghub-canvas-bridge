// Generation receipts schedule index reconciliation, never another generation.
import {mkdir,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {BridgeClient} from './bridge-client.mjs';
export class HistorySync {
 constructor({root=join(homedir(),'.runninghub-canvas-bridge','history-sync'),bridgeFactory=()=>new BridgeClient(),now=Date.now}={}){Object.assign(this,{root,bridgeFactory,now});this.jobs=new Map();this.running=false;}
 async init(){await mkdir(this.root,{recursive:true,mode:0o700});for(const name of await readdir(this.root)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const j=JSON.parse(await readFile(join(this.root,name),'utf8'));this.jobs.set(j.id,j);}}
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
 status(){return [...this.jobs.values()].map(({id,canvasUrl,nodeId,taskId,state,attempts,nextAttemptAt,result,error})=>({id,canvasUrl,nodeId,taskId,state,attempts,nextAttemptAt,result,error}));}
 start(){if(!this.timer){this.timer=setInterval(()=>this.tick().catch(()=>{}),10000);this.timer.unref?.();}}
 stop(){clearInterval(this.timer);this.timer=null;}
 async tick(){
  if(this.running)return;this.running=true;
  try{for(const j of this.jobs.values()){
   if(j.state==='complete'||j.nextAttemptAt>this.now())continue;
   try{
    const b=this.bridgeFactory();
    // select uses connected pages only. Background maintenance never opens/focuses a tab.
    await b.select(j.canvasUrl,true);
    const receipt=await b.command('canvas.platformWrite',{operation:'syncNodeHistory',body:{nodeId:j.nodeId,taskId:j.taskId}});
    if(receipt.ok===false)throw Error('HISTORY_SYNC_OUTCOME_UNKNOWN: reconcile the index on the next check, never resubmit generation');
    const value=receipt.result?.result??receipt.result;
    if(!value || (!value.pending && !value.nodeId))throw Error('HISTORY_SYNC_RECEIPT_INVALID');
    j.result=value;j.state=value.pending?'waiting':'complete';delete j.error;
   }catch(e){j.state='waiting';j.error=String(e.message).slice(0,400);}
   j.attempts++;j.nextAttemptAt=this.now()+(j.error?Math.min(300000,10000*2**Math.min(j.attempts,5)):15000);await this.save(j);
  }}finally{this.running=false;}
 }
}
