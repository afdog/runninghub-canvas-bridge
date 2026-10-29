import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';

export function imageThumbnailSize(width,height,thumbnail={}){
  if(!(width>0&&height>0))throw Error('图片尺寸无法读取，请保留本次上传结果。');
  const ratio=width/height;
  const bounds=ratio>1.05?(thumbnail.landscape||{width:320,height:180}):ratio<.95?(thumbnail.portrait||{width:180,height:320}):(thumbnail.square||{width:240,height:240});
  const scale=Math.min(bounds.width/width,bounds.height/height);
  return {width:Math.round(width*scale*100)/100,height:Math.round(height*scale*100)/100};
}

export function nextImagePosition(nodes) {
  const generated=nodes.filter(n=>n.title?.startsWith('GPT 生图 · '));
  const originals=nodes.filter(n=>!n.title?.startsWith('GPT 生图 · '));
  const bottom=Math.max(0,...originals.map(n=>(n.position?.y||0)+(n.height||400)));
  const cellWidth=Math.max(520,...generated.map(n=>(n.width||380)+160));
  const cellHeight=Math.max(620,...generated.map(n=>(n.height||400)+180));
  const startY=generated.length?Math.min(...generated.map(n=>n.position?.y||0)):bottom+220;
  const index=generated.length;
  const occupied=nodes.map(n=>({x:n.position?.x||0,y:n.position?.y||0,w:n.width||380,h:n.height||400}));
  for(let slot=index;slot<index+2000;slot++){
    const x=100+(slot%3)*cellWidth,y=startY+Math.floor(slot/3)*cellHeight;
    if(!occupied.some(n=>x<n.x+n.w+100&&x+400+100>n.x&&y<n.y+n.h+100&&y+440+100>n.y))return {x,y};
  }
  throw Error('没有找到足够宽松的画布位置，请先整理画布。');
}

export class ImageCanvas {
  constructor({scopeTtlMs=60000,browserSource=process.env.RH_GPT_IMAGE_BROWSER_SOURCE}={}){
    if(browserSource&&!['codex-browser','browser-extension'].includes(browserSource))throw Error('Invalid RH_GPT_IMAGE_BROWSER_SOURCE');
    this.scopeTtlMs=scopeTtlMs;this.browserSource=browserSource;this.scopes=new Map();this.opening=new Map();
  }
  async connect(){
    if(this.ready)return this.ready;
    this.ready=(async()=>{
      this.client=new Client({name:'runninghub-gpt-image',version:'0.1.0'});
      this.client.onerror=()=>{};
      const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../mcp.mjs',import.meta.url))],env:{...process.env},stderr:'pipe'});
      await this.client.connect(transport);
    })().catch(e=>{this.ready=null;throw e;});return this.ready;
  }
  async call(name,args,recovered=false){
    await this.connect();
    const reply=await this.client.callTool({name,arguments:args},undefined,{timeout:180000});
    const value=reply.structuredContent||JSON.parse(reply.content?.find(v=>v.type==='text')?.text||'{}');
    if(reply.isError||value.ok===false||value.result?.ok===false){
      const message=value.errorCode||value.error||value.result?.error||'画布操作未完成。';
      const bound=[...this.scopes].find(([,s])=>s.context.scopeId===args.scopeId);
      if(bound&&/SESSION_EXPIRED|SCOPE_EXPIRED|CANVAS_NOT_CONNECTED/.test(message)){
        this.scopes.delete(bound[0]);
        if(!recovered&&['rh_get_node','rh_canvas_summary','rh_connections','rh_get_layout_template'].includes(name)){
          const context=await this.open(bound[0]);Object.assign(bound[1].context,context);return this.call(name,{...args,scopeId:context.scopeId},true);
        }
      }
      throw Error(message);
    }
    return value;
  }
  async open(canvasUrl){
    const cached=this.scopes.get(canvasUrl);if(cached&&cached.expires>Date.now())return cached.context;
    if(this.opening.has(canvasUrl))return this.opening.get(canvasUrl);
    const pending=(async()=>{
      // Let the bridge reuse the exact connected canvas in Chrome or the in-app browser.
      const r=await this.call('rh_open_canvas',{canvasUrl,...(this.browserSource?{browserSource:this.browserSource}:{}),allowWrites:true,intent:'connect'});
      if(!r.scopeId)throw Error('画布连接未就绪');const context={canvasUrl,scopeId:r.scopeId};
      this.scopes.set(canvasUrl,{context,expires:Date.now()+this.scopeTtlMs});return context;
    })();this.opening.set(canvasUrl,pending);
    try{return await pending;}finally{this.opening.delete(canvasUrl);}
  }
  async normalize(context,nodeId){
    const uploaded=await this.call('rh_get_node',{scopeId:context.scopeId,nodeId,view:'full'});
    const value=uploaded.result||uploaded,element=value.element;
    const size=imageThumbnailSize(Number(element?.width||element?.data?.width),Number(element?.height||element?.data?.height));
    await this.call('rh_transform_nodes',{scopeId:context.scopeId,nodes:[{nodeId,...size}],expectedRevisions:{[nodeId]:value.revision},dryRun:false});
    return size;
  }
  async import(job){
    const context=await this.open(job.canvasUrl);
    if(job.targetNodeId){
      const receipt=await this.call('rh_gpt_image_commit_output',{scopeId:context.scopeId,nodeId:job.targetNodeId,jobId:job.id,index:job.currentIndex||0,prompt:job.prompt,filePath:job.outputPath,requestId:job.uploadRequestId});
      const result=receipt.result||receipt;
      const verified=await this.call('rh_get_node',{scopeId:context.scopeId,nodeId:job.targetNodeId,view:'full'});
      const history=(verified.result||verified).element?.data?.codexImage?.history||[];
      if(!history.some(h=>h.jobId===job.id&&h.index===(job.currentIndex||0)&&h.sha256===job.sha256))throw Error('图片已上传，但节点结果回读尚未确认；请保留本次结果。');
      return {nodeId:job.targetNodeId,receipt,url:result.url,dimensions:result.dimensions,verified:true};
    }
    const layout=await this.call('rh_get_layout_template',{scopeId:context.scopeId,canvasUrl:job.canvasUrl});
    const summary=await this.call('rh_canvas_summary',{scopeId:context.scopeId,limit:500});
    if(summary.result?.truncated)throw Error('画布节点过多，请在对话中指定生成图片的位置。');
    const position=nextImagePosition(summary.result?.nodes||[]);
    // This request ID is saved before import. An uncertain upload is never replayed.
    const result=await this.call('rh_upload_image',{scopeId:context.scopeId,filePath:job.outputPath,requestId:job.uploadRequestId,title:'GPT 生图 · '+job.prompt.slice(0,32),...position});
    const nodeId=result.result?.primaryReference?.nodeId||result.primaryReference?.nodeId;
    if(!nodeId)throw Error('上传回执缺少节点 ID，请检查画布后再继续。');
    const uploaded=await this.call('rh_get_node',{scopeId:context.scopeId,nodeId,view:'full'});
    const element=uploaded.result?.element||uploaded.element;
    const size=imageThumbnailSize(Number(element?.width||element?.style?.width||element?.data?.width),Number(element?.height||element?.style?.height||element?.data?.height),layout.template?.imageThumbnail);
    const revision=uploaded.result?.revision||uploaded.revision;
    if(!revision)throw Error('上传已完成，但缺少排版校验版本，请检查本次画布节点。');
    await this.call('rh_transform_nodes',{scopeId:context.scopeId,nodes:[{nodeId,...size}],expectedRevisions:{[nodeId]:revision},dryRun:false});
    const verified=await this.call('rh_get_node',{scopeId:context.scopeId,nodeId,view:'outputs'});
    return {nodeId,position,size,receipt:result,verified:!!verified};
  }
  close(){this.client?.close().catch(()=>{});}
}
