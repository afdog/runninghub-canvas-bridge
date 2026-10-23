import {createHash} from 'node:crypto';
import {errorDetails} from './command-result.mjs';
import '../extension/site-policy.js';
export async function recoverReceipt(bridge,{requestId,canvasUrl}){
 const site=canvasUrl?globalThis.RHCanvasSitePolicy.parseCanvas(canvasUrl):bridge.canvasUrl?globalThis.RHCanvasSitePolicy.parseCanvas(bridge.canvasUrl):null;
 if(canvasUrl&&!site)throw Error('INVALID_CANVAS_URL');
 let id=requestId;
 if(!/^rh-[a-f0-9]{64}$/.test(id)){
  if(!site)throw Error('RECOVERY_CANVAS_REQUIRED: pass the original canvasUrl or returned rh- receipt ID; no browser connection is needed');
  const canonical=site.origin+new URL(canvasUrl||bridge.canvasUrl).pathname;
  id='rh-'+createHash('sha256').update(canonical+':'+id).digest('hex');
 }
 const saved=await bridge.request('/command-record?id='+encodeURIComponent(id));
 if(!saved.record)return {ok:false,found:false,requestId:id,state:'unknown',submissionState:'unknown',retryable:false,nextAction:'Receipt not found. Inspect original task identity; do not submit a replacement.'};
 const actual=globalThis.RHCanvasSitePolicy.parseCanvas(saved.record.canvasUrl);
 if(!actual||site&&site.key!==actual.key)throw Error('RECEIPT_CANVAS_MISMATCH');
 const event=saved.result;
 return {found:true,requestId:id,canvasUrl:saved.record.canvasUrl,state:saved.record.state,record:saved.record,replayed:false,
  ...(event?{ok:event.ok,result:event.result,errorCode:event.errorCode,error:event.error,...errorDetails(event)}:{ok:true,pending:true,retryAfterMs:1500}),
  ...(saved.record.state==='unknown'?{submissionState:'unknown',retryable:false,nextAction:'Inspect the original task. Never resubmit an uncertain command.'}:{})};
}
