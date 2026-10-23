// Classify failures without losing receipt identity or retrying mutations.
export function failureCode(value){
 const declared=value?.errorCode || value?.code;
 const message=String(value?.error || value?.message || value || '').replace(/^Error:\s*/, '');
 const embedded=message.match(/^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?=[:\s]|$)/)?.[1];
 return declared && declared!=='COMMAND_FAILED'?declared:embedded || declared || (/Failed to fetch|fetch failed|network|ECONN/i.test(message)?'NETWORK_ERROR':'COMMAND_FAILED');
}
export function failurePolicy(value){
 const code=failureCode(value);
 if(value?.submissionState==='unknown'||/OUTCOME_UNKNOWN|RECEIPT_UNKNOWN/.test(code))return {code,category:'unknown',retryable:false,action:'recover_receipt'};
 if(/CANVAS_NOT_CONNECTED|BROWSER_EXTENSION_OFFLINE|REQUESTED_BROWSER_OFFLINE/.test(code))return {code,category:'connection',retryable:false,action:'wait_for_connection'};
 if(value?.retryable===false)return {code,category:'blocked',retryable:false,action:'inspect'};
 if(/NETWORK|TIMEOUT|ECONN|FETCH_FAILED/.test(code)||[408,429,500,502,503,504].includes(value?.status))return {code,category:'transient',retryable:true,action:'retry_read'};
 return {code,category:'blocked',retryable:false,action:'inspect'};
}
