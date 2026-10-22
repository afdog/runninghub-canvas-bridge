// Four independent lanes. Each owns its poll, execution and receipt until settled.
(function(root){
 root.nextBrowserPollDelay=(job,elapsedMs)=>job||elapsedMs>=1000?0:1500;
 root.createRHBrowserPump=function({poll,execute,complete,schedule,cancel,report=()=>{},interval=1500}){
  let stopped=false;
  const lanes=Array.from({length:4},()=>({running:null,timer:null,pending:null}));
  function start(lane){
   if(stopped)return Promise.resolve();if(lane.running)return lane.running;
   if(lane.timer!==null){cancel(lane.timer);lane.timer=null;}
   lane.running=Promise.resolve().then(async()=>{
    let delay=interval;
    try{
     if(!lane.pending){
      const started=Date.now(),job=await poll();delay=root.nextBrowserPollDelay(job,Date.now()-started);
      if(!job)return;
      let result;
      try{result=await execute(job);}catch(error){const reason=String(error?.message||'unknown').replace(/https?:\/\/\S+/g,'[URL]').replace(/Bearer\s+\S+/gi,'[REDACTED]').slice(0,180);result={ok:false,error:'BROWSER_OPERATION_FAILED: '+reason};}
      lane.pending={job,result};
     }
     const acknowledgement=await complete(lane.pending.job,lane.pending.result);
     if(acknowledgement?.ok===false){
      if(acknowledgement.id!==lane.pending.job.id || acknowledgement.receiptDisposition!=='retired')throw Error('RECEIPT_NOT_ACCEPTED');
      // The original ID stays recoverable; terminal rejection must not occupy a worker forever.
      const id=lane.pending.job.id;lane.pending=null;
      report('BROWSER_RECEIPT_RETIRED',{id,errorCode:acknowledgement.errorCode,submissionState:'unknown'});
     }
     lane.pending=null;delay=0;
    }catch{delay=interval;report('BROWSER_TRANSPORT_UNAVAILABLE');}
    finally{lane.running=null;if(!stopped)lane.timer=schedule(()=>start(lane),delay);}
   });
   return lane.running;
  }
  return {wake:()=>Promise.all(lanes.map(start)),stop(){stopped=true;for(const lane of lanes)if(lane.timer!==null)cancel(lane.timer);},isRunning:()=>lanes.some(l=>l.running!==null)};
 };
})(globalThis);
