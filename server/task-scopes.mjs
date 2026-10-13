import {AsyncLocalStorage} from 'node:async_hooks';
import {BridgeClient} from './bridge-client.mjs';
export class TaskScopes{
 constructor(base){this.base=base;this.local=new AsyncLocalStorage();this.proxy=new Proxy(base,{get:(_,key)=>{const client=this.local.getStore() || base;const value=client[key];return typeof value==='function'?value.bind(client):value;}});}
 async resolve(id){const client=new BridgeClient(this.base.base);const {access}=await client.request('/sessions?id='+encodeURIComponent(id));if(!access)throw new Error('SCOPE_EXPIRED: reopen your exact canvas; never use another task scope');client.sessionId=id;client.pinnedClientId=access.clientId || null;client.canvasUrl=access.origin+(access.origin==='https://rhtv.runninghub.cn'?'/projects/canvas/':'/project/canvas/')+access.canvasId;return client;}
 async run(mode,args,fn){
  if(mode==='canvas'&&!args.scopeId)throw new Error('TASK_SCOPE_REQUIRED: use scopeId returned by rh_open_canvas/rh_select_canvas');
  const client=args.scopeId?await this.resolve(args.scopeId):new BridgeClient(this.base.base);
  const {scopeId,...rest}=args;
  return this.local.run(client,async()=>{const result=await fn(rest);return {...result,...(client.sessionId?{scopeId:client.sessionId,canvasUrl:client.canvasUrl}:{})};});
 }
}
