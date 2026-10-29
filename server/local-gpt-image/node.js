const token=document.querySelector('meta[name=gpt-image-token]').content;
const params=new URL(location.href).searchParams;
const nodeId=params.get('nodeId'),canvasUrl=params.get('canvasUrl');
const $=id=>document.getElementById(id),busy=new Set(['queued','running','importing','waiting']);
let mode='text',initialized=false,dirty=false,saving=false,saveTimer=null,submitting=false,active=null,state=null,connected=false,refreshing=false,selectedJob=null,renderKey='',refKey='',pending=null,pollError=false,panelVisible=true;
let concurrencySaving=false,concurrencyError='';
const pendingKey='rh-codex-node-pending:'+canvasUrl+':'+nodeId;
try{pending=JSON.parse(localStorage.getItem(pendingKey)||'null');}catch{}
function error(text){$('error').textContent=text||'';$('error').hidden=!text;}
async function request(path,body){
  const r=await fetch('/gpt-image/'+path,{method:body===undefined?'GET':'POST',headers:{'x-gpt-image-token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error||'连接未完成'),{httpStatus:r.status});return data;
}
function config(){return {prompt:$('prompt').value,ratio:$('ratio').value,count:Number($('count').value),transparent:$('transparent').checked,mode};}
function modeView(){for(const b of document.querySelectorAll('[data-mode]'))b.setAttribute('aria-pressed',String(b.dataset.mode===mode));$('references').hidden=mode!=='reference';}
function fill(c){$('prompt').value=c.prompt;$('ratio').value=c.ratio;$('count').value=String(c.count);$('transparent').checked=c.transparent;mode=c.mode;modeView();}
async function save(){
  clearTimeout(saveTimer);if(!dirty||saving||active||submitting)return;
  const value=config(),snapshot=JSON.stringify(value);saving=true;$('save-state').textContent='保存中…';
  try{await request('node/config',value);dirty=JSON.stringify(config())!==snapshot;$('save-state').textContent=dirty?'待保存':'已保存';}
  catch(e){$('save-state').textContent='未保存';error(e.message);}
  finally{saving=false;if(dirty)saveTimer=setTimeout(save,1500);}
}
function changed(){dirty=true;$('save-state').textContent='待保存';clearTimeout(saveTimer);saveTimer=setTimeout(save,650);}
function controls(){
  const cooldown=Math.max(0,Math.ceil(((state?.retryNotBefore||0)-Date.now())/1000));
  const locked=submitting||!!active||!!pending;
  for(const id of ['prompt','ratio','count','transparent','choose','upload'])$(id).disabled=locked;
  for(const b of document.querySelectorAll('[data-mode]'))b.disabled=locked;
  const pool=state?.concurrency;
  $('concurrency').disabled=!connected||concurrencySaving||!pool;
  if(pool&&!concurrencySaving)$('concurrency').value=String(pool.maxConcurrentImages);
  $('concurrency-state').textContent=concurrencySaving?'保存中…':concurrencyError||pool?.warning||(!pool?'读取设置…':!connected?'连接中断，设置保留':pool.runningImages>pool.maxConcurrentImages?pool.runningImages+' 张正在完成，后续按 '+pool.maxConcurrentImages+' 张并行':pool.runningImages+' 张处理中'+(pool.queuedImages?' · '+pool.queuedImages+' 张排队':'')+' · 已保存');
  $('generate').disabled=!connected||submitting||!!active;
  $('generate').firstChild.textContent=submitting?'正在提交…':active?(active.status==='queued'?'已加入队列…':'正在生成…'):pending?'检查并继续原请求':cooldown?'加入队列 · 限流等待 '+cooldown+' 秒':state?.concurrency?.runningImages>=state?.concurrency?.maxConcurrentImages?'加入生成队列 ':'开始生成 ';
  const last=state?.jobs[0],matches=last&&['prompt','ratio','count','transparent','mode'].every(k=>config()[k]===last[k]);
  $('resume').hidden=!!active||!last?.canResume||!matches;$('resume').textContent='继续剩余 '+Math.max(0,(last?.count||1)-(last?.completedCount||0))+' 张';$('resume').disabled=submitting;
  $('stop').hidden=!active;$('stop').disabled=false;
  $('progress').hidden=!active;
  if(active){$('stage').textContent=active.status==='waiting'?(active.activity||'等待下一张')+' · '+Math.max(0,Math.ceil((active.nextImageAt-Date.now())/1000))+' 秒':active.activity||'正在处理…';$('elapsed').textContent=Math.max(0,Math.floor((Date.now()-(active.resumedAt||active.createdAt))/1000))+' 秒';$('completed-count').textContent='已保存 '+active.completedCount+' / '+active.count+' 张'+(active.retryAttempt?' · 自动重试 '+active.retryAttempt+' / '+active.maxAutoRetries:active.runningCount?' · '+active.runningCount+' 张生成中'+(active.queuedCount?' · '+active.queuedCount+' 张等待':''):active.queuedCount?' · '+active.queuedCount+' 张等待':'');$('progress-bar').setAttribute('aria-valuetext',$('stage').textContent);}
}
function imageUrl(jobId,index){return '/gpt-image/image?id='+encodeURIComponent(jobId)+'&index='+index+'&token='+encodeURIComponent(token);}
function renderReferences(references){
  const key=JSON.stringify(references)+Boolean(active);if(key===refKey)return;refKey=key;
  $('ref-count').textContent=references.length+' / 5';$('ref-empty').hidden=!!references.length;$('reference-list').replaceChildren();
  for(const ref of references){
    const card=document.createElement('div');card.className='ref';const img=document.createElement('img');img.src=ref.url;img.alt=ref.title;
    const name=document.createElement('span');name.textContent=ref.title;name.title=ref.title;const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','移除参考图 '+ref.title);remove.disabled=!!active;
    remove.onclick=async()=>{try{await request('node/reference',{sourceNodeId:ref.nodeId,remove:true});refKey='';await refresh();}catch(e){error(e.message);}};
    card.append(img,name,remove);$('reference-list').append(card);
  }
}
function renderResults(){
  const jobs=state?.jobs||[];
  const selected=jobs.find(j=>j.id===selectedJob&&j.images?.length)||jobs.find(j=>j.id===state?.node.selectedOutput?.jobId&&j.images?.length)||jobs.find(j=>j.images?.length);
  const key=JSON.stringify([selected?.id,selected?.images,state?.node.history?.length,state?.node.selectedOutput,!!active]);if(key===renderKey)return;renderKey=key;
  if(!selected){$('result-count').textContent='';return;}
  const images=selected.images||[];$('gallery').replaceChildren();$('gallery').classList.toggle('multiple',images.length>1);
  $('result-count').textContent=images.length+' 张'+(selected.status==='complete'?' · 已完成':'');
  for(const item of images){
    const figure=document.createElement('figure');figure.className='output';const img=document.createElement('img');img.src=imageUrl(selected.id,item.index);img.alt=selected.prompt+' · 第 '+(item.index+1)+' 张';
    const caption=document.createElement('figcaption');const details=document.createElement('span');details.textContent=item.dimensions?item.dimensions.width+' × '+item.dimensions.height:'已生成';
    const link=document.createElement('a');link.href=img.src;link.download='Codex-'+selected.id+'-'+(item.index+1)+'.png';link.textContent='保存原图';
    const use=document.createElement('button');use.type='button';const current=state.node.selectedOutput?.jobId===selected.id&&state.node.selectedOutput?.index===item.index;use.textContent=current?'当前图片':'设为当前图';use.disabled=current||!!active;use.setAttribute('aria-label',(current?'当前图片':'设为当前图')+' · 第 '+(item.index+1)+' 张');use.onclick=async()=>{try{use.disabled=true;await request('node/output',{jobId:selected.id,index:item.index});renderKey='';await refresh();}catch(e){error(e.message);use.disabled=false;}};
    caption.append(details,link);figure.append(img,caption,use);$('gallery').append(figure);
  }
  const history=jobs.filter(j=>j.images?.length);$('history-toggle').hidden=history.length<2;$('history').replaceChildren();
  for(const job of history){const button=document.createElement('button');button.textContent=new Date(job.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})+' · '+job.images.length+' 张 · '+job.prompt;button.onclick=()=>{selectedJob=job.id;renderKey='';renderResults();};$('history').append(button);}
}
async function refresh(){
  if(refreshing)return;refreshing=true;
  try{
    const data=await request('node/state');
    // A poll started before a settings save must not restore its older selection.
    if((state?.concurrency?.updatedAt||0)>(data.concurrency?.updatedAt||0))data.concurrency={...data.concurrency,maxConcurrentImages:state.concurrency.maxConcurrentImages,updatedAt:state.concurrency.updatedAt,warning:state.concurrency.warning};
    state=data;if(pollError){error('');pollError=false;}connected=!!data.status.imageGeneration;active=data.jobs.find(j=>busy.has(j.status))||null;
    if(!initialized){fill(data.node.config);initialized=true;}
    if(pending&&data.jobs.some(j=>j.id===pending.requestId)){pending=null;localStorage.removeItem(pendingKey);}
    $('connection').textContent=active?(active.status==='queued'?'已加入队列':'生成中'):connected?'Codex 已连接 · 最多 '+(state.concurrency?.maxConcurrentImages||1)+' 张并行':'未连接';
    renderReferences(data.node.references);renderResults();parent.postMessage({type:'rh.gptNode.state',nodeId,job:data.jobs[0]||null},new URL(canvasUrl).origin);
    const last=data.jobs[0];if(last?.error&&!active)error((last.completedCount?'本批已保存 '+last.completedCount+' / '+last.count+' 张。\n':'')+last.error);
  }catch(e){pollError=true;connected=false;$('connection').textContent='连接中断';error(e.message);if(/生图连接已过期/.test(e.message))location.reload();}
  finally{refreshing=false;controls();}
}
for(const id of ['prompt','ratio','count','transparent'])$(id).addEventListener(id==='prompt'?'input':'change',changed);
$('concurrency').onchange=async()=>{
  if(concurrencySaving||!connected)return;
  const value=Number($('concurrency').value);concurrencySaving=true;concurrencyError='';controls();
  try{const {concurrency}=await request('settings',{maxConcurrentImages:value});state={...state,concurrency};}
  catch(e){concurrencyError=e.message;}
  finally{concurrencySaving=false;controls();void refresh();}
};
for(const b of document.querySelectorAll('[data-mode]'))b.onclick=()=>{mode=b.dataset.mode;modeView();changed();};
$('info-toggle').onclick=()=>{$('parameter-info').hidden=!$('parameter-info').hidden;};
$('history-toggle').onclick=()=>{$('history').hidden=!$('history').hidden;};
$('choose').onclick=async()=>{
  if(!$('choices').hidden){$('choices').hidden=true;return;}
  try{
    const {choices}=await request('node/choices');$('choices').replaceChildren();$('choices').hidden=false;
    const connectedIds=new Set((state?.node.references||[]).map(r=>r.nodeId));
    for(const choice of choices){const b=document.createElement('button');b.type='button';const img=document.createElement('img');img.src=choice.url;img.alt='';const name=document.createElement('span');name.textContent=choice.title;b.append(img,name);b.disabled=connectedIds.has(choice.nodeId);b.onclick=async()=>{try{b.disabled=true;await request('node/reference',{sourceNodeId:choice.nodeId});$('choices').hidden=true;refKey='';await refresh();}catch(e){b.disabled=false;error(e.message);}};$('choices').append(b);}
    if(!choices.length)$('choices').textContent='画布中还没有可用图片，可以上传参考图。';
  }catch(e){error(e.message);}
};
$('upload').onclick=()=>$('files').click();
function fileData(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve({name:file.name,base64:String(r.result).split(',')[1]});r.onerror=()=>reject(Error('参考图读取失败'));r.readAsDataURL(file);});}
$('files').onchange=async()=>{
  const files=[...$('files').files];if(!files.length)return;
  if(files.length+(state?.node.references.length||0)>5||files.reduce((s,f)=>s+f.size,0)>30*1024*1024){error('最多 5 张参考图，合计不超过 30 MiB。');return;}
  submitting=true;controls();error('');
  try{for(const file of files)await request('node/upload-reference',await fileData(file));refKey='';await refresh();}catch(e){error(e.message+'；请检查已上传的参考图后再操作。');}finally{submitting=false;$('files').value='';controls();}
};
$('form').onsubmit=async event=>{
  event.preventDefault();if(submitting||active||!connected)return;
  if(!pending&&!config().prompt.trim())return;
  submitting=true;clearTimeout(saveTimer);controls();error('');
  try{
    if(!pending){pending={...config(),requestId:crypto.randomUUID()};localStorage.setItem(pendingKey,JSON.stringify(pending));}
    const {job}=await request('node/generate',pending);active=job;selectedJob=job.id;dirty=false;$('save-state').textContent='已保存';pending=null;localStorage.removeItem(pendingKey);await refresh();
  }catch(e){if(e.httpStatus>=400&&e.httpStatus<500){pending=null;localStorage.removeItem(pendingKey);}error(e.message+(pending?'；保留原请求，检查后可继续，不会重复生成。':''));}
  finally{submitting=false;controls();}
};
$('resume').onclick=async()=>{const job=state?.jobs[0];if(!job||submitting)return;submitting=true;controls();error('');try{await request('resume?id='+encodeURIComponent(job.id),{});selectedJob=job.id;await refresh();}catch(e){error(e.message);}finally{submitting=false;controls();}};
$('stop').onclick=async()=>{if(!active)return;try{await request('stop?id='+encodeURIComponent(active.id),{});await refresh();}catch(e){error(e.message);}};
window.addEventListener('message',event=>{if(event.source!==parent||event.origin!==new URL(canvasUrl).origin||event.data?.type!=='rh.gptNode.visibility')return;panelVisible=event.data.visible===true;if(panelVisible)void refresh();});
setInterval(()=>{if(panelVisible||dirty||submitting)void refresh();},2200);setInterval(controls,1000);void refresh();

parent.postMessage({type:'rh.gptNode.loaded',nodeId},new URL(canvasUrl).origin);
