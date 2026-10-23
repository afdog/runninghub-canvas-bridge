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

function recoverable(time,{active=0,depth=0,delivery=0,lastSuccess=1000,instance='runtime-a'}={}){
 const h=health(time,{last_success:new Date(lastSuccess).toISOString(),consecutive_failures:5});h.runtime={instance_id:instance,started_at:new Date(0).toISOString()};
 h.components.dispatcher={details:{active}};h.components.queue={details:{depth}};h.components['response-delivery']={details:{in_progress:delivery}};return h;
}
test('confirmed stale idle tunnel stops the old alias before reconnect, with serialized ticks and a retry ceiling',async()=>{
 let time=200000,alive=true,stops=0,connections=0,instance=0,healthy=false;const events=[];
 const watcher=createTunnelSupervisor({now:()=>time,status:async()=>({process_running:alive,healthy:true,ready:true,health_snapshot:healthy?health(time):recoverable(time,{instance:'r-'+instance})}),stop:async()=>{stops++;alive=false;},connect:async()=>{assert.equal(alive,false);connections++;instance++;alive=true;},canRestart:async()=>true,report:e=>events.push(e.state)});
 await watcher.tick();assert.equal(stops,0);time+=30000;await Promise.all([watcher.tick(),watcher.tick()]);assert.equal(stops,1);assert.equal(connections,1);
 for(let i=0;i<8;i++){time+=65000;await watcher.tick();}assert.equal(stops,3);assert.equal(connections,3);assert.equal(events.at(-1),'restart-limit-reached');
 healthy=true;await watcher.tick();assert.equal(events.at(-1),'polling');healthy=false;time+=120000;await watcher.tick();time+=31000;await watcher.tick();assert.equal(stops,4);
});
test('uncertain health, recent network failures and busy cloud or bridge work never trigger a restart',async()=>{
 let time=200000,stops=0,current=recoverable(time),idle=true;const watcher=createTunnelSupervisor({now:()=>time,status:async()=>({process_running:true,healthy:true,ready:true,health_snapshot:current}),stop:async()=>{stops++;},connect:async()=>assert.fail('must not connect'),canRestart:async()=>idle});
 for(const options of [{active:1},{depth:1},{delivery:1}]){current=recoverable(time,options);await watcher.tick();time+=31000;current=recoverable(time,options);await watcher.tick();}
 current=recoverable(time);idle=false;await watcher.tick();time+=31000;current=recoverable(time);await watcher.tick();assert.equal(stops,0);
 idle=true;current=recoverable(time,{lastSuccess:time-10000});await watcher.tick();time+=60000;current=recoverable(time,{lastSuccess:time-10000});await watcher.tick();
 current={};time+=600000;await watcher.tick();assert.equal(stops,0);
});
test('a recovered or replaced runtime during idle checks is not stopped; failed stop never starts a duplicate',async()=>{
 let time=200000,reads=0,stops=0,connections=0;const watcher=createTunnelSupervisor({now:()=>time,status:async()=>{reads++;return {process_running:true,healthy:true,ready:true,health_snapshot:reads===3?health(time):recoverable(time)};},stop:async()=>{stops++;},connect:async()=>{connections++;},canRestart:async()=>true});
 await watcher.tick();time+=31000;await watcher.tick();assert.equal(stops,0);
 reads=100;time+=31000;await watcher.tick();time+=31000;await watcher.tick();assert.equal(stops,1);assert.equal(connections,0);
});
test('sleep/wake gap alone is not a restart signal and a dead runtime keeps bounded reconnect backoff',async()=>{
 let time=200000,current=health(time),connections=0,alive=true;const watcher=createTunnelSupervisor({now:()=>time,status:async()=>({process_running:alive,healthy:true,ready:true,health_snapshot:current}),stop:async()=>assert.fail('healthy wake must not stop'),connect:async()=>{connections++;},canRestart:async()=>true});
 await watcher.tick();time+=3600000;current=health(time);await watcher.tick();assert.equal(connections,0);alive=false;await watcher.tick();await watcher.tick();assert.equal(connections,1);
});
