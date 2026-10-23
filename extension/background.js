importScripts('site-policy.js','browser-pump.js');
const BROWSER_SOURCE='browser-extension';
const BASE='http://127.0.0.1:18765';
const policy=globalThis.RHCanvasSitePolicy;
const EXTENSION_FILES=['background.js','bridge-main.js','browser-pump.js','keepalive.js','site-policy.js'];
const instanceId=crypto.randomUUID();
async function readExtensionBuild(){
 const parts=await Promise.all(EXTENSION_FILES.map(async name=>{const response=await fetch(chrome.runtime.getURL(name),{cache:'no-store'});if(!response.ok)throw Error('BUILD_READ_FAILED');return [name,(await response.text()).replaceAll('codex-browser',['browser','extension'].join('-'))];}));
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parts)))),n=>n.toString(16).padStart(2,'0')).join('');
}
const activeBuild=readExtensionBuild().catch(()=>null);
const delay=ms=>new Promise(r=>setTimeout(r,ms));

async function ready(tab,createdUrl){
  for(let i=0;i<60;i++){
    try{
      const current=await chrome.tabs.get(tab.id);
      if(current.status==='complete')return current;
    }catch(error){
      // Codex can return a new tab before its ID is usable. Resolve the exact
      // created URL again; this retries readiness, never an account API write.
      if(!createdUrl || !/^No tab with id:/.test(String(error?.message || error)))throw error;
      const matches=await chrome.tabs.query({url:createdUrl});
      const resolved=matches.find(t=>t.url===createdUrl);if(resolved)tab=resolved;
    }
    await delay(250);
  }
  throw new Error('PAGE_LOAD_TIMEOUT');
}
// Serialize page creation per origin; pending navigations count as existing tabs.
const creationLocks=new Map(),recentTabs=new Map();
chrome.tabs?.onRemoved?.addListener(id=>recentTabs.delete(id));
const tabUrl=tab=>tab.pendingUrl || tab.url || '';
async function ensureTab(origin,url,matches,active){
 const previous=creationLocks.get(origin)||Promise.resolve();
 const task=previous.catch(()=>{}).then(async()=>{
  const tabs=await chrome.tabs.query({});
  let tab=tabs.find(t=>matches(tabUrl(t)));
  if(!tab){
   for(const [id,entry] of recentTabs){
    if(Date.now()-entry.created>30000){recentTabs.delete(id);continue;}
    if(!matches(entry.url))continue;
    const visible=tabs.find(t=>t.id===id);
    if(visible && tabUrl(visible) && !matches(tabUrl(visible))){recentTabs.delete(id);continue;}
    tab=visible || entry.tab;break;
   }
  }
  if(tab)return {tab,created:false};
  tab=await chrome.tabs.create({url,active});
  recentTabs.set(tab.id,{tab:{...tab,pendingUrl:tabUrl(tab)||url},url,created:Date.now()});
  return {tab,created:true};
 });
 creationLocks.set(origin,task);
 try{return await task;}finally{if(creationLocks.get(origin)===task)creationLocks.delete(origin);}
}
async function handle(job){return handleRaw(job);}
async function handleRaw(job){
  if(job.action==='openCanvas'){
    const site=policy.parseCanvas(job.canvasUrl);if(!site)throw new Error('INVALID_CANVAS_URL');
    const found=await ensureTab(site.origin,job.canvasUrl,url=>policy.parseCanvas(url)?.key===site.key,BROWSER_SOURCE==='codex-browser' || job.focus===true);
    if(found.created)return {ok:true,reused:false};
    const current=job.focus?await chrome.tabs.update(found.tab.id,{active:true}):found.tab;
    if(current.pendingUrl || current.status!=='complete')return {ok:true,reused:true,pending:true};
    const tab=await ready(current);
    if(policy.parseCanvas(tab.url)?.key!==site.key)throw new Error('PAGE_ORIGIN_CHANGED');
    await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['site-policy.js','bridge-main.js']});
    return {ok:true,reused:true};
  }
  if(!['listCanvases','manageCanvas'].includes(job.action) || !policy.origins.includes(job.origin))throw new Error('BROWSER_ACTION_INVALID');
  const createdUrl=job.origin+'/projects/canvas/me';
  const found=await ensureTab(job.origin,createdUrl,url=>{try{return new URL(url).origin===job.origin;}catch{return false;}},BROWSER_SOURCE==='codex-browser');
  const tab=await ready(found.tab,found.created?createdUrl:null);
  const results=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:job.action==='manageCanvas'?manageAccountCanvas:listAccountCanvases,args:[{origin:job.origin,scope:job.scope,teamId:job.teamId,operation:job.operation,body:job.body,dryRun:job.dryRun}]});
  if(!results[0]?.result)throw new Error('CANVAS_LIST_EMPTY_RESPONSE');
  return results[0].result;
}
// Credentials are read and used only inside the logged-in RunningHub page.
async function manageAccountCanvas({origin,scope,teamId,operation,body,dryRun}){
 const paths={createCanvas:'/canvas/create',renameCanvas:'/canvas/rename',createFolder:'/canvas/folder/create',renameFolder:'/canvas/folder/update',moveCanvas:'/canvas/move/v1/submit'};
 if(location.origin!==origin||!paths[operation])return {ok:false,error:'BROWSER_OPERATION_INVALID'};
 if(dryRun)return {ok:true,dryRun:true,data:{operation,body}};
 try{
  const cookie=document.cookie.split('; ').find(v=>v.startsWith('Rh-Accesstoken='));const token=cookie?decodeURIComponent(cookie.slice(15)):localStorage.getItem('Rh-Accesstoken');if(!token)return {ok:false,error:'LOGIN_REQUIRED'};
  const headers={'Content-Type':'application/json',version:'1.0.0',Authorization:'Bearer '+token};if(scope==='team')headers['X-Team-Id']=teamId;
  const base=origin.endsWith('.runninghub.ai')?'https://www.runninghub.ai':origin;
  const response=await fetch(base+paths[operation],{method:'POST',credentials:'include',headers,body:JSON.stringify({...body,...(scope==='team'?{teamId}:{})}),signal:AbortSignal.timeout(25000)});
  if(!response.ok)return {ok:false,error:'PLATFORM_HTTP_'+response.status};const payload=await response.json();if(payload.code!=null&&Number(payload.code)!==0)return {ok:false,error:'PLATFORM_API_'+String(payload.code)};
  return {ok:true,data:payload.data??{code:payload.code}};
 }catch{return {ok:false,error:'BROWSER_WRITE_OUTCOME_UNKNOWN: inspect account before retrying'};}
}
async function listAccountCanvases({origin,scope,teamId}){
  try{
    if(location.origin!==origin)return {ok:false,error:'PAGE_ORIGIN_CHANGED'};
    const cookie=document.cookie.split('; ').find(v=>v.startsWith('Rh-Accesstoken='));
    const tokens=[cookie?decodeURIComponent(cookie.slice(15)):'',localStorage.getItem('Rh-Accesstoken') || ''];
    const token=tokens.find(v=>{if(!v)return false;try{const p=v.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');const d=JSON.parse(atob(p.padEnd(Math.ceil(p.length/4)*4,'=')));return !d.exp || d.exp*1000>Date.now();}catch{return true;}});
    if(!token)return {ok:false,error:'LOGIN_REQUIRED: sign in to RunningHub in this browser'};
    const headers={'Content-Type':'application/json',version:'1.0.0',Authorization:'Bearer '+token};
    if(scope==='team')headers['X-Team-Id']=teamId;
    const apiOrigin=origin.endsWith('.runninghub.ai')?'https://www.runninghub.ai':origin;
    const folders=[{id:null,path:''}],seenFolders=new Set(),seen=new Set(),canvases=[];
    let requests=0;
    for(let f=0;f<folders.length;f++){
      const folder=folders[f];
      for(let page=1;;page++){
        if(++requests>500)return {ok:true,complete:false,canvases};
        const body={page,size:100,queryScope:'ALL',querySortBy:'UPDATE_TIME',querySortOrder:'DESC',...(folder.id?{folderId:folder.id}:{}),...(scope==='team'?{teamId}:{})};
        const response=await fetch(apiOrigin+'/canvas/list',{method:'POST',credentials:'include',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
        if(!response.ok)return {ok:false,error:'CANVAS_LIST_HTTP_'+response.status};
        const envelope=await response.json();if(envelope.code!=null && Number(envelope.code)!==0)return {ok:false,error:'CANVAS_LIST_API_'+String(envelope.code)};
        const data=envelope.data ?? envelope;
        if(!Array.isArray(data.records))return {ok:false,error:'CANVAS_LIST_SCHEMA_CHANGED'};
        for(const row of data.records){
          if(typeof row.id==='number' && !Number.isSafeInteger(row.id))return {ok:false,error:'CANVAS_ID_PRECISION_LOSS'};
          const id=String(row.id ?? '');if(!/^[A-Za-z0-9_-]+$/.test(id))continue;
          if(String(row.type).toUpperCase()==='FOLDER'){
            if(!seenFolders.has(id)){seenFolders.add(id);folders.push({id,path:[folder.path,row.name || id].filter(Boolean).join('/')});}
          }else if(!seen.has(id)){
            seen.add(id);canvases.push({id,name:String(row.name || ''),url:origin+(origin==='https://rhtv.runninghub.cn'?'/projects/canvas/':'/project/canvas/')+id,folderPath:folder.path});
          }
        }
        if(data.pages!=null ? page>=Number(data.pages) : data.records.length<100)break;
      }
    }
    return {ok:true,complete:true,canvases};
  }catch{return {ok:false,error:'CANVAS_LIST_FAILED: check browser login and network'};}
}
async function completeBrowserJob(job,result){
 const r=await fetch(BASE+'/browser/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:job.id,lease:job.lease,result}),signal:AbortSignal.timeout(8000)});
 const value=await r.json();
 if(r.ok && value?.ok===true)return value;
 if(r.status===409 && value?.id===job.id && value?.receiptDisposition==='retired' && ['BROWSER_RECEIPT_MISMATCH','BROWSER_RESULT_INVALID'].includes(value.errorCode))return value;
 throw Error('RECEIPT_FAILED');
}
const transport=createRHBrowserPump({
 poll:async()=>{
  try{
   const r=await fetch(BASE+'/browser/poll?waitMs=12000&browserSource='+encodeURIComponent(BROWSER_SOURCE)+'&extensionVersion='+encodeURIComponent(chrome.runtime.getManifest().version)+'&extensionBuild='+encodeURIComponent(await activeBuild||'')+'&instanceId='+encodeURIComponent(instanceId),{signal:AbortSignal.timeout(20000)});
   if(!r.ok)throw new Error('POLL_FAILED');
   const job=await r.json();
   return job;
  }catch(error){throw error;}
 },
 execute:handle,
 complete:completeBrowserJob,
 schedule:(fn,delay)=>setTimeout(fn,delay),cancel:clearTimeout
});
const pump=()=>transport.wake();
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(message?.type==='rh.canvasHeartbeat' && policy.parseCanvas(sender.tab?.url)){pump();reply({ok:true,browserSource:BROWSER_SOURCE});}
});
chrome.alarms.create('bridge-browser-poll',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(pump);
chrome.runtime.onStartup.addListener(pump);
chrome.runtime.onInstalled.addListener(pump);
pump();

// Installed files are replaced only by the opt-in, checksum-verified updater.
// Read the disk manifest as well as the bridge version to avoid reload loops
// for extensions extracted elsewhere or a bridge already running a newer build.
let checkingUpdate=false;
async function checkInstalledUpdate(){
 if(checkingUpdate)return;checkingUpdate=true;
 try{
  void transport.wake();
  const response=await fetch(BASE+'/browser/update',{signal:AbortSignal.timeout(4000)});
  if(!response.ok)return;const state=await response.json();
  if(!state.reloadAllowed)return;
  const disk=await (await fetch(chrome.runtime.getURL('manifest.json'),{cache:'no-store'})).json();
  if(disk.version===state.version && (disk.version!==chrome.runtime.getManifest().version || state.fingerprint && await activeBuild && await activeBuild!==state.fingerprint && await readExtensionBuild()===state.fingerprint)){transport.stop();chrome.runtime.reload();}
 }catch{}finally{checkingUpdate=false;}
}
chrome.alarms.create('bridge-installed-update',{periodInMinutes:1});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='bridge-installed-update')checkInstalledUpdate();});
