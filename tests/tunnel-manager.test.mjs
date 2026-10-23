import test from 'node:test';import assert from 'node:assert/strict';import{resolve,join}from'node:path';
import{tunnelArguments,manageTunnel}from'../scripts/tunnel-manager.mjs';import{discoverSecureTunnel,waitTunnelBridge}from'../scripts/update-host.mjs';
const c=()=>({alias:'fixture',tunnelId:'tunnel_existing',profile:'fixture-profile',client:resolve('client.exe'),node:process.execPath,root:resolve('installed'),runtimeKeyFile:resolve('private/runtime-key'),profileDir:resolve('private/profiles')});
test('portable tunnel manager reuses existing alias/key reference and the stable installed MCP path',async()=>{
 const config=c(),args=tunnelArguments('connect',config);assert.ok(args.includes('tunnel_existing'));assert.equal(args[args.indexOf('--mcp-command')+1],JSON.stringify(config.node)+' '+JSON.stringify(join(config.root,'server/mcp.mjs')));assert.ok(args.includes('file:'+config.runtimeKeyFile));assert.ok(!args.includes('create'));
 assert.deepEqual(tunnelArguments('stop',config),['runtimes','stop','fixture','--json']);assert.throws(()=>tunnelArguments('login',config),/ACTION/);
 const calls=[];const result=await manageTunnel('connect',config,{exists:async()=>{},fetchImpl:async()=>Response.json({product:'runninghub-canvas-bridge',update:{maintenance:false}}),run:async(...args)=>{calls.push(args);return {process_running:true};}});assert.equal(result.process_running,true);assert.equal(calls.length,1);
});
test('manager does not reconnect into an update window and never requests a remote bridge',async()=>{
 const deps={exists:async()=>{},fetchImpl:async()=>Response.json({product:'runninghub-canvas-bridge',update:{maintenance:true}}),run:async()=>assert.fail('must not launch')};
 await assert.rejects(manageTunnel('connect',c(),deps),/BRIDGE_NOT_READY/);await assert.rejects(manageTunnel('connect',{...c(),bridgeUrl:'https://example.test'},deps),/LOCAL_BRIDGE_REQUIRED/);
 let touched=false;await manageTunnel('stop',c(),{fetchImpl:async()=>assert.fail('stop does not need a live bridge'),run:async()=>{touched=true;return {process_running:false};}});assert.equal(touched,true);
});
test('updater includes only a configured running tunnel owned by this installation',async()=>{
 const config={root:resolve('installed'),data:resolve('private'),node:process.execPath};let running=true,owner=config.root;
 const deps={existsFile:async()=>true,readConfig:async()=>({root:owner}),runCommand:async()=>JSON.stringify({process_running:running})};
 const [service]=await discoverSecureTunnel(config,deps);assert.equal(service.kind,'secure-tunnel');assert.equal(service.configPath,join(config.data,'chatgpt-tunnel/config.json'));
 running=false;assert.deepEqual(await discoverSecureTunnel(config,deps),[]);running=true;owner=resolve('other');assert.deepEqual(await discoverSecureTunnel(config,deps),[]);
 await assert.rejects(discoverSecureTunnel(config,{...deps,readConfig:async()=>({root:config.root}),runCommand:async()=>{throw Error('status failed');}}),/status failed/);
});

test('updater waits for bridge restart before reconnecting the tunnel, with bounded loopback reads',async()=>{
 let reads=0,sleeps=0;const deps={readConfig:async()=>({bridgeUrl:'http://127.0.0.1:18765'}),fetchImpl:async()=>{reads++;return Response.json({product:'runninghub-canvas-bridge',update:{maintenance:reads<3}});},sleep:async()=>{sleeps++;},attempts:4};
 await waitTunnelBridge('config',deps);assert.equal(reads,3);assert.equal(sleeps,2);
 await assert.rejects(waitTunnelBridge('config',{...deps,attempts:2,fetchImpl:async()=>{throw Error('offline');}}),/TUNNEL_BRIDGE_NOT_READY/);
 await assert.rejects(waitTunnelBridge('config',{...deps,readConfig:async()=>({bridgeUrl:'https://example.test'})}),/LOCAL_BRIDGE_REQUIRED/);
});
