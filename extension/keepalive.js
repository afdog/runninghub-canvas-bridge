// Messages wake a suspended worker; MAIN-world nudges cover throttled page timers.
(() => {
 let last=0;
 const ping=()=>{if(Date.now()-last<5000)return;last=Date.now();try{chrome.runtime.sendMessage({type:'rh.canvasHeartbeat'}).catch(()=>{});}catch{}};
 window.addEventListener('message',e=>{if(e.source===window && e.data?.type==='rh.canvasWake')ping();});
 document.addEventListener('visibilitychange',ping);window.addEventListener('pageshow',ping);
 ping();setInterval(ping,10000);
})();
