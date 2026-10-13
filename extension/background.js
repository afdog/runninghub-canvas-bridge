importScripts('site-policy.js');
const BROWSER_SOURCE='browser-extension';
const BASE='http://127.0.0.1:18765';
const policy=globalThis.RHCanvasSitePolicy;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let running=false;
async function ready(tab){
  for(let i=0;i<60;i++){
    const current=await chrome.tabs.get(tab.id);
    if(current.status==='complete')return current;
    await delay(250);
  }
  throw new Error('PAGE_LOAD_TIMEOUT');
}
const opening=new Map();
async function handle(job){
 if(job.action!=='openCanvas')return handleRaw(job);
 if(opening.has(job.canvasUrl))return opening.get(job.canvasUrl);
 const task=handleRaw(job);opening.set(job.canvasUrl,task);try{return await task;}finally{opening.delete(job.canvasUrl);}
}
async function handleRaw(job){
  if(job.action==='openCanvas'){
    const site=policy.parseCanvas(job.canvasUrl);if(!site)throw new Error('INVALID_CANVAS_URL');
    const tabs=await chrome.tabs.query({url:policy.origins.map(o=>o+'/*')});
    const existing=tabs.find(t=>policy.parseCanvas(t.url)?.key===site.key);
    const tab=await ready(existing ? (job.focus?await chrome.tabs.update(existing.id,{active:true}):existing) : await chrome.tabs.create({url:job.canvasUrl,active:job.focus===true}));
    if(policy.parseCanvas(tab.url)?.key!==site.key)throw new Error('PAGE_ORIGIN_CHANGED');
    await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['site-policy.js','bridge-main.js']});
    return {ok:true,reused:Boolean(existing)};
  }
  if(!['listCanvases','manageCanvas'].includes(job.action) || !policy.origins.includes(job.origin))throw new Error('BROWSER_ACTION_INVALID');
  const tabs=await chrome.tabs.query({url:job.origin+'/*'});
  const tab=await ready(tabs[0] || await chrome.tabs.create({url:job.origin+'/projects/canvas/me',active:false}));
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
async function pump(){
  if(running)return;running=true;
  try{
    await Promise.all(Array.from({length:4},async()=>{for(let i=0;i<20;i++){
      const response=await fetch(BASE+'/browser/poll?browserSource='+encodeURIComponent(BROWSER_SOURCE),{signal:AbortSignal.timeout(22000)});
      if(!response.ok)break;
      const job=await response.json();if(!job)continue;
      let result;try{result=await handle(job);}catch{result={ok:false,error:'BROWSER_OPERATION_FAILED'};}
      await fetch(BASE+'/browser/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:job.id,lease:job.lease,result}),signal:AbortSignal.timeout(8000)});
    }}));
  }catch{}finally{running=false;}
}
chrome.runtime.onMessage.addListener((message,sender)=>{if(message?.type==='rh.canvasHeartbeat' && policy.parseCanvas(sender.tab?.url))pump();});
chrome.alarms.create('bridge-browser-poll',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(pump);
chrome.runtime.onStartup.addListener(pump);
chrome.runtime.onInstalled.addListener(pump);
pump();
