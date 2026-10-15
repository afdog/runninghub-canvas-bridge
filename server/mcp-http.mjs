#!/usr/bin/env node
import {MediaConsent} from './media-consent.mjs';
import express from 'express';
import {rateLimit} from 'express-rate-limit';
import {createMcpHandler} from '@modelcontextprotocol/server';
import {toNodeHandler} from '@modelcontextprotocol/node';
import {mcpAuthRouter} from '@modelcontextprotocol/sdk/server/auth/router.js';
import {requireBearerAuth} from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMcpServer} from './mcp.mjs';
import {RemoteAuth,REMOTE_SCOPE} from './remote-auth.mjs';

const PRODUCT_VERSION=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;

export const defaultRemoteConfig=()=>join(homedir(),'.runninghub-canvas-bridge','remote','config.json');
export function validatePublicUrl(value){
 const url=new URL(value);
 if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw Error('Use an HTTPS origin without a path, credentials, query or fragment');
 return url.origin;
}

export function createRemoteApp({publicUrl,ownerSecretHash,statePath,factory=createMcpServer}){
 publicUrl=validatePublicUrl(publicUrl);
 const auth=new RemoteAuth({publicUrl,ownerSecretHash,statePath});
 const app=express();app.disable('x-powered-by');
 // Keep the TCP listener loopback-only. cloudflared publishes this dedicated
 // gateway, never the internal bridge's /command, media or management routes.
 app.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
  let host;try{host=new URL('http://'+req.headers.host).hostname;}catch{return res.status(403).end();}
  if(![new URL(publicUrl).hostname,'127.0.0.1','localhost'].includes(host))return res.status(403).end();
  const origin=req.headers.origin;
  if(origin && ![publicUrl,'https://gemini.google.com'].includes(origin))return res.status(403).end();
  if(origin){res.set('Access-Control-Allow-Origin',origin);res.vary('Origin');}
  res.set('Access-Control-Expose-Headers','WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version');
  if(req.method==='OPTIONS')return res.set({'Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, MCP-Session-Id, Last-Event-ID'}).status(204).end();
  next();
 });
 // The reverse proxy is intentionally not trusted for client IPs. A single-user
 // gateway shares conservative login limits, so spoofed headers cannot bypass it.
 const rateOptions={validate:{xForwardedForHeader:false}};
 app.post('/approve',rateLimit({...rateOptions,windowMs:15*60000,limit:20,standardHeaders:true,legacyHeaders:false}),express.urlencoded({extended:false,limit:'16kb'}),(req,res)=>auth.approve(req,res));
 const mediaConsent=new MediaConsent({origin:publicUrl,secretHash:ownerSecretHash});
 app.get('/media-approval/:id',async(req,res)=>{try{const page=await mediaConsent.page(req.params.id);res.set('Referrer-Policy','same-origin');res.cookie('rh_media_consent',page.csrf,{httpOnly:true,secure:true,sameSite:'strict',path:'/media-approval',maxAge:600000});res.type('html').send(page.html);}catch{res.status(404).send('处理计划不存在、已过期或已执行。');}});
 app.post('/media-approval/:id',rateLimit({...rateOptions,windowMs:15*60000,limit:20,standardHeaders:true,legacyHeaders:false}),express.urlencoded({extended:false,limit:'16kb'}),async(req,res)=>{try{const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('rh_media_consent='))?.slice(17);await mediaConsent.approve(req.params.id,req.body,cookie,req.headers.origin);res.type('text').send('已授权这一次处理。请回到原对话继续。');}catch{res.status(403).send('授权失败，请确认连接密钥、计划有效期与确认选项。');}});
 app.use(mcpAuthRouter({provider:auth,issuerUrl:new URL(publicUrl),resourceServerUrl:new URL('/mcp',publicUrl),scopesSupported:[REMOTE_SCOPE],resourceName:'RunningHub Canvas',clientRegistrationOptions:{clientSecretExpirySeconds:0,rateLimit:rateOptions},authorizationOptions:{rateLimit:rateOptions},tokenOptions:{rateLimit:rateOptions},revocationOptions:{rateLimit:rateOptions}}));
 app.get('/.well-known/oauth-protected-resource',(req,res)=>res.json({resource:auth.resource,authorization_servers:[publicUrl],scopes_supported:[REMOTE_SCOPE],resource_name:'RunningHub Canvas'}));
 app.get('/health',(req,res)=>res.json({ok:true,version:PRODUCT_VERSION,service:'runninghub-remote-mcp',authentication:'oauth2-pkce',transport:'streamable-http'}));
 app.get('/',(req,res)=>res.type('text').send('RunningHub Canvas MCP. Connect your client to /mcp.'));
 // createMcpServer takes a BridgeClient, not the SDK's per-request context.
 const handle=toNodeHandler(createMcpHandler(()=>factory(undefined,{approvalOrigin:publicUrl})));
 const bearer=requireBearerAuth({verifier:auth,requiredScopes:[REMOTE_SCOPE],resourceMetadataUrl:new URL('/.well-known/oauth-protected-resource/mcp',publicUrl).href});
 app.all('/mcp',bearer,express.json({limit:'2mb'}),(req,res,next)=>Promise.resolve(handle(req,res,req.body)).catch(next));
 app.use((req,res)=>res.status(404).json({error:'not_found'}));
 app.use((error,req,res,next)=>{if(res.headersSent)return res.end();res.status(error.status===413?413:500).json({error:error.status===413?'request_too_large':'gateway_error'});});
 return {app,auth};
}

export function startRemote(configPath=process.env.RH_REMOTE_CONFIG||defaultRemoteConfig()){
 const config=JSON.parse(readFileSync(configPath,'utf8'));
 const port=config.port??18766;
 if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid remote gateway port');
 const {app}=createRemoteApp({...config,statePath:join(dirname(configPath),'oauth-state.json')});
 const server=app.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({ok:true,listen:`http://127.0.0.1:${port}`,publicMcpUrl:new URL('/mcp',config.publicUrl).href})));
 server.requestTimeout=180000;server.headersTimeout=10000;
 return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)startRemote(process.argv[2]);
