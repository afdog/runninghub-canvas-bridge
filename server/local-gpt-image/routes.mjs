import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {imageKind} from './engine.mjs';
import {ParallelGptImageEngine} from './parallel.mjs';
import {NODE_ID} from './nodes.mjs';

const ORIGINS=['https://www.runninghub.cn','https://rhtv.runninghub.cn','https://www.runninghub.ai','https://rhtv.runninghub.ai'];
export function canonicalCanvas(value){
  const u=new URL(value);if(!ORIGINS.includes(u.origin)||u.username||u.password)throw Error('画布地址不受支持');
  const m=u.pathname.match(/^\/projects?\/canvas\/([A-Za-z0-9_-]+)\/?$/);if(!m)throw Error('需要准确的画布地址');
  return u.origin+'/project/canvas/'+m[1];
}
export class GptImageAddon {
  constructor({port=18765,engine}={}){this.base='http://127.0.0.1:'+port;this.engine=engine||new ParallelGptImageEngine();this.tokens=new Map();}
  json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
  authorize(req,url){
    const token=req.headers['x-gpt-image-token']||url.searchParams.get('token');
    const grant=this.tokens.get(token);
    if(!grant||grant.expires<Date.now())throw Error('生图连接已过期，请重新打开入口。');
    if(req.headers.origin&&req.headers.origin!==this.base)throw Error('请求来源不受支持');
    if(req.method==='POST'&&req.headers.origin!==this.base)throw Error('请求来源不受支持');
    return grant;
  }
  async body(req){
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>42*1024*1024)throw Error('请求过大，参考图合计最多 30 MiB。');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
  }
  async handle(req,res,url){
    try{
      const port=new URL(this.base).port;
      if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host))return this.json(res,403,{error:'INVALID_HOST'});
      if(req.headers.origin&&req.headers.origin!==this.base&&!ORIGINS.includes(req.headers.origin))return this.json(res,403,{error:'ORIGIN_NOT_ALLOWED'});
      const files={'/gpt-image/concurrency.mjs':['concurrency.mjs','text/javascript; charset=utf-8'],'/gpt-image/node.js':['node.js','text/javascript; charset=utf-8'],'/gpt-image/node.css':['node.css','text/css; charset=utf-8'],'/gpt-image/host.js':['host.js','text/javascript; charset=utf-8'],'/gpt-image/ui.js':['ui.js','text/javascript; charset=utf-8'],'/gpt-image/ui.css':['ui.css','text/css; charset=utf-8'],'/gpt-image/icon.svg':['icon.svg','image/svg+xml']};
      if(req.method==='GET'&&files[url.pathname]){
        const [file,type]=files[url.pathname];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(await readFile(new URL(file,import.meta.url)));return;
      }
      if(req.method==='GET'&&['/gpt-image/ui','/gpt-image/node','/gpt-image/host'].includes(url.pathname)){
        const canvasUrl=canonicalCanvas(url.searchParams.get('canvasUrl'));
        for(const [token,grant] of this.tokens)if(grant.expires<Date.now())this.tokens.delete(token);
        const nodeId=url.pathname==='/gpt-image/node'?url.searchParams.get('nodeId'):null;
        if(url.pathname==='/gpt-image/node'&&!NODE_ID.test(nodeId||''))throw Error('无效的节点');
        const token=randomBytes(32).toString('hex');this.tokens.set(token,{canvasUrl,nodeId,expires:Date.now()+12*3600000});
        const file=url.pathname==='/gpt-image/node'?'node.html':url.pathname==='/gpt-image/host'?'host.html':'ui.html';
        const html=(await readFile(new URL(file,import.meta.url),'utf8')).replace('__TOKEN__',token);
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors "+ORIGINS.join(' ')+"; base-uri 'none'; form-action 'none'",'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(html);return;
      }
      const grant=this.authorize(req,url);
      if(req.method==='GET'&&url.pathname==='/gpt-image/settings'){await this.engine.loadSettings();return this.json(res,200,{concurrency:this.engine.schedulerState()});}
      if(req.method==='POST'&&url.pathname==='/gpt-image/settings')return this.json(res,200,{concurrency:await this.engine.setConcurrency((await this.body(req)).maxConcurrentImages)});
      if(req.method==='GET'&&url.pathname==='/gpt-image/jobs')return this.json(res,200,{jobs:await this.engine.list(grant.canvasUrl,grant.nodeId)});
      if(req.method==='POST'&&url.pathname==='/gpt-image/node/create')return this.json(res,200,await this.engine.nodes.create(grant.canvasUrl,await this.body(req)));
      if(url.pathname.startsWith('/gpt-image/node/')){
        if(!grant.nodeId)throw Error('缺少节点绑定，请重新打开节点');
        const {canvasUrl,nodeId}=grant;
        if(req.method==='GET'&&url.pathname==='/gpt-image/node/state'){
          const jobs=await this.engine.list(canvasUrl,nodeId);
          return this.json(res,200,{node:await this.engine.nodes.state(canvasUrl,nodeId),jobs,status:await this.engine.status(),retryNotBefore:this.engine.retryNotBefore||0,concurrency:this.engine.schedulerState?.()||null});
        }
        if(req.method==='GET'&&url.pathname==='/gpt-image/node/choices')return this.json(res,200,{choices:await this.engine.nodes.choices(canvasUrl,nodeId)});
        if(req.method==='POST'&&url.pathname==='/gpt-image/node/output')return this.json(res,200,await this.engine.nodes.selectOutput(canvasUrl,nodeId,await this.body(req)));
        if(req.method==='POST'&&url.pathname==='/gpt-image/node/config')return this.json(res,200,await this.engine.nodes.saveConfig(canvasUrl,nodeId,await this.body(req)));
        if(req.method==='POST'&&url.pathname==='/gpt-image/node/reference')return this.json(res,200,await this.engine.nodes.connect(canvasUrl,nodeId,await this.body(req)));
        if(req.method==='POST'&&url.pathname==='/gpt-image/node/upload-reference')return this.json(res,200,await this.engine.nodes.uploadReference(canvasUrl,nodeId,await this.body(req)));
        if(req.method==='POST'&&url.pathname==='/gpt-image/node/generate')return this.json(res,202,{job:await this.engine.create(canvasUrl,{...await this.body(req),targetNodeId:nodeId})});
      }
      if(req.method==='GET'&&url.pathname==='/gpt-image/state'){
        let jobs=await this.engine.list(grant.canvasUrl);
        if(url.searchParams.has('id')){const job=this.engine.jobs.get(url.searchParams.get('id'));jobs=job?.canvasUrl===grant.canvasUrl?[this.engine.view(job)]:[];}
        return this.json(res,200,{status:await this.engine.status(),jobs,retryNotBefore:this.engine.retryNotBefore||0});
      }
      if(req.method==='POST'&&url.pathname==='/gpt-image/generate')return this.json(res,202,{job:await this.engine.create(grant.canvasUrl,await this.body(req))});
      const job=this.engine.jobs.get(url.searchParams.get('id'));
      if(!job||job.canvasUrl!==grant.canvasUrl||(grant.nodeId&&job.targetNodeId!==grant.nodeId))return this.json(res,404,{error:'图片记录不存在'});
      if(req.method==='POST'&&url.pathname==='/gpt-image/resume')return this.json(res,200,{job:await this.engine.resume(job)});
      if(req.method==='POST'&&url.pathname==='/gpt-image/stop')return this.json(res,200,{job:await this.engine.stop(job)});
      if(req.method==='GET'&&url.pathname==='/gpt-image/image'&&job.outputPath){
        const index=url.searchParams.get('index');
        const path=index===null?job.outputPath:job.outputs?.find(o=>o.index===Number(index))?.path;
        if(!path)throw Error('图片结果不存在');
        const bytes=await readFile(path),kind=imageKind(bytes);
        res.writeHead(200,{'Content-Type':kind==='jpg'?'image/jpeg':'image/'+kind,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(bytes);return;
      }
      return this.json(res,404,{error:'NOT_FOUND'});
    }catch(error){if(!res.headersSent)this.json(res,400,{error:String(error.message).slice(0,1200)});else res.end();}
  }
  close(){this.engine.close();}
}
