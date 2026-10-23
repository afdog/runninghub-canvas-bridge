import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test("local HTTP bridge restricts origins, commands, and stale/incorrect client routing", async (t) => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const archiveRoot=await mkdtemp(join(tmpdir(),'rh-http-test-'));
  t.after(()=>rm(archiveRoot,{recursive:true,force:true}));
  const child = spawn(process.execPath, ["server/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, RH_ARCHIVE_DIR:archiveRoot,RH_HISTORY_SYNC_DIR:join(archiveRoot,'history'),RH_MEDIA_OPERATIONS_DIR:join(archiveRoot,'media'), RH_BRIDGE_PORT: String(port), RH_BRIDGE_ALLOW_WRITES: "0", RH_BRIDGE_ALLOW_GENERATION: "0", RH_BRIDGE_ACCESS_FILE: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } });
  await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Bridge exited before ready"); })]);
  const base = `http://127.0.0.1:${port}`;
  const origin = "https://www.runninghub.ai";
  const post = (path, value, headers = {}) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value)
  });
  assert.equal((await fetch(base + "/health", { headers: { Origin: "https://evil.test" } })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(base + "/health", { headers: { Host: "evil.test" } }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    req.on("error", reject); req.end();
  });
  assert.equal(invalidHostStatus, 403);
  const health = await fetch(base + "/health", { headers: { Origin: origin } });
  assert.equal(health.headers.get("access-control-allow-origin"), origin);
  assert.equal((await health.json()).access.generationEnabled, false);
  assert.equal((await post("/command", { type: "canvas.summary" }, { Origin: origin })).status, 403);
  assert.equal((await fetch(base + "/events", { headers: { Origin: origin } })).status, 403);
  const lease='00000000-0000-4000-8000-000000000000';
  assert.equal((await post('/update/maintenance',{lease},{Origin:origin})).status,403);
  assert.equal((await post('/update/maintenance',{lease})).status,200);
  assert.equal((await post('/command',{type:'canvas.summary'})).status,503);
  assert.equal((await (await fetch(base+'/health')).json()).update.maintenance,true);
  await post('/update/maintenance',{lease,action:'release'});
  assert.equal((await (await fetch(base+'/health')).json()).update.maintenance,false);
  const accountJob=await (await post('/browser/jobs',{action:'listCanvases',requestId:'receipt-http-boundary'})).json();
  const leased=await (await fetch(base+'/browser/poll?waitMs=0')).json();
  const browserWaiting=fetch(base+'/browser/result?id='+accountJob.id+'&waitMs=3000');
  assert.equal((await post('/browser/result',{id:accountJob.id,lease:leased.lease,result:{canvases:[],complete:true}})).status,200);
  assert.equal((await (await browserWaiting).json()).state,'complete');
  const rejected=await post('/browser/result',{id:accountJob.id,lease:'foreign',result:{canvases:[]}});assert.equal(rejected.status,409);const retired=await rejected.json();assert.equal(retired.id,accountJob.id);assert.equal(retired.receiptDisposition,'retired');
  assert.equal((await (await fetch(base+'/browser/result?id='+accountJob.id)).json()).state,'complete');
  const opening={action:'openCanvas',canvasUrl:origin+'/project/canvas/opening',requestId:'open-first-alias'};
  const openJob=await (await post('/browser/jobs',opening)).json();
  const openShared=await (await post('/browser/jobs',{...opening,requestId:'open-second-alias'})).json();assert.equal(openShared.id,openJob.id);
  const {browserRequestId}=await import('../server/request-identity.mjs');
  const alias=browserRequestId({...opening,requestId:'open-second-alias'});
  const openLease=await (await fetch(base+'/browser/poll?waitMs=0')).json();
  const started=Date.now(),aliasWait=fetch(base+'/browser/result?id='+alias+'&waitMs=8000');
  await new Promise(r=>setTimeout(r,30));
  await post('/browser/result',{id:openJob.id,lease:openLease.lease,result:{ok:true,reused:false}});
  assert.equal((await (await aliasWait).json()).state,'complete');assert.ok(Date.now()-started<4000,'shared receipt wakes without waiting for the timeout');
  const runtime = await (await fetch(base + "/runtime-version")).json();
  const href = origin + "/project/canvas/fixture";
  assert.equal((await post("/events", { kind: "bridge.installed", clientId: "fixture-client", href, runtimeVersion: runtime.version }, { Origin: origin })).status, 200);
  assert.equal((await post("/events", { clientId: "foreign", href: "https://evil.test/project/canvas/fixture" })).status, 400);
  const denied = await post("/command", { type: "canvas.updateNodeText" });
  assert.equal((await denied.json()).errorCode, "READ_ONLY");
  assert.equal((await (await post("/command", { type: "canvas.runNode" })).json()).errorCode, "GENERATION_DISABLED");
  assert.equal((await (await post("/command", { type: "canvas.summary", clientId: "missing-client" })).json()).errorCode, "NO_PAGE_CLIENT");
  const command = { id: "unique-request-1", type: "canvas.summary", clientId: "fixture-client" };
  const queued = await (await post("/command", command)).json();
  assert.equal(queued.clientId, "fixture-client");
  assert.equal((await (await post("/command", command)).json()).duplicate, true);
  assert.equal((await (await post("/command", { ...command, type: "canvas.getElement" })).json()).errorCode, "REQUEST_ID_CONFLICT");
  const commands = await (await fetch(base + "/commands?clientId=fixture-client&href=" + encodeURIComponent(href), { headers: { Origin: origin } })).json();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "canvas.summary");
  assert.equal((await (await fetch(base + "/commands?clientId=fixture-client&href=" + encodeURIComponent(href), { headers: { Origin: origin } })).json()).length, 0);
  const waitStarted = Date.now();
  const pendingPoll = fetch(base + "/commands?clientId=fixture-client&href=" + encodeURIComponent(href) + "&waitMs=3000", { headers: { Origin: origin } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await post("/command", { id: "long-poll-1", type: "canvas.summary", clientId: "fixture-client" });
  const woke = await (await pendingPoll).json();
  assert.equal(woke.length, 1);
  assert.equal(woke[0].id, "long-poll-1");
  assert.ok(Date.now() - waitStarted < 2000);
  assert.equal((await fetch(base + "/commands?clientId=fixture-client&href=" + encodeURIComponent("https://rhtv.runninghub.cn/projects/canvas/fixture"), { headers: { Origin: origin } })).status, 403);
  assert.equal((await post("/access", { canvasUrl: href, allowWrites: true }, { Origin: origin })).status, 403);
  assert.equal((await post("/access", { canvasUrl: origin + "/project/canvas/other", allowWrites: true })).status, 409);
  const access = await (await post("/access", { canvasUrl: href, allowWrites: true })).json();
  assert.equal(access.access.allowWrites, true);
  assert.equal(access.access.canvasId, "fixture");
  const result = { href, clientId: "fixture-client", kind: "command.result", commandId: queued.id, ok: true, result: { counts: { nodes: 2 } } };
  const waitingResult=fetch(base+'/result?id='+queued.id+'&waitMs=3000');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await post("/events", result, { Origin: origin })).status, 200);
  assert.equal((await (await waitingResult).json()).commandId,queued.id);
  assert.equal((await (await fetch(base + "/result?id=" + queued.id)).json()).result.counts.nodes, 2);
  const session=async allowWrites=>(await (await post('/sessions',{canvasUrl:href,allowWrites})).json()).sessionId;
  const writer=await session(true),reader=await session(false);
  const resolved=await (await fetch(base+'/sessions?id='+writer+'&resolve=1')).json();assert.equal(resolved.target.clientId,'fixture-client');
  const builds=await (await fetch(base+'/build-info')).json();assert.equal(builds.backend.needsRestart,false);assert.match(builds.extension.expected.fingerprint,/^[a-f0-9]{64}$/);
  assert.ok(writer);assert.notEqual(writer,reader);
  assert.equal((await (await fetch(base+'/sessions?id='+writer)).json()).access.allowWrites,true);
  assert.equal((await (await fetch(base+'/sessions?id='+reader)).json()).access.allowWrites,false);
  assert.equal((await (await fetch(base+'/runtime-version')).json()).version,runtime.version,'scope changes must not reload every page');
  const edit={id:'edit-one',type:'canvas.updateNodeParams',clientId:'fixture-client',sessionId:writer};
  assert.equal((await post('/command',edit)).status,200);
  assert.equal((await (await post('/command',{...edit,id:'denied',sessionId:reader})).json()).errorCode,'READ_ONLY');
  // Legacy access changes cannot revoke a selected session's writes.
  await post('/access',{canvasUrl:href,allowWrites:false});
  await post('/command',{...edit,id:'edit-two'});
  const poll=async()=>(await (await fetch(base+'/commands?clientId=fixture-client&href='+encodeURIComponent(href),{headers:{Origin:origin}})).json());
  const first=await poll();assert.equal(first.length,1);assert.equal(first[0].id,'edit-one');assert.equal(first[0].access.allowWrites,true);
  assert.equal((await poll()).length,0);
  assert.equal((await post('/events',{...result,commandId:'edit-one',clientId:'intruder'},{Origin:origin})).status,409);
  assert.equal((await poll()).length,0);
  await post('/events',{...result,commandId:'edit-one'},{Origin:origin});
  assert.equal((await poll())[0].id,'edit-two');
  await post('/events',{...result,commandId:'edit-two'},{Origin:origin});
  assert.equal((await (await post('/command',{...edit,id:'expired-session',sessionId:'missing'})).json()).errorCode,'SESSION_EXPIRED');

  // Two tabs on the same canvas must share the mutation lock.
  await post('/events',{href,kind:'bridge.installed',clientId:'second-tab',runtimeVersion:runtime.version},{Origin:origin});
  const pinned=(await (await post('/sessions',{canvasUrl:href,allowWrites:false,clientId:'fixture-client'})).json()).sessionId;
  assert.equal((await (await post('/command',{type:'canvas.summary',clientId:'second-tab',sessionId:pinned})).json()).errorCode,'SESSION_CLIENT_MISMATCH');
  const repinned=await (await post('/sessions',{canvasUrl:href,allowWrites:false,clientId:'second-tab',sessionId:pinned})).json();
  assert.notEqual(repinned.sessionId,pinned);
  assert.equal((await (await fetch(base+'/sessions?id='+pinned)).json()).access.clientId,'fixture-client');

  await post('/command',{...edit,id:'tab-one'});
  await post('/command',{...edit,id:'tab-two',clientId:'second-tab'});
  assert.equal((await poll())[0].id,'tab-one');
  const secondPoll=async(waitMs=0)=>(await (await fetch(base+'/commands?clientId=second-tab&href='+encodeURIComponent(href)+'&waitMs='+waitMs,{headers:{Origin:origin}})).json());
  assert.equal((await secondPoll()).length,0);
  const wakeStarted=Date.now(),waitingSecond=secondPoll(3000);
  await new Promise(resolve=>setTimeout(resolve,100));
  await post('/events',{...result,commandId:'tab-one'},{Origin:origin});
  assert.equal((await waitingSecond)[0].id,'tab-two');
  assert.ok(Date.now()-wakeStarted<2000,'other tab should wake before the long poll deadline');
  const unknown={...result,clientId:'second-tab',commandId:'tab-two',ok:false,result:undefined,submissionState:'unknown',errorCode:'CANVAS_WRITE_OUTCOME_UNKNOWN'};
  await post('/events',unknown,{Origin:origin});
  const receipt=await (await fetch(base+'/command-record?id=tab-two')).json();
  assert.equal(receipt.record.state,'unknown');assert.equal(receipt.result.submissionState,'unknown');
  const duplicate=await (await post('/command',{...edit,id:'tab-two',clientId:'second-tab'})).json();
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.state,'unknown');assert.equal((await secondPoll()).length,0);
  await post('/command',{...edit,id:'revoked-before-dispatch'});
  await post('/sessions',{sessionId:writer,canvasUrl:href,allowWrites:false});
  assert.equal((await poll()).length,0);
  assert.equal((await (await fetch(base+'/result?id=revoked-before-dispatch')).json()).errorCode,'READ_ONLY');

});

test('HTTP command receipts and duplicate IDs survive service restart without replaying unknown commands',async t=>{
  const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const root=await mkdtemp(join(tmpdir(),'rh-restart-'));let child;
  const stop=async()=>{if(child && child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}};
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  const start=async()=>{child=spawn(process.execPath,['server/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,RH_ARCHIVE_DIR:root,RH_HISTORY_SYNC_DIR:join(root,'history'),RH_MEDIA_OPERATIONS_DIR:join(root,'media'),RH_BRIDGE_PORT:String(port),RH_BRIDGE_ALLOW_WRITES:'0',RH_BRIDGE_ALLOW_GENERATION:'0',RH_BRIDGE_ACCESS_FILE:''},stdio:['ignore','pipe','pipe']});await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('Bridge failed to start');})]);};
  await start();const base=`http://127.0.0.1:${port}`,href='https://www.runninghub.ai/project/canvas/restart';
  const post=async(path,value)=>(await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})).json();
  const get=async path=>(await fetch(base+path)).json();
  const register=async()=>{await post('/events',{kind:'bridge.installed',clientId:'restart-client',href});return (await post('/sessions',{canvasUrl:href,allowWrites:true})).sessionId;};
  let sessionId=await register();
  const command={id:'persisted-edit',type:'canvas.updateNodeParams',clientId:'restart-client',nodeId:'n',params:{prompt:'test'}};
  await post('/command',{...command,sessionId});
  assert.equal((await get('/commands?clientId=restart-client&href='+encodeURIComponent(href))).length,1);
  await post('/command',{...command,id:'never-sent',sessionId});
  await stop();await start();
  assert.equal((await get('/result?id=persisted-edit')).errorCode,'COMMAND_OUTCOME_UNKNOWN');
  assert.equal((await get('/result?id=never-sent')).errorCode,'COMMAND_NOT_DISPATCHED');
  sessionId=await register();
  const duplicate=await post('/command',{...command,sessionId});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.state,'unknown');
  assert.equal((await get('/commands?clientId=restart-client&href='+encodeURIComponent(href))).length,0);
  assert.equal((await post('/command',{...command,params:{prompt:'different'},sessionId})).errorCode,'REQUEST_ID_CONFLICT');
  await post('/command',{...command,id:'offline-unsent',type:'canvas.summary',sessionId,queueTimeoutMs:1000});
  const until=Date.now()+5000;let expired;
  do {expired=await get('/result?id=offline-unsent');if(expired)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<until);
  assert.equal(expired.errorCode,'COMMAND_EXPIRED');assert.equal(expired.submissionState,'not_submitted');assert.equal((await get('/command-record?id=offline-unsent')).record.state,'expired');

});


test('history rejection reaches queued requests at dispatch and survives restart without trusting caller overrides',async t=>{
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const root=await mkdtemp(join(tmpdir(),'rh-route-http-'));let child;
 const stop=async()=>{if(child && child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}};
 t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
 const start=async()=>{child=spawn(process.execPath,['server/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,RH_ARCHIVE_DIR:root,RH_COMMAND_DIR:join(root,'commands'),RH_HISTORY_SYNC_DIR:join(root,'history'),RH_MEDIA_OPERATIONS_DIR:join(root,'media'),RH_BRIDGE_PORT:String(port),RH_BRIDGE_ALLOW_WRITES:'0',RH_BRIDGE_ALLOW_GENERATION:'1',RH_BRIDGE_ACCESS_FILE:''},stdio:['ignore','pipe','pipe']});await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Bridge failed to start');})]);};
 await start();const base=`http://127.0.0.1:${port}`,href='https://www.runninghub.ai/project/canvas/routing';
 const post=async(path,value)=>(await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})).json();
 const get=async path=>(await fetch(base+path)).json();
 const register=async()=>{await post('/events',{kind:'bridge.installed',clientId:'route-client',href});return (await post('/sessions',{canvasUrl:href,allowWrites:true})).sessionId;};
 let sessionId=await register();const command={type:'canvas.runNode',clientId:'route-client',nodeId:'n'};
 for(const id of ['first','queued'])await post('/command',{...command,id,sessionId,historyRouteFailure:{historyId:'caller-forged'}});
 const poll=()=>get('/commands?clientId=route-client&href='+encodeURIComponent(href));
 const first=await poll();assert.equal(first.length,1);assert.equal(first[0].historyRouteFailure,null);
 await post('/events',{kind:'command.result',commandId:'first',clientId:'route-client',href,ok:false,errorCode:'HISTORY_ROUTE_CONFLICT',submissionState:'rejected',historyRoute:{historyId:'rejected-index',revision:'0'}});
 const queued=await poll();assert.equal(queued.length,1);assert.equal(queued[0].historyRouteFailure.historyId,'rejected-index');
 await post('/events',{kind:'command.result',commandId:'queued',clientId:'route-client',href,ok:false,errorCode:'HISTORY_ROUTE_CONFLICT',submissionState:'not_submitted',historyRoute:{historyId:'new-index'}});
 await stop();await start();sessionId=await register();
 await post('/command',{...command,id:'preflight',type:'canvas.preflight',sessionId});const pre=(await poll())[0];assert.equal(pre.historyRouteFailure.historyId,'rejected-index');assert.equal(pre.historyRouteFailure.requestId,'first');
 await post('/command',{...command,id:'other-node',type:'canvas.preflight',nodeId:'other',sessionId});assert.equal((await poll())[0].historyRouteFailure,null);
});
