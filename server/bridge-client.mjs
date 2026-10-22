import {errorDetails} from './command-result.mjs';
import { randomUUID, createHash } from "node:crypto";
import "../extension/site-policy.js";
import { browserRequestId } from "./request-identity.mjs";
const policy=globalThis.RHCanvasSitePolicy;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class BridgeClient {
  constructor(base = process.env.RH_BRIDGE_URL || "http://127.0.0.1:18765") {
    const url = new URL(base);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) {
      throw new Error("Bridge must be a loopback HTTP service");
    }
    this.base = url.origin;
    this.canvasUrl = null;
    this.sessionId = null;
    this.clientId = null;
  }
  async request(path, body, timeoutMs = 8000) {
    const response = await fetch(this.base + path, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const value = await response.json();
    if (!response.ok) { const error = new Error(value.errorCode || value.error || `HTTP ${response.status}`); error.status = response.status;if(value?.ok===false && typeof value.requestId==='string')error.receipt=value;throw error; }
    return value;
  }
  async waitReceipt(path, ready, timeoutMs) {
    const until = Date.now() + timeoutMs;
    let failures = 0;
    while (Date.now() < until) {
      try {
        const waitMs=Math.min(10000,Math.max(1,until-Date.now())),started=Date.now();
        const value = await this.request(path+'&waitMs='+waitMs,undefined,waitMs+2000);
        if (ready(value)) return value;
        failures = 0;
        if(Date.now()-started>=1000)continue;
      } catch {
        // Retry only the receipt read. Never replay the submitted operation.
        if (++failures >= 3) return null;
      }
      await pause(Math.min(failures ? 100 * failures : 300, Math.max(0, until - Date.now())));
    }
    return null;
  }
  async browserJob(args, {timeoutMs = 180000} = {}) {
    const health=await this.request('/browser/status');
    args={...args,requestId:args.requestId || randomUUID(),browserSource:args.browserSource || (health.providers?.includes('codex-browser')?'codex-browser':'browser-extension')};
    if(health.providers?.length && !health.providers.includes(args.browserSource))throw new Error('REQUESTED_BROWSER_OFFLINE: '+args.browserSource);
    if(!health.connected)throw new Error('BROWSER_EXTENSION_OFFLINE: load the bridge extension in the requested browser and keep it running');
    let id=browserRequestId(args);
    try { ({id}=await this.request('/browser/jobs',args)); }
    catch(error) {
      if(error.status>=400 && error.status<500)throw error;
      if(!health.recovery?.stableBrowserIds && args.action!=='manageCanvas')return {ok:false,state:'unknown',submissionState:'unknown',clientRequestId:args.requestId,browserRequestId:null,errorCode:'LEGACY_BROWSER_RECEIPT_UNKNOWN',nextAction:'The older bridge did not acknowledge a job ID. Inspect the browser/account state before retrying; update the bridge for stable browser receipts.'};
    }
    const job=await this.waitReceipt('/browser/result?id='+encodeURIComponent(id),value=>value?.result,timeoutMs);
    if(job?.result)return {...job.result,...(job.state==='unknown'?{submissionState:'unknown'}:{}),browserRequestId:id,browserSource:args.browserSource};
    return {ok:false,state:'unknown',submissionState:'unknown',browserRequestId:id,errorCode:'BROWSER_OUTCOME_UNKNOWN',nextAction:'Use rh_browser_result with this ID before opening or submitting again.'};
  }
  async open(canvasUrl,allowWrites=false,focus=false,browserSource,intent='connect'){
    const site=policy.parseCanvas(canvasUrl);if(!site)throw new Error('INVALID_CANVAS_URL');
    if(!['connect','show'].includes(intent))throw new Error('INVALID_PRESENTATION_INTENT');
    const [clients,health]=await Promise.all([this.request('/clients'),this.request('/browser/status')]);
    const matches=clients.filter(c=>policy.parseCanvas(c.href)?.key===site.key && c.runtimeFreshness==='fresh');
    const source=browserSource || (health.providers?.includes('codex-browser') || matches.some(c=>c.browserSource==='codex-browser')?'codex-browser':'browser-extension');
    const connected=matches.find(c=>c.browserSource===source && c.clientId===this.pinnedClientId) || matches.find(c=>c.browserSource===source);
    // Connecting a task is not a request to display its page. Legacy focus=true
    // is deliberately ignored; only the explicit show intent may activate a tab.
    if(connected && intent==='connect')return {ok:true,reused:true,browserSource:source,...await this.select(canvasUrl,allowWrites,connected.clientId),presentation:{intent,activation:'unchanged',connection:'existing',legacyFocusIgnored:focus===true}};
    const opened=await this.browserJob({action:'openCanvas',canvasUrl,intent,browserSource:source});if(opened.ok===false)return opened;
    for(let i=0;i<60;i++){
      const clients=await this.request('/clients');
      const match=clients.find(c=>policy.parseCanvas(c.href)?.key===policy.parseCanvas(canvasUrl)?.key && c.runtimeFreshness==='fresh' && (!opened.browserSource || c.browserSource===opened.browserSource));
      if(match)return {...opened,...await this.select(canvasUrl,allowWrites,match.clientId)};
      await pause(500);
    }
    return {ok:false,canvasUrl,opened:true,error:'CANVAS_CONNECTION_PENDING: page opened; check rh_status before retrying'};
  }
  async status() {
    const [health, clients, browsers, deployment] = await Promise.all([this.request("/health"), this.request("/clients"), this.request("/browser/status"),this.request("/build-info").catch(()=>({available:false}))]);
    const session = this.sessionId ? await this.request('/sessions?id='+encodeURIComponent(this.sessionId)) : null;
    return { ...health, browsers, deployment, legacyAccess:health.access, access:session?.access || null, sessionId:this.sessionId, sessionState:!this.sessionId?'unselected':session?.access?'selected':'expired', selectedCanvas: this.canvasUrl, clients: clients.map(c => ({ clientId: c.clientId, canvasUrl: c.href, title: c.title, runtimeFreshness: c.runtimeFreshness, browserSource:c.browserSource || "unknown", browserInstanceId:c.browserInstanceId || null })) };
  }
  async select(canvasUrl, allowWrites, clientId) {
    this.pinnedClientId = clientId || null;
    const canvas = policy.parseCanvas(canvasUrl);
    if (!canvas) throw new Error("INVALID_CANVAS_URL");
    for(let attempt=0;attempt<15;attempt++) {
      const clients=await this.request('/clients');
      if(clients.some(c=>policy.parseCanvas(c.href)?.key===canvas.key && (!clientId || c.clientId===clientId)))break;
      if(attempt===14)throw new Error('CANVAS_NOT_CONNECTED');
      await pause(400);
    }
    let result;
    try { result = await this.request("/sessions", { canvasUrl, allowWrites, ...(clientId?{clientId}:{}), ...(this.sessionId ? {sessionId:this.sessionId} : {}) }); }
    catch(error) {
      if(!String(error.message).startsWith('SESSION_EXPIRED')) throw error;
      this.sessionId=null;
      result=await this.request('/sessions',{canvasUrl,allowWrites,...(clientId?{clientId}:{})});
    }
    this.sessionId = result.sessionId;
    this.canvasUrl = new URL(canvasUrl).origin + new URL(canvasUrl).pathname;
    await this.target();
    return { ...result, canvasUrl: this.canvasUrl };
  }
  async target() {
    if (!this.canvasUrl) throw new Error("SELECT_CANVAS_FIRST: call rh_select_canvas with an observed connected URL");
    const expected = policy.parseCanvas(this.canvasUrl);
    if(this.resolvedTarget){
      const target=this.resolvedTarget;this.resolvedTarget=null;
      if(target.canvasId===expected.canvasId&&target.canvasOrigin===expected.origin&&(!this.pinnedClientId||target.clientId===this.pinnedClientId)){this.clientId=target.clientId;return target;}
    }
    for (let attempt = 0; attempt < 15; attempt++) {
      const clients = await this.request("/clients");
      const candidates = clients.filter(c => policy.parseCanvas(c.href)?.key === expected.key && c.runtimeFreshness === "fresh" && (!this.pinnedClientId || c.clientId === this.pinnedClientId));
      const match = candidates.find(c=>c.clientId===this.clientId) || candidates[0];
      if (match) { this.clientId = match.clientId; return { clientId: match.clientId, canvasId: expected.canvasId, canvasOrigin: expected.origin }; }
      await pause(400);
    }
    throw new Error("CANVAS_NOT_CONNECTED: reopen the selected canvas in its requested browser; a pinned page never falls back to another browser");
  }
  wireId(id) { return this.canvasUrl && !/^rh-[a-f0-9]{64}$/.test(id) ? 'rh-'+createHash('sha256').update(this.canvasUrl+':'+id).digest('hex') : id; }
  async command(type, args = {}, { id = randomUUID(), timeoutMs = 45000 } = {}) {
    const target = await this.target();
    const command = { ...args, ...target, type, id: this.wireId(id), sessionId:this.sessionId, compactMutation: true };
    // Deliberately send once. A timeout is not evidence that a paid submission failed.
    let acceptedId = command.id;
    try { acceptedId = (await this.request("/command", command)).id; }
    catch(error) { if(error.status>=400 && error.status<500)throw error; }
    const event = await this.waitReceipt(`/result?id=${encodeURIComponent(acceptedId)}`,Boolean,timeoutMs);
    if (event && event.submissionState !== "unknown" && !["CANVAS_WRITE_OUTCOME_UNKNOWN", "COMMAND_OUTCOME_UNKNOWN"].includes(event.errorCode)) {
      if(event.ok===false)return {ok:false,requestId:acceptedId,canvasUrl:this.canvasUrl,errorCode:event.errorCode || 'COMMAND_FAILED',error:event.error,...errorDetails(event)};
      return { ...(event.result?.ok === false ? { ok: false } : {}), requestId: acceptedId, canvasUrl: this.canvasUrl, result: event.result };
    }
    return {ok:false,submissionState:"unknown",requestId:acceptedId,canvasUrl:this.canvasUrl,errorCode:event?.errorCode || 'COMMAND_OUTCOME_UNKNOWN',nextAction:"Use rh_command_result for this request ID. Do not submit again with a new ID."};
  }
}
