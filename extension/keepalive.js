// Wake the extension worker while a canvas is open, including hosts that suspend alarms.
(() => {
  const ping=()=>chrome.runtime.sendMessage({type:'rh.canvasHeartbeat'}).catch(()=>{});
  ping();setInterval(ping,10000);
})();
