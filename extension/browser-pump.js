// One bounded batch at a time. A failed lane must not release the other lanes.
(function(root){
 root.createRHBrowserPump=function({poll,execute,complete,schedule,cancel,report=()=>{},interval=1500}){
  let running=null,timer=null,stopped=false;
  const lane=async()=>{const job=await poll();if(!job)return;let result;try{result=await execute(job);}catch(error){const reason=String(error?.message||'unknown').replace(/https?:\/\/\S+/g,'[URL]').replace(/Bearer\s+\S+/gi,'[REDACTED]').slice(0,180);result={ok:false,error:'BROWSER_OPERATION_FAILED: '+reason};}await complete(job,result);};
  const wake=()=>{
   if(stopped)return Promise.resolve();if(running)return running;
   if(timer!==null){cancel(timer);timer=null;}
   running=Promise.allSettled(Array.from({length:4},lane)).then(results=>{for(const r of results)if(r.status==='rejected')report('BROWSER_TRANSPORT_UNAVAILABLE');}).finally(()=>{running=null;if(!stopped)timer=schedule(wake,interval);});
   return running;
  };
  return {wake,stop(){stopped=true;if(timer!==null)cancel(timer);},isRunning:()=>running!==null};
 };
})(globalThis);
