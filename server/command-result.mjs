export function errorDetails(event){
 return Object.fromEntries(['submitted','submissionState','retryable','platformCode','historyRoute','nextAction'].filter(k=>event?.[k]!==undefined).map(k=>[k,event[k]]));
}
// Read/compose helpers must stop on a failed receipt before dereferencing its payload.
export class CommandResultError extends Error {
  constructor(receipt){super(receipt.errorCode || 'COMMAND_FAILED');this.name='CommandResultError';this.receipt=receipt;}
}
export function assertCommandSucceeded(receipt){
  if(receipt?.ok===false)throw new CommandResultError(receipt);
  return receipt;
}
export function failureReceipt(error){
  const r=error?.receipt;
  if(!r || r.ok!==false || typeof r.requestId!=='string')return null;
  return {...r,...(typeof r.error==='string'?{error:r.error.replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]')}:{} )};
}
