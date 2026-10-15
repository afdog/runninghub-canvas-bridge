// RH's history cards sometimes receive an MP4 as thumbnailUrl (including rh-ai).
// Render that exact media locally; never rewrite node types, outputs or task records.
(() => {
 const selector='.rh-history-card__preview > img, .rh-history-preview__image';
 const videoUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&/\.(mp4|webm|mov|m4v)$/i.test(u.pathname)?u.href:null;}catch{return null;}};
 function install(root=document){
  if(typeof MutationObserver==='undefined'||!root.documentElement)return ()=>{};
  const tracked=new Map();let busy=false;
  const remove=img=>{const r=tracked.get(img);if(!r)return;r.video.pause();r.video.remove();img.style.display=r.display;tracked.delete(img);};
  const scan=()=>{
   if(busy)return;busy=true;
   try{
    for(const [img,r]of tracked)if(!img.isConnected||videoUrl(img.getAttribute('src'))!==r.url)remove(img);
    for(const img of root.querySelectorAll(selector)){
     const url=videoUrl(img.getAttribute('src'));if(!url||tracked.has(img))continue;
     const video=root.createElement('video');video.src=url;video.controls=true;video.muted=true;video.preload='metadata';video.playsInline=true;
     video.className='rh-bridge-history-video';video.setAttribute('aria-label','历史视频预览（不切换当前结果）');
     video.style.cssText='display:block;width:100%;height:100%;object-fit:contain;background:#111;position:absolute;inset:0;z-index:1';
     // Previewing media must not trigger the native card's apply-history handler.
     for(const event of ['click','dblclick','pointerdown','pointerup','keydown','keyup'])video.addEventListener(event,e=>e.stopPropagation());
     tracked.set(img,{video,url,display:img.style.display});img.style.display='none';img.parentNode.appendChild(video);
    }
   }finally{busy=false;}
  };
  const observer=new MutationObserver(scan);observer.observe(root.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src']});scan();
  return ()=>{observer.disconnect();for(const img of [...tracked.keys()])remove(img);};
 }
 globalThis.RHHistoryMediaPreview={install,videoUrl};
})();
