import test from 'node:test';
import assert from 'node:assert/strict';
import '../server/canvas-features.js';
import '../server/production-features.js';
const P=globalThis.RHProductionFeatures;
const snapshot=()=>({nodes:[{id:'outer',type:'rh-ai',data:{instanceType:'plus',apiKeyMode:'standard',generateNum:1,aiApp:{id:'app',inputNodes:[
 {nodeId:'263',fieldName:'text',fieldType:'STRING',fieldValue:'OLD_PROMPT'},
 {nodeId:'10',fieldName:'duration',fieldType:'INT',fieldValue:'12'},
 {nodeId:'11',fieldName:'ref',fieldType:'IMAGE',fieldValue:'https://example.test/a.png',binding:{sourceNodeId:'image'}},
 {nodeId:'12',fieldName:'optional',fieldType:'VIDEO',fieldValue:'None'},
 {nodeId:'13',fieldName:'literal',fieldType:'IMAGE',fieldValue:'https://example.test/literal.png'}
]}}},{id:'image',type:'rh-image',data:{imageUrl:'https://example.test/a.png'}}],edges:[{id:'ref-edge',source:'image',target:'outer'}]});
const check=(s,expected)=>P.appPreflight(s,'outer',expected);
const has=(r,code)=>r.expectationErrors.some(e=>e.code===code);
test('native expected prompt validates persisted data and returns precise mismatch without mutation',async()=>{
 const s=snapshot(),before=structuredClone(s),tools=P.create({readSnapshot:async()=>s});
 const r=await tools.appPreflight({nodeId:'outer',expected:{prompt:'NEW_PROMPT'}});
 assert.equal(r.ok,false);assert.equal(r.digest,null);assert.ok(has(r,'APP_EXPECTED_PROMPT_MISMATCH'));assert.equal(r.validationState,'saved');assert.equal(r.resolvedNode.data.aiApp.inputNodes[0].fieldValue,'OLD_PROMPT');assert.deepEqual(s,before);
 assert.equal((await check(s,{prompt:'OLD_PROMPT'})).ok,true);
});
test('native expectations distinguish internal input identity, exact values and supported saved settings',async()=>{
 const s=snapshot(),inputs=[{nodeId:'263',fieldName:'text',value:'OLD_PROMPT',sourceNodeId:null},{nodeId:'10',fieldName:'duration',value:'12'}];
 assert.equal((await check(s,{appInputs:inputs,params:{instanceType:'plus',apiKeyMode:'standard',generateNum:1}})).ok,true);
 assert.equal((await check(s,{params:{inputs}})).ok,true);
 assert.ok(has(await check(s,{appInputs:[{nodeId:'outer',fieldName:'prompt',value:'wrong'}]}),'APP_EXPECTED_INPUT_UNKNOWN'));
 assert.ok(has(await check(s,{appInputs:[{nodeId:'10',fieldName:'duration',value:12}]}),'APP_EXPECTED_VALUE_MISMATCH'));
 assert.ok(has(await check(s,{params:{instanceType:'default'}}),'APP_EXPECTED_PARAMETER_MISMATCH'));
 assert.ok(has(await check(s,{params:{cleanupUnusedInputs:true}}),'APP_EXPECTED_UNSUPPORTED'));
});
test('multiple text inputs require an exact prompt locator, never a label guess',async()=>{
 const s=snapshot();s.nodes[0].data.aiApp.inputNodes.push({nodeId:'264',fieldName:'negative',fieldType:'STRING',fieldValue:'NEGATIVE'});
 assert.ok(has(await check(s,{prompt:'OLD_PROMPT'}),'APP_EXPECTED_PROMPT_AMBIGUOUS'));
 assert.equal((await check(s,{prompt:'OLD_PROMPT',promptField:{nodeId:'263',fieldName:'text'}})).ok,true);
 assert.ok(has(await check(s,{prompt:'OLD_PROMPT',promptField:{nodeId:'10',fieldName:'duration'}}),'APP_EXPECTED_PROMPT_INVALID'));
 assert.ok(has(await check(s,{promptField:{nodeId:'263',fieldName:'text'}}),'APP_EXPECTED_PROMPT_REQUIRED'));
});
test('references check the complete resolved media mapping and actual binding identity',async()=>{
 const s=snapshot(),good=(await check(s)).references;assert.equal(good.length,2);assert.equal(good[1].sourceNodeId,null);
 assert.equal((await check(s,{references:good})).ok,true);
 assert.ok(has(await check(s,{references:good.slice(0,1)}),'APP_EXPECTED_REFERENCES_MISMATCH'));
 assert.ok(has(await check(s,{references:good.map(r=>({...r,sourceNodeId:'different'}))}),'APP_EXPECTED_REFERENCES_MISMATCH'));
 assert.ok(has(await check(s,{appInputs:[{nodeId:'11',fieldName:'ref',sourceNodeId:null}]}),'APP_EXPECTED_BINDING_MISMATCH'));
 assert.equal((await check(s,{appInputs:[{nodeId:'11',fieldName:'ref',sourceNodeId:'image',value:good[0].url}]})).ok,true);
 s.edges=[];assert.equal((await check(s,{references:good})).ok,false);
});
test('expected values use resolved connected text and media rather than stale literal fields',async()=>{
 const s=snapshot();s.nodes.push({id:'text',type:'rh-text',data:{text:'LIVE_TEXT'}});s.edges.push({id:'text-edge',source:'text',target:'outer'});s.nodes[0].data.aiApp.inputNodes[0].binding={sourceNodeId:'text'};s.nodes[1].data.imageUrl='https://example.test/new.png';
 assert.equal((await check(s,{prompt:'LIVE_TEXT',appInputs:[{nodeId:'11',fieldName:'ref',value:'https://example.test/new.png',sourceNodeId:'image'}]})).ok,true);
 assert.ok(has(await check(s,{prompt:'OLD_PROMPT'}),'APP_EXPECTED_PROMPT_MISMATCH'));
 assert.equal(s.nodes[0].data.aiApp.inputNodes[0].fieldValue,'OLD_PROMPT');
});
test('unsupported, malformed, duplicate and conflicting native expectations cannot silently pass',async()=>{
 for(const expected of [null,[],{futureField:true},{appInputs:null},{appInputs:[]},{appInputs:[{nodeId:'263',fieldName:'text'}]},{appInputs:[{nodeId:'263',fieldName:'text',value:{text:'OLD_PROMPT'}}]},{appInputs:[{nodeId:'263',fieldName:'text',value:'OLD_PROMPT',extra:true}]},{references:[{parameter:'263:text',url:'https://example.test/a.png'}]},{params:null},{appInputs:[{nodeId:'263',fieldName:'text',value:'OLD_PROMPT'}],params:{inputs:[]}}]){
  assert.equal((await check(snapshot(),expected)).ok,false,JSON.stringify(expected));
 }
 const input={nodeId:'263',fieldName:'text',value:'OLD_PROMPT'};assert.ok(has(await check(snapshot(),{appInputs:[input,input]}),'APP_EXPECTED_INPUT_DUPLICATE'));
 const s=snapshot();s.nodes[0].data.aiApp.inputNodes.push({...s.nodes[0].data.aiApp.inputNodes[0]});assert.ok(has(await check(s,{appInputs:[input]}),'APP_EXPECTED_INPUT_AMBIGUOUS'));
});
