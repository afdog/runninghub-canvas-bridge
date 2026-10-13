(() => {
 const clone=v=>JSON.parse(JSON.stringify(v));
 const F=globalThis.RHCanvasFeatures;
 const key=f=>String(f.nodeId)+':'+f.fieldName;
 const empty=v=>v==null||v==='';
 function refreshGroups(s){
   for(const g of s.nodes.filter(n=>n.type==='group')){const members=s.nodes.filter(n=>n.data?.groupId===g.id);g.data.nodeIds=members.map(n=>n.id);if(!members.length){g.data.nodeOffsets={};continue;}const x=Math.min(...members.map(n=>n.position.x))-60,y=Math.min(...members.map(n=>n.position.y))-80,w=Math.max(...members.map(n=>n.position.x+Number(n.width||n.style?.width||n.data?.width||380)))-x+60,h=Math.max(...members.map(n=>n.position.y+Number(n.height||n.style?.height||n.data?.height||240)))-y+60;g.position={x,y};g.width=w;g.height=h;g.style={...g.style,width:w,height:h};g.data={...g.data,width:w,height:h,nodeOffsets:Object.fromEntries(members.map(n=>[n.id,{x:n.position.x-x,y:n.position.y-y}]))};}
 }
 function validateValue(field,value){
  const type=String(field.fieldType||'STRING').toUpperCase();
  let data=field.fieldData;if(typeof data==='string'){try{data=JSON.parse(data);}catch{data=null;}}
  const meta=Array.isArray(data)&&data[1]&&typeof data[1]==='object'&&!Array.isArray(data[1])?data[1]:data && !Array.isArray(data)?data:{};
  if(empty(value)||(['IMAGE','VIDEO','AUDIO'].includes(type)&&value==='None')){if(field.required===true||field.isRequired===true)throw new Error('APP_INPUT_REQUIRED: '+key(field));return;}
  if(type==='INT'&&!Number.isInteger(Number(value)))throw new Error('APP_INPUT_INTEGER: '+key(field));
  if(['INT','FLOAT'].includes(type)&&!Number.isFinite(Number(value)))throw new Error('APP_INPUT_NUMBER: '+key(field));
  const min=field.min??meta.min,max=field.max??meta.max;
  if(min!=null&&Number(value)<Number(min)||max!=null&&Number(value)>Number(max))throw new Error('APP_INPUT_RANGE: '+key(field));
  if(type==='BOOLEAN'&&![true,false,'true','false','0','1',0,1].includes(value))throw new Error('APP_INPUT_BOOLEAN: '+key(field));
  if(['IMAGE','VIDEO','AUDIO'].includes(type)&&!/^https:\/\//.test(String(value)))throw new Error('APP_MEDIA_URL_REQUIRED: '+key(field));
  const options=meta.options || (Array.isArray(data?.[0])?data[0]:Array.isArray(data)&&!meta.options&&!data[1]?.options&&typeof data[1]!=='object'?data:null);
  if(type==='LIST'&&Array.isArray(options)&&!options.some(o=>String(o?.value??o?.name??o)===String(value)))throw new Error('APP_INPUT_OPTION: '+key(field));
 }
 function resolvedApp(snapshot,nodeId){
  const node=clone(snapshot.nodes.find(n=>n.id===nodeId));if(!node||node.type!=='rh-ai'||!node.data?.aiApp?.id)throw new Error('AI_APP_NOT_CONFIGURED');
  const used=[nodeId],errors=[],warnings=[];
  for(const field of node.data.aiApp.inputNodes || []){
   try{
    const binding=field.binding;
    if(binding?.sourceNodeId){
     const source=snapshot.nodes.find(n=>n.id===binding.sourceNodeId);if(!source||!snapshot.edges.some(e=>e.source===source.id&&e.target===nodeId))throw new Error('APP_BINDING_DISCONNECTED: '+key(field));
     used.push(source.id);const type=String(field.fieldType).toLowerCase();
     const values=type==='string'?[source.data?.text ?? source.data?.params?.prompt ?? '']:F.mediaUrls(source,type);
     let chosen=values.includes(field.fieldValue)?field.fieldValue:values.length===1?values[0]:null;
     if(chosen==null && !values.length && ['image','video','audio'].includes(type) && (field.fieldValue==='None'||empty(field.fieldValue)) && !field.required && !field.isRequired){chosen='None';warnings.push('EMPTY_OPTIONAL_REFERENCE: '+key(field));}
     if(chosen==null)throw new Error('APP_BINDING_AMBIGUOUS: '+key(field));field.fieldValue=chosen;
    }
    validateValue(field,field.fieldValue);delete field.binding;
   }catch(e){errors.push(e.message);}
  }
  return {node,used:[...new Set(used)],errors,warnings};
 }
 async function appPreflight(snapshot,nodeId){
  const resolved=resolvedApp(snapshot,nodeId);const pinned=resolved.used.map(id=>F.nodeState(snapshot,id));
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(F.canonical(pinned)));
  return {ok:resolved.errors.length===0,nodeId,appId:resolved.node.data.aiApp.id,errors:resolved.errors,warnings:resolved.warnings,digest:Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join(''),resolvedNode:resolved.node};
 }
 globalThis.RHProductionFeatures={validateValue,resolvedApp,appPreflight,
 create({api,withMutation,readSnapshot,toYValue,models}){
  const patch=async(command,fn)=>withMutation(command,ctx=>{const before={nodes:ctx.nodes.toJSON(),edges:ctx.edges.toJSON()},after=fn(clone(before));ctx.doc.transact(()=>{
   const changed=new Map(after.nodes.map(n=>[n.id,n]));for(let i=0;i<ctx.nodes.length;i++){const old=ctx.nodes.get(i).toJSON?.()||ctx.nodes.get(i),next=changed.get(old.id);if(!next){ctx.nodes.delete(i--,1);continue;}if(F.canonical(old)!==F.canonical(next)){ctx.nodes.delete(i,1);ctx.nodes.insert(i,[toYValue(ctx.Y,next)]);}changed.delete(old.id);}for(const n of changed.values())ctx.nodes.push([toYValue(ctx.Y,n)]);
   if(F.canonical(before.edges)!==F.canonical(after.edges)){ctx.edges.delete(0,ctx.edges.length);ctx.edges.push(after.edges.map(e=>toYValue(ctx.Y,e)));}
  });return {nodeIds:after.changed || [],generationTriggered:false};});
  const appSchema=async({appId,nodeId})=>{if(!appId){const s=await readSnapshot();appId=s.nodes.find(n=>n.id===nodeId)?.data?.aiApp?.id;}if(!appId)throw new Error('AI_APP_ID_REQUIRED');return {appId,detail:await api('/api/webapp/detail',{webappId:appId})};};
  const createApp=async c=>{const {detail}=await appSchema(c);if(!Array.isArray(detail.inputNodes))throw new Error('AI_APP_SCHEMA_UNSUPPORTED');return patch(c,s=>{if(s.nodes.some(n=>n.id===c.nodeId))throw new Error('NODE_ID_EXISTS');s.nodes.push({id:c.nodeId,type:'rh-ai',position:{x:c.x,y:c.y},data:{title:c.title||detail.name,label:c.title||detail.name,width:320,height:200,status:'idle',apiKeyMode:'standard',instanceType:detail.instanceType||'default',aiApp:{id:c.appId,name:detail.name,workflowId:detail.workflowId,instanceType:detail.instanceType||'default',inputNodes:detail.inputNodes.map(f=>{const v={...f};delete v.binding;return v;}),covers:detail.covers||[],priceInfo:detail.priceInfo||null},output:[]}});s.changed=[c.nodeId];return s;});};
  const configureApp=async c=>patch(c,s=>{
   const node=s.nodes.find(n=>n.id===c.nodeId);if(node?.type!=='rh-ai'||!Array.isArray(node.data?.aiApp?.inputNodes))throw new Error('AI_APP_NOT_CONFIGURED');
   const fields=node.data.aiApp.inputNodes;const seen=new Set();
   for(const input of c.inputs){const k=key(input);if(seen.has(k))throw new Error('APP_INPUT_DUPLICATE');seen.add(k);const field=fields.find(f=>key(f)===k);if(!field)throw new Error('APP_INPUT_UNKNOWN: '+k);
    if(input.sourceNodeId){const source=s.nodes.find(n=>n.id===input.sourceNodeId);if(!source||source.id===node.id)throw new Error('APP_SOURCE_NOT_FOUND');const type=String(field.fieldType).toLowerCase();const values=type==='string'?[source.data?.text??source.data?.params?.prompt??'']:F.mediaUrls(source,type);const value=input.value??(values.length===1?values[0]:null);if(value==null||!values.includes(value))throw new Error('APP_SOURCE_OUTPUT_AMBIGUOUS');validateValue(field,value);field.fieldValue=value;field.binding={sourceNodeId:source.id,sourceHandle:'output'};if(!s.edges.some(e=>e.source===source.id&&e.target===node.id))s.edges.push({id:'e-'+source.id+'-'+node.id,source:source.id,target:node.id,sourceHandle:'output',targetHandle:'input',type:'default'});
    }else{validateValue(field,input.value);field.fieldValue=input.value;delete field.binding;}
   }
   if(c.instanceType){node.data.instanceType=c.instanceType;node.data.aiApp.instanceType=c.instanceType;}
   if(c.apiKeyMode)node.data.apiKeyMode=c.apiKeyMode;
   s.changed=[node.id];return s;
  });
  const createModel=async c=>{
   const schema=await models.modelSchema({modelCode:c.modelCode,types:[c.modelType]});if(schema.models.length!==1)throw new Error('MODEL_SCHEMA_AMBIGUOUS');const model=schema.models[0],params=Object.fromEntries(model.parameters.filter(p=>p.default!==undefined).map(p=>[p.name,p.default]));Object.assign(params,c.params||{});const validation=models.validateParameters(params,model.parameters);if(!validation.ok)throw new Error('MODEL_PARAMS_INVALID: '+validation.errors.join(';'));
   const output=c.modelType.split('_').at(-1);const type=output==='VIDEO'?'rh-video':output==='IMAGE'?'rh-image':['AUDIO','MUSIC'].includes(output)?'rh-audio':'rh-text';
   return patch(c,s=>{let n=s.nodes.find(n=>n.id===c.nodeId);if(n&&!c.replaceModel)throw new Error('NODE_ID_EXISTS');if(!n){n={id:c.nodeId,type,position:{x:c.x,y:c.y},data:{width:380,height:280,status:'idle'}};s.nodes.push(n);}n.type=type;n.data={...n.data,title:c.title||n.data.title||model.name,label:c.title||n.data.label||model.name,modelCode:c.modelCode,subType:c.modelType.toLowerCase().replaceAll('_','-'),params};s.changed=[n.id];return s;});
  };
  const editGroups=async c=>patch(c,s=>{
   const selected=new Set(c.nodeIds||[]),group=s.nodes.find(n=>n.id===c.groupId);
   if(c.action==='rename'){if(group?.type!=='group')throw new Error('GROUP_NOT_FOUND');group.data.groupName=c.title;}
   else if(c.action==='ungroup'){if(group?.type!=='group')throw new Error('GROUP_NOT_FOUND');s.nodes=s.nodes.filter(n=>n.id!==c.groupId);for(const n of s.nodes)if(n.data?.groupId===c.groupId){delete n.data.groupId;delete n.data.addNewGroup;}}
   else{
    if(!selected.size)throw new Error('GROUP_MEMBERS_REQUIRED');for(const id of selected){const n=s.nodes.find(n=>n.id===id);if(!n||n.type==='group')throw new Error('GROUP_MEMBER_INVALID');}
    if(group&&group.type!=='group')throw new Error('GROUP_ID_OCCUPIED');if(!group)s.nodes.push({id:c.groupId,type:'group',position:{x:0,y:0},zIndex:-1000,selectable:false,data:{groupName:c.title||'Group',nodeIds:[]}});
    for(const n of s.nodes)if(selected.has(n.id)){n.data={...n.data,groupId:c.groupId,addNewGroup:false};}
   }
   refreshGroups(s);
   s.changed=[c.groupId,...selected];return s;
  });
  const transformNodes=async c=>patch(c,s=>{for(const change of c.nodes){const n=s.nodes.find(n=>n.id===change.nodeId);if(!n)throw new Error('NODE_NOT_FOUND');if(n.type==='group'){if(change.width!=null)throw new Error('GROUP_SIZE_IS_DERIVED');const dx=(change.x??n.position.x)-n.position.x,dy=(change.y??n.position.y)-n.position.y;for(const member of s.nodes.filter(m=>m.data?.groupId===n.id)){member.position.x+=dx;member.position.y+=dy;}}if(change.x!=null)n.position.x=change.x;if(change.y!=null)n.position.y=change.y;if(change.width!=null){n.width=change.width;n.height=change.height;n.style={...n.style,width:change.width,height:change.height};n.data={...n.data,width:change.width,height:change.height,opResize:true};}}refreshGroups(s);s.changed=c.nodes.map(n=>n.nodeId);return s;});
  const applyWorkflow=async c=>{const detail=await api('/canvas/workflow/detail',{id:c.workflowId});let graph=detail.workflowContent;for(let i=0;i<4&&typeof graph==='string';i++)graph=JSON.parse(graph);if(!Array.isArray(graph?.nodes)||!Array.isArray(graph?.edges))throw new Error('WORKFLOW_SCHEMA_UNSUPPORTED');return patch(c,s=>{const ids=new Map(graph.nodes.map((n,i)=>[n.id,c.prefix+'-'+i]));for(const id of ids.values())if(s.nodes.some(n=>n.id===id))throw new Error('WORKFLOW_ALREADY_APPLIED');for(const n0 of graph.nodes){const n=clone(n0);n.id=ids.get(n.id);n.position={x:Number(n.position?.x||0)+c.x,y:Number(n.position?.y||0)+c.y};if(n.data?.groupId)n.data.groupId=ids.get(n.data.groupId);if(n.data?.nodeIds)n.data.nodeIds=n.data.nodeIds.map(id=>ids.get(id)).filter(Boolean);if(n.data?.nodeOffsets)n.data.nodeOffsets=Object.fromEntries(Object.entries(n.data.nodeOffsets).filter(([id])=>ids.has(id)).map(([id,v])=>[ids.get(id),v]));for(const f of n.data?.aiApp?.inputNodes||[])if(f.binding){const sourceId=ids.get(f.binding.sourceNodeId);if(sourceId)f.binding.sourceNodeId=sourceId;else delete f.binding;}s.nodes.push(n);}for(const e of graph.edges){if(ids.has(e.source)&&ids.has(e.target))s.edges.push({...e,id:c.prefix+'-'+e.id,source:ids.get(e.source),target:ids.get(e.target)});}s.changed=[...ids.values()];return s;});};
  const addTaskOutput=async c=>{
   const data=await api('/canvas/task/batchStatus',{taskIds:[c.taskId],includeResults:true});const task=data.tasks?.find(t=>String(t.taskId)===c.taskId);if(!task)throw new Error('TASK_NOT_FOUND');const plans=task.plans||[];const plan=c.planId?plans.find(p=>String(p.planId)===c.planId):plans.length===1?plans[0]:null;if(!plan)throw new Error('TASK_PLAN_REQUIRED');const output=plan.outputs?.[c.outputIndex];if(!output?.url)throw new Error('TASK_OUTPUT_NOT_FOUND');const ext=String(output.outputType||'').toLowerCase();const kind=['mp4','mov','webm','video'].includes(ext)?'video':['wav','mp3','m4a','aac','flac','ogg','audio'].includes(ext)?'audio':['png','jpg','jpeg','webp','image'].includes(ext)?'image':null;if(!kind)throw new Error('OUTPUT_MEDIA_KIND_UNSUPPORTED');
   return patch(c,s=>{const existing=s.nodes.find(n=>F.mediaUrls(n,kind).includes(output.url));if(existing){s.changed=[existing.id];return s;}if(s.nodes.some(n=>n.id===c.nodeId))throw new Error('NODE_ID_EXISTS');s.nodes.push({id:c.nodeId,type:'rh-'+kind,position:{x:c.x,y:c.y},data:{title:c.title||'History output',label:c.title||'History output',width:380,height:kind==='audio'?160:240,status:'idle',sourceObjects:[output.url],[kind+'Url']:output.url,historySource:{taskId:c.taskId,planId:String(plan.planId),outputIndex:c.outputIndex}}});s.changed=[c.nodeId];return s;});
  };
  const platformRead=async c=>{
   const endpoints={assetTypes:'/canvas/asset/type/list',apps:c.view==='mine'?'/api/webapp/user/list':'/api/webapp/list',tasks:'/canvas/task/batchStatus',history:'/canvas/his/list',historyInputs:'/canvas/his/generate/param/detail',workflows:'/canvas/workflow/list',workflow:'/canvas/workflow/detail'};
   if(!endpoints[c.operation])throw new Error('PLATFORM_OPERATION_INVALID');return api(endpoints[c.operation],c.body||{});
  };
  const platformWrite=async c=>{
   const endpoints={cancel:'/canvas/task/cancel',renameCanvas:'/canvas/rename',createCanvas:'/canvas/create',createFolder:'/canvas/folder/create',renameFolder:'/canvas/folder/update',moveCanvas:'/canvas/move/v1/submit',renameAsset:'/canvas/asset/user/group/item/rename',renameAssetFolder:'/canvas/asset/user/group/rename',createAssetFolder:'/canvas/asset/user/folder/create',moveAssets:'/canvas/asset/user/folder/move',saveWorkflow:'/canvas/workflow/save',saveAsset:'/canvas/asset/user/folder/item/batch-add'};
   if(!endpoints[c.operation])throw new Error('PLATFORM_OPERATION_INVALID');if(c.operation==='cancel'){const current=await api('/canvas/task/batchStatus',{taskIds:[c.body.taskId]});const task=current.tasks?.find(t=>String(t.taskId)===String(c.body.taskId));if(!task)throw new Error('TASK_NOT_FOUND');if(String(task.canvasId)!==String(globalThis.RHCanvasSitePolicy.parseCanvas(location.href).canvasId))throw new Error('TASK_CANVAS_MISMATCH');if(['SUCCESS','FAILED','CANCELED','CANCELLED'].includes(task.status))return {cancelled:false,terminal:true,status:task.status};}if(c.dryRun)return {dryRun:true,request:{endpoint:endpoints[c.operation],body:c.body}};return api(endpoints[c.operation],c.body||{});
  };
  return {addTaskOutput,appSchema,createApp,configureApp,createModel,editGroups,transformNodes,applyWorkflow,platformRead,platformWrite,appPreflight:async c=>appPreflight(await readSnapshot(),c.nodeId)};
 }
 };
})();
