import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,readdir,realpath,stat} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {homedir} from 'node:os';
import {CodexRpc} from './rpc.mjs';
import {ImageCanvas} from './canvas.mjs';
import {CanvasNodes,nodeConfig,NODE_ID} from './nodes.mjs';

const MAX_IMAGE=30*1024*1024;
const RATE_LIMIT_BACKOFF_MS=60000;
export function safeErrorText(value){
  return String(value||'').replace(/Bearer\s+[\w.~-]+/gi,'Bearer [REDACTED]').replace(/\bsk-[\w-]+/g,'[REDACTED]').replace(/([?&](?:token|access_token|api_key)=)[^\s&]+/gi,'$1[REDACTED]').slice(0,1600);
}
export function describeImageFailure({failure,error,message,status}={}){
  const detail=safeErrorText([failure?.message,typeof error==='object'?error?.message:error,message].filter(Boolean).join('\n'));
  if(failure?.type==='usageLimitExceeded')return {code:'IMAGE_USAGE_LIMIT',message:'原生生图用量已达上限。请等待用量恢复后重试。',resetsAt:failure.resetsAt||failure.resets_at||null};
  if(/cloudflare|cf-chl|challenge-platform|enable javascript and cookies|网关验证|安全验证/i.test(detail))return {code:'IMAGE_GATEWAY_REJECTED',message:'生图请求被服务网关安全验证拦截'+(/\b429\b/.test(detail)?'（HTTP 429）':'')+'。请在 ChatGPT 官方网页检查并完成安全验证；网页恢复后，生图通道仍可能暂时被拦截。通道恢复后可点击“继续剩余图片”，已完成结果会保留；本次不会自动重发。'};
  if(/\b429\b|too many requests|rate.?limit|请求过多|服务限流/i.test(detail))return {code:'IMAGE_RATE_LIMITED',message:'生图服务暂时限流（HTTP 429），当前这张未生成。请稍后继续。'};
  if(/\b401\b|unauthorized|未登录|登录已过期/i.test(detail))return {code:'IMAGE_AUTH_REQUIRED',message:'生图账户认证已失效，请重新连接 Codex 账户后重试。'};
  if(/\b50[234]\b|service unavailable|bad gateway/i.test(detail))return {code:'IMAGE_SERVICE_UNAVAILABLE',message:'生图服务暂时不可用，请稍后再试。'};
  return {code:'IMAGE_GENERATION_FAILED',message:detail||('原生生图未返回完成的图片'+(status?'（状态：'+status+'）':'')+'。已保留本次回执。')};
}
function imageFailureError(job,item){
  const failure=describeImageFailure({failure:item?.failure,error:item?.error||job.latestServiceError,message:job.message,status:item?.status});
  return Object.assign(new Error(failure.message),{code:failure.code,resetsAt:failure.resetsAt});
}
export function imageKind(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes[0]===255&&bytes[1]===216)return 'jpg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';
  throw Error('仅支持有效的 PNG、JPEG 或 WebP 图片。');
}
export function validateInput(input){
  if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>16000)throw Error('请输入 1–16000 字的画面描述。');
  const config=nodeConfig(input);
  if(input.targetNodeId!==undefined&&!NODE_ID.test(input.targetNodeId))throw Error('无效的 Codex 节点');
  if(input.transparent!==undefined&&typeof input.transparent!=='boolean')throw Error('透明背景必须为开或关。');
  if(input.autoRetryLimit!==undefined&&(!Number.isInteger(input.autoRetryLimit)||input.autoRetryLimit<0||input.autoRetryLimit>2))throw Error('自动续作次数必须为 0–2。');
  if(!Array.isArray(input.references||[])||(input.references||[]).length>5)throw Error('最多可附加 5 张参考图。');
  let total=0;
  const references=(input.references||[]).map((ref,i)=>{
    if(typeof ref.base64!=='string'||ref.base64.length>MAX_IMAGE*4/3+8||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ref.base64))throw Error('参考图数据无效。');
    const bytes=Buffer.from(ref.base64,'base64');total+=bytes.length;
    if(!bytes.length||total>MAX_IMAGE)throw Error('参考图合计不能超过 30 MiB。');
    return {bytes,extension:imageKind(bytes),name:'reference-'+(i+1)};
  });
  return {...config,prompt:input.prompt.trim(),targetNodeId:input.targetNodeId,references,autoRetryLimit:input.autoRetryLimit};
}
const INSTRUCTIONS=`你是画布中的 GPT 原生生图入口。用户消息是画面描述，只生成或编辑一张图片。必须调用内置 image_gen.imagegen 工具，禁止用代码、SVG、网页、第三方模型或图像 API 代替。不要读取宿主文件，除了本次用户附加且消息中明确列出的参考图；附加图也已作为本次输入给你。只在有参考图时使用 referenced_image_paths，否则不要指定任何参考图参数。严格设置用户要求的 transparent_background。调用一次生图工具后立即结束，不进行第二次生成，不调用其他账户工具或画布工具。不要自行上传，宿主会将真实结果放回已绑定画布。若生图失败，保留 HTTP 状态码和明确原因；若错误含 Cloudflare、安全验证或 HTML 网关拦截，明确说明这一点，不推断为账户用量耗尽。不要复述长 HTML 或凭据，不换其他模型或付费 API。`;

export class GptImageEngine {
  constructor({root=join(homedir(),'.runninghub-canvas-bridge','gpt-images'),rpc,canvas,interImageDelayMs=0,minRequestIntervalMs=60000,autoRetryLimit=2,retryBaseMs=RATE_LIMIT_BACKOFF_MS,retryJitterMs=5000,singleImage=false}={}){
    this.singleImage=singleImage;this.interImageDelayMs=interImageDelayMs;this.minRequestIntervalMs=minRequestIntervalMs;this.autoRetryLimit=autoRetryLimit;this.retryBaseMs=retryBaseMs;this.retryJitterMs=retryJitterMs;this.lastDispatchAt=0;this.timers=new Map();this.root=root;this.jobs=new Map();this.threads=new Map();this.active=null;this.statusPromise=null;this.retryNotBefore=0;
    this.canvas=canvas||new ImageCanvas();this.nodes=new CanvasNodes(this);
    this.rpc=rpc||new CodexRpc({onRequest:()=>{throw Error('该入口只开放 GPT 原生生图。');},onEvent:m=>this.onEvent(m)});
  }
  isNodeBusy(canvasUrl,nodeId){return this.active?.canvasUrl===canvasUrl&&this.active?.targetNodeId===nodeId;}
  async status(){
    if(this.statusPromise)return this.statusPromise;
    this.statusPromise=(async()=>{
      await this.rpc.start();
      const account=await this.rpc.request('account/read',{refreshToken:false});
      if(account.account?.type!=='chatgpt')throw Error('此入口需要已登录的 ChatGPT 账户，不会改走 API Key。');
      const caps=await this.rpc.request('modelProvider/capabilities/read',{});
      if(!caps.imageGeneration)throw Error('当前账户未开放原生生图。');
      return {ok:true,label:'GPT 原生生图',authenticated:true,imageGeneration:true,billing:'Codex 账户用量',apiKeyRequired:false,controls:{ratios:['auto','1:1','16:9','9:16','4:3','3:4'],ratioMode:'prompt',quality:'automatic',resolution:'automatic',modelVersion:'managed',maxCount:4,maxReferences:5}};
    })().catch(e=>{this.statusPromise=null;throw e;});return this.statusPromise;
  }
  view(job){
    const {id,canvasUrl,prompt,ratio,transparent,status,activity,createdAt,nodeId,sha256}=job;
    const failure=status==='failed'?describeImageFailure({error:job.error,message:job.message,failure:job.imageDiagnostics?.find(i=>i.failure)?.failure}):null;
    const diagnostic=job.imageDiagnostics?.at(-1);
    const rejected=job.dispatchOutcome==='rejected'||(job.dispatchOutcome===undefined&&diagnostic?.status==='failed'&&!diagnostic.hasSavedPath&&!diagnostic.inlineResultLength);
    return {id,canvasUrl,prompt,ratio,transparent,status,activity,error:failure?.message||job.error,errorCode:job.errorCode||failure?.code,retryNotBefore:job.retryNotBefore,createdAt,resumedAt:job.resumedAt,finishedAt:job.finishedAt,nodeId,sha256,hasImage:!!job.outputPath,targetNodeId:job.targetNodeId,count:job.count||1,currentIndex:job.currentIndex||0,completedCount:(job.outputs||[]).filter(o=>o.uploaded).length,images:(job.outputs||[]).map(({index,sha256,dimensions,uploaded,generationMs,uploadMs})=>({index,sha256,dimensions,uploaded,generationMs,uploadMs})),mode:job.mode||'text',nextImageAt:job.nextImageAt||null,waitReason:job.waitReason||null,retryAttempt:job.retryCounts?.[job.currentIndex||0]||0,maxAutoRetries:job.autoRetryLimit??this.autoRetryLimit,canResume:status==='failed'&&rejected&&['IMAGE_RATE_LIMITED','IMAGE_SERVICE_UNAVAILABLE','IMAGE_GATEWAY_REJECTED'].includes(job.errorCode)&&!(job.outputs||[]).some(o=>!o.uploaded)};
  }
  async save(job){
    const {imageItems,saving,...safe}=job;
    const path=join(this.root,job.id,'job.json'),temp=path+'.tmp';
    const data=JSON.stringify(safe,null,2);
    job.saving=(job.saving||Promise.resolve()).catch(()=>{}).then(async()=>{await writeFile(temp,data,{mode:0o600});await rename(temp,path);});
    await job.saving;
  }
  async list(canvasUrl,targetNodeId){
    await mkdir(this.root,{recursive:true,mode:0o700});
    for(const name of await readdir(this.root)){
      if(!/^[a-f0-9-]{36}$/.test(name)||this.jobs.has(name))continue;
      try{
        const j=JSON.parse(await readFile(join(this.root,name,'job.json'),'utf8'));
        if(['queued','running','importing','waiting'].includes(j.status)){j.status='interrupted';j.activity='';j.interruptedAt=Date.now();j.error='本机服务已重启，未确认本次上游结果。请检查已有图片与画布；本次请求不会自动重发。';await this.save(j);}
        this.retryNotBefore=Math.max(this.retryNotBefore,Number(j.retryNotBefore)||0);
        this.lastDispatchAt=Math.max(this.lastDispatchAt,Number(j.lastDispatchAt)||0);
        this.jobs.set(name,j);
      }catch{}
    }
    return [...this.jobs.values()].filter(j=>j.canvasUrl===canvasUrl&&(!targetNodeId||j.targetNodeId===targetNodeId)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,20).map(j=>this.view(j));
  }
  async create(canvasUrl,input){
    if(input.targetNodeId&&input.mode==='reference')input={...input,references:await this.nodes.references(canvasUrl,input.targetNodeId)};
    const validated=validateInput(input);
    const id=input.requestId||randomUUID();
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw Error('请求 ID 必须是 UUID。');
    const requestDigest=createHash('sha256').update(JSON.stringify({canvasUrl,prompt:validated.prompt,ratio:validated.ratio,transparent:validated.transparent,count:validated.count,mode:validated.mode,targetNodeId:validated.targetNodeId,references:validated.references.map(r=>createHash('sha256').update(r.bytes).digest('hex')),autoRetryLimit:validated.autoRetryLimit})).digest('hex');
    const previous=()=>{const existing=this.jobs.get(id);if(!existing)return null;if(existing.requestDigest!==requestDigest)throw Error('同一请求 ID 不能用于不同的生图内容。');return this.view(existing);};
    await this.list(canvasUrl);
    const existing=previous();if(existing)return existing;
    if(Date.now()<this.retryNotBefore)throw Error('生图服务刚刚限流，请稍后再试；当前请求尚未提交。');
    if(this.active)throw Error('已有一张图片正在处理，请等待完成或停止。');
    await this.status();
    const repeated=previous();if(repeated)return repeated;
    if(Date.now()<this.retryNotBefore)throw Error('生图服务刚刚限流，请稍后再试；当前请求尚未提交。');
    if(this.active)throw Error('已有图片正在处理。');
    const directory=join(this.root,id);
    const job={id,canvasUrl,prompt:validated.prompt,ratio:validated.ratio,transparent:validated.transparent,count:validated.count,mode:validated.mode,targetNodeId:validated.targetNodeId,autoRetryLimit:validated.autoRetryLimit??this.autoRetryLimit,currentIndex:0,outputs:[],requestDigest,status:'queued',activity:'正在连接画布…',createdAt:Date.now(),uploadRequestId:'gpt-image-'+id,references:[]};
    this.active=job;this.jobs.set(id,job);
    try{
      await mkdir(directory,{recursive:true,mode:0o700});
      for(const ref of validated.references){const path=join(directory,ref.name+'.'+ref.extension);await writeFile(path,ref.bytes,{mode:0o600});job.references.push(path);}
      await this.save(job);
      void this.run(job).catch(e=>this.fail(job,e));
      return this.view(job);
    }catch(error){this.active=null;this.jobs.delete(id);throw error;}
  }
  async run(job){
    if(job.cancelled)return this.finishCancelled(job);
    const delay=Math.max(0,this.retryNotBefore-Date.now(),this.lastDispatchAt+this.minRequestIntervalMs-Date.now());
    if(delay>0)return this.schedule(job,delay,this.retryNotBefore>Date.now()?'rate_limit':'pacing');
    job.nextImageAt=null;job.waitReason=null;job.error=null;job.errorCode=null;job.imageItems=[];job.message='';job.latestServiceError=null;job.dispatchOutcome='unknown';
    const attempt={index:job.currentIndex||0,startedAt:Date.now()};(job.attempts||=[]).push(attempt);
    await this.canvas.open(job.canvasUrl);
    if(job.targetNodeId)await this.nodes.patch(job.canvasUrl,job.targetNodeId,{activeJobId:job.id,config:nodeConfig(job)});
    await this.status();
    if(job.cancelled)return this.finishCancelled(job);
    const t=await this.rpc.request('thread/start',{sandbox:'read-only',approvalPolicy:'never',ephemeral:true,cwd:join(this.root,job.id),baseInstructions:INSTRUCTIONS,developerInstructions:'当前请求只允许一次内置生图。',dynamicTools:[],config:{model_reasoning_effort:'low',service_tier:'default'},serviceTier:'default'},90000);
    job.threadId=t.thread.id;this.threads.set(job.threadId,job);
    if(job.cancelled)return this.finishCancelled(job);
    job.status='running';job.activity='正在准备第 '+((job.currentIndex||0)+1)+' / '+(job.count||1)+' 张…';job.lastDispatchAt=this.lastDispatchAt=Date.now();attempt.dispatchedAt=job.lastDispatchAt;await this.save(job);
    const parameters={description:job.prompt,aspectRatio:job.ratio,transparent_background:job.transparent,referenceImagePaths:job.references,variation:job.count>1?{index:job.currentIndex+1,total:job.count,instruction:'这是独立的一张图片，在保持主题和要求的同时作自然的构图变化，不要拼成多格图。'}:null};
    const text='请用内置 image_gen.imagegen 生成一张图片。以下 JSON 中 description 是画面内容，其余是生成要求：\n'+JSON.stringify(parameters)+'\n画面比例为 auto 时由你选择。把比例要求写入生图 prompt。参考图为空时不要附加历史图片。生成成功后简短回复。';
    const r=await this.rpc.request('turn/start',{threadId:job.threadId,input:[{type:'text',text},...job.references.map(path=>({type:'localImage',path}))],effort:'low',serviceTier:'default',approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}},90000);
    job.turnId=r.turn.id;
    if(job.cancelled)await this.rpc.request('turn/interrupt',{threadId:job.threadId,turnId:job.turnId});
  }
  async fail(job,error){
    const failure=error.code?{code:error.code,message:safeErrorText(error.message)}:describeImageFailure({error,message:job.message});
    job.status='failed';job.activity='';job.error=failure.message;job.errorCode=failure.code;job.finishedAt=Date.now();
    if(failure.code==='IMAGE_RATE_LIMITED'){
      const index=job.currentIndex||0,retries=job.retryCounts?.[index]||0;
      const knownRejected=job.imageItems?.length===1&&job.imageItems[0].status==='failed'&&!job.imageItems[0].savedPath&&!job.imageItems[0].result&&!(job.outputs||[]).some(o=>o.index===index);
      const backoff=this.retryBaseMs*Math.pow(2,Math.min(retries,2))+Math.floor(Math.random()*this.retryJitterMs);
      this.retryNotBefore=Date.now()+backoff;job.retryNotBefore=this.retryNotBefore;
      if(knownRejected&&!job.cancelled&&retries<(job.autoRetryLimit??this.autoRetryLimit)&&this.active===job){
        (job.retryCounts||={})[index]=retries+1;job.finishedAt=null;
        return this.schedule(job,backoff,'rate_limit');
      }
    }
    if(this.active===job)this.active=null;await this.save(job).catch(()=>{});
  }
  async finishCancelled(job){job.status='interrupted';job.activity='';job.nextImageAt=null;job.waitReason=null;job.error='已停止。若图片已生成，会保留本地结果。';if(this.active===job)this.active=null;await this.save(job);}
  onEvent(message){
    if(message.method==='local/disconnected'){
      this.statusPromise=null;
      if(this.active&&this.active.status!=='importing')void this.fail(this.active,Error('本机生图连接已结束，请检查当前结果；不会自动重发。'));
      this.threads.clear();return;
    }
    const p=message.params||{},job=this.threads.get(p.threadId);if(!job)return;
    if(message.method==='error'&&p.error)job.latestServiceError=safeErrorText(p.error.message||p.error);
    if(message.method==='item/started'&&p.item?.type==='imageGeneration'){if(job.attempts?.length)job.attempts.at(-1).toolStartedAt=Date.now();job.activity='正在绘制第 '+((job.currentIndex||0)+1)+' / '+(job.count||1)+' 张';void this.save(job).catch(()=>{});}
    if(message.method==='item/completed'&&p.item?.type==='imageGeneration'){
      job.imageItems.push(p.item);
      job.dispatchOutcome=p.item.status==='failed'&&!p.item.savedPath&&!p.item.result?'rejected':p.item.status==='completed'?'completed':'unknown';
      job.imageDiagnostics=(job.imageDiagnostics||[]).concat({id:p.item.id,status:p.item.status,failure:p.item.failure||null,error:p.item.error?safeErrorText(p.item.error.message||p.item.error):null,hasSavedPath:!!p.item.savedPath,inlineResultLength:p.item.result?.length||0,at:Date.now()}).slice(-5);
      if(job.attempts?.length)job.attempts.at(-1).imageCompletedAt=Date.now();
      if(p.item.status==='completed'&&!p.item.failure&&(p.item.savedPath||p.item.result)){
        const turn={threadId:p.threadId,turnId:job.turnId};this.threads.delete(p.threadId);job.turnId=null;
        void this.complete(job,turn).catch(e=>this.fail(job,e));
      }
    }
    if(message.method==='item/completed'&&p.item?.type==='agentMessage')job.message=p.item.text?.slice(0,1600);
    if(message.method==='turn/completed'){
      job.turnId=null;this.threads.delete(job.threadId);
      if(p.turn?.error){void this.fail(job,Error(p.turn.error.message||'原生生图未完成'));return;}
      void this.complete(job).catch(e=>this.fail(job,e));
    }
  }
  async completedBytes(job,item){
    if(item.status!=='completed'||item.failure)throw imageFailureError(job,item);
    if(item.savedPath){
      const actual=await realpath(item.savedPath);
      const allowed=[resolve(this.root,job.id),resolve(process.env.CODEX_HOME||join(homedir(),'.codex'),'generated_images')];
      if(!allowed.some(root=>actual.startsWith(root+sep)))throw Error('生成图片路径超出本次输出目录。');
      if((await stat(actual)).size>MAX_IMAGE)throw Error('生成图片超过画布的 30 MiB 限制。');
      return readFile(actual);
    }
    if(item.result&&item.result.length<MAX_IMAGE*4/3+8)return Buffer.from(item.result.replace(/^data:image\/[\w+.-]+;base64,/,''),'base64');
    throw Error('原生工具未返回可读取的图片文件；请保留本次结果并检查服务。');
  }
  async complete(job,finishedTurn){
    const items=job.imageItems||[];
    if(items.length!==1){if(job.cancelled)return this.finishCancelled(job);throw Error(job.message||'未取得唯一的原生生图结果，本次没有上传。');}
    const bytes=await this.completedBytes(job,items[0]),kind=imageKind(bytes);
    if(bytes.length>MAX_IMAGE)throw Error('生成图片超过画布的大小限制。');
    job.outputPath=join(this.root,job.id,'generated-'+(job.currentIndex||0)+'.'+kind);await writeFile(job.outputPath,bytes,{mode:0o600});
    if(finishedTurn?.turnId)void this.rpc.request('turn/interrupt',finishedTurn,5000).catch(()=>{});
    job.sha256=createHash('sha256').update(bytes).digest('hex');job.imageItems=[];
    if(job.cancelled)return this.finishCancelled(job);
    job.outputs ||= [];
    const attempt=job.attempts?.at(-1),output={index:job.currentIndex||0,path:job.outputPath,sha256:job.sha256,uploaded:false,imageCompletedAt:attempt?.imageCompletedAt,uploadStartedAt:Date.now(),generationMs:attempt?.imageCompletedAt?attempt.imageCompletedAt-(attempt.toolStartedAt||attempt.dispatchedAt||attempt.startedAt):undefined};job.outputs.push(output);
    job.uploadRequestId='gpt-image-'+job.id+'-'+(job.currentIndex||0);
    job.status='importing';job.activity='第 '+((job.currentIndex||0)+1)+' 张已生成，正在保存到节点…';await this.save(job);
    const imported=await this.canvas.import(job);
    output.uploaded=true;output.uploadedAt=Date.now();output.uploadMs=output.uploadedAt-output.uploadStartedAt;output.url=imported.url;output.dimensions=imported.dimensions;output.receipt=imported.receipt;
    job.nodeId=imported.nodeId;job.uploadReceipt=imported.receipt;
    await this.save(job);
    if(job.cancelled)return this.finishCancelled(job);
    if(!this.singleImage&&(job.currentIndex||0)+1<(job.count||1)){job.currentIndex=(job.currentIndex||0)+1;return this.waitForNext(job);}
    job.status='complete';job.activity='已完成 '+(job.count||1)+' / '+(job.count||1)+' 张';job.finishedAt=Date.now();
    if(this.active===job)this.active=null;await this.save(job);
  }
  async waitForNext(job){
    if(!this.interImageDelayMs)return this.run(job);
    return this.schedule(job,this.interImageDelayMs,'pacing');
  }
  async schedule(job,delay,reason){
    job.status='waiting';job.waitReason=reason;job.activity=reason==='rate_limit'?'服务限流，等待自动继续':'按请求间隔准备下一张';job.nextImageAt=Date.now()+delay;await this.save(job);
    clearTimeout(this.timers.get(job.id));
    const timer=setTimeout(()=>{this.timers.delete(job.id);job.nextImageAt=null;if(job.cancelled)void this.finishCancelled(job);else void this.run(job).catch(e=>this.fail(job,e));},delay);
    this.timers.set(job.id,timer);
  }
  async resume(job){
    if(this.active===job||job.status==='complete')return this.view(job);
    if(this.active)throw Error('请先等待其他节点完成');
    if(!this.view(job).canResume)throw Error('本次结果尚不允许安全续作，请保留原始记录');
    if(Date.now()<this.retryNotBefore)throw Error('服务限流等待期尚未结束');
    await this.status();if(this.active)throw Error('已有图片正在处理');
    this.active=job;job.status='queued';job.error=null;job.errorCode=null;job.message='';job.nextImageAt=null;job.finishedAt=null;job.cancelled=false;job.resumedAt=Date.now();job.activity='继续剩余图片，保留已完成结果';job.resumeCount=(job.resumeCount||0)+1;(job.retryCounts||={})[job.currentIndex||0]=0;
    await this.save(job);void this.run(job).catch(e=>this.fail(job,e));return this.view(job);
  }
  async stop(job){
    if(this.active!==job)return this.view(job);
    if(job.status==='importing')throw Error('图片正在上传，请等待本次上传回执；不会重新生成。');
    job.cancelled=true;
    if(job.status==='waiting'){clearTimeout(this.timers.get(job.id));this.timers.delete(job.id);await this.finishCancelled(job);return this.view(job);}
    if(job.threadId&&job.turnId)await this.rpc.request('turn/interrupt',{threadId:job.threadId,turnId:job.turnId});
    else if(job.status==='queued')job.activity='正在停止…';
    return this.view(job);
  }
  close(){for(const timer of this.timers.values())clearTimeout(timer);this.rpc.close();this.canvas.close();}
}
