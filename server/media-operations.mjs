import {assertCommandSucceeded} from './command-result.mjs';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {mediaRoot,saveJson,hash} from './media-consent.mjs';
import {localOperations,aiOperations,validateOperation,ffmpegPath,processLocal,nativeMediaRequest,quoteFromEstimate} from './media-processing.mjs';
import './canvas-features.js';
const F=globalThis.RHCanvasFeatures;
const unwrap=r=>assertCommandSucceeded(r).result;

async function quotedModelCost(bridge,nodeId,expectedDigest,expectedNode){
  const unknown={kind:'unknown',runningHubCredits:null,source:'canvas.price.estimate'};
  if(typeof expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(expectedDigest))return unknown;
  try{
    const preview=unwrap(await bridge.command('canvas.runNode',{nodeId,dryRun:true,validateParams:true,expectedDigest,expectedNode}));
    const request=preview?.request;
    if(!request?.canvasId||request.targetType!=='NODE'||request.targetId!==nodeId||!request.canvas)return unknown;
    const estimate=unwrap(await bridge.command('canvas.platformRead',{operation:'priceEstimate',body:request}));
    return quoteFromEstimate(estimate)||unknown;
  }catch{return unknown;}
}

export class MediaOperations {
 constructor({root=mediaRoot(),bridgeFactory,downloads,process=processLocal}){Object.assign(this,{root,bridgeFactory,downloads,process});this.jobs=new Map();this.active=new Set();this.grants=new Map();}
 async init(){await mkdir(this.root,{recursive:true});for(const file of await readdir(this.root)){if(!/^[0-9a-f-]{36}\.json$/.test(file))continue;const p=JSON.parse(await readFile(join(this.root,file),'utf8'));if(['running','submitting'].includes(p.state)){p.state='unknown';p.error='Interrupted: inspect original command/task; never resubmit automatically';await this.save(p);}this.jobs.set(p.id,p);}}
 save(p){return saveJson(join(this.root,p.id+'.json'),p);}
 public(p){if(!p)throw Error('MEDIA_PLAN_NOT_FOUND');const {sourceUrl,sourceSnapshot,processingSnapshot,grant,...safe}=p;return safe;}
 status(id,canvasUrl){const p=this.jobs.get(id);if(!p||p.canvasUrl!==canvasUrl)throw Error('MEDIA_PLAN_SCOPE_MISMATCH');return this.public(p);}
 async refreshStatus(id,context){
  this.status(id,context.canvasUrl);const p=this.jobs.get(id),b=this.bridgeFactory(context);
  if(p.commandRequestId&&!this.active.has(id)&&['unknown','submitting'].includes(p.state)){
   const event=await b.request('/result?id='+encodeURIComponent(p.commandRequestId));
   if(event){
    const uncertain=event.submissionState==='unknown'||['CANVAS_WRITE_OUTCOME_UNKNOWN','COMMAND_OUTCOME_UNKNOWN'].includes(event.errorCode);
    p.receipt={requestId:p.commandRequestId,ok:event.ok,result:event.result,error:event.error,errorCode:event.errorCode,...(uncertain?{submissionState:'unknown'}:{})};
    p.state=uncertain?'unknown':event.ok===false?'failed':p.provider==='canvas-browser'?'complete':'submitted';
    p.recoveredOriginalReceipt=true;await this.save(p);
   }
  }
  if(p.state==='submitted'&&p.provider==='canvas-model'){
   const r=p.receipt?.result,taskId=r?.task?.taskId||r?.run?.task?.taskId;
   if(taskId){const result=unwrap(await b.command('canvas.platformRead',{operation:'tasks',body:{taskIds:[taskId],includeResults:true}}));const task=result.tasks?.find(t=>String(t.taskId)===String(taskId));
    const canvasId=new URL(p.canvasUrl).pathname.split('/').at(-1);
    if(task&&String(task.canvasId)===canvasId&&task.plans?.some(plan=>plan.nodeId===p.processingNodeId)){p.task=task;if(task.status==='SUCCESS')p.state='complete';else if(['FAILED','CANCELED','CANCELLED'].includes(task.status))p.state='failed';await this.save(p);}
   }
  }
  return this.public(p);
 }
 async capabilities(){let available=false;try{await ffmpegPath();available=true;}catch{}return {local:{available,cost:'no RunningHub credits',operations:localOperations},canvasBrowser:{operations:['capture_frame','crop','resize','rotate','flip'],cost:'zero RunningHub credits; source decode and PNG upload only',limits:'16 megapixels; CORS-readable source required'},canvasMedia:{operations:['crop','trim','speed','reverse','rotate','flip'],cost:'unknown; owner consent required'},canvasModel:{operations:aiOperations,cost:'quoted from /canvas/price/estimate when estimatePrice is present; otherwise unknown. Owner consent is still required',preparation:'Create a separate live-schema model/app node, bind source/mask and configure exact parameters before planning.'},routing:'Compare local/agent and canvas convenience, fidelity, codec, data transfer and available features. Choose deliberately. Never assume an AI model is free. Agent external local tools are also valid; preserve provenance when importing.'};}
 async plan(input,context){
  const {sourceNodeId,sourceUrl:chosen,operation,provider,options={},processingNodeId}=input;
  if(!['local','canvas-browser','canvas-media','canvas-model'].includes(provider))throw Error('PROVIDER_REQUIRED');
  if(provider==='canvas-model'){if(!aiOperations.includes(operation)||!processingNodeId||processingNodeId===sourceNodeId)throw Error('SEPARATE_PROCESSING_NODE_REQUIRED');}
  else validateOperation(operation,options);
  const b=this.bridgeFactory(context),snapshot=unwrap(await b.command('canvas.yjsSnapshot'));
  const node=snapshot.nodes.find(n=>n.id===sourceNodeId);if(!node)throw Error('SOURCE_NODE_NOT_FOUND');
  const urls=['video','image','audio'].flatMap(kind=>F.mediaUrls(node,kind));const sourceUrl=chosen||(urls.length===1?urls[0]:null);
  if(!sourceUrl||!urls.includes(sourceUrl))throw Error('EXACT_SOURCE_OUTPUT_REQUIRED');
  const p={id:randomUUID(),canvasUrl:context.canvasUrl,sourceNodeId,sourceTitle:node.data?.title||node.data?.label||sourceNodeId,sourceUrl,sourceSnapshot:F.canonical(node),operation,provider,options,processingNodeId:['canvas-media','canvas-model'].includes(provider)?processingNodeId:undefined,state:['local','canvas-browser'].includes(provider)?'planned':'awaiting_consent',createdAt:Date.now(),expiresAt:Date.now()+30*60000,cost:{kind:['local','canvas-browser'].includes(provider)?'free':'unknown',runningHubCredits:['local','canvas-browser'].includes(provider)?0:null},routingReason:String(input.routingReason||'').trim()};
  if(!p.routingReason)throw Error('ROUTING_REASON_REQUIRED: compare canvas and local convenience/quality');
  if(provider==='local')await ffmpegPath();
  if(provider==='canvas-browser'&&(!['capture_frame','crop','resize','rotate','flip'].includes(operation)||!F.mediaUrls(node,operation==='capture_frame'?'video':'image').includes(sourceUrl)))throw Error('BROWSER_OPERATION_MEDIA_UNSUPPORTED');
  if(provider==='canvas-media'){
   if(!F.mediaUrls(node,'video').includes(sourceUrl))throw Error('VIDEO_REQUIRED');
   const processing=snapshot.nodes.find(n=>n.id===processingNodeId);
   if(!processing||processing.id===node.id||processing.type!=='rh-video'||processing.data?.output?.length||/running|queued|processing/i.test(processing.data?.status||''))throw Error('EMPTY_SEPARATE_VIDEO_NODE_REQUIRED');
   p.processingSnapshot=F.canonical(processing);
   p.request=nativeMediaRequest({canvasId:snapshot.canvasId,nodeId:processingNodeId,url:sourceUrl,operation,options});
  }
  if(provider==='canvas-model'){
   const processing=snapshot.nodes.find(n=>n.id===processingNodeId);if(!processing||processing.data?.output?.length||/running|queued|processing/i.test(processing.data?.status||''))throw Error('EMPTY_PROCESSING_NODE_REQUIRED');
   const expectedKind=operation.startsWith('image_')?'image':operation.startsWith('video_')?'video':'audio';if(processing.type!=='rh-ai'&&processing.type!=='rh-'+expectedKind)throw Error('PROCESSING_MEDIA_KIND_MISMATCH');if(operation.startsWith('image_')&&!F.mediaUrls(node,'image').includes(sourceUrl)||operation.startsWith('video_')&&!F.mediaUrls(node,'video').includes(sourceUrl))throw Error('SOURCE_MEDIA_KIND_MISMATCH');
   const preflight=unwrap(await b.command('canvas.preflight',{nodeId:processingNodeId}));
   if(!preflight.ok||!JSON.stringify(preflight).includes(sourceUrl))throw Error('PROCESSING_REFERENCE_OR_PREFLIGHT_INVALID');
   p.processingSnapshot=F.canonical(processing);p.processingDigest=preflight.digest;
   p.archiveTarget=(await b.request('/archives/binding?canvasUrl='+encodeURIComponent(context.canvasUrl)+'&nodeId='+encodeURIComponent(processingNodeId)))?.target||null;
   p.processingSummary={title:processing.data?.title,appName:processing.data?.aiApp?.name,outputKind:processing.type==='rh-ai'?'Application-defined':expectedKind,modelCode:processing.data?.modelCode,appId:processing.data?.aiApp?.id,params:processing.data?.params,inputs:processing.data?.aiApp?.inputNodes};
   p.cost=await quotedModelCost(b,processingNodeId,p.processingDigest,p.processingSnapshot);
  }
  p.digest=hash(F.canonical(p));this.jobs.set(p.id,p);await this.save(p);return this.public(p);
 }
 async execute(id,context){
  const p=this.jobs.get(id);if(!p||p.canvasUrl!==context.canvasUrl)throw Error('MEDIA_PLAN_SCOPE_MISMATCH');
  if(!['planned','awaiting_consent'].includes(p.state)||this.active.has(id))return this.public(p);
  this.active.add(id);
  try{
   if(p.expiresAt<Date.now())throw Error('MEDIA_PLAN_EXPIRED');
   if(p.cost.kind!=='free'){let consent;try{consent=JSON.parse(await readFile(join(this.root,id+'.approval.json'),'utf8'));}catch{}if(!consent||consent.digest!==p.digest||consent.expiresAt<Date.now())throw Error('USER_CONSENT_REQUIRED');}
   const b=this.bridgeFactory(context),snapshot=unwrap(await b.command('canvas.yjsSnapshot'));
   if(F.canonical(snapshot.nodes.find(n=>n.id===p.sourceNodeId))!==p.sourceSnapshot)throw Error('SOURCE_CHANGED_REPLAN');
   if(p.processingNodeId&&F.canonical(snapshot.nodes.find(n=>n.id===p.processingNodeId))!==p.processingSnapshot)throw Error('PROCESSING_CHANGED_REPLAN');
   p.state='running';await this.save(p);
   this.run(p,b).catch(async e=>{p.state='failed';p.error=String(e.message).replace(/https?:\/\/\S+/g,'[URL]').slice(0,400);await this.save(p);}).finally(()=>this.active.delete(id));
   return this.public(p);
  }catch(e){this.active.delete(id);throw e;}
 }
 authorizeCommand(command,canvasUrl){
  if(command.dryRun&&command.type!=='canvas.runMediaOperation')return;
  const protectedNode=[...this.jobs.values()].some(p=>p.canvasUrl===canvasUrl&&p.processingNodeId===command.nodeId&&p.provider!=='local');
  if(command.type!=='canvas.runMediaOperation'&&!(command.type==='canvas.runNode'&&protectedNode))return;
  const grant=this.grants.get(command.mediaGrant);
  if(!grant||grant.canvasUrl!==canvasUrl||grant.nodeId!==command.nodeId||grant.requestId!==command.id||grant.type!==command.type||grant.payload!==F.canonical({request:command.request,expectedNode:command.expectedNode,expectedDigest:command.expectedDigest}))throw Error('USER_CONSENT_REQUIRED: execute the approved immutable media plan');
  // Single logical dispatch. Duplicate commands are recovered by the command journal.
  this.grants.delete(command.mediaGrant);
 }
 async run(p,b){
  if(p.provider==='local'){
   const dir=join(this.root,p.id);await mkdir(dir,{recursive:true});
   const download=await this.downloads.add({requestId:'media-'+p.id,files:[{url:p.sourceUrl,name:'source'}],destination:dir});p.downloadId=download.id;await this.save(p);
   await this.downloads.running.get(download.id);const result=this.downloads.status(download.id);if(result.state!=='complete')throw Error('SOURCE_DOWNLOAD_FAILED');
   p.result=await this.process({operation:p.operation,options:p.options,input:result.files[0].path,directory:dir});p.state='complete';p.nextAction='Use rh_upload_media to add this verified result as a new node; preserve the original. Completion is not user adoption.';await this.save(p);return;
  }
  if(p.provider==='canvas-browser'){p.commandRequestId=b.wireId('media-'+p.id);p.state='submitting';await this.save(p);try{p.receipt=await b.command('canvas.processBrowserMedia',{sourceNodeId:p.sourceNodeId,sourceUrl:p.sourceUrl,sourceSnapshot:p.sourceSnapshot,operation:p.operation,options:p.options,outputNodeId:'media-'+p.id},{id:'media-'+p.id});p.state=p.receipt.ok===false?'unknown':'complete';}catch(e){p.state='unknown';p.error=String(e.message).slice(0,300);}await this.save(p);return;}
  if(p.provider==='canvas-model'&&p.archiveTarget){if(p.archiveTarget.project_id&&!p.archiveTarget.work_id)throw Error('PROJECT_WORK_REQUIRED');await b.request('/archives',{archiveId:'media-'+p.id,submissionRequestId:b.wireId('media-'+p.id),canvasUrl:p.canvasUrl,nodeId:p.processingNodeId,target:p.archiveTarget,expectedOutputs:Number(JSON.parse(p.processingSnapshot).data?.generateNum||1)},60000);}
  const type=p.provider==='canvas-model'?'canvas.runNode':'canvas.runMediaOperation',mediaGrant=randomBytes(32).toString('hex'),requestId='media-'+p.id;
  const args={nodeId:p.processingNodeId,mediaGrant,...(p.provider==='canvas-model'?{expectedDigest:p.processingDigest,validateParams:true}:{request:p.request,expectedNode:p.processingSnapshot})};
  this.grants.set(mediaGrant,{canvasUrl:p.canvasUrl,nodeId:p.processingNodeId,requestId:b.wireId(requestId),type,payload:F.canonical({request:args.request,expectedNode:args.expectedNode,expectedDigest:args.expectedDigest})});
  p.commandRequestId=b.wireId(requestId);p.state='submitting';await this.save(p);
  try{
   const receipt=await b.command(type,args,{id:requestId});p.receipt=receipt;p.state=receipt.ok===false?'unknown':'submitted';p.nextAction='Inspect the original task and processing node; submission is not completion. Never repeat this plan to recover a timeout.';await this.save(p);
  }catch(e){p.state='unknown';p.error=String(e.message).slice(0,300);await this.save(p);}finally{this.grants.delete(mediaGrant);}
 }
}
