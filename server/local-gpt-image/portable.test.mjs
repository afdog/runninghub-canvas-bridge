import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexRpc,codexEnvironment} from './rpc.mjs';
import {ImageCanvas} from './canvas.mjs';

test('portable Codex environment preserves required platform paths without forwarding API keys',()=>{
  const env=codexEnvironment({PATH:'/test/bin',HOME:'/test/home',CODEX_HOME:'/test/codex',APPDATA:'C:/test/appdata',SystemRoot:'C:/Windows',OPENAI_API_KEY:'fixture-secret',GITHUB_TOKEN:'fixture-token'});
  assert.ok(env.PATH.includes('/test/bin'));assert.equal(env.CODEX_HOME,'/test/codex');assert.equal(env.APPDATA,'C:/test/appdata');assert.equal(env.SystemRoot,'C:/Windows');
  assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.GITHUB_TOKEN,undefined);
  assert.equal(new CodexRpc({binary:'/test/custom-codex'}).binary,'/test/custom-codex');
});
test('image canvas can select the connected browser automatically or honor an explicit adapter',async()=>{
  const canvasUrl='https://rhtv.runninghub.cn/project/canvas/123';
  for(const browserSource of ['', 'browser-extension','codex-browser']){
    const c=new ImageCanvas({browserSource});let input;
    c.call=async(name,args)=>{assert.equal(name,'rh_open_canvas');input=args;return {scopeId:'scope'};};
    await c.open(canvasUrl);assert.equal(input.canvasUrl,canvasUrl);assert.equal(input.intent,'connect');
    if(browserSource)assert.equal(input.browserSource,browserSource);else assert.equal(Object.hasOwn(input,'browserSource'),false);
  }
  assert.throws(()=>new ImageCanvas({browserSource:'invalid-browser'}),/Invalid/);
});
