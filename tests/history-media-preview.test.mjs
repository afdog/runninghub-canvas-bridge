import test from 'node:test';import assert from 'node:assert/strict';import '../server/history-media-preview.js';
const {install,videoUrl}=globalThis.RHHistoryMediaPreview;
test('preview accepts only actual HTTPS video paths; image thumbnails stay native',()=>{
 assert.equal(videoUrl('https://cdn.example/movie.mp4?sig=private'),'https://cdn.example/movie.mp4?sig=private');assert.equal(videoUrl('https://cdn.example/cover.jpg'),null);assert.equal(videoUrl('javascript:alert(1)'),null);assert.equal(videoUrl('http://localhost/a.mp4'),null);
});
test('preview is idempotent, stops apply-history clicks and restores DOM on cleanup',()=>{
 let callback,disconnected=false;globalThis.MutationObserver=class{constructor(fn){callback=fn;}observe(){}disconnect(){disconnected=true;}};
 const videos=[],img={style:{display:'inline'},isConnected:true,getAttribute:()=> 'https://cdn.example/movie.mp4',parentNode:{appendChild:v=>videos.push(v)}};
 const root={documentElement:{},querySelectorAll:()=>[img],createElement:()=>({style:{},listeners:{},setAttribute(){},addEventListener(k,fn){this.listeners[k]=fn;},pause(){this.paused=true;},remove(){this.removed=true;}})};
 const cleanup=install(root);assert.equal(videos.length,1);callback();assert.equal(videos.length,1);assert.equal(videos[0].src,'https://cdn.example/movie.mp4');assert.equal(videos[0].controls,true);assert.equal(img.style.display,'none');let stopped=false;videos[0].listeners.click({stopPropagation(){stopped=true;}});assert.equal(stopped,true);
 cleanup();assert.equal(disconnected,true);assert.equal(videos[0].removed,true);assert.equal(videos[0].paused,true);assert.equal(img.style.display,'inline');delete globalThis.MutationObserver;
});
