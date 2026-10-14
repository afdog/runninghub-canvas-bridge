import { randomUUID, createHash } from "node:crypto";
import "../extension/site-policy.js";
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
    if (!response.ok) throw new Error(value.errorCode || value.error || `HTTP ${response.status}`);
    return value;
  }
  async browserJob(args){
    const health=await this.request('/browser/status');
    args={...args,browserSource:args.browserSource || (health.providers?.includes('codex-browser')?'codex-browser':'browser-extension')};
    if(health.providers?.length && !health.providers.includes(args.browserSource))throw new Error('REQUESTED_BROWSER_OFFLINE: '+args.browserSource);
    if(!health.connected)throw new Error('BROWSER_EXTENSION_OFFLINE: load the bridge extension in the requested browser and keep it running');
    const {id}=await this.request('/browser/jobs',args);
    const until=Date.now()+180000;
    while(Date.now()<until){const job=await this.request('/browser/result?id='+encodeURIComponent(id));if(job.result){if(job.result.ok===false)throw new Error(job.result.error);return {...job.result,browserSource:args.browserSource};}await pause(300);}
    return {ok:false,state:'unknown',browserRequestId:id,nextAction:'Read /browser/result with this ID before opening again.'};
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
    const [health, clients, browsers] = await Promise.all([this.request("/health"), this.request("/clients"), this.request("/browser/status")]);
    const session = this.sessionId ? await this.request('/sessions?id='+encodeURIComponent(this.sessionId)) : null;
    return { ...health, browsers, legacyAccess:health.access, access:session?.access || null, sessionId:this.sessionId, sessionState:!this.sessionId?'unselected':session?.access?'selected':'expired', selectedCanvas: this.canvasUrl, clients: clients.map(c => ({ clientId: c.clientId, canvasUrl: c.href, title: c.title, runtimeFreshness: c.runtimeFreshness, browserSource:c.browserSource || "unknown", browserInstanceId:c.browserInstanceId || null })) };
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
    const accepted = await this.request("/command", command);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const event = await this.request(`/result?id=${encodeURIComponent(accepted.id)}`);
      if (event) {
        if (event.ok === false) throw new Error(`${event.errorCode || "COMMAND_FAILED"}: ${event.error || ""}`);
        return { ...(event.result?.ok === false ? { ok: false } : {}), requestId: accepted.id, canvasUrl: this.canvasUrl, result: event.result };
      }
      await pause(300);
    }
    return { ok: false, submissionState: "unknown", requestId: accepted.id, nextAction: "Use rh_command_result for this request ID. Do not submit again with a new ID." };
  }
}
