// Durable receipts before dispatch; uncertain writes are never replayed or expired.
import {mkdir,readdir,readFile,open,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const nameFor=id=>createHash('sha256').update(id).digest('hex')+'.json';
const terminalReads=new Set(['completed','expired','rejected','interrupted']);
export class CommandJournal {
  constructor(root,{classify=()=>undefined}={}){this.root=root;this.classify=classify;this.queues=new Map();this.blocked=new Set();this.pruned=0;this.errors=0;}
  status(){return {quarantined:this.blocked.size,prunedReads:this.pruned,storageErrors:this.errors};}
  isQuarantined(id){return this.blocked.has(nameFor(id));}
  async save(id,record,result){
    if(this.isQuarantined(id))throw Error('COMMAND_RECEIPT_QUARANTINED');
    const payload=JSON.stringify({id,record,result}),durable=record?.mode!=='read';
    const next=(this.queues.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{
      await mkdir(this.root,{recursive:true,mode:0o700});
      const temp=join(this.root,nameFor(id)+'.'+randomUUID()+'.tmp');let fd;
      try{fd=await open(temp,'wx',0o600);await fd.writeFile(payload);if(durable)await fd.sync();await fd.close();fd=null;await rename(temp,join(this.root,nameFor(id)));}
      catch(error){this.errors++;throw error;}
      finally{await fd?.close().catch(()=>{});await rm(temp,{force:true}).catch(()=>{});}
    });
    this.queues.set(id,next);try{await next;}finally{if(this.queues.get(id)===next)this.queues.delete(id);}
  }
  async load(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    const quarantine=join(this.root,'quarantine');await mkdir(quarantine,{recursive:true,mode:0o700});
    for(const name of await readdir(quarantine))if(/^[a-f0-9]{64}\.json$/.test(name))this.blocked.add(name);
    const entries=[];
    for(const name of (await readdir(this.root)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
      let entry;
      try{entry=JSON.parse(await readFile(join(this.root,name),'utf8'));if(!entry?.id||!entry.record||typeof entry.record!=='object'||nameFor(entry.id)!==name)throw Error('COMMAND_JOURNAL_CORRUPT');}
      catch(error){
        if(error.code==='ENOENT')continue;
        this.blocked.add(name);this.errors++;
        await rename(join(this.root,name),join(quarantine,name)).catch(()=>{});
        continue;
      }
      if(!entry.record.mode)entry.record.mode=this.classify(entry.record);
      if(['queued','dispatched'].includes(entry.record.state)){
        const sent=entry.record.state==='dispatched';entry.record.state=sent?'unknown':'interrupted';
        entry.result={ok:false,commandId:entry.id,errorCode:sent?'COMMAND_OUTCOME_UNKNOWN':'COMMAND_NOT_DISPATCHED',error:sent?'Bridge restarted after dispatch. Inspect the original receipt and node; never resubmit blindly.':'Bridge restarted before dispatch. This request was not sent to the page.'};
        await this.save(entry.id,entry.record,entry.result);
      }
      entries.push(entry);
    }
    return entries;
  }
  async prune(records,results,{now=Date.now(),maxAgeMs=86400000,maxReads=2000}={}){
    const eligible=[...records].filter(([,r])=>r.mode==='read'&&terminalReads.has(r.state)).sort((a,b)=>(b[1].completedAt||b[1].createdAt||0)-(a[1].completedAt||a[1].createdAt||0));
    for(let i=0;i<eligible.length;i++){
      const [id,record]=eligible[i];
      if(i<maxReads&&now-(record.completedAt||record.createdAt||now)<maxAgeMs)continue;
      // A receipt can finish persisting while retention runs; never unlink an active write.
      if(this.queues.has(id))continue;
      await rm(join(this.root,nameFor(id)),{force:true});records.delete(id);results.delete(id);this.pruned++;
    }
  }
}
