import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {isImageConcurrency,imageConcurrencyLabel,imagePoolFull} from './concurrency.mjs';

test('a saved concurrency change updates the badge even while a canvas poll is still waiting',async()=>{
  const source=(await readFile(new URL('./node.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/,'');
  const elements=new Map(),requests=[];
  const element=id=>{
    if(!elements.has(id))elements.set(id,{value:'',textContent:'',hidden:false,disabled:false,firstChild:{textContent:''},addEventListener(){},setAttribute(){},focus(){}});
    return elements.get(id);
  };
  const c={isImageConcurrency,imageConcurrencyLabel,imagePoolFull,URL,location:{href:'http://127.0.0.1/gpt-image/node?canvasUrl=https%3A%2F%2Frhtv.runninghub.cn%2Fproject%2Fcanvas%2F123&nodeId=fixture'},
    document:{querySelector:()=>({content:'fixture-token'}),getElementById:element,querySelectorAll:()=>[]},
    localStorage:{getItem:()=>null},parent:{postMessage(){}},window:{addEventListener(){}},setInterval(){},setTimeout(){},clearTimeout(){},
    fetch:async(path,init)=>{
      requests.push({path,body:init.body});
      if(path==='/gpt-image/node/state')return new Promise(()=>{});
      assert.equal(path,'/gpt-image/settings');
      return {ok:true,json:async()=>({concurrency:{maxConcurrentImages:null,updatedAt:2,runningImages:0,queuedImages:0}})};
    }};
  runInNewContext(source+`\nthis.testUI={start(){state={jobs:[],concurrency:{maxConcurrentImages:4,updatedAt:1,runningImages:0,queuedImages:0}};connected=true;controls();},save:saveConcurrency};`,c);
  c.testUI.start();assert.match(element('connection').textContent,/最多 4 张/);
  await c.testUI.save(null);
  assert.equal(element('connection').textContent,'Codex 已连接 · 并行不限');
  assert.equal(element('concurrency').value,'unlimited');
  assert.match(element('concurrency-state').textContent,/不限并行 · 已保存/);
  assert.match(element('generate').firstChild.textContent,/开始生成/);
  assert.equal(requests.length,2);assert.equal(JSON.parse(requests[1].body).maxConcurrentImages,null);
});
