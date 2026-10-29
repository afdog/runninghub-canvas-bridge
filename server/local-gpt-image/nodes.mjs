import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const NODE_SIZE={width:320,height:240};
export const NODE_ID=/^codex-image-[a-f0-9-]{36}$/;
export function nodeConfig(input={}){
  const prompt=String(input.prompt||'');if(prompt.length>16000)throw Error('提示词最多 16000 字。');
  const ratio=input.ratio||'auto';if(!['auto','1:1','16:9','9:16','4:3','3:4'].includes(ratio))throw Error('不支持的比例');
  const count=input.count===undefined?1:input.count;if(!Number.isInteger(count)||count<1||count>4)throw Error('每批可生成 1–4 张图片');
  if(input.transparent!==undefined&&typeof input.transparent!=='boolean')throw Error('透明背景参数无效');
  const mode=input.mode||'text';if(!['text','reference'].includes(mode))throw Error('不支持的生成方式');
  return {prompt,ratio,count,transparent:input.transparent===true,mode};
}
function unpack(value){return value.result||value;}
function source(node){
  const data=node.data||{},urls=[data.imageUrl,...(data.sourceObjects||[]).map(s=>typeof s==='string'?s:s?.url),...(data.output||[]).map(o=>typeof o==='string'?o:o?.url||o?.imageUrl)];
  const url=urls.find(u=>typeof u==='string'&&/^https:\/\//.test(u));
  return node.type==='rh-image'&&url?{nodeId:node.id,title:data.title||'图片',url}:null;
}
export function checkedMediaUrl(value){
  const u=new URL(value);const hosts=['runninghub.cn','runninghub.ai','xiaoyaoyou.com','runninghub.com','myqcloud.com'];
  if(u.protocol!=='https:'||u.username||u.password||u.port||!hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))throw Error('该参考图片来源暂不支持，请下载后上传参考图。');
  return u.href;
}
async function download(url){
  for(let i=0;i<4;i++){
    const r=await fetch(checkedMediaUrl(url),{redirect:'manual',signal:AbortSignal.timeout(60000)});
    if(r.status>=300&&r.status<400){url=new URL(r.headers.get('location'),url).href;continue;}
    if(!r.ok)throw Error('参考图下载失败（HTTP '+r.status+'）');
    const chunks=[];let length=0;
    for await(const chunk of r.body){length+=chunk.length;if(length>30*1024*1024)throw Error('参考图不能超过 30 MiB');chunks.push(chunk);}
    return Buffer.concat(chunks);
  }
  throw Error('参考图重定向次数过多');
}
export class CanvasNodes {
  constructor(engine){this.engine=engine;this.canvas=engine.canvas;this.locks=new Map();this.cache=new Map();}
  key(canvasUrl,nodeId){return canvasUrl+':'+nodeId;}
  invalidate(canvasUrl,nodeId){this.cache.delete(this.key(canvasUrl,nodeId));}
  serial(id,fn){const run=(this.locks.get(id)||Promise.resolve()).catch(()=>{}).then(fn);this.locks.set(id,run);return run.finally(()=>{if(this.locks.get(id)===run)this.locks.delete(id);this.cache.delete(id);});}
  async read(canvasUrl,nodeId){
    if(!NODE_ID.test(nodeId||''))throw Error('无效的 Codex 节点');
    const ctx=await this.canvas.open(canvasUrl),result=unpack(await this.canvas.call('rh_get_node',{scopeId:ctx.scopeId,nodeId,view:'full'}));
    if(result.element?.data?.codexImage?.version!==1)throw Error('此节点不是 Codex 生图节点，或已被删除');
    return {ctx,node:result.element,revision:result.revision};
  }
  async create(canvasUrl,{requestId,x,y}){
    if(!/^[a-f0-9-]{36}$/.test(requestId||''))throw Error('无效的请求 ID');
    const id='codex-image-'+requestId;
    return this.serial(this.key(canvasUrl,id),async()=>{
      const ctx=await this.canvas.open(canvasUrl);
      const summary=unpack(await this.canvas.call('rh_canvas_summary',{scopeId:ctx.scopeId,limit:500}));
      if(summary.truncated)throw Error('画布节点过多，请先指定放置区域。');
      const previous=(summary.nodes||[]).find(n=>n.id===id);if(previous)return {nodeId:id};
      await this.canvas.call('rh_get_layout_template',{scopeId:ctx.scopeId,canvasUrl});
      const wanted={x:Number.isFinite(x)?x:100,y:Number.isFinite(y)?y:100};
      const boxes=(summary.nodes||[]).map(n=>({x:n.position?.x||0,y:n.position?.y||0,w:n.width||320,h:n.height||300}));
      let position;
      for(let i=0;i<1000;i++){
        const p={x:wanted.x+(i%3)*640,y:wanted.y+Math.floor(i/3)*800};
        if(!boxes.some(b=>p.x<b.x+b.w+80&&p.x+NODE_SIZE.width+80>b.x&&p.y<b.y+b.h+80&&p.y+NODE_SIZE.height+80>b.y)){position=p;break;}
      }
      if(!position)throw Error('请在空白区域创建节点');
      await this.canvas.call('rh_gpt_image_create_node',{scopeId:ctx.scopeId,nodeId:id,...position});
      return {nodeId:id,position};
    });
  }
  async patch(canvasUrl,nodeId,values){return this.serial(this.key(canvasUrl,nodeId),async()=>{
    for(let attempt=0;attempt<2;attempt++){
      const {ctx,node,revision}=await this.read(canvasUrl,nodeId);
      try{await this.canvas.call('rh_update_node',{scopeId:ctx.scopeId,nodeId,data:{codexImage:{...node.data.codexImage,...values}},expectedRevisions:{[nodeId]:revision},dryRun:false});return {ok:true};}
      catch(error){if(attempt||!/STALE|REVISION/i.test(error.message))throw error;}
    }
  });}
  async saveConfig(canvasUrl,nodeId,input){
    if((this.engine.isNodeBusy?.(canvasUrl,nodeId)??this.engine.active?.targetNodeId===nodeId))throw Error('生成中暂不能修改本次参数');
    const config=nodeConfig(input);await this.patch(canvasUrl,nodeId,{config});return {config};
  }
  async selectOutput(canvasUrl,nodeId,{jobId,index}){
    if((this.engine.isNodeBusy?.(canvasUrl,nodeId)??this.engine.active?.targetNodeId===nodeId))throw Error('请等待本次生成完成再切换图片');
    return this.serial(this.key(canvasUrl,nodeId),async()=>{
      const {ctx,node,revision}=await this.read(canvasUrl,nodeId);
      const output=node.data.codexImage.history?.find(o=>o.jobId===jobId&&o.index===index);
      if(!output)throw Error('此图片不在该节点的生成记录中');
      const url=checkedMediaUrl(output.url);
      await this.canvas.call('rh_update_node',{scopeId:ctx.scopeId,nodeId,expectedRevisions:{[nodeId]:revision},dryRun:false,data:{imageUrl:url,sourceObjects:[url],imageWidth:output.width,imageHeight:output.height,codexImage:{...node.data.codexImage,selectedOutput:{jobId,index}}}});
      return {ok:true};
    });
  }
  async state(canvasUrl,nodeId,{fresh=false}={}){
    const cached=this.cache.get(this.key(canvasUrl,nodeId));if(!fresh&&cached&&cached.expires>Date.now())return cached.value;
    const {ctx,node}=await this.read(canvasUrl,nodeId);
    const connections=unpack(await this.canvas.call('rh_connections',{scopeId:ctx.scopeId,nodeId,direction:'upstream',depth:1}));
    const references=(connections.nodes||[]).filter(n=>n.id!==nodeId).map(source).filter(Boolean).map(s=>({...s,edgeIds:(connections.edges||[]).filter(e=>e.source===s.nodeId&&e.target===nodeId).map(e=>e.id)}));
    const value={nodeId,title:node.data.title,config:nodeConfig(node.data.codexImage.config),history:node.data.codexImage.history||[],selectedOutput:node.data.codexImage.selectedOutput||null,references,activeJobId:node.data.codexImage.activeJobId||null};
    this.cache.set(this.key(canvasUrl,nodeId),{expires:Date.now()+3500,value});return value;
  }
  async choices(canvasUrl,nodeId){
    const {ctx}=await this.read(canvasUrl,nodeId);
    const s=unpack(await this.canvas.call('rh_canvas_summary',{scopeId:ctx.scopeId,types:['rh-image'],limit:100}));
    const ids=(s.nodes||[]).filter(n=>n.id!==nodeId).map(n=>n.id);if(!ids.length)return [];
    const r=unpack(await this.canvas.call('rh_get_node',{scopeId:ctx.scopeId,nodeIds:ids,view:'full'}));
    return (r.nodes||[]).map(n=>source(n.element||n)).filter(Boolean);
  }
  async connect(canvasUrl,nodeId,{sourceNodeId,remove=false}){
    if((this.engine.isNodeBusy?.(canvasUrl,nodeId)??this.engine.active?.targetNodeId===nodeId))throw Error('生成中不能更改本次参考图');
    const state=await this.state(canvasUrl,nodeId,{fresh:true});
    const {ctx}=await this.read(canvasUrl,nodeId);
    if(remove){const s=state.references.find(s=>s.nodeId===sourceNodeId);if(s?.edgeIds.length)await this.canvas.call('rh_delete_elements',{scopeId:ctx.scopeId,nodeIds:[],edgeIds:s.edgeIds,dryRun:false});}
    else{
      if(state.references.length>=5)throw Error('最多连接 5 张参考图');
      const r=unpack(await this.canvas.call('rh_get_node',{scopeId:ctx.scopeId,nodeId:sourceNodeId,view:'full'}));
      if(sourceNodeId===nodeId||!source(r.element))throw Error('请选择具有图片结果的其他节点');
      await this.canvas.call('rh_connect_nodes',{scopeId:ctx.scopeId,source:sourceNodeId,target:nodeId,sourceHandle:'output',targetHandle:'input',dryRun:false});
    }
    this.invalidate(canvasUrl,nodeId);return this.state(canvasUrl,nodeId,{fresh:true});
  }
  async references(canvasUrl,nodeId){
    const state=await this.state(canvasUrl,nodeId,{fresh:true});
    if(!state.references.length)throw Error('请先上传或连接一张参考图');
    if(state.references.length>5)throw Error('最多使用 5 张参考图，请移除多余连线');
    let total=0;const references=[];
    for(const ref of state.references){const bytes=await download(ref.url);total+=bytes.length;if(total>30*1024*1024)throw Error('参考图合计不能超过 30 MiB');references.push({base64:bytes.toString('base64')});}
    return references;
  }
  async uploadReference(canvasUrl,nodeId,ref){
    if(this.engine.isNodeBusy?.(canvasUrl,nodeId))throw Error('生成中不能更改本次参考图');
    const state=await this.state(canvasUrl,nodeId,{fresh:true});if(state.references.length>=5)throw Error('最多连接 5 张参考图');
    const {validateInput}=await import('./engine.mjs');
    const image=validateInput({prompt:'reference',references:[ref]}).references[0];
    const id=randomUUID(),directory=join(this.engine.root,'reference-uploads');await mkdir(directory,{recursive:true,mode:0o700});
    const path=join(directory,id+'.'+image.extension);await writeFile(path,image.bytes,{mode:0o600});
    const {ctx}=await this.read(canvasUrl,nodeId);
    const summary=unpack(await this.canvas.call('rh_canvas_summary',{scopeId:ctx.scopeId,limit:500}));
    const {nextImagePosition}=await import('./canvas.mjs');const pos=nextImagePosition(summary.nodes||[]);
    const result=await this.canvas.call('rh_upload_image',{scopeId:ctx.scopeId,filePath:path,requestId:'codex-reference-'+id,title:'参考图 · '+String(ref.name||'本地图片').slice(0,60),...pos,connectToNodeId:nodeId});
    const refId=unpack(result).primaryReference?.nodeId;
    if(refId)await this.canvas.normalize(ctx,refId);
    this.invalidate(canvasUrl,nodeId);return this.state(canvasUrl,nodeId,{fresh:true});
  }
}
