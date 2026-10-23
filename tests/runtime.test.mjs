import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {webcrypto} from "node:crypto";
const productionSource=await readFile(new URL("../server/production-features.js",import.meta.url),"utf8");
const layoutSource=await readFile(new URL('../server/layout-template.js',import.meta.url),'utf8');
const cleanupSource=await readFile(new URL('../server/canvas-cleanup.js',import.meta.url),'utf8');
const featureSource=await readFile(new URL("../server/canvas-features.js",import.meta.url),"utf8");
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { messageYjsSyncStep1 } from "y-protocols/sync";

const siteSource = await readFile(new URL("../extension/site-policy.js", import.meta.url), "utf8");
const runtimeSource = (await readFile(new URL("../server/bridge-runtime.js", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n")
  .replace('import(`${BRIDGE}/vendor/yjs.js`)', "Promise.resolve(globalThis.testDependencies)")
  .replace("  pollCommands();\n})();", "  window.testHooks = { withCanvasYjs, executeCommand, getNodeTitle, dropReadSession };\n})();");

assert.ok(runtimeSource.includes("window.testHooks ="), "Runtime test hooks must replace the live poll loop");

function fixture({ emptySchema = false, allowWrites = false, canvasId = "fixture", generationEnabled = false, apiData = {}, apiReply, dropResults = 0 } = {}) {
  const remoteDoc = new Y.Doc();
  if (!emptySchema) {
    const content = new Y.Map();
    content.set("nodes", new Y.Array()); content.set("edges", new Y.Array());
    remoteDoc.getMap("canvas").set("canvas_content", content);
  }
  const writes = [], providers = [], events = [], requests = [], payloads = [];
  class Provider {
    constructor(url, room, doc, options) {
      this.url = url; this.room = room; this.doc = doc; this.options = options;
      this.ws = { readyState: 1, bufferedAmount: 0 };
      this.handlers = new Map(); this.messageHandlers = [() => { this.syncReply = true; }];
      this._updateHandler = (update, origin) => { if (origin !== this && this.ws?.readyState === 1) { writes.push(update); Y.applyUpdate(remoteDoc, update); } };
      doc.on("update", this._updateHandler); providers.push(this);
    }
    on(name, callback) { this.handlers.set(name, callback); }
    connect() { Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(remoteDoc), this); this.handlers.get("sync")?.(true); }
    destroy() { this.destroyed = true; this.doc.off("update", this._updateHandler); }
  }
  const token = "test." + Buffer.from(JSON.stringify({ sub: "current-user", exp: 9999999999 })).toString("base64url") + ".synthetic";
  const sandbox = {
    URL, Headers, AbortSignal, console, atob, structuredClone, crypto:webcrypto, TextEncoder, setTimeout: (fn, ms) => setTimeout(fn, ms === 1200 ? 1 : ms), clearTimeout,
    location: new URL(`https://www.runninghub.ai/project/canvas/${canvasId}`),
    document: { cookie: "Rh-Accesstoken=" + token, title: "Fixture", querySelectorAll: () => [] },
    localStorage: { getItem: () => null },
    testDependencies: { Y, WebsocketProvider: Provider, decoding, messageYjsSyncStep1 },
    __RUNNINGHUB_CANVAS_BRIDGE_ACCESS__: { allowWrites, generationEnabled, canvasId: "fixture", origin: "https://www.runninghub.ai" },
    fetch: async (url, options) => {
      if (String(url).endsWith("/events")) { const event=JSON.parse(options.body); if(event.kind==='command.result'&&dropResults-->0)throw Error('lost receipt');events.push(event); return { ok: true }; }
      requests.push(String(url));
      assert.equal(options.headers.Authorization, "Bearer " + token);
      const body=options.body?JSON.parse(options.body):{};payloads.push({url:String(url),body});
      const custom=apiReply?.(new URL(url).pathname,body);if(custom)return custom;
      const data = apiData[new URL(url).pathname] ?? (String(url).endsWith('/canvas/node-history/page')?{schemaVersion:1,canvasId,nodeId:body.nodeId,historyId:null,revision:'0',resultCount:0,totalBatchCount:0,batches:[],hasNext:false}:undefined) ?? (String(url).endsWith("/canvas/task/run") ? {taskId: "fixture-task", status: "RUNNING"} : String(url).endsWith("/canvas/getCanvasDetail")
        ? { user_id: "canvas-owner-not-the-current-user" }
        : { yjsGeneration: 5, yjsGenerationRequired: true });
      return { ok: true, status: 200, json: async () => ({ code: 0, data }), text: async () => JSON.stringify({ code: 0, data }) };
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(siteSource + "\n" + featureSource + "\n" + layoutSource + "\n" + cleanupSource + "\n" + productionSource + "\n" + runtimeSource, sandbox);
  return { sandbox, writes, providers, events, remoteDoc, requests, payloads, setDropResults:n=>{dropResults=n;} };
}

test("read session uses current account, international socket and generation without updates", async () => {
  const f = fixture();
  await f.sandbox.testHooks.withCanvasYjs(({ nodes }) => assert.equal(nodes.length, 0));
  const p = f.providers[0];
  assert.equal(p.url, "wss://www.runninghub.ai/canvas/ws");
  assert.equal(p.options.params.userId, "current-user");
  assert.equal(p.options.params.generation, "5");
  assert.equal(p.options.params.readOnly, "1");
  assert.equal(p.options.disableBc, true);
  assert.equal(f.writes.length, 0);
  const input = encoding.createEncoder();
  encoding.writeVarUint(input, messageYjsSyncStep1);
  encoding.writeVarUint8Array(input, new Uint8Array([0]));
  p.messageHandlers[0](encoding.createEncoder(), decoding.createDecoder(encoding.toUint8Array(input)));
  assert.equal(p.syncReply, undefined);
  assert.ok(!p.destroyed);
  await f.sandbox.testHooks.withCanvasYjs(({ nodes }) => assert.equal(nodes.length, 0));
  assert.equal(f.providers.length, 1);
  assert.equal(f.requests.filter((url) => url.includes("getCanvasDetail")).length, 1);
  f.sandbox.testHooks.dropReadSession();
  assert.equal(p.destroyed, true);
  f.remoteDoc.destroy();
});

test("summary pages revisions and filters; repeated batch reads share one sync", async () => {
  const f = fixture({ allowWrites: true });
  const run = async (id, type, args = {}) => {
    await f.sandbox.testHooks.executeCommand({ id, type, ...args });
    return f.events.find((event) => event.commandId === id);
  };
  await run("a", "canvas.createTextNode", { config: { id: "a", title: "A", text: "one", x: 0, y: 0 } });
  await run("b", "canvas.createNode", { config: { id: "b", type: "rh-image", data: { title: "B", groupId: "g1", status: "finished", width: 640, height: 360 }, position: { x: 10, y: 20 } } });
  const page = await run("summary", "canvas.summary", { compact: true, limit: 1, offset: 0, includeRevision: true });
  assert.equal(page.ok, true, page.error);
  assert.equal(page.result.counts.matchedNodes, 2);
  assert.equal(page.result.nodes.length, 1);
  assert.equal(page.result.nodes[0].id, "a");
  assert.equal(page.result.truncated, true);
  assert.equal(page.result.nextOffset, 1);
  assert.match(page.result.nodes[0].revision, /^[a-f0-9]{64}$/);
  const next = await run("next", "canvas.summary", { compact: true, limit: 1, offset: page.result.nextOffset });
  assert.equal(next.result.nodes[0].id, "b");
  assert.equal(next.result.truncated, false);
  const filtered = await run("filtered", "canvas.summary", { types: ["rh-image"], groupId: "g1", limit: 10 });
  assert.equal(filtered.result.nodes.length, 1);
  assert.equal(filtered.result.nodes[0].groupId, "g1");
  assert.equal(filtered.result.nodes[0].width, 640);
  const readsBefore = f.providers.filter((provider) => provider.options.params.readOnly === "1").length;
  const batch = await run("batch", "canvas.getElements", { elementIds: ["a", "missing"] });
  assert.equal(batch.ok, true, batch.error);
  assert.equal(batch.result.nodes.length, 1);
  assert.deepEqual(batch.result.missing, ["missing"]);
  assert.match(batch.result.nodes[0].revision, /^[a-f0-9]{64}$/);
  await run("batch2", "canvas.getElements", { elementIds: ["a"] });
  assert.equal(f.providers.filter((provider) => provider.options.params.readOnly === "1").length, readsBefore);
  f.sandbox.testHooks.dropReadSession();
  f.remoteDoc.destroy();
});

test("continuous reads revalidate generation after 15 seconds rather than extending the TTL", async t => {
  const permission = { yjsGeneration: 5, yjsGenerationRequired: true };
  const f = fixture({ apiData: { "/canvas/checkUserIdByCanvasId": permission } });
  t.after(() => { f.sandbox.testHooks.dropReadSession(); f.remoteDoc.destroy(); });
  let now = 0;
  f.sandbox.Date = class extends Date { static now() { return now; } };
  await f.sandbox.testHooks.withCanvasYjs(() => {});
  permission.yjsGeneration = 6;
  for (let i = 1; i <= 6; i++) {
    now = i * 10000;
    await f.sandbox.testHooks.withCanvasYjs(() => {});
  }
  assert.equal(f.requests.filter(url => url.endsWith("/canvas/checkUserIdByCanvasId")).length, 4);
  assert.equal(f.providers.length, 2);
  assert.equal(f.providers[0].destroyed, true);
  assert.equal(f.providers[1].options.params.generation, "6");
});

test("a read-only socket is replaced before writing and writes still recheck platform locks", async t => {
  const permission = { yjsGeneration: 5 };
  const f = fixture({ allowWrites: true, apiData: { "/canvas/checkUserIdByCanvasId": permission } });
  t.after(() => { f.sandbox.testHooks.dropReadSession(); f.remoteDoc.destroy(); });
  await f.sandbox.testHooks.withCanvasYjs(() => {});
  await f.sandbox.testHooks.executeCommand({id:"upgrade",type:"canvas.createTextNode",config:{id:"one",text:"kept"}});
  assert.equal(f.providers[0].options.params.readOnly, "1");
  assert.equal(f.providers[0].destroyed, true);
  assert.equal(f.providers[1].options.params.readOnly, "0");
  permission.canvasLocked = true;
  await f.sandbox.testHooks.executeCommand({id:"locked",type:"canvas.updateNodeText",nodeId:"one",text:"blocked"});
  assert.match(f.events.find(e=>e.commandId==="locked").error,/locked/);
  assert.equal(f.remoteDoc.getMap("canvas").get("canvas_content").get("nodes").get(0).toJSON().data.text,"kept");
});

test("closed or undrained write sockets return unknown receipts and discard unconfirmed local state", async t => {
  for (const failure of ["closed","missing","undrained"]) {
    await t.test(failure, async t => {
      const f=fixture({allowWrites:true});
      t.after(()=>{f.sandbox.testHooks.dropReadSession();f.remoteDoc.destroy();});
      await f.sandbox.testHooks.withCanvasYjs(()=>{},{write:true});
      const p=f.providers[0];p.doc.off("update",p._updateHandler);
      let now=0;f.sandbox.Date=class extends Date{static now(){return now;}};
      const original=f.sandbox.setTimeout;
      f.sandbox.setTimeout=(fn,ms)=>ms===20?original(()=>{now+=1300;fn();},1):original(fn,ms);
      p.doc.on("update",(_update,origin)=>{
        if(origin===p)return;
        if(failure==="undrained")p.ws.bufferedAmount=100;
        else {
          if(failure==="closed")p.ws.readyState=3;else p.ws=null;
          p.handlers.get("connection-close")?.({code:1006});
        }
      });
      await f.sandbox.testHooks.executeCommand({id:"lost",type:"canvas.createTextNode",config:{id:"n",text:"not confirmed"}});
      const receipt=f.events.find(e=>e.commandId==="lost");
      assert.equal(receipt.ok,false);
      assert.equal(receipt.submissionState,"unknown");
      assert.equal(receipt.errorCode,"CANVAS_WRITE_OUTCOME_UNKNOWN");
      assert.equal(p.destroyed,true);
      await f.sandbox.testHooks.executeCommand({id:"read-after-lost",type:"canvas.summary"});
      assert.equal(f.events.find(e=>e.commandId==="read-after-lost").result.counts.nodes,0);
      assert.equal(f.writes.length,0);
    });
  }
});

test("a connected write waits for its pending socket buffer to drain", async t => {
  const f=fixture({allowWrites:true});
  t.after(()=>{f.sandbox.testHooks.dropReadSession();f.remoteDoc.destroy();});
  await f.sandbox.testHooks.withCanvasYjs(()=>{},{write:true});
  const p=f.providers[0];p.ws.bufferedAmount=10;
  let completed=false;
  const pending=f.sandbox.testHooks.executeCommand({id:"drain",type:"canvas.createTextNode",config:{id:"n",text:"kept"}}).then(()=>{completed=true;});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(completed,false);
  p.ws.bufferedAmount=0;
  await pending;
  assert.equal(f.events.find(e=>e.commandId==="drain").ok,true);
  assert.equal(f.remoteDoc.getMap("canvas").get("canvas_content").get("nodes").length,1);
});

test("schema mismatch cannot initialize or overwrite remote canvas data", async () => {
  const f = fixture({ emptySchema: true });
  await assert.rejects(f.sandbox.testHooks.withCanvasYjs(() => {}), /CANVAS_SCHEMA_UNSUPPORTED/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.providers[0].destroyed, true);
  f.remoteDoc.destroy();
});

test("writes are refused before connecting unless this exact canvas is enabled", async () => {
  const f = fixture();
  await assert.rejects(f.sandbox.testHooks.withCanvasYjs(() => {}, { write: true }), /READ_ONLY/);
  assert.equal(f.providers.length, 0);
  const other = fixture({ allowWrites: true, canvasId: "different" });
  await assert.rejects(other.sandbox.testHooks.withCanvasYjs(() => {}, { write: true }), /CANVAS_NOT_ALLOWED/);
  assert.equal(other.providers.length, 0);
  f.remoteDoc.destroy(); other.remoteDoc.destroy();
});

test("generation is refused inside the page even if the HTTP guard were bypassed", async () => {
  const f = fixture({ allowWrites: true });
  await f.sandbox.testHooks.executeCommand({ id: "generation-attempt", type: "canvas.runNode" });
  const result = f.events.find((event) => event.commandId === "generation-attempt");
  assert.equal(result.ok, false);
  assert.match(result.error, /GENERATION_DISABLED/);
  assert.equal(f.providers.length, 0);
  assert.equal(f.sandbox.testHooks.getNodeTitle({ data: { label: "User label", title: "Upload" } }), "User label");
  f.remoteDoc.destroy();
});

test("dry-run previews nodes without sending any update to the shared canvas", async () => {
  const f = fixture();
  await f.sandbox.testHooks.executeCommand({ id: "preview", type: "canvas.createTextNode", dryRun: true, config: { id: "draft", text: "草稿", x: 0, y: 0 } });
  const event = f.events.find(e => e.commandId === "preview");
  assert.equal(event.ok, true);
  assert.equal(event.result.applied, false);
  assert.equal(event.result.result.node.position.x, 0);
  assert.equal(event.result.result.node.position.y, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.remoteDoc.getMap("canvas").get("canvas_content").get("nodes").length, 0);
  f.remoteDoc.destroy();
});

test("text edits update the visible label as well as the legacy title", async () => {
  const f = fixture({ allowWrites: true });
  await f.sandbox.testHooks.executeCommand({ id: "create", type: "canvas.createTextNode", config: { id: "text-test", title: "原名", text: "保留完整对白。", x: 0, y: 0 } });
  await f.sandbox.testHooks.executeCommand({ id: "edit", type: "canvas.updateNodeText", nodeId: "text-test", title: "新名", text: "保留完整对白。" });
  assert.equal(f.events.find(e => e.commandId === "edit").ok, true);
  const node = f.remoteDoc.getMap("canvas").get("canvas_content").get("nodes").get(0).toJSON();
  assert.equal(node.data.title, "新名");
  assert.equal(node.data.label, "新名");
  assert.equal(node.data.text, "保留完整对白。");
  assert.equal(f.providers.every(p => p.options.params.readOnly === "0"), true);
  f.remoteDoc.destroy();
});

test("repeated writes reuse the open socket and flush without a fixed delay", async () => {
  const f = fixture({ allowWrites: true });
  let delayed = 0;
  const original = f.sandbox.setTimeout;
  f.sandbox.setTimeout = (fn, ms, ...args) => { if (ms === 1200) delayed += 1; return original(fn, ms, ...args); };
  await f.sandbox.testHooks.executeCommand({ id: "create", type: "canvas.createTextNode", config: { id: "n", title: "一", text: "第一版" } });
  await f.sandbox.testHooks.executeCommand({ id: "edit", type: "canvas.updateNodeText", nodeId: "n", text: "第二版" });
  await f.sandbox.testHooks.executeCommand({ id: "read", type: "canvas.getElement", elementId: "n" });
  assert.equal(f.providers.length, 1);
  assert.equal(f.providers[0].options.params.readOnly, "0");
  assert.ok(!f.providers[0].destroyed);
  assert.equal(delayed, 0);
  assert.equal(f.events.find(e => e.commandId === "read").result.element.data.text, "第二版");
  f.sandbox.testHooks.dropReadSession();
  f.remoteDoc.destroy();
});

test("generation preview never submits; enabled real run preserves node payload", async () => {
  const f = fixture({ allowWrites: true, generationEnabled: true });
  await f.sandbox.testHooks.executeCommand({id:"create",type:"canvas.createTextNode",config:{id:"run-test",text:"完整对白。"}});
  await f.sandbox.testHooks.executeCommand({id:"preview-run",type:"canvas.runNode",nodeId:"run-test",dryRun:true});
  assert.equal(f.events.find(e=>e.commandId==="preview-run").result.submitted,false);
  assert.equal(f.requests.some(url=>url.endsWith('/canvas/task/run')),false);
  await f.sandbox.testHooks.executeCommand({id:"real-run",type:"canvas.runNode",nodeId:"run-test"});
  assert.equal(f.events.find(e=>e.commandId==="real-run").result.task.taskId,"fixture-task");
  assert.equal(f.requests.filter(url=>url.endsWith('/canvas/task/run')).length,1);
  f.remoteDoc.destroy();
});

test("get-element command ID is separate from the target node ID",async()=>{
 const f=fixture({allowWrites:true});
 await f.sandbox.testHooks.executeCommand({id:'create',type:'canvas.createTextNode',config:{id:'node-a',text:'第一版'}});
 await f.sandbox.testHooks.executeCommand({id:'read-1',type:'canvas.getElement',elementId:'node-a'});
 await f.sandbox.testHooks.executeCommand({id:'edit',type:'canvas.updateNodeText',nodeId:'node-a',text:'第二版'});
 await f.sandbox.testHooks.executeCommand({id:'read-2',type:'canvas.getElement',elementId:'node-a'});
 assert.equal(f.events.find(e=>e.commandId==='read-1').result.element.data.text,'第一版');
 assert.equal(f.events.find(e=>e.commandId==='read-2').result.element.data.text,'第二版');
 f.remoteDoc.destroy();
});

test("native H3 validates reference slots and preview retains the graph without submitting", async () => {
  const f = fixture({ allowWrites: true, generationEnabled: true });
  const execute = command => f.sandbox.testHooks.executeCommand(command);
  const result = id => f.events.find(event => event.commandId === id);
  await execute({ id: "image", type: "canvas.createNode", config: { id: "reference", type: "rh-image", data: { sourceObjects: ["https://example.com/reference.png"] } } });
  await execute({ id: "video", type: "canvas.createNode", config: { id: "h3", type: "rh-video", data: {
    modelCode: "multimodal-video-rhart-video-minimax-h3-rh-enhanced-ref2va-app", subType: "multimodal-video", generateNum: 2,
    params: { prompt: "角色说：完整保留这句测试对白。", refImage1: "https://example.com/reference.png", duration: "6", aspectRatio: "16:9", resolution: "1080p" }
  } } });
  await execute({ id: "wire", type: "canvas.connectNodes", source: "reference", target: "h3" });
  await execute({ id: "preview", type: "canvas.runNode", nodeId: "h3", validateReferences: true, dryRun: true });
  assert.equal(result("preview").ok, true);
  assert.equal(result("preview").result.submitted, false);
  const graph = result("preview").result.request.canvas;
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.nodes.find(node => node.id === "h3").data.params.prompt, "角色说：完整保留这句测试对白。");
  await execute({ id: "bad-reference", type: "canvas.updateNodeParams", nodeId: "h3", params: { refImage1: "https://example.com/wrong.png" } });
  await execute({ id: "blocked", type: "canvas.runNode", nodeId: "h3", validateReferences: true });
  assert.equal(result("blocked").ok, false);
  assert.match(result("blocked").error, /without matching direct upstream/);
  await execute({ id: "clear-prompt", type: "canvas.updateNodeParams", nodeId: "h3", params: { prompt: "" } });
  await execute({ id: "empty-prompt", type: "canvas.runNode", nodeId: "h3" });
  assert.equal(result("empty-prompt").ok, false);
  assert.match(result("empty-prompt").error, /Video prompt is empty/);
  assert.equal(f.requests.some(url => url.endsWith("/canvas/task/run")), false);
  f.remoteDoc.destroy();
});

test("template clone preserves model settings, previews without mutation, and refuses native reference slots", async () => {
  const f = fixture({ allowWrites: true });
  const execute = command => f.sandbox.testHooks.executeCommand(command);
  await execute({ id: "template", type: "canvas.createNode", config: { id: "blank", type: "rh-video", data: {
    modelCode: "text-video-rhart-video-minimax-h3-rh-enhanced-t2va-app", subType: "text-video", generateNum: 2,
    params: { prompt: "", aspectRatio: "16:9", resolution: "1080p", duration: "6" }
  } } });
  const options = { type: "canvas.cloneTemplate", sourceNodeId: "blank", nodeId: "copy", title: "示例镜头草稿", x: 720, y: 300 };
  await execute({ ...options, id: "preview", dryRun: true });
  assert.equal(f.events.find(e => e.commandId === "preview").result.applied, false);
  assert.equal(f.remoteDoc.getMap("canvas").get("canvas_content").get("nodes").length, 1);
  await execute({ ...options, id: "clone" });
  const nodes = f.remoteDoc.getMap("canvas").get("canvas_content").get("nodes").toJSON();
  const copy = nodes.find(node => node.id === "copy");
  assert.equal(copy.data.generateNum, 2);
  assert.equal(copy.data.params.resolution, "1080p");
  assert.equal(copy.position.x, 720);
  assert.equal(copy.data.output, undefined);
  await execute({ id: "add-ref", type: "canvas.updateNodeParams", nodeId: "blank", params: { refAudio1: "https://example.com/dialogue.wav" } });
  await execute({ ...options, id: "reject", nodeId: "copy2" });
  assert.match(f.events.find(e => e.commandId === "reject").error, /TEMPLATE_NOT_EMPTY/);
  f.remoteDoc.destroy();
});

test('live models, output recognition and reference binding retain unrelated parameters',async()=>{
  const f=fixture({allowWrites:true,apiData:{'/canvas/model/list':[{type:'MULTIMODAL_VIDEO',modelList:[{modelCode:'test-h3',config:[{paramName:'refImage1',type:'image',paramValue:''},{paramName:'duration',type:'number',min:1,max:15,paramValue:6}]}]}]}});
  const run=async(type,args={})=>{const id='test-'+f.events.length;await f.sandbox.testHooks.executeCommand({id,type,...args});const event=f.events.find(e=>e.commandId===id);assert.equal(event.ok,true,event.error);return event.result;};
  await run('canvas.createNode',{config:{id:'source',type:'rh-ai',data:{output:[{url:'https://example.test/ref.png',mediaCategory:'image',success:true}]}}});
  await run('canvas.createNode',{config:{id:'target',type:'rh-video',data:{modelCode:'test-h3',subType:'multimodal-video',params:{prompt:'Exact full dialogue.',duration:6}}}});
  const refs=await run('canvas.inspectReferences',{nodeId:'source'});assert.equal(refs.image.length,1);assert.equal(refs.video.length,0);
  const schema=await run('canvas.modelSchema',{modelCode:'test-h3'});assert.equal(schema.models[0].parameters[1].max,15);
  await run('canvas.bindReferences',{nodeId:'target',references:[{sourceNodeId:'source',kind:'image',parameter:'refImage1'}]});
  const node=(await run('canvas.getElement',{elementId:'target'})).element;
  assert.equal(node.data.params.refImage1,'https://example.test/ref.png');assert.equal(node.data.params.duration,6);assert.equal(node.data.params.prompt,'Exact full dialogue.');
  assert.equal(f.remoteDoc.getMap('canvas').get('canvas_content').get('edges').length,1);
  assert.equal(f.requests.some(url=>url.endsWith('/task/run')),false);f.remoteDoc.destroy();
});

test('batch edit rejects stale revisions without partially changing nodes',async()=>{
  const f=fixture({allowWrites:true});
  const run=async(id,type,args={})=>{await f.sandbox.testHooks.executeCommand({id,type,...args});return f.events.find(e=>e.commandId===id);};
  for(const id of ['one','two'])await run(id,'canvas.createTextNode',{config:{id,title:id,text:'original'}});
  const a=(await run('read-a','canvas.getElement',{elementId:'one'})).result;
  const b=(await run('read-b','canvas.getElement',{elementId:'two'})).result;
  await run('concurrent','canvas.updateNodeParams',{nodeId:'two',params:{prompt:'newer edit'}});
  const event=await run('batch','canvas.batchUpdate',{updates:[{nodeId:'one',title:'changed'},{nodeId:'two',title:'changed'}],expectedRevisions:{one:a.revision,two:b.revision}});
  assert.equal(event.ok,false);assert.match(event.error,/EDIT_CONFLICT/);
  assert.equal((await run('reread','canvas.getElement',{elementId:'one'})).result.element.data.title,'one');f.remoteDoc.destroy();
});

test('asset reuse creates once, preserves kind and rejects expired/unknown selection',async()=>{
  const f=fixture({allowWrites:true,apiData:{'/canvas/asset/user/folder/item/search':{records:[{id:'asset-1',nodeType:'AUDIO',url:'https://example.test/voice.wav',itemName:'Voice'}],pages:1}}});
  const run=async(id,type,args={})=>{await f.sandbox.testHooks.executeCommand({id,type,...args});return f.events.find(e=>e.commandId===id);};
  const search=await run('search','canvas.searchAssets',{keyword:'Voice'});assert.equal(search.ok,true);
  const token=search.result.records[0].assetToken;
  const added=await run('add','canvas.addAsset',{assetToken:token,x:10,y:20});assert.equal(added.ok,true,added.error);assert.equal(added.result.result.mediaKind,'audio');
  const reused=await run('again','canvas.addAsset',{assetToken:token,x:30,y:40});assert.equal(reused.result.result.reused,true);
  assert.equal(f.remoteDoc.getMap('canvas').get('canvas_content').get('nodes').length,1);
  assert.equal((await run('bad','canvas.addAsset',{assetToken:'unknown'})).ok,false);f.remoteDoc.destroy();
});

function workflowFixture() {
  const config=[
    {paramName:'prompt',paramDataType:'string',required:true},
    {paramName:'duration',paramDataType:'string',min:4,max:15},
    {paramName:'resolution',paramDataType:'string',optionValue:[{value:'480p'},{value:'768p'}]},
    ...['refImage1','refImage2'].map(paramName=>({paramName,type:'image',paramDataType:'string'}))
  ];
  const f=fixture({allowWrites:true,generationEnabled:true,apiData:{'/canvas/model/list':[{type:'MULTIMODAL_VIDEO',modelList:[{modelCode:'model',config}]}]}});
  let seq=0;
  f.run=async(type,args={})=>{const id='workflow-'+seq++;await f.sandbox.testHooks.executeCommand({id,type,...args});return f.events.find(e=>e.commandId===id);};
  f.nodes=()=>f.remoteDoc.getMap('canvas').get('canvas_content').get('nodes').toJSON();
  f.edges=()=>f.remoteDoc.getMap('canvas').get('canvas_content').get('edges').toJSON();
  f.seed=async()=>{
    for(const id of ['a','b']) await f.run('canvas.createNode',{config:{id,type:'rh-image',data:{sourceObjects:[`https://example.test/${id}.png`]}}});
    await f.run('canvas.createNode',{config:{id:'blank',type:'rh-video',data:{modelCode:'model',subType:'multimodal-video',params:{duration:'6',resolution:'480p'}}}});
  };
  return f;
}

test('replace references removes old media slots and edges but preserves text/control connections',async t=>{
  const f=workflowFixture();t.after(()=>f.remoteDoc.destroy());await f.seed();
  await f.run('canvas.createTextNode',{config:{id:'text',text:'source words'}});
  await f.run('canvas.connectNodes',{source:'text',target:'blank'});
  await f.run('canvas.bindReferences',{nodeId:'blank',references:[{sourceNodeId:'a',kind:'image',parameter:'refImage1'},{sourceNodeId:'b',kind:'image',parameter:'refImage2'}]});
  const result=await f.run('canvas.bindReferences',{nodeId:'blank',mode:'replace',references:[{sourceNodeId:'b',kind:'image',parameter:'refImage1'}]});
  assert.equal(result.ok,true,result.error);
  const params=f.nodes().find(n=>n.id==='blank').data.params;
  assert.equal(params.refImage1,'https://example.test/b.png');assert.equal(params.refImage2,undefined);assert.equal(params.duration,'6');
  assert.deepEqual(f.edges().map(e=>e.source).sort(),['b','text']);
  const before=JSON.stringify(f.nodes());
  assert.equal((await f.run('canvas.bindReferences',{nodeId:'blank',mode:'replace',dryRun:true,references:[]})).ok,true);
  assert.equal(JSON.stringify(f.nodes()),before);
  await f.run('canvas.bindReferences',{nodeId:'blank',mode:'replace',references:[]});
  assert.deepEqual(f.edges().map(e=>e.source),['text']);
});

test('live parameter validation refuses range/type/enum/unknown keys and preflight pins exact text and graph',async t=>{
  const f=workflowFixture();t.after(()=>f.remoteDoc.destroy());await f.seed();
  for(const params of [{duration:'99'},{duration:6},{resolution:'invalid'},{invented:true}]) {
    const event=await f.run('canvas.updateNodeParams',{nodeId:'blank',params,validateParams:true});
    assert.equal(event.ok,false);assert.match(event.error,/PARAMETER_INVALID/);
  }
  await f.run('canvas.updateNodeParams',{nodeId:'blank',params:{prompt:'完整对白。'},validateParams:true});
  const mismatch=await f.run('canvas.preflight',{nodeId:'blank',expected:{prompt:'不同对白'}});
  assert.equal(mismatch.result.ok,false);
  const pre=await f.run('canvas.preflight',{nodeId:'blank',expected:{prompt:'完整对白。'}});
  assert.equal(pre.result.ok,true);assert.match(pre.result.digest,/^[a-f0-9]{64}$/);
  await f.run('canvas.updateNodeParams',{nodeId:'blank',params:{prompt:'更新对白。'},validateParams:true});
  const run=await f.run('canvas.runNode',{nodeId:'blank',expectedDigest:pre.result.digest,validateParams:true});
  assert.equal(run.ok,false);assert.match(run.error,/EDIT_CONFLICT/);
  assert.equal(f.requests.some(u=>u.endsWith('/task/run')),false);
});

test('prepare batch is all-or-nothing, preserves full prompts, previews and rejects duplicate IDs',async t=>{
  const f=workflowFixture();t.after(()=>f.remoteDoc.destroy());await f.seed();
  const shot={nodeId:'shot-1',templateNodeId:'blank',title:'First',prompt:'不要缩短——完整对白。',references:[{sourceNodeId:'a',kind:'image',parameter:'refImage1'}]};
  const invalid=await f.run('canvas.prepareShots',{shots:[shot,{...shot,nodeId:'shot-2',params:{duration:'99'}}]});
  assert.equal(invalid.ok,false);assert.equal(f.nodes().length,3);
  const preview=await f.run('canvas.prepareShots',{shots:[shot],dryRun:true});
  assert.equal(preview.ok,true,preview.error);assert.equal(f.nodes().length,3);
  const event=await f.run('canvas.prepareShots',{shots:[shot,{...shot,nodeId:'shot-2'}],layout:{x:0,y:0,gap:100,columns:2}});
  assert.equal(event.ok,true,event.error);assert.equal(f.nodes().length,5);assert.equal(f.edges().length,2);
  assert.equal(f.nodes().find(n=>n.id==='shot-1').data.params.prompt,shot.prompt);
  assert.equal((await f.run('canvas.prepareShots',{shots:[shot]})).ok,false);
  assert.equal(f.requests.some(u=>u.endsWith('/task/run')),false);
});

test('layout keeps unselected nodes fixed and avoids variable-sized obstacles',async t=>{
  const f=workflowFixture();t.after(()=>f.remoteDoc.destroy());await f.seed();
  await f.run('canvas.moveNodes',{nodeIds:['blank'],positions:{blank:{x:0,y:0}}});
  await f.run('canvas.updateNode',{nodeId:'blank',data:{width:1100,height:800}});
  const fixed=JSON.stringify(f.nodes().find(n=>n.id==='blank'));
  const event=await f.run('canvas.autoLayout',{nodeIds:['a','b'],x:0,y:0,gap:100,columns:2});
  assert.equal(event.ok,true,event.error);assert.equal(JSON.stringify(f.nodes().find(n=>n.id==='blank')),fixed);
  const selected=f.nodes().filter(n=>['a','b'].includes(n.id));
  const obstacle=JSON.parse(fixed),ow=obstacle.data.width || 420,oh=obstacle.data.height || 380;
  assert.ok(selected.every(n=>n.position.x>=obstacle.position.x+ow+100 || n.position.y>=obstacle.position.y+oh+100),JSON.stringify({obstacle,selected}));assert.notEqual(selected[0].position.x,selected[1].position.x);
});

test('AI app creation, exact inputs, preflight and dry-run do not require modelCode',async()=>{
 const f=fixture({allowWrites:true,apiData:{'/api/webapp/detail':{id:'app',name:'Test App',workflowId:'workflow',inputNodes:[{nodeId:'1',fieldName:'prompt',fieldType:'STRING',fieldValue:''},{nodeId:'2',fieldName:'duration',fieldType:'INT',fieldValue:'12',min:1,max:20}]}}});
 await f.sandbox.testHooks.executeCommand({id:'app-create',type:'canvas.createApp',appId:'app',nodeId:'app-node',x:0,y:0});
 assert.equal(f.events.find(e=>e.commandId==='app-create').ok,true);
 await f.sandbox.testHooks.executeCommand({id:'app-config',type:'canvas.configureApp',nodeId:'app-node',inputs:[{nodeId:'1',fieldName:'prompt',value:'完整台词，不压缩。'}]});
 assert.equal(f.events.find(e=>e.commandId==='app-config').ok,true);
 await f.sandbox.testHooks.executeCommand({id:'app-pre',type:'canvas.preflight',nodeId:'app-node'});
 const pre=f.events.find(e=>e.commandId==='app-pre');assert.equal(pre.ok,true);assert.equal(pre.result.ok,true);assert.match(pre.result.digest,/^[a-f0-9]{64}$/);
 await f.sandbox.testHooks.executeCommand({id:'app-run-preview',type:'canvas.runNode',nodeId:'app-node',validateParams:true,dryRun:true,expectedDigest:pre.result.digest});
 const result=f.events.find(e=>e.commandId==='app-run-preview');assert.equal(result.ok,true,result.error);assert.equal(result.result.submitted,false);assert.equal(result.result.request.canvas.nodes[0].data.aiApp.inputNodes[0].fieldValue,'完整台词，不压缩。');assert.equal(f.requests.some(r=>r.endsWith('/canvas/task/run')),false);
 const before=JSON.stringify(f.remoteDoc.toJSON());
 const frozen=JSON.parse(before).canvas.canvas_content.nodes.find(n=>n.id==='app-node');
 frozen.data.aiApp.inputNodes[0].fieldValue='old frozen prompt';
 await f.sandbox.testHooks.executeCommand({id:'stale-frozen-preview',type:'canvas.runNode',nodeId:'app-node',validateParams:true,dryRun:true,expectedDigest:pre.result.digest,expectedNode:f.sandbox.RHCanvasFeatures.canonical(frozen)});
 assert.match(f.events.find(e=>e.commandId==='stale-frozen-preview').error,/EDIT_CONFLICT: frozen processing node changed/);
 await f.sandbox.testHooks.executeCommand({id:'bad-config',type:'canvas.configureApp',nodeId:'app-node',inputs:[{nodeId:'1',fieldName:'prompt',value:'must not apply'},{nodeId:'2',fieldName:'duration',value:'100'}]});
 assert.equal(f.events.find(e=>e.commandId==='bad-config').ok,false);assert.equal(JSON.stringify(f.remoteDoc.toJSON()),before);f.remoteDoc.destroy();
});


test('generation payload uses the exact native history index and preserves the live current output',async()=>{
 const f=fixture({allowWrites:true,generationEnabled:true,apiData:{'/canvas/node-history/page':{schemaVersion:1,canvasId:'fixture',nodeId:'run-history',historyId:'own-native-id',revision:'0',resultCount:2,totalBatchCount:2,batches:[],hasNext:false}}});
 await f.sandbox.testHooks.executeCommand({id:'create-history',type:'canvas.createNode',config:{id:'run-history',type:'rh-text',data:{modelCode:'text-text-rhart-text-g-3-flash-preview',subType:'text-text',params:{prompt:'keep'},output:[{url:'https://example.com/current.mp4'}],historyStorage:{source:'remote',historyId:'foreign-copy',resultCount:99},nodeOutputHistory:[{id:'legacy'}]}}});
 const before=f.remoteDoc.getMap('canvas').get('canvas_content').toJSON();
 await f.sandbox.testHooks.executeCommand({id:'run-history',type:'canvas.runNode',nodeId:'run-history'});
 assert.equal(f.events.find(e=>e.commandId==='run-history').ok,true);
 const data=f.payloads.find(p=>p.url.endsWith('/canvas/task/run')).body.canvas.nodes[0].data;
 assert.equal(data.historyStorage.historyId,'own-native-id');assert.equal(data.historyStorage.resultCount,2);assert.equal(data.nodeOutputHistory,undefined);assert.deepEqual(data.output,before.nodes[0].data.output);
 assert.deepEqual(f.remoteDoc.getMap('canvas').get('canvas_content').toJSON(),before);f.remoteDoc.destroy();
});


test('lost result delivery retries the receipt without resubmitting generation',async()=>{
 const f=fixture({allowWrites:true,generationEnabled:true,dropResults:0});
 await f.sandbox.testHooks.executeCommand({id:'make-receipt-test',type:'canvas.createTextNode',config:{id:'receipt-node',text:'keep'}});
 assert.equal(f.events.filter(e=>e.commandId==='make-receipt-test').length,1);
 f.setDropResults(2);
 await f.sandbox.testHooks.executeCommand({id:'receipt-run',type:'canvas.runNode',nodeId:'receipt-node'});
 assert.equal(f.requests.filter(u=>u.endsWith('/canvas/task/run')).length,1);assert.equal(f.events.find(e=>e.commandId==='receipt-run').result.task.taskId,'fixture-task');f.remoteDoc.destroy();
});

test('wrapped layout dispatch preserves content and cleanup is revision-pinned with a recoverable mutation diff',async t=>{
 const f=workflowFixture();t.after(()=>f.remoteDoc.destroy());await f.seed();
 const edgesBefore=JSON.stringify(f.edges()),paramsBefore=JSON.stringify(f.nodes().find(n=>n.id==='blank').data.params);
 const preview=await f.run('canvas.applyLayoutTemplate',{groups:[{id:'group',title:'Grid',nodeIds:['a','b','blank']}],dryRun:true});
 assert.equal(preview.ok,true,preview.error);assert.equal(f.nodes().length,3);
 const apply=await f.run('canvas.applyLayoutTemplate',{groups:[{id:'group',title:'Grid',nodeIds:['a','b','blank']}]});
 assert.equal(apply.ok,true,apply.error);assert.equal(JSON.stringify(f.edges()),edgesBefore);assert.equal(JSON.stringify(f.nodes().find(n=>n.id==='blank').data.params),paramsBefore);
 const checked=await f.run('canvas.checkLayout');assert.equal(checked.ok,true,checked.error);assert.equal(checked.result.passes,true);
 const before={nodes:f.nodes(),edges:f.edges()},entries=[{nodeId:'a',reason:'user_rejected',decisionNote:'Fixture discard'}];
 const result=await f.run('canvas.cleanupNodes',{entries,expected:before});assert.equal(result.ok,true,result.error);assert.ok(result.result.rollbackId);assert.equal(f.nodes().some(n=>n.id==='a'),false);assert.equal(f.nodes().find(n=>n.id==='group').data.nodeIds.includes('a'),false);
 const stale=await f.run('canvas.cleanupNodes',{entries,expected:before});assert.equal(stale.ok,false);assert.match(stale.error,/EDIT_CONFLICT/);assert.equal(f.requests.some(u=>u.endsWith('/task/run')),false);
});


test('runtime reuses a P app and its native history through configuration, summary and a generation preview',async t=>{
 const f=fixture({allowWrites:true,generationEnabled:true,apiData:{'/canvas/node-history/page':{schemaVersion:1,canvasId:'fixture',nodeId:'p-app',historyId:'own-index',revision:'2',resultCount:2,totalBatchCount:2,batches:[],hasNext:false}}});t.after(()=>f.remoteDoc.destroy());
 let i=0;const run=async(type,args)=>{const id='reuse-test-'+i++;await f.sandbox.testHooks.executeCommand({id,type,...args});const r=f.events.find(e=>e.commandId===id);assert.equal(r.ok,true,r.error);return r.result;};
 const data={title:'P001',bridgeProductionKey:'EP01/P001',aiApp:{id:'app',inputNodes:[{nodeId:'1',fieldName:'prompt',fieldType:'STRING',fieldValue:'initial'}]},historyStorage:{source:'remote',historyId:'own-index',revision:'2',resultCount:2},output:[{url:'https://example.test/current.mp4'}],adopted:true};
 await run('canvas.createNode',{config:{id:'p-app',type:'rh-ai',data}});const snapshot=()=>f.remoteDoc.getMap('canvas').get('canvas_content').toJSON(),before=snapshot();
 const reused=await run('canvas.createApp',{appId:'app',nodeId:'new-attempt',productionKey:'EP01/P001',x:0,y:0});assert.equal(reused.result.nodeId,'p-app');assert.equal(reused.result.reused,true);assert.deepEqual(snapshot(),before);
 await run('canvas.configureApp',{nodeId:'p-app',inputs:[{nodeId:'1',fieldName:'prompt',value:'revised'}]});const current=snapshot().nodes[0];assert.deepEqual(current.data.historyStorage,data.historyStorage);assert.deepEqual(current.data.output,data.output);assert.equal(current.data.adopted,true);
 const summary=await run('canvas.summary',{});assert.equal(summary.nodes[0].productionKey,'EP01/P001');assert.equal(summary.nodes[0].appId,'app');const found=await run('canvas.findElements',{query:{text:'EP01/P001',summary:true}});assert.equal(found.nodes[0].id,'p-app');
 const pre=await run('canvas.preflight',{nodeId:'p-app'});const generated=await run('canvas.runNode',{nodeId:'p-app',validateParams:true,dryRun:true,expectedDigest:pre.digest});assert.equal(generated.submitted,false);assert.equal(generated.request.canvas.nodes[0].id,'p-app');assert.equal(generated.request.canvas.nodes[0].data.historyStorage.historyId,'own-index');assert.equal(snapshot().nodes.length,1);assert.equal(f.requests.some(u=>u.endsWith('/canvas/task/run')),false);
});


test('301 history routing rejection is structured; rejected receipts block unchanged new requests without writes or reruns',async t=>{
 const history={schemaVersion:1,canvasId:'fixture',nodeId:'app',historyId:'owned-index',revision:'0',resultCount:1,totalBatchCount:1,batches:[],hasNext:false};
 const f=fixture({allowWrites:true,generationEnabled:true,apiData:{'/canvas/node-history/page':history},apiReply:path=>path==='/canvas/task/run'?{ok:true,status:200,text:async()=>JSON.stringify({code:301,msg:'节点历史路由不属于当前画布'})}:null});t.after(()=>f.remoteDoc.destroy());
 const run=async(id,type,args={})=>{await f.sandbox.testHooks.executeCommand({id,type,...args});return f.events.find(e=>e.commandId===id);};
 await run('create','canvas.createNode',{config:{id:'app',type:'rh-ai',data:{aiApp:{id:'a',inputNodes:[]},historyStorage:{source:'remote',historyId:'owned-index',revision:'0',resultCount:1},output:[{url:'https://example.test/old.mp4'}],accepted:true}}});
 const before=JSON.stringify(f.remoteDoc.toJSON());
 const rejected=await run('first','canvas.runNode',{nodeId:'app',validateParams:true});
 assert.equal(rejected.errorCode,'HISTORY_ROUTE_CONFLICT');assert.equal(rejected.submissionState,'rejected');assert.equal(rejected.submitted,false);assert.equal(rejected.platformCode,301);assert.equal(rejected.historyRoute.historyId,'owned-index');
 const historyRouteFailure={requestId:'first',...rejected.historyRoute};
 const next=await run('second','canvas.runNode',{nodeId:'app',validateParams:true,historyRouteFailure});assert.equal(next.submissionState,'not_submitted');assert.equal(next.retryable,false);
 const pre=await run('pre','canvas.preflight',{nodeId:'app',historyRouteFailure});assert.equal(pre.result.ok,false);assert.ok(pre.result.errors.includes('HISTORY_ROUTE_CONFLICT'));
 const sync=await run('sync','canvas.platformWrite',{operation:'syncNodeHistory',body:{nodeId:'app'},historyRouteFailure});assert.equal(sync.result.changed,false);assert.equal(sync.result.ok,false);
 assert.equal(f.payloads.filter(p=>p.url.endsWith('/canvas/task/run')).length,1);assert.equal(JSON.stringify(f.remoteDoc.toJSON()),before);
 // A larger count or revision on the same rejected route does not repair its ownership.
 history.revision='2';history.resultCount=3;
 assert.equal((await run('third','canvas.runNode',{nodeId:'app',validateParams:true,historyRouteFailure})).submissionState,'not_submitted');
});

test('run transport errors, malformed replies and missing task IDs remain unknown and never auto-retry',async t=>{
 for(const reply of [()=>{throw Error('network');},()=>({ok:false,status:503,text:async()=>JSON.stringify({code:301,msg:'节点历史路由不属于当前画布'})}),()=>({ok:true,status:200,text:async()=>'<html>broken</html>'}),()=>({ok:true,status:200,text:async()=>JSON.stringify({code:0,data:{}})})]){
  const f=fixture({allowWrites:true,generationEnabled:true,apiReply:path=>path==='/canvas/task/run'?reply():null});t.after(()=>f.remoteDoc.destroy());
  await f.sandbox.testHooks.executeCommand({id:'create',type:'canvas.createTextNode',config:{id:'n',text:'fixture'}});
  await f.sandbox.testHooks.executeCommand({id:'run',type:'canvas.runNode',nodeId:'n'});
  const event=f.events.find(e=>e.commandId==='run');assert.equal(event.errorCode,'COMMAND_OUTCOME_UNKNOWN');assert.equal(event.submissionState,'unknown');assert.equal(event.submitted,undefined);assert.equal(f.payloads.filter(p=>p.url.endsWith('/canvas/task/run')).length,1);
 }
});


test('preserved route repair persists only history fields and a generation preview omits the rejected route without submitting',async t=>{
 const batch={batchId:'batch',taskId:'old-task',createdAt:1,nodeConfigSnapshot:{modelCode:'app-id'},paramsSnapshot:{nodeInfoList:[]},outputs:[{outputId:'output',url:'https://example.test/old.mp4',outputType:'mp4'}]};
 const history={schemaVersion:1,canvasId:'fixture',nodeId:'app',historyId:'bad-route',revision:'0',resultCount:1,totalBatchCount:1,batches:[batch],hasNext:false};
 const f=fixture({allowWrites:true,generationEnabled:true,apiData:{'/canvas/node-history/page':history,'/canvas/task/batchStatus':{tasks:[{taskId:'old-task',canvasId:'fixture',status:'SUCCESS',plans:[{nodeId:'app',outputs:[{url:'https://example.test/old.mp4'}]}]}]}}});t.after(()=>f.remoteDoc.destroy());
 const run=async(id,type,args={})=>{await f.sandbox.testHooks.executeCommand({id,type,...args});return f.events.find(e=>e.commandId===id);};
 await run('create','canvas.createNode',{config:{id:'app',type:'rh-ai',data:{status:'finished',taskId:'old-task',aiApp:{id:'app-id',inputNodes:[]},historyStorage:{source:'remote',schemaVersion:1,historyId:'bad-route',revision:'0',resultCount:1},output:[{url:'https://example.test/old.mp4'}],adopted:true}}});
 const historyRouteFailure={requestId:'original-rejection',historyId:'bad-route'};
 const preview=await run('preview','canvas.platformWrite',{operation:'syncNodeHistory',body:{nodeId:'app',repairRoute:true},historyRouteFailure,dryRun:true});assert.equal(preview.ok,true,preview.error);
 const result=await run('repair','canvas.platformWrite',{operation:'syncNodeHistory',body:{nodeId:'app',repairRoute:true},historyRouteFailure,expectedRevisions:preview.result.result.expectedRevisions});assert.equal(result.ok,true,result.error);
 const snapshot=f.remoteDoc.getMap('canvas').get('canvas_content').toJSON();assert.equal(snapshot.nodes.length,1);assert.equal(snapshot.nodes[0].data.adopted,true);
 const preflight=await run('preflight','canvas.preflight',{nodeId:'app',historyRouteFailure});assert.equal(preflight.result.ok,true);assert.equal(preflight.result.historyRoute.blocked,false);
 const payload=await run('payload','canvas.runNode',{nodeId:'app',validateParams:true,dryRun:true,historyRouteFailure});assert.equal(payload.ok,true,payload.error);
 const data=payload.result.request.canvas.nodes[0].data;assert.equal(data.historyStorage,undefined);assert.equal(data.bridgeHistoryRecovery,undefined);assert.equal(data.nodeOutputHistory[0].id,'batch');assert.equal(data.nodeOutputHistory[0].outputs[0].historyOutputId,'output');
 assert.deepEqual(f.remoteDoc.getMap('canvas').get('canvas_content').toJSON(),snapshot);assert.equal(f.payloads.some(p=>p.url.endsWith('/canvas/task/run')),false);
 const newFailure={requestId:'later-rejection',historyId:null};const blocked=await run('guard','canvas.runNode',{nodeId:'app',validateParams:true,dryRun:true,historyRouteFailure:newFailure});assert.equal(blocked.errorCode,'HISTORY_ROUTE_CONFLICT');
});
test('generation history lookup tolerates unrelated canvas edits but rejects changed target inputs',async t=>{
 for(const changed of ['unrelated','target']){
  let f,mutate=false;
  f=fixture({allowWrites:true,generationEnabled:true,apiReply:path=>{
   if(path==='/canvas/node-history/page'&&mutate){
    const nodes=f.providers.at(-1).doc.getMap('canvas').get('canvas_content').get('nodes');
    const node=nodes.toArray().find(n=>n.get('id')===changed);
    if(changed==='target')node.get('data').set('apiKeyMode','plus');else node.get('position').set('x',500);
   }
  }});t.after(()=>f.remoteDoc.destroy());
  const run=async(id,type,args)=>{await f.sandbox.testHooks.executeCommand({id,type,...args});return f.events.find(e=>e.commandId===id);};
  await run('target-new','canvas.createNode',{config:{id:'target',type:'rh-ai',data:{aiApp:{id:'application',inputNodes:[]}}}});
  await run('other-new','canvas.createTextNode',{config:{id:'unrelated',text:'unrelated'}});
  mutate=true;const result=await run('preview','canvas.runNode',{nodeId:'target',validateParams:true,dryRun:true});
  assert.equal(result.ok,changed==='unrelated',result.error);
  if(changed==='target')assert.equal(result.errorCode,'EDIT_CONFLICT');
  assert.equal(f.requests.some(u=>u.endsWith('/canvas/task/run')),false);
 }
});
test('node projections keep full revisions and app edits return fresh revisions without another read',async t=>{
 const f=fixture({allowWrites:true});t.after(()=>f.remoteDoc.destroy());
 const run=async(id,type,args)=>{await f.sandbox.testHooks.executeCommand({id,type,...args});const e=f.events.find(e=>e.commandId===id);assert.equal(e.ok,true,e.error);return e.result;};
 await run('new','canvas.createNode',{config:{id:'app',type:'rh-ai',data:{aiApp:{id:'application',inputNodes:[{nodeId:'1',fieldName:'text',fieldType:'STRING',fieldValue:'完整原文'}]},nodeOutputHistory:[{sample:'history'}],bridgeHistoryRecovery:{sample:'large-recovery'},output:[{url:'https://example.test/result.mp4'}]}}});
 const full=await run('full','canvas.getElement',{elementId:'app'}),inputs=await run('inputs','canvas.getElement',{elementId:'app',view:'inputs'});
 assert.equal(inputs.revision,full.revision);assert.equal(inputs.element.data.aiApp.inputNodes[0].fieldValue,'完整原文');assert.equal(inputs.element.data.nodeOutputHistory,undefined);
 const edited=await run('edit','canvas.configureApp',{nodeId:'app',inputs:[{nodeId:'1',fieldName:'text',value:'新的完整正文'}]});
 const after=await run('after','canvas.getElement',{elementId:'app'});assert.equal(edited.result.revisions.app,after.revision);assert.notEqual(after.revision,full.revision);
});

test('native app dry-run stays unsaved; preflight and run enforce expected through the public runtime path',async t=>{
 const f=fixture({allowWrites:true,generationEnabled:true,apiData:{'/api/webapp/detail':{id:'app',name:'Expected App',inputNodes:[{nodeId:'263',fieldName:'text',fieldType:'STRING',fieldValue:'OLD_PROMPT'},{nodeId:'10',fieldName:'seconds',fieldType:'INT',fieldValue:'12'}]}}});t.after(()=>{f.sandbox.testHooks.dropReadSession();f.remoteDoc.destroy();});let i=0;
 const run=async(type,args={})=>{const id='expected-'+i++;await f.sandbox.testHooks.executeCommand({id,type,...args});return f.events.find(e=>e.commandId===id);};
 await run('canvas.createApp',{nodeId:'outer',appId:'app',x:0,y:0});const before=JSON.stringify(f.remoteDoc.toJSON());
 const inputs=[{nodeId:'263',fieldName:'text',value:'NEW_PROMPT'}],expected={prompt:'NEW_PROMPT',appInputs:inputs};
 const preview=await run('canvas.configureApp',{nodeId:'outer',inputs,dryRun:true});assert.equal(preview.ok,true);assert.equal(preview.result.applied,false);assert.equal(JSON.stringify(f.remoteDoc.toJSON()),before);
 const rejected=await run('canvas.preflight',{nodeId:'outer',expected});assert.equal(rejected.result.ok,false);assert.match(rejected.result.errors.join(' '),/APP_EXPECTED_PROMPT_MISMATCH/);
 const attempt=await run('canvas.runNode',{nodeId:'outer',expected,validateParams:true});assert.equal(attempt.ok,false);assert.match(attempt.error,/APP_PREFLIGHT_FAILED/);assert.equal(f.requests.some(u=>u.endsWith('/canvas/task/run')),false);
 await run('canvas.configureApp',{nodeId:'outer',inputs});const pre=await run('canvas.preflight',{nodeId:'outer',expected});assert.equal(pre.result.ok,true);
 const payload=await run('canvas.runNode',{nodeId:'outer',expected,expectedDigest:pre.result.digest,validateParams:true,dryRun:true});assert.equal(payload.ok,true,payload.error);assert.equal(payload.result.request.canvas.nodes[0].data.aiApp.inputNodes[0].fieldValue,'NEW_PROMPT');
 await run('canvas.configureApp',{nodeId:'outer',inputs:[{nodeId:'10',fieldName:'seconds',value:'13'}]});const stale=await run('canvas.runNode',{nodeId:'outer',expectedDigest:pre.result.digest,validateParams:true,dryRun:true});assert.equal(stale.ok,false);assert.match(stale.error,/EDIT_CONFLICT/);assert.equal(f.requests.some(u=>u.endsWith('/canvas/task/run')),false);
});

test('ordinary model expectations compare values and complete references and reject native-only fields',async t=>{
 const f=workflowFixture();t.after(()=>f.remoteDoc.destroy());await f.seed();
 await f.run('canvas.updateNodeParams',{nodeId:'blank',params:{prompt:'Saved prompt'},validateParams:true});
 await f.run('canvas.bindReferences',{nodeId:'blank',references:[{sourceNodeId:'a',kind:'image',parameter:'refImage1'}]});
 const pre=(await f.run('canvas.preflight',{nodeId:'blank'})).result;
 assert.equal((await f.run('canvas.preflight',{nodeId:'blank',expected:{params:{duration:'6'},references:pre.references}})).result.ok,true);
 for(const expected of [{params:{duration:'7'}},{references:[]},{appInputs:[{nodeId:'263',fieldName:'text',value:'x'}]},{promptField:{nodeId:'263',fieldName:'text'}}])assert.equal((await f.run('canvas.preflight',{nodeId:'blank',expected})).result.ok,false);
 assert.equal(f.requests.some(u=>u.endsWith('/canvas/task/run')),false);
});
