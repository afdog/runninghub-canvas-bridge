import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
function fixture({installed='0.9.0',disk='0.9.1',server='0.9.1',idle=true}={}){
 let reloads=0,stops=0;const listen={addListener(){}};
 const context=vm.createContext({importScripts(){},setTimeout,clearTimeout,AbortSignal,URL,URLSearchParams,
  RHCanvasSitePolicy:{origins:[]},createRHBrowserPump:()=>({wake:async()=>{},stop:()=>stops++}),
  chrome:{runtime:{onMessage:listen,onStartup:listen,onInstalled:listen,getManifest:()=>({version:installed}),getURL:p=>'chrome-extension://fixture/'+p,reload:()=>reloads++},alarms:{create(){},onAlarm:listen}},
  fetch:async url=>({ok:true,json:async()=>String(url).includes('/browser/update')?{version:server,reloadAllowed:idle}:{version:disk}})
 });vm.runInContext(source,context);return {check:()=>vm.runInContext('checkInstalledUpdate()',context),result:()=>({reloads,stops})};
}
test('extension reloads only when its disk files match the ready bridge',async()=>{
 const f=fixture();await f.check();assert.deepEqual(f.result(),{reloads:1,stops:1});
});
test('extension does not reload busy, unrelated-folder, or already-current installs',async()=>{
 for(const options of [{idle:false},{disk:'0.9.0'},{installed:'0.9.1'},{disk:'0.9.2'}]){const f=fixture(options);await f.check();assert.deepEqual(f.result(),{reloads:0,stops:0});}
});
