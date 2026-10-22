// Unsent work must expire even when the old page never polls again after reconnect.
// Dispatched work is never expired here: its outcome must be recovered separately.
export async function expireQueuedCommands({queues,records,results,persist,notify=()=>{},now=Date.now()}){
 const expired=[];
 for(const [clientId,queue] of queues){
  const keep=[];
  for(const command of queue){
   const record=records.get(command.id);
   if(record?.state==='queued' && Number.isFinite(command.expiresAt) && command.expiresAt<now){
    record.state='expired';record.completedAt=now;
    results.set(command.id,{ok:false,commandId:command.id,errorCode:'COMMAND_EXPIRED',submitted:false,submissionState:'not_submitted',error:'The request expired before it was dispatched to the page. Reconnect the exact canvas before starting new work.'});
    expired.push(command.id);
   }else keep.push(command);
  }
  if(keep.length)queues.set(clientId,keep);else queues.delete(clientId);
 }
 for(const id of expired){await persist(id);notify(id);}
 return expired;
}
