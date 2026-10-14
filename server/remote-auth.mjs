import {randomBytes, createHash, timingSafeEqual} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync, renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError} from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const REMOTE_SCOPE='runninghub:canvas';
export const secret=()=>randomBytes(32).toString('base64url');
export const digest=value=>createHash('sha256').update(String(value)).digest('hex');
const equal=(a,b)=>timingSafeEqual(Buffer.from(digest(a)),Buffer.from(digest(b)));
const html=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const now=()=>Math.floor(Date.now()/1000);

export function savePrivateJson(path,value){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const temp=path+'.'+randomBytes(8).toString('hex')+'.tmp';
 writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
 renameSync(temp,path);
}

// The SDK supplies OAuth request validation, client authentication and S256
// verification. This provider owns the single-user consent and token lifecycle.
export class RemoteAuth {
 constructor({publicUrl,ownerSecretHash,statePath}){
  this.publicUrl=publicUrl;this.resource=new URL('/mcp',publicUrl).href;
  this.ownerSecretHash=ownerSecretHash;this.statePath=statePath;
  if(!/^[a-f0-9]{64}$/.test(ownerSecretHash||''))throw Error('REMOTE_OWNER_SECRET_REQUIRED');
  try{this.state=JSON.parse(readFileSync(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;this.state={version:1,clients:{},access:{},refresh:{}};}
  if(this.state.version!==1 || !this.state.clients || !this.state.access || !this.state.refresh)throw Error('REMOTE_AUTH_STATE_INVALID');
  this.pending=new Map();this.codes=new Map();
  this.clientsStore={getClient:id=>Object.hasOwn(this.state.clients,id)?this.state.clients[id]:undefined,registerClient:async client=>{
   if(Object.keys(this.state.clients).length>=500)throw new InvalidClientMetadataError('Client registration limit reached');
   if(!Array.isArray(client.redirect_uris)||!client.redirect_uris.length||client.redirect_uris.length>8)throw new InvalidClientMetadataError('Supply 1 to 8 HTTPS redirect URIs');
   for(const value of client.redirect_uris){
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.hash)throw new InvalidClientMetadataError('Redirect URI must use HTTPS without credentials or fragments');
   }
   if(client.scope && client.scope.split(' ').some(s=>s!==REMOTE_SCOPE))throw new InvalidClientMetadataError('Unsupported scope');
   if(client.token_endpoint_auth_method && !['none','client_secret_post','client_secret_basic'].includes(client.token_endpoint_auth_method))throw new InvalidClientMetadataError('Unsupported client authentication');
   this.state.clients[client.client_id]=client;this.persist();return client;
  }};
 }
 persist(){
  for(const table of ['access','refresh'])for(const [key,value] of Object.entries(this.state[table]))if(value.expiresAt<now())delete this.state[table][key];
  savePrivateJson(this.statePath,this.state);
 }
 checkResource(resource){
  // Older clients omit resource. Every issued token still has one fixed audience.
  if(resource && resource.href!==this.resource)throw new InvalidRequestError('Resource does not match this MCP endpoint');
 }
 scopes(scopes){
  const result=scopes?.length?scopes:[REMOTE_SCOPE];
  if(result.some(s=>s!==REMOTE_SCOPE))throw new InvalidScopeError('Unsupported scope');
  return result;
 }
 async authorize(client,params,res){
  this.checkResource(params.resource);const scopes=this.scopes(params.scopes);
  if(!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))throw new InvalidRequestError('S256 challenge required');
  for(const [id,p] of this.pending)if(p.expiresAt<now())this.pending.delete(id);
  if(this.pending.size>=100)throw new InvalidRequestError('Too many pending authorizations');
  const requestId=secret(),csrf=secret();
  this.pending.set(requestId,{clientId:client.client_id,...params,scopes,csrfHash:digest(csrf),expiresAt:now()+600});
  const secure=new URL(this.publicUrl).protocol==='https:';
  // Native browser form POSTs use Origin: null under no-referrer. Preserve the
  // same-origin Origin check without sending a referrer to the OAuth callback.
  res.set('Referrer-Policy','same-origin');
  res.cookie('rh_remote_consent',csrf,{httpOnly:true,secure,sameSite:'lax',path:'/approve',maxAge:600000});
  res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 RunningHub Canvas</title><style>body{margin:0;background:#0c1220;color:#e7eefc;font:16px/1.6 system-ui;display:grid;min-height:100vh;place-items:center}main{max-width:460px;margin:24px;padding:36px;border:1px solid #29364f;border-radius:20px;background:#141e30}h1{font-size:24px}small{color:#a6b5cc;overflow-wrap:anywhere}label{display:block;margin-top:24px}input,button{box-sizing:border-box;width:100%;padding:13px;border-radius:9px;margin-top:8px;font:inherit}input{background:#0c1220;color:white;border:1px solid #465875}button{border:0;background:#7c9cff;color:#0a1224;cursor:pointer}p{margin-bottom:12px}</style><main><small>RUNNINGHUB CANVAS BRIDGE</small><h1>连接你的画布工具</h1><p>应用：<strong>${html(client.client_name||'MCP client')}</strong><br><small>回调地址：${html(params.redirectUri)}</small></p><p>连接后可读取与编辑画布、上传和下载素材，以及按你的要求提交生成。</p><form method="post" action="/approve"><input type="hidden" name="requestId" value="${requestId}"><input type="hidden" name="csrf" value="${csrf}"><label for="key">本机连接密钥</label><input id="key" name="ownerSecret" type="password" required autocomplete="current-password"><small>使用安装时保存在本机的连接密钥。无需提供 RunningHub 或 Google 密码。</small><button type="submit">授权连接</button></form></main></html>`);
 }
 approve(req,res){
  const p=this.pending.get(req.body?.requestId);
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('rh_remote_consent='))?.slice('rh_remote_consent='.length);
  if(req.headers.origin!==new URL(this.publicUrl).origin || !p || p.expiresAt<now() || !cookie || !equal(digest(cookie),p.csrfHash) || !equal(cookie,req.body.csrf||''))return res.status(403).send('连接请求已过期或校验失败，请从客户端重新连接。');
  if(!equal(digest(req.body.ownerSecret||''),this.ownerSecretHash))return res.status(403).send('本机连接密钥不正确，请返回重试。');
  this.pending.delete(req.body.requestId);
  const code=secret();
  this.codes.set(digest(code),{...p,expiresAt:now()+120});
  const target=new URL(p.redirectUri);target.searchParams.set('code',code);if(p.state!==undefined)target.searchParams.set('state',p.state);
  // Chrome applies form-action to the entire redirect chain, including the
  // client's own redirects. Finish the same-origin POST before navigating to
  // the registered callback; no cross-origin form destination is needed.
  res.clearCookie('rh_remote_consent',{path:'/approve'});
  res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${html(target.href)}"><title>授权完成</title><main><h1>授权完成</h1><p>正在返回客户端。</p><a href="${html(target.href)}" rel="noreferrer">继续返回客户端</a></main></html>`);
 }
 getCode(client,code){
  for(const [id,value] of this.codes)if(value.expiresAt<now())this.codes.delete(id);
  const value=this.codes.get(digest(code));
  if(!value || value.clientId!==client.client_id)throw new InvalidGrantError('Invalid or expired authorization code');
  return value;
 }
 async challengeForAuthorizationCode(client,code){return this.getCode(client,code).codeChallenge;}
 issue(clientId,scopes,family=secret()){
  if(Object.keys(this.state.refresh).length>2000)throw new InvalidGrantError('Too many active grants');
  const access=secret(),refresh=secret();
  const shared={clientId,scopes,family,resource:this.resource};
  this.state.access[digest(access)]={...shared,expiresAt:now()+3600};
  this.state.refresh[digest(refresh)]={...shared,expiresAt:now()+30*86400,used:false};
  this.persist();
  return {access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:scopes.join(' ')};
 }
 async exchangeAuthorizationCode(client,code,verifier,redirectUri,resource){
  const value=this.getCode(client,code);this.checkResource(resource);
  if(redirectUri!==value.redirectUri)throw new InvalidGrantError('Redirect URI does not match');
  this.codes.delete(digest(code));return this.issue(client.client_id,value.scopes);
 }
 async exchangeRefreshToken(client,token,scopes,resource){
  this.checkResource(resource);const value=this.state.refresh[digest(token)];
  if(!value || value.expiresAt<now() || value.clientId!==client.client_id || value.resource!==this.resource)throw new InvalidGrantError('Invalid refresh token');
  if(value.used){this.revokeFamily(value.family);throw new InvalidGrantError('Refresh token was already used; reconnect this client');}
  const next=this.scopes(scopes||value.scopes);if(next.some(s=>!value.scopes.includes(s)))throw new InvalidScopeError('Scope escalation rejected');
  value.used=true;return this.issue(client.client_id,next,value.family);
 }
 async verifyAccessToken(token){
  const value=this.state.access[digest(token)];
  if(!value || value.expiresAt<=now() || value.resource!==this.resource)throw new InvalidTokenError('Invalid or expired access token');
  return {token,clientId:value.clientId,scopes:value.scopes,expiresAt:value.expiresAt,resource:new URL(this.resource)};
 }
 revokeFamily(family){
  for(const table of ['access','refresh'])for(const [key,value] of Object.entries(this.state[table]))if(value.family===family)delete this.state[table][key];
  this.persist();
 }
 async revokeToken(client,{token}){
  const key=digest(token),value=this.state.access[key]||this.state.refresh[key];
  if(value?.clientId===client.client_id)this.revokeFamily(value.family);
 }
}
