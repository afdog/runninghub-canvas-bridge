import {createHash} from 'node:crypto';
import {browserRequestId} from './request-identity.mjs';
import {mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import { randomUUID } from 'node:crypto';
import '../extension/site-policy.js';
const sites=globalThis.RHCanvasSitePolicy;
export class BrowserReceiptError extends Error {
  constructor(id,code){
    super(code);this.receipt={ok:false,id,receiptDisposition:'retired',submissionState:'unknown',errorCode:code,
      nextAction:'Inspect rh_browser_result with the original job ID and account state. Do not repeat the browser operation.'};
  }
}
export class BrowserBroker {
  constructor(root){this.jobs=new Map();this.providers=new Map();this.extensionVersions=new Map();this.lastSeen=0;this.root=root;if(root){mkdirSync(root,{recursive:true});for(const name of readdirSync(root).filter(n=>n.endsWith('.json'))){const j=JSON.parse(readFileSync(join(root,name),'utf8'));if(j.state==='running'){j.state='unknown';j.result={ok:false,error:'BROWSER_WRITE_OUTCOME_UNKNOWN: inspect account before any replacement request'};}this.jobs.set(j.id,j);}}}
  persist(j){if(!this.root||j.args.action!=='manageCanvas')return;const p=join(this.root,j.id+'.json');writeFileSync(p+'.tmp',JSON.stringify(j),{mode:0o600});renameSync(p+'.tmp',p);}
  status(){return {recovery:{stableBrowserIds:true},extensionVersions:[...this.extensionVersions].filter(([,v])=>Date.now()-v.lastSeen<45000).map(([,v])=>({browserSource:v.browserSource,instanceId:v.instanceId,version:v.version,fingerprint:v.fingerprint||null})),presentationPolicy:'connect-by-default-v1',providers:[...this.providers].filter(([,t])=>Date.now()-t<45000).map(([source])=>source),connected:Date.now()-this.lastSeen<45000,pending:[...this.jobs.values()].filter(j=>['queued','running'].includes(j.state)).length};}
  enqueue(input){
    if(!['listCanvases','openCanvas','manageCanvas'].includes(input.action))throw new Error('BROWSER_ACTION_INVALID');
    const args={action:input.action};if(input.browserSource){if(!['browser-extension','codex-browser'].includes(input.browserSource))throw new Error('INVALID_BROWSER_SOURCE');args.browserSource=input.browserSource;}
    if(input.action==='openCanvas'){
      const site=sites.parseCanvas(input.canvasUrl);if(!site)throw new Error('INVALID_CANVAS_URL');
      args.canvasUrl=site.origin+new URL(input.canvasUrl).pathname;
      args.intent=input.intent ?? 'connect';if(!['connect','show'].includes(args.intent))throw new Error('INVALID_PRESENTATION_INTENT');
      // Normalize even requests from already-running older MCP clients. The
      // extension understands focus, but callers must explicitly request show.
      args.focus=args.intent==='show';
    }else{
      args.origin=input.origin || 'https://rhtv.runninghub.ai';
      if(!sites.origins.includes(args.origin))throw new Error('INVALID_SITE');
      args.scope=input.scope || 'personal';if(!['personal','team'].includes(args.scope))throw new Error('INVALID_SCOPE');
      if(args.scope==='team'){
        if(!/^[A-Za-z0-9_-]{1,100}$/.test(input.teamId || ''))throw new Error('TEAM_ID_REQUIRED');
        args.teamId=input.teamId;
      }
    }
    if(input.action==='manageCanvas'){if(!['createCanvas','renameCanvas','createFolder','renameFolder','moveCanvas'].includes(input.operation))throw new Error('BROWSER_OPERATION_INVALID');if(!/^[\w-]{8,128}$/.test(input.requestId||''))throw new Error('REQUEST_ID_REQUIRED');args.operation=input.operation;args.body=input.body;args.dryRun=input.dryRun===true;}
    if([...this.jobs.values()].filter(j=>['queued','running'].includes(j.state)).length>=100)throw new Error('BROWSER_QUEUE_FULL');
    const id=browserRequestId({...input,origin:args.origin});const prior=this.jobs.get(id);if(prior){if(JSON.stringify(prior.args)!==JSON.stringify(args))throw new Error('BROWSER_REQUEST_CONFLICT');return {id};}const job={id,args,created:Date.now(),state:'queued'};this.jobs.set(id,job);this.persist(job);return {id};
  }
  poll(browserSource="browser-extension",extensionVersion=null,build=null,instanceId=null){
    if(/^\d+\.\d+\.\d+$/.test(extensionVersion||''))this.extensionVersions.set(browserSource+':'+String(instanceId||''),{browserSource,instanceId:typeof instanceId==='string'?instanceId.slice(0,100):null,version:extensionVersion,fingerprint:/^[a-f0-9]{64}$/.test(build||'')?build:null,lastSeen:Date.now()});
    this.providers.set(browserSource,Date.now());
    this.lastSeen=Date.now();
    for(const [id,j] of this.jobs){if(j.args.action!=='manageCanvas'&&Date.now()-j.created>300000)this.jobs.delete(id);}
    const job=[...this.jobs.values()].find(j=>j.state==='queued' && (!j.args.browserSource || j.args.browserSource===browserSource));
    if(!job)return null;
    job.state='running';job.provider=browserSource;job.lease=randomUUID();this.persist(job);return {id:job.id,lease:job.lease,...job.args};
  }
  invalidReceipt(id,lease){
    const j=this.jobs.get(id);
    if(j&&j.lease===lease&&['running','unknown'].includes(j.state)&&!j.receiptFingerprint){
      j.state='unknown';j.result={ok:false,errorCode:'BROWSER_RESULT_INVALID',submissionState:'unknown',error:'BROWSER_RESULT_INVALID: inspect original operation; do not replay'};this.persist(j);
    }
    return new BrowserReceiptError(id,'BROWSER_RESULT_INVALID');
  }
  complete({id,lease,result}){
    if(!result||typeof result!=='object'||Array.isArray(result))throw this.invalidReceipt(id,lease);
    const j=this.jobs.get(id),fingerprint=createHash('sha256').update(JSON.stringify(result)).digest('hex');
    if(j && j.lease===lease && j.receiptFingerprint===fingerprint && ['complete','unknown'].includes(j.state)){this.persist(j);return {ok:true,duplicate:true};}
    // A durable job restored after a restart may still receive its original lease's result.
    const recovering=j?.state==='unknown'&&!j.receiptFingerprint;
    if(!j || j.lease!==lease || (j.state!=='running'&&!recovering))throw new BrowserReceiptError(id,'BROWSER_RECEIPT_MISMATCH');
    // Only pass the narrowly shaped browser result. Never store browser auth or arbitrary payloads.
    if(result?.ok===false)j.result={ok:false,error:String(result.error || 'BROWSER_FAILED').replace(/Bearer\s+\S+/gi,'[REDACTED]').slice(0,200)};
    else if(j.args.action==='manageCanvas')j.result={ok:true,result:result.data,dryRun:result.dryRun===true};
    else if(j.args.action==='openCanvas')j.result={ok:true,canvasUrl:j.args.canvasUrl,reused:result?.reused===true,presentation:{intent:j.args.intent,activation:j.args.focus?'requested':j.provider==='codex-browser' && result?.reused!==true?'required-for-new-tab':'unchanged',connection:result?.reused===true?'existing':'new'}};
    else{
      if(!Array.isArray(result?.canvases))throw this.invalidReceipt(id,lease);
      j.result={ok:true,complete:result.complete===true,scope:j.args.scope,teamId:j.args.teamId,origin:j.args.origin,
        canvases:result.canvases.slice(0,20000).filter(c=>sites.parseCanvas(c.url)?.origin===j.args.origin).map(c=>({id:String(c.id),name:String(c.name || '').slice(0,500),url:c.url,folderPath:String(c.folderPath || '').slice(0,1000)}))};
    }
    j.receiptFingerprint=fingerprint;j.state=j.result?.error?.includes('UNKNOWN')?'unknown':'complete';this.persist(j);return {ok:true};
  }
  result(id){const j=this.jobs.get(id);return j?{id,state:j.state,...(j.result?{result:j.result}:{})}:{id,state:'unknown'};}
}
