import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {GptImageEngine,validateInput} from './engine.mjs';
import {isImageConcurrency,imageConcurrencyLabel} from './concurrency.mjs';

const BUSY=new Set(['queued','running','importing','waiting']);
const TERMINAL=new Set(['complete','failed','interrupted']);
const RESUMABLE=new Set(['IMAGE_RATE_LIMITED','IMAGE_SERVICE_UNAVAILABLE','IMAGE_GATEWAY_REJECTED']);

// One durable batch owns the node/history. Each image has its own native thread.
// The existing single-image runner owns validation, early delivery and retry safety.
export class ParallelGptImageEngine extends GptImageEngine {
  constructor({maxConcurrentImages=4,...options}={}){
    super(options);
    if(!isImageConcurrency(maxConcurrentImages))throw Error('Invalid image concurrency');
    this.maxConcurrentImages=maxConcurrentImages;
    this.workers=new Map();this.readyJobs=new Set();this.imports=new Map();
    this.pumpTimer=null;this.pumping=false;this.pumpAgain=false;this.lastServed=null;this.closing=false;
    this.settingsPath=join(this.root,'settings.json');this.settingsReady=null;this.settingsSaving=null;this.settingsRevision=0;this.settingsWarning=null;
  }
  async loadSettings(){
    if(!this.settingsReady)this.settingsReady=(async()=>{
      try{
        const s=JSON.parse(await readFile(this.settingsPath,'utf8'));
        if(s.version!==1||!isImageConcurrency(s.maxConcurrentImages))throw Error('Invalid saved settings');
        this.maxConcurrentImages=s.maxConcurrentImages;this.settingsRevision=Number(s.updatedAt)||0;
      }catch(e){
        // A broken saved preference must never silently raise the user's selected limit.
        if(e.code!=='ENOENT'){this.maxConcurrentImages=1;this.settingsWarning='并行设置未能读取，暂按 1 张处理；请重新选择并行数量。';}
      }
    })();
    await this.settingsReady;
  }
  async setConcurrency(value){
    if(!isImageConcurrency(value))throw Error('并行数量必须为正整数，或选择不限。');
    await this.loadSettings();
    const change=(this.settingsSaving||Promise.resolve()).catch(()=>{}).then(async()=>{
      const updatedAt=Math.max(Date.now(),this.settingsRevision+1),temp=this.settingsPath+'.'+randomUUID()+'.tmp';
      try{
        await mkdir(this.root,{recursive:true,mode:0o700});
        await writeFile(temp,JSON.stringify({version:1,maxConcurrentImages:value,updatedAt},null,2),{mode:0o600});
        await rename(temp,this.settingsPath);
      }catch(e){throw Error('并行设置保存失败，仍使用原来的 '+imageConcurrencyLabel(this.maxConcurrentImages)+'设置。');}
      finally{await rm(temp,{force:true}).catch(()=>{});}
      this.maxConcurrentImages=value;this.settingsRevision=updatedAt;this.settingsWarning=null;
      // Decreasing the limit drains current work naturally. Increasing it wakes the queue.
      void this.pump();return this.schedulerState();
    });
    this.settingsSaving=change;return change;
  }
  get pendingJobCount(){return new Set([...this.jobs.values()].filter(j=>BUSY.has(j.status)).map(j=>j.id).concat([...(this.workers?.values()||[])].map(w=>w.job.id))).size;}
  isNodeBusy(canvasUrl,nodeId){return !!nodeId&&[...this.jobs.values()].some(j=>j.canvasUrl===canvasUrl&&j.targetNodeId===nodeId&&BUSY.has(j.status));}
  schedulerState(){return {maxConcurrentImages:this.maxConcurrentImages,min:1,max:null,unlimited:this.maxConcurrentImages===null,updatedAt:this.settingsRevision,warning:this.settingsWarning,runningImages:this.workers.size,queuedImages:[...this.jobs.values()].filter(j=>this.readyJobs.has(j.id)&&!j.paused&&!j.cancelled).reduce((n,j)=>n+(j.items||[]).filter(i=>i.status==='queued').length,0),pendingJobs:this.pendingJobCount};}
  async status(){await this.loadSettings();return {...await super.status(),concurrency:this.schedulerState()};}
  view(job){
    const v=super.view(job);if(!job.items)return v;
    const failed=job.items.filter(i=>i.status==='failed');
    return {...v,runningCount:job.items.filter(i=>i.status==='running').length,importingCount:job.items.filter(i=>i.status==='importing').length,queuedCount:job.items.filter(i=>i.status==='queued'||i.status==='waiting').length,maxConcurrentImages:this.maxConcurrentImages,
      retryAttempt:Math.max(0,...job.items.map(i=>i.retryAttempt||0)),
      canResume:job.status==='failed'&&failed.length>0&&failed.every(i=>i.dispatchOutcome==='rejected'&&RESUMABLE.has(i.errorCode))&&!job.outputs.some(o=>!o.uploaded)&&!job.items.some(i=>i.status==='interrupted')};
  }
  async create(canvasUrl,input){
    if(input.targetNodeId&&input.mode==='reference')input={...input,references:await this.nodes.references(canvasUrl,input.targetNodeId)};
    const validated=validateInput(input),id=input.requestId||randomUUID();
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw Error('请求 ID 必须是 UUID。');
    const requestDigest=createHash('sha256').update(JSON.stringify({canvasUrl,prompt:validated.prompt,ratio:validated.ratio,transparent:validated.transparent,count:validated.count,mode:validated.mode,targetNodeId:validated.targetNodeId,references:validated.references.map(r=>createHash('sha256').update(r.bytes).digest('hex')),autoRetryLimit:validated.autoRetryLimit})).digest('hex');
    const previous=()=>{const j=this.jobs.get(id);if(!j)return null;if(j.requestDigest!==requestDigest)throw Error('同一请求 ID 不能用于不同的生图内容。');return this.view(j);};
    await this.list(canvasUrl);let existing=previous();if(existing)return existing;
    await this.status();existing=previous();if(existing)return existing;
    if(this.isNodeBusy(canvasUrl,validated.targetNodeId))throw Error('此节点已有生成任务；可在其他节点同时生成。');
    const job={id,canvasUrl,...validated,references:[],requestDigest,status:'queued',activity:'等待并行名额',createdAt:Date.now(),autoRetryLimit:validated.autoRetryLimit??this.autoRetryLimit,currentIndex:0,outputs:[],items:Array.from({length:validated.count},(_,index)=>({index,status:'queued'}))};
    // Reserve synchronously before filesystem/network awaits: two clicks cannot own one node.
    this.jobs.set(id,job);this.active=job;
    try{
      const directory=join(this.root,id);await mkdir(directory,{recursive:true,mode:0o700});
      for(const ref of validated.references){const path=join(directory,ref.name+'.'+ref.extension);await writeFile(path,ref.bytes,{mode:0o600});job.references.push(path);}
      await this.save(job);this.readyJobs.add(id);void this.pump();return this.view(job);
    }catch(error){this.jobs.delete(id);this.active=[...this.jobs.values()].find(j=>BUSY.has(j.status))||null;throw error;}
  }
  // Serialize loading old receipts so simultaneous submissions cannot restore a live job as interrupted.
  async list(canvasUrl,targetNodeId){
    await this.loadSettings();
    if(!this.loading)this.loading=super.list(canvasUrl,targetNodeId).finally(()=>{this.loading=null;});
    await this.loading;
    return [...this.jobs.values()].filter(j=>j.canvasUrl===canvasUrl&&(!targetNodeId||j.targetNodeId===targetNodeId)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,targetNodeId?20:100).map(j=>this.view(j));
  }
  next(){
    const jobs=[...this.jobs.values()].filter(j=>this.readyJobs.has(j.id)&&!j.paused&&!j.cancelled&&j.items?.some(i=>i.status==='queued'));
    if(!jobs.length)return null;
    const at=jobs.findIndex(j=>j.id===this.lastServed),job=jobs[(at+1)%jobs.length];
    this.lastServed=job.id;return {job,item:job.items.find(i=>i.status==='queued')};
  }
  async pump(){
    await this.loadSettings();
    if(this.closing)return;
    if(this.pumping){this.pumpAgain=true;return;}
    this.pumping=true;clearTimeout(this.pumpTimer);this.pumpTimer=null;
    try{
      if(Date.now()<this.retryNotBefore){
        for(const job of this.jobs.values())if(this.readyJobs.has(job.id)&&!job.paused&&!job.cancelled){this.aggregate(job);await this.save(job);}
        this.pumpTimer=setTimeout(()=>void this.pump(),Math.max(1,this.retryNotBefore-Date.now()));this.pumpTimer.unref();return;
      }
      let launched=0;
      while(!this.closing&&(this.maxConcurrentImages===null||this.workers.size<this.maxConcurrentImages)){
        // Recheck cooldown after yielding: unlimited scheduling must still obey 429.
        if(Date.now()<this.retryNotBefore){this.pumpAgain=true;break;}
        const next=this.next();if(!next)break;
        this.launch(next.job,next.item);
        // Let settings, cancellation and error receipts run during large queues.
        if(++launched%16===0)await new Promise(resolve=>setImmediate(resolve));
      }
    }finally{this.pumping=false;if(this.pumpAgain){this.pumpAgain=false;queueMicrotask(()=>void this.pump());}}
  }
  launch(job,item){
    const key=job.id+':'+item.index;
    item.status='running';
    const task={id:job.id,canvasUrl:job.canvasUrl,prompt:job.prompt,ratio:job.ratio,transparent:job.transparent,mode:job.mode,targetNodeId:job.targetNodeId,count:job.count,references:job.references,createdAt:job.createdAt,currentIndex:item.index,status:'queued',outputs:[],autoRetryLimit:job.autoRetryLimit,attempts:item.attempts||[]};
    const worker=new GptImageEngine({root:this.root,rpc:this.rpc,canvas:{open:(...args)=>this.canvas.open(...args),import:t=>this.importOne(t)},singleImage:true,minRequestIntervalMs:0,interImageDelayMs:0,autoRetryLimit:job.autoRetryLimit,retryBaseMs:this.retryBaseMs,retryJitterMs:this.retryJitterMs});
    worker.nodes=this.nodes;worker.active=task;worker.status=()=>this.status();
    worker.save=t=>this.record(job,item,t,worker,key);
    const run=worker.run.bind(worker);
    worker.run=async t=>{worker.retryNotBefore=Math.max(worker.retryNotBefore,this.retryNotBefore);return run(t);};
    this.workers.set(key,{worker,task,job});this.aggregate(job);
    void worker.run(task).catch(e=>worker.fail(task,e));
  }
  async importOne(task){
    // Same-node commits must not race the native history revision. The fallback panel
    // serializes placement per canvas too, preventing overlapping new media cards.
    const key=task.canvasUrl+':'+(task.targetNodeId||'placement');
    const pending=(this.imports.get(key)||Promise.resolve()).catch(()=>{}).then(()=>this.canvas.import(task));
    this.imports.set(key,pending);
    try{return await pending;}finally{if(this.imports.get(key)===pending)this.imports.delete(key);this.nodes.invalidate(task.canvasUrl,task.targetNodeId);}
  }
  async record(job,item,task,worker,key){
    for(const name of ['status','activity','error','errorCode','dispatchOutcome','nextImageAt','waitReason','threadId','turnId','lastDispatchAt','finishedAt','imageDiagnostics','attempts','message'])item[name]=task[name];
    item.retryAttempt=task.retryCounts?.[item.index]||0;
    // A runner's queued state means connection/preparation, not a second scheduler entry.
    if(task.status==='queued')item.status='running';
    for(const output of task.outputs||[]){const at=job.outputs.findIndex(o=>o.index===output.index);if(at<0)job.outputs.push({...output});else job.outputs[at]={...output};}
    job.outputs.sort((a,b)=>a.index-b.index);
    if(task.outputPath){job.outputPath=task.outputPath;job.sha256=task.sha256;}
    if(task.nodeId)job.nodeId=task.nodeId;
    job.lastDispatchAt=Math.max(job.lastDispatchAt||0,task.lastDispatchAt||0);
    this.lastDispatchAt=Math.max(this.lastDispatchAt,job.lastDispatchAt);
    this.retryNotBefore=Math.max(this.retryNotBefore,worker.retryNotBefore);
    if(worker.retryNotBefore)job.retryNotBefore=this.retryNotBefore;
    if(task.status==='failed')job.paused=true;
    this.aggregate(job);
    const terminal=TERMINAL.has(task.status);
    await this.save(job);
    // Release only after the complete receipt is durable. Never terminate sibling work.
    if(terminal&&this.workers.get(key)?.task===task){
      this.workers.delete(key);void this.pump();
    }
  }
  aggregate(job){
    const running=job.items.filter(i=>i.status==='running'),importing=job.items.filter(i=>i.status==='importing'),waiting=job.items.filter(i=>i.status==='waiting'),queued=job.items.filter(i=>i.status==='queued'),failed=job.items.filter(i=>i.status==='failed');
    const live=running.length+importing.length+waiting.length;
    job.currentIndex=(job.items.find(i=>i.status!=='complete')||job.items.at(-1)).index;
    job.nextImageAt=null;job.waitReason=null;
    if(live){
      job.status=running.length?'running':importing.length?'importing':'waiting';
      job.activity=job.cancelled?'正在停止，保留已完成结果':running.length?'正在生成 '+running.map(i=>'第 '+(i.index+1)+' 张').join('、'):importing.length?'正在保存 '+importing.map(i=>'第 '+(i.index+1)+' 张').join('、'):'服务限流，等待自动继续';
      if(job.status==='waiting'){job.waitReason='rate_limit';job.nextImageAt=Math.max(this.retryNotBefore,...waiting.map(i=>i.nextImageAt||0));}
    }else if(job.cancelled){job.status='interrupted';job.activity='';job.error='已停止。已完成图片保留，未提交的图片不会继续生成。';}
    else if(failed.length||job.paused){job.status='failed';job.activity='';job.error=failed[0]?.error||job.error;job.errorCode=failed[0]?.errorCode||job.errorCode;}
    else if(job.items.every(i=>i.status==='complete')){job.status='complete';job.activity='已完成 '+job.count+' / '+job.count+' 张';job.error=null;job.errorCode=null;}
    else if(queued.length){job.status=this.retryNotBefore>Date.now()?'waiting':'queued';job.activity=job.status==='waiting'?'服务限流，等待继续':'等待并行名额';if(job.status==='waiting'){job.waitReason='rate_limit';job.nextImageAt=this.retryNotBefore;}}
    else {job.status='interrupted';job.activity='';job.error='连接已中断，请检查已保存的结果；不会自动重发。';}
    if(TERMINAL.has(job.status)){job.finishedAt||=Date.now();this.readyJobs.delete(job.id);}
    this.active=[...this.jobs.values()].find(j=>BUSY.has(j.status))||null;
  }
  onEvent(message){
    if(message.method==='local/disconnected')this.statusPromise=null;
    for(const {worker} of [...(this.workers?.values()||[])])worker.onEvent(message);
  }
  async resume(job){
    if(BUSY.has(job.status)||job.status==='complete')return this.view(job);
    if(!this.view(job).canResume)throw Error('本次结果尚不允许安全续作，请保留原始记录');
    if(this.isNodeBusy(job.canvasUrl,job.targetNodeId))throw Error('此节点已有生成任务');
    await this.status();
    if(BUSY.has(job.status))return this.view(job);
    if(this.isNodeBusy(job.canvasUrl,job.targetNodeId))throw Error('此节点已有生成任务');
    // Upgrade legacy sequential receipts while preserving all completed indices.
    job.items=Array.from({length:job.count||1},(_,index)=>job.outputs?.some(o=>o.index===index&&o.uploaded)?{...(job.items?.find(i=>i.index===index)||{}),index,status:'complete'}:{index,status:'queued',attempts:job.items?.find(i=>i.index===index)?.attempts||[]});
    job.paused=false;job.cancelled=false;job.error=null;job.errorCode=null;job.finishedAt=null;job.resumedAt=Date.now();job.resumeCount=(job.resumeCount||0)+1;job.status='queued';job.activity='继续剩余图片，保留已完成结果';this.active=job;
    await this.save(job);this.readyJobs.add(job.id);void this.pump();return this.view(job);
  }
  async stop(job){
    if(!BUSY.has(job.status))return this.view(job);
    job.cancelled=true;
    for(const item of job.items||[])if(item.status==='queued')item.status='interrupted';
    for(const {worker,task} of [...this.workers.values()].filter(w=>w.job===job)){
      // An in-flight commit is allowed to finish; its receipt must not be discarded.
      if(task.status!=='importing')await worker.stop(task);
    }
    this.aggregate(job);await this.save(job);void this.pump();return this.view(job);
  }
  close(){this.closing=true;clearTimeout(this.pumpTimer);for(const {worker} of this.workers.values())for(const timer of worker.timers.values())clearTimeout(timer);super.close();}
}
