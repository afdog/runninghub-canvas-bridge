import {z} from 'zod';
import {readFile,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

export function registerGptImageTools(tool,bridge){
  tool('rh_gpt_image_create_node','Create one persistent native canvas image node with Codex image controls. It never submits RunningHub generation. The stable nodeId supports safe retry after uncertain creation.',{
    nodeId:z.string().regex(/^codex-image-[a-f0-9-]{36}$/),x:z.number().finite(),y:z.number().finite()
  },async({nodeId,x,y})=>{
    return bridge.command('canvas.createNode',{config:{id:nodeId,type:'rh-image',x,y,node:{width:320,height:240},style:{width:320,height:240},data:{title:'Codex 生图',label:'Codex 生图',status:'idle',width:320,height:240,opResize:true,imageDisplaySizeLocked:true,codexImage:{version:1,config:{prompt:'',ratio:'auto',transparent:false,count:1,mode:'text'},history:[]}}}});
  });
  tool('rh_gpt_image_commit_output','Attach one verified local Codex image result to its original Codex canvas node. Preserves position, connections and earlier results; never generates. jobId must match the active job stored on this node.',{
    nodeId:z.string().regex(/^codex-image-[a-f0-9-]{36}$/),jobId:z.string().uuid(),index:z.number().int().min(0).max(3),filePath:z.string(),requestId:z.string(),prompt:z.string().max(16000)
  },async({nodeId,jobId,index,filePath,requestId,prompt})=>{
    if(!isAbsolute(filePath))throw Error('需要绝对图片路径');
    const info=await stat(filePath);if(!info.isFile()||info.size>30*1024*1024)throw Error('图片超过大小限制');
    const bytes=await readFile(filePath);
    const type=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
    if(!type)throw Error('无效图片');
    return bridge.command('canvas.uploadLocalReferenceImage',{file:{name:'codex-'+jobId+'-'+index+'.'+(type==='image/jpeg'?'jpg':type.split('/')[1]),type,base64:bytes.toString('base64')},config:{codexTargetNodeId:nodeId,jobId,index,prompt}},{id:requestId,timeoutMs:55000});
  });
  async function grant(){
    if(!bridge.canvasUrl)throw Error('请先连接目标画布。');
    const response=await fetch(bridge.base+'/gpt-image/ui?canvasUrl='+encodeURIComponent(bridge.canvasUrl),{signal:AbortSignal.timeout(10000)});
    const html=await response.text();
    const token=html.match(/name="gpt-image-token" content="([a-f0-9]+)"/)?.[1];
    if(!response.ok||!token)throw Error('GPT 原生生图入口未就绪。');
    return token;
  }
  async function request(path,body){
    const token=await grant();
    const response=await fetch(bridge.base+'/gpt-image/'+path,{method:body===undefined?'GET':'POST',headers:{'x-gpt-image-token':token,...(body===undefined?{}:{Origin:bridge.base,'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
    const data=await response.json();if(!response.ok)throw Error(data.error||'原生生图请求未完成，请检查原请求记录。');return data;
  }
  tool('rh_gpt_image_status','Read GPT built-in image-generation capability and jobs for the scoped canvas. Does not generate. Uses the saved ChatGPT sign-in, not an OpenAI API key. Query the original job after an uncertain request; never create a replacement request ID.',{jobId:z.string().uuid().optional()},async({jobId})=>{
    const data=await request('state'+(jobId?'?id='+encodeURIComponent(jobId):''));return {ok:true,status:data.status,jobs:data.jobs};
  },{readOnly:true,idempotent:true});
  tool('rh_gpt_image_generate','Default GPT built-in image generation for this local integration. Generate or edit one image using the signed-in Codex account limits, then automatically upload it with spacing to this scoped RunningHub canvas. No RunningHub model generation or API-key fallback. Requires an explicit user image prompt. Up to five local reference images, 30 MiB total. Return immediately with a job ID and poll rh_gpt_image_status. A requestId is reused only for the exact same request; never resubmit a failed or uncertain generation with a new ID.',{
    requestId:z.string().uuid(),prompt:z.string().min(1).max(16000),ratio:z.enum(['auto','1:1','16:9','9:16','4:3','3:4']).default('auto'),transparent:z.boolean().default(false),count:z.number().int().min(1).max(4).default(1),targetNodeId:z.string().regex(/^codex-image-[a-f0-9-]{36}$/).optional(),referencePaths:z.array(z.string()).max(5).default([])
  },async({referencePaths,...input})=>{
    const session=await bridge.request('/sessions?id='+encodeURIComponent(bridge.sessionId||''));
    if(!session?.access?.allowWrites)throw Error('当前画布连接是只读，请使用允许写入的画布 scope。');
    await bridge.target();let total=0;
    const references=[];
    for(const filePath of referencePaths){
      if(!isAbsolute(filePath))throw Error('参考图必须使用绝对路径。');
      const info=await stat(filePath);total+=info.size;if(!info.isFile()||total>30*1024*1024)throw Error('参考图合计不能超过 30 MiB。');
      references.push({base64:(await readFile(filePath)).toString('base64')});
    }
    return {ok:true,...await request('generate',{...input,references})};
  });
}
