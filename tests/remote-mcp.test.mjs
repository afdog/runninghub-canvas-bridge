import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createRemoteApp,validatePublicUrl} from '../server/mcp-http.mjs';
import {createMcpServer} from '../server/mcp.mjs';
import {RemoteAuth,digest,secret,REMOTE_SCOPE} from '../server/remote-auth.mjs';

const publicUrl='https://mcp.example.test';
const redirect='https://client.example.test/callback';
async function setup(t,{realFactory=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'rh-remote-')),ownerSecret=secret(),statePath=join(dir,'oauth.json');
 const {app,auth}=createRemoteApp({publicUrl,ownerSecretHash:digest(ownerSecret),statePath,...(realFactory?{}:{factory:()=>createMcpServer({status:async()=>({ok:true,fixture:true})})})});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
 const post=(path,data,headers={})=>request(path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(data)});
 const register=async(metadata={})=>{const r=await request('/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Test client',redirect_uris:[redirect],token_endpoint_auth_method:'none',...metadata})});assert.equal(r.status,201);return r.json();};
 async function consent(client,{key=ownerSecret,csrfOverride,origin=publicUrl}={}){
  const verifier=secret(),challenge=createHash('sha256').update(verifier).digest('base64url');
  const q=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',resource:publicUrl+'/mcp',state:'test-state'});
  const start=await request('/authorize?'+q);assert.equal(start.status,200);
  const page=await start.text(),requestId=page.match(/name="requestId" value="([^"]+)"/)[1],csrf=page.match(/name="csrf" value="([^"]+)"/)[1];
  const response=await post('/approve',{requestId,csrf:csrfOverride??csrf,ownerSecret:key},{Cookie:start.headers.get('set-cookie').split(';')[0],Origin:origin});
  const pageResult=await response.clone().text();
  const location=pageResult.match(/<a href="([^"]+)"/)?.[1]?.replaceAll('&amp;','&');
  return {response,verifier,code:location?new URL(location).searchParams.get('code'):null,location};
 }
 const exchange=(client,flow,extra={})=>post('/token',{grant_type:'authorization_code',client_id:client.client_id,code:flow.code,code_verifier:flow.verifier,redirect_uri:redirect,resource:publicUrl+'/mcp',...(client.client_secret?{client_secret:client.client_secret}:{}),...extra});
 return {base,auth,ownerSecret,statePath,request,post,register,consent,exchange};
}

test('remote gateway requires HTTPS configuration and exposes only metadata before authorization',async t=>{
 assert.throws(()=>validatePublicUrl('http://mcp.example.test'),/HTTPS/);
 assert.throws(()=>validatePublicUrl('https://mcp.example.test/secret'),/HTTPS/);
 const f=await setup(t);
 const unauth=await f.request('/mcp',{method:'POST'});assert.equal(unauth.status,401);assert.match(unauth.headers.get('www-authenticate'),/oauth-protected-resource\/mcp/);
 const metadata=await (await f.request('/.well-known/oauth-authorization-server')).json();assert.equal(metadata.registration_endpoint,publicUrl+'/register');assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
 const resource=await (await f.request('/.well-known/oauth-protected-resource/mcp')).json();assert.equal(resource.resource,publicUrl+'/mcp');
 assert.equal((await f.request('/command',{method:'POST'})).status,404);
 const badHost=await new Promise((resolve,reject)=>{const r=httpRequest(f.base+'/health',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});assert.equal(badHost,403);
 assert.equal((await f.request('/mcp',{method:'POST',headers:{Origin:'https://evil.example'}})).status,403);
 const bad=await f.request('/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:['http://evil.example/callback']})});assert.equal(bad.status,400);
 assert.equal(f.auth.clientsStore.getClient('__proto__'),undefined);
});

test('OAuth consent rejects wrong owner key, cross-site form and CSRF, then enforces PKCE and code binding',async t=>{
 const f=await setup(t),client=await f.register();
 assert.equal((await f.consent(client,{key:'wrong'})).response.status,403);
 assert.equal((await f.consent(client,{csrfOverride:'wrong'})).response.status,403);
 assert.equal((await f.consent(client,{origin:'https://evil.example'})).response.status,403);
 assert.equal((await f.consent(client,{origin:'null'})).response.status,403);
 const flow=await f.consent(client);assert.equal(flow.response.status,200);assert.equal(new URL(flow.location).searchParams.get('state'),'test-state');
 assert.equal(flow.response.headers.get('referrer-policy'),'no-referrer');
 assert.match(await flow.response.clone().text(),/http-equiv="refresh"/);
 assert.equal((await f.exchange(client,flow,{code_verifier:secret()})).status,400);
 assert.equal((await f.exchange(client,flow,{redirect_uri:'https://client.example.test/other'})).status,400);
 assert.equal((await f.exchange(client,flow,{resource:'https://other.example/mcp'})).status,400);
 const other=await f.register();assert.equal((await f.exchange(other,flow)).status,400);
 const token=await f.exchange(client,flow);assert.equal(token.status,200);
 assert.equal((await f.exchange(client,flow)).status,400);
 assert.equal((await token.json()).scope,REMOTE_SCOPE);
});

test('browser consent preserves same-origin POST and rejects unregistered callbacks',async t=>{
 const f=await setup(t),client=await f.register();
 const q=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',code_challenge:digest('browser-verifier').slice(0,43),code_challenge_method:'S256'});
 const r=await f.request('/authorize?'+q);assert.equal(r.status,200);
 assert.equal(r.headers.get('referrer-policy'),'same-origin');
 const csp=r.headers.get('content-security-policy');
 assert.match(csp,/form-action 'self';/);
 assert.match(csp,/frame-ancestors 'none'/);
 assert.equal(csp.includes('*'),false);
 const denied=await f.request('/authorize?'+new URLSearchParams({...Object.fromEntries(q),redirect_uri:'https://evil.example/callback'}));
 assert.equal(denied.status,400);
 assert.equal((await f.request('/health')).headers.get('referrer-policy'),'no-referrer');
});

test('authenticated remote MCP serves all 87 tools, legacy handshake and modern concurrent calls',async t=>{
 const f=await setup(t),registered=await f.register({token_endpoint_auth_method:'client_secret_post'});
 const flow=await f.consent(registered),response=await f.exchange(registered,flow),tokens=await response.json();assert.equal(response.status,200);
 const headers={Authorization:`Bearer ${tokens.access_token}`};
 const transport=new StreamableHTTPClientTransport(new URL(f.base+'/mcp'),{requestInit:{headers}});
 const client=new Client({name:'legacy-remote-test',version:'1'});t.after(()=>client.close());
 await client.connect(transport);assert.equal((await client.listTools()).tools.length,87);
 const called=await client.callTool({name:'rh_status',arguments:{}});assert.equal(called.structuredContent.fixture,true);
 const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'modern-remote-test',version:'1'}};
 const calls=await Promise.all(Array.from({length:3},(_,id)=>f.request('/mcp',{method:'POST',headers:{...headers,'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':'rh_status','Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:id+1,method:'tools/call',params:{name:'rh_status',arguments:{},_meta:meta}})})));
 for(const r of calls){const body=await r.text();assert.equal(r.status,200,body);assert.match(body,/"fixture":true/);}
 assert.equal((await f.request('/mcp',{method:'POST',headers:{Authorization:'Bearer invalid'}})).status,401);
 const saved=await readFile(f.statePath,'utf8');assert.equal(saved.includes(tokens.access_token),false);assert.equal(saved.includes(tokens.refresh_token),false);assert.equal(saved.includes(f.ownerSecret),false);
 if(process.platform!=='win32')assert.equal((await stat(f.statePath)).mode&0o777,0o600);
});

test('refresh survives restart, binds the client and audience, rotates, and revokes the family on replay',async t=>{
 const f=await setup(t),client=await f.register(),other=await f.register();
 const flow=await f.consent(client),tokens=await (await f.exchange(client,flow)).json();
 const restored=new RemoteAuth({publicUrl,ownerSecretHash:digest(f.ownerSecret),statePath:f.statePath});
 assert.equal((await restored.verifyAccessToken(tokens.access_token)).clientId,client.client_id);
 await assert.rejects(restored.exchangeRefreshToken(other,tokens.refresh_token),/Invalid refresh token/);
 await assert.rejects(restored.exchangeRefreshToken(client,tokens.refresh_token,undefined,new URL('https://other.example/mcp')),/Resource/);
 const next=await restored.exchangeRefreshToken(client,tokens.refresh_token);assert.notEqual(next.refresh_token,tokens.refresh_token);
 assert.equal((await restored.verifyAccessToken(next.access_token)).clientId,client.client_id);
 await assert.rejects(restored.exchangeRefreshToken(client,tokens.refresh_token),/already used/);
 await assert.rejects(restored.verifyAccessToken(next.access_token),/Invalid/);
});

test('revocation invalidates both access and refresh tokens',async t=>{
 const f=await setup(t),client=await f.register(),flow=await f.consent(client),tokens=await (await f.exchange(client,flow)).json();
 const r=await f.post('/revoke',{client_id:client.client_id,token:tokens.refresh_token});assert.equal(r.status,200);
 await assert.rejects(f.auth.verifyAccessToken(tokens.access_token),/Invalid/);
 await assert.rejects(f.auth.exchangeRefreshToken(client,tokens.refresh_token),/Invalid/);
});

test('the real MCP factory retains required task scopes behind the HTTP adapter',async t=>{
 const f=await setup(t,{realFactory:true}),registered=await f.register(),flow=await f.consent(registered),tokens=await (await f.exchange(registered,flow)).json();
 const client=new Client({name:'real-factory-test',version:'1'});t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(f.base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${tokens.access_token}`}}}));
 const {tools}=await client.listTools();assert.equal(tools.length,87);assert.ok(tools.find(t=>t.name==='rh_get_node').inputSchema.required.includes('scopeId'));
 const rejected=await client.callTool({name:'rh_get_node',arguments:{nodeId:'example'}});assert.equal(rejected.isError,true);
});
