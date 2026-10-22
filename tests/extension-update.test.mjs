import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {EXTENSION_FILES} from '../server/build-info.mjs';
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
function fixture({installed='0.9.0',disk='0.9.1',server='0.9.1',idle=true,build=null}={}){
 let reloads=0,stops=0,files="old";const listen={addListener(){}};
 const context=vm.createContext({crypto:webcrypto,TextEncoder,importScripts(){},setTimeout,clearTimeout,AbortSignal,URL,URLSearchParams,
  RHCanvasSitePolicy:{origins:[]},createRHBrowserPump:()=>({wake:async()=>{},stop:()=>stops++}),
  chrome:{runtime:{onMessage:listen,onStartup:listen,onInstalled:listen,getManifest:()=>({version:installed}),getURL:p=>'chrome-extension://fixture/'+p,reload:()=>reloads++},alarms:{create(){},onAlarm:listen}},
  fetch:async url=>({ok:true,json:async()=>String(url).includes('/browser/update')?{version:server,reloadAllowed:idle,fingerprint:build}:{version:disk},text:async()=>files})
 });vm.runInContext(source,context);return {ready:()=>vm.runInContext('activeBuild',context),setFiles:value=>{files=value;},check:()=>vm.runInContext('checkInstalledUpdate()',context),result:()=>({reloads,stops})};
}
test('extension reloads only when its disk files match the ready bridge',async()=>{
 const f=fixture();await f.check();assert.deepEqual(f.result(),{reloads:1,stops:1});
});
test('extension does not reload busy, unrelated-folder, or already-current installs',async()=>{
 for(const options of [{idle:false},{disk:'0.9.0'},{installed:'0.9.1'},{disk:'0.9.2'}]){const f=fixture(options);await f.check();assert.deepEqual(f.result(),{reloads:0,stops:0});}
});

test('same-version extension fixes reload once only after idle and matching disk fingerprint',async()=>{
 const hash=createHash('sha256').update(JSON.stringify(EXTENSION_FILES.map(n=>[n,'new']))).digest('hex');
 const f=fixture({installed:'0.9.1',build:hash});await f.ready();await f.check();assert.equal(f.result().reloads,0);f.setFiles('new');await f.check();assert.equal(f.result().reloads,1);
 const busy=fixture({installed:'0.9.1',build:hash,idle:false});await busy.ready();busy.setFiles('new');await busy.check();assert.equal(busy.result().reloads,0);
});
