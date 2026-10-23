import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeClient} from '../server/bridge-client.mjs';
import {BrowserBroker} from '../server/browser-broker.mjs';
const client=()=>{const b=new BridgeClient();b.canvasUrl='https://www.runninghub.ai/project/canvas/fixture';b.target=async()=>({clientId:'p',canvasId:'fixture',canvasOrigin:'https://www.runninghub.ai'});return b;};
test('accepted command survives lost POST response and transient receipt connection failure, submits once',async()=>{
 const b=client();let posts=0,reads=0,id;
 b.request=async(path,body)=>{if(path==='/command'){posts++;id=body.id;throw Error('lost response');}if(++reads===1)throw Error('offline');assert.ok(path.includes(id));return {ok:true,result:{saved:true}};};
 const r=await b.command('canvas.updateNodeText',{},{id:'stable-request'});assert.equal(r.requestId,id);assert.equal(r.result.saved,true);assert.equal(posts,1);assert.equal(reads,2);
});
test('persistent receipt outage retains original identity, definitive rejection is not retried',async()=>{
 const b=client();let posts=0;b.request=async(path,body)=>{if(path==='/command'){posts++;return{id:body.id};}throw Error('offline');};
 const r=await b.command('canvas.updateNodeText',{},{id:'stable-request'});assert.equal(r.submissionState,'unknown');assert.equal(r.requestId,b.wireId('stable-request'));assert.equal(posts,1);
 b.request=async()=>{throw Object.assign(Error('READ_ONLY'),{status:403});};await assert.rejects(b.command('canvas.updateNodeText'),/READ_ONLY/);
});
test('browser client knows broker job ID before POST response; retry reads only',async()=>{
 const b=client(),broker=new BrowserBroker();let posts=0,id;
 b.request=async(path,body)=>{if(path==='/browser/status')return {...broker.status(),connected:true,providers:['browser-extension']};if(path==='/browser/jobs'){posts++;id=broker.enqueue(body).id;const job=broker.poll();broker.complete({id,lease:job.lease,result:{canvases:[],complete:true}});throw Error('lost response');}assert.ok(path.includes(id));return broker.result(id);};
 const r=await b.browserJob({action:'listCanvases'});assert.equal(posts,1);assert.equal(r.browserRequestId,id);assert.equal(r.ok,true);
});
test('browser outage always returns recoverable ID',async()=>{
 const b=client();b.request=async path=>{if(path==='/browser/status')return {connected:true,recovery:{stableBrowserIds:true}};throw Error('offline');};
 const r=await b.browserJob({action:'openCanvas',canvasUrl:b.canvasUrl});assert.match(r.browserRequestId,/^[a-f0-9]{64}$/);assert.equal(r.state,'unknown');
});

test('older bridge with a lost browser acknowledgement reports missing identity honestly',async()=>{
 const b=client();b.request=async path=>{if(path==='/browser/status')return{connected:true};throw Error('lost acknowledgement');};
 const r=await b.browserJob({action:'listCanvases'});assert.equal(r.browserRequestId,null);assert.ok(r.clientRequestId);assert.equal(r.errorCode,'LEGACY_BROWSER_RECEIPT_UNKNOWN');
});

test('browser recovery retains unknown state when a restarted broker has only an uncertain original receipt',async()=>{
 const b=client();b.request=async(path,body)=>{if(path==='/browser/status')return{connected:true,recovery:{stableBrowserIds:true}};if(path==='/browser/jobs')return{id:'original-browser-job'};return{state:'unknown',result:{ok:false,error:'BROWSER_WRITE_OUTCOME_UNKNOWN'}};};
 const r=await b.browserJob({action:'manageCanvas',operation:'renameCanvas',requestId:'original-logical'});assert.equal(r.browserRequestId,'original-browser-job');assert.equal(r.submissionState,'unknown');
});


test('bridge client retains structured rejection and route evidence',async()=>{
 const b=client(),event={ok:false,errorCode:'HISTORY_ROUTE_CONFLICT',submissionState:'rejected',submitted:false,retryable:false,platformCode:301,historyRoute:{historyId:'native'},nextAction:'repair'};
 b.request=async(path,body)=>path==='/command'?{id:body.id}:event;
 const result=await b.command('canvas.runNode',{nodeId:'n'},{id:'original-run'});
 for(const key of ['submissionState','submitted','retryable','platformCode','historyRoute','nextAction'])assert.deepEqual(result[key],event[key]);
});
test('page opened before a connection check fails retains its browser receipt instead of reopening',async()=>{
 const b=client();let checks=0,opens=0;
 b.request=async path=>{if(path==='/browser/status')return{providers:['browser-extension']};if(path==='/clients'){if(checks++===0)return[];throw Error('connection reset');}throw Error(path);};
 b.browserJob=async()=>{opens++;return{ok:true,browserSource:'browser-extension',browserRequestId:'opened-once'};};
 const result=await b.open(b.canvasUrl);assert.equal(opens,1);assert.equal(result.opened,true);assert.equal(result.errorCode,'CANVAS_CONNECTION_PENDING');assert.equal(result.browserRequestId,'opened-once');
});
