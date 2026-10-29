const token=document.querySelector('meta[name=gpt-image-token]').content;
const $=id=>document.getElementById(id);
const busyStates=new Set(['queued','running','importing','waiting']);
let connected=false,submitting=false,activeJob=null,stopping=false,lastView='',previews=[],retryNotBefore=0;
async function request(path,body){
  const response=await fetch('/gpt-image/'+path,{method:body===undefined?'GET':'POST',headers:{'x-gpt-image-token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'连接未完成');return data;
}
function showError(message){$('error').textContent=message||'';$('error').hidden=!message;}
function controls(){
  const remaining=Math.max(0,Math.ceil((retryNotBefore-Date.now())/1000));
  $('generate').disabled=!connected||submitting||!!activeJob||remaining>0;
  $('generate').firstChild.textContent=submitting?'正在提交…':activeJob?'正在生成图片…':remaining?'服务限流，'+remaining+' 秒后可重试':'生成并放回画布 ';
  $('stop').hidden=!activeJob||activeJob.status==='importing';$('stop').disabled=stopping;
  for(const id of ['prompt','ratio','transparent','references','clear-references'])$(id).disabled=submitting||!!activeJob;
}
function imageUrl(job){return '/gpt-image/image?id='+encodeURIComponent(job.id)+'&token='+encodeURIComponent(token);}
function render(jobs){
  activeJob=jobs.find(j=>busyStates.has(j.status))||null;controls();
  const signature=JSON.stringify(jobs);if(signature===lastView)return;lastView=signature;
  const list=$('jobs');list.replaceChildren();
  if(!jobs.length){const p=document.createElement('p');p.className='empty';p.textContent='第一张图片，从一个想法开始。';list.append(p);return;}
  for(const job of jobs){
    const item=document.createElement('article');item.className='job';
    const state=document.createElement('p');state.className='job-state';state.textContent=job.activity||({failed:'生成未完成',interrupted:'已停止',complete:'已生成并放回画布'}[job.status]||'正在处理…');
    const prompt=document.createElement('p');prompt.className='job-prompt';prompt.textContent=job.prompt;
    item.append(state,prompt);
    if(job.hasImage){const img=document.createElement('img');img.src=imageUrl(job);img.alt=job.prompt;img.loading='lazy';const a=document.createElement('a');a.href=imageUrl(job);a.download='GPT-'+job.id+'.png';a.textContent='保存图片';item.append(img,a);}
    if(job.error){const error=document.createElement('p');error.className='job-error';error.textContent=job.error;item.append(error);}
    list.append(item);
  }
}
async function refresh(){
  try{const data=await request('state');connected=data.status.imageGeneration===true;retryNotBefore=data.retryNotBefore||0;$('connection').textContent='账户已连接 · GPT 原生生图';render(data.jobs);}
  catch(error){connected=false;$('connection').textContent=error.message;controls();}
}
function readFile(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({base64:String(reader.result).split(',')[1]});reader.onerror=()=>reject(Error('参考图读取失败'));reader.readAsDataURL(file);});}
function clearPreviews(){for(const url of previews)URL.revokeObjectURL(url);previews=[];$('reference-previews').replaceChildren();}
$('references').addEventListener('change',()=>{
  clearPreviews();const files=[...$('references').files];
  if(files.length>5||files.reduce((s,f)=>s+f.size,0)>30*1024*1024){$('references').value='';showError('最多 5 张参考图，合计不超过 30 MiB。');return;}
  showError('');$('clear-references').hidden=!files.length;
  for(const file of files){const img=document.createElement('img'),url=URL.createObjectURL(file);previews.push(url);img.src=url;img.alt=file.name;$('reference-previews').append(img);}
});
$('clear-references').addEventListener('click',()=>{$('references').value='';$('clear-references').hidden=true;clearPreviews();});
$('form').addEventListener('submit',async event=>{
  event.preventDefault();if(submitting||activeJob||!connected)return;
  if(!$('prompt').value.trim())return;
  submitting=true;controls();showError('');
  try{
    const references=await Promise.all([...$('references').files].map(readFile));
    const data=await request('generate',{requestId:crypto.randomUUID(),prompt:$('prompt').value,ratio:$('ratio').value,transparent:$('transparent').checked,references});
    activeJob=data.job;await refresh();
  }catch(error){showError(error.message+'；请先检查生成记录，避免重复提交。');}
  finally{submitting=false;controls();}
});
$('stop').addEventListener('click',async()=>{if(!activeJob||stopping)return;stopping=true;controls();try{await request('stop?id='+encodeURIComponent(activeJob.id),{});await refresh();}catch(error){showError(error.message);}finally{stopping=false;controls();}});
$('close').addEventListener('click',()=>{window.parent.postMessage({type:'rh.gptImage.close'},'*');});
setInterval(()=>{if(!submitting)void refresh();},3000);
setInterval(controls,1000);
void refresh();
