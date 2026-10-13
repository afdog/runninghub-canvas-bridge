import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';import {createTunnelSupervisor,readTunnelHealth,tunnelPollState} from '../scripts/tunnel-watchdog.mjs';
test('tunnel supervisor reconnects dead processes with backoff and leaves healthy or uncertain processes alone',async()=>{
 let time=0,connections=0,current={process_running:false},fail=false;
 const watcher=createTunnelSupervisor({now:()=>time,status:async()=>{if(fail)throw Error();return current;},connect:async()=>{connections++;}});
 await watcher.tick();assert.equal(connections,1);await watcher.tick();assert.equal(connections,1);time=16000;await watcher.tick();assert.equal(connections,2);
 current={process_running:true,healthy:false,ready:false};time=600000;await watcher.tick();assert.equal(connections,2);
 current={process_running:true,healthy:true,ready:true};await watcher.tick();current={process_running:false};await watcher.tick();assert.equal(connections,3);
 fail=true;time+=100000;await watcher.tick();assert.equal(connections,3);
});

function health(time,overrides={}){return {live:true,ready:true,snapshot_at:new Date(time).toISOString(),components:{'control-plane':{status:'ok',state:'polling',details:{last_success:new Date(time-5000).toISOString(),consecutive_failures:0,deadline_seconds:15,...overrides}}}};}
test('live poll health distinguishes proxy backoff, stale snapshots and a stalled poll from local readiness',()=>{
 const time=200000;
 assert.equal(tunnelPollState(health(time),time),'polling');
 assert.equal(tunnelPollState(health(time,{consecutive_failures:1}),time),'poll-degraded');
 assert.equal(tunnelPollState(health(time,{last_success:new Date(time-90000).toISOString()}),time),'poll-stalled');
 assert.equal(tunnelPollState(health(time-31000),time),'poll-health-unavailable');
 assert.equal(tunnelPollState({live:true,ready:true},time),'poll-health-unavailable');
});
test('degraded cloud health is visible and does not restart a running runtime or overlap ticks',async()=>{
 const time=200000,states=[];let connections=0,current=health(time,{consecutive_failures:1}),release;
 const watcher=createTunnelSupervisor({now:()=>time,status:async()=>({process_running:true,healthy:true,ready:true,health_snapshot:current}),connect:async()=>{connections++;},report:e=>states.push(e.state)});
 await watcher.tick();assert.deepEqual(states,['poll-degraded']);assert.equal(connections,0);
 current=health(time);await watcher.tick();assert.equal(states.at(-1),'polling');
 const gate=new Promise(r=>release=r),blocked=createTunnelSupervisor({status:async()=>{await gate;return {process_running:false};},connect:async()=>{connections++;}});
 const first=blocked.tick();assert.equal(blocked.tick(),first);release();await first;assert.equal(connections,1);
});
test('live health reader uses bounded loopback requests and refuses remote hosts, credentials and redirects',async t=>{
 const expected=health(Date.now()),seen=[];
 const server=createServer((req,res)=>{seen.push(req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(expected));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.deepEqual(await readTunnelHealth({ui_url:base+'/ui'}),expected);assert.deepEqual(seen,['/health?details=true']);
 let requests=0;const fetchImpl=async()=>{requests++;throw Error();};
 assert.equal(await readTunnelHealth({ui_url:'https://example.com/ui'},{fetchImpl}),null);
 assert.equal(await readTunnelHealth({ui_url:'http://user:secret@127.0.0.1/ui'},{fetchImpl}),null);assert.equal(requests,0);
 const redirect=createServer((req,res)=>{res.writeHead(302,{Location:base+'/ui'});res.end();});redirect.listen(0,'127.0.0.1');await once(redirect,'listening');t.after(()=>redirect.close());
 assert.equal(await readTunnelHealth({ui_url:`http://127.0.0.1:${redirect.address().port}/ui`}),null);assert.equal(seen.length,1);
 assert.equal(await readTunnelHealth({ui_url:base},{fetchImpl:async()=>new Response('x'.repeat(256*1024+1))}),null);
});
