const token=document.querySelector('meta[name=gpt-image-token]').content;
const canvasUrl=new URL(location.href).searchParams.get('canvasUrl');
const parentOrigin=new URL(canvasUrl).origin;
window.addEventListener('message',async event=>{
  if(event.origin!==parentOrigin||event.source!==parent||event.data?.type!=='rh.gptNode.create')return;
  const {requestId,x,y}=event.data;
  try{
    const r=await fetch('/gpt-image/node/create',{method:'POST',headers:{'x-gpt-image-token':token,'Content-Type':'application/json'},body:JSON.stringify({requestId,x,y})});
    const data=await r.json();if(!r.ok)throw Error(data.error||'节点创建失败');
    parent.postMessage({type:'rh.gptNode.created',requestId,...data},parentOrigin);
  }catch(e){parent.postMessage({type:'rh.gptNode.error',requestId,error:e.message},parentOrigin);}
});
parent.postMessage({type:'rh.gptNode.ready'},parentOrigin);

let refreshing=false;
async function refreshJobs(){
 if(refreshing)return;refreshing=true;
 try{const r=await fetch('/gpt-image/jobs',{headers:{'x-gpt-image-token':token}});const data=await r.json();if(!r.ok){if(/生图连接已过期/.test(data.error||''))location.reload();return;}parent.postMessage({type:'rh.gptNode.jobs',jobs:data.jobs},parentOrigin);}catch{}finally{refreshing=false;}
}
setInterval(refreshJobs,2500);void refreshJobs();
