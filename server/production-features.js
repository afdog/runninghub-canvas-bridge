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
 // A copied graph is new work. Keep media provenance separately from native ownership.
 const cloneGraph=(graph,{prefix,keepOutputs=true,sourceCanvasId=null}={})=>{
  if(!prefix)throw Error('COPY_PREFIX_REQUIRED');
  const ids=new Map(graph.nodes.map((n,i)=>[n.id,prefix+'-'+i]));
  const nodes=graph.nodes.map(original=>{
   const n=clone(original),d=n.data||{};n.id=ids.get(n.id);n.selected=false;delete n.dragging;
   for(const k of ['parentId','parentNode'])if(n[k]){if(ids.has(n[k]))n[k]=ids.get(n[k]);else delete n[k];}
   d.bridgeSource={canvasId:sourceCanvasId,nodeId:original.id,taskId:d.taskId||null};
   for(const k of ['taskId','jobId','localVideoEditTaskId','localVideoEditStatus','historyStorage','nodeOutputHistory','outputHistory','selectedHistoryBatchId','selectedHistoryOutputId','selectedOutputHistoryId','selectedOutputHistoryIndex','progress','error','errorMsg','queuePosition','accepted','adopted','adoption','adoptionStatus'])delete d[k];
   d.status='idle';
   if(!keepOutputs)d.output=[];
   else if(Array.isArray(d.output))d.output=d.output.map(o=>{if(!o||typeof o!=='object')return o;const v={...o};for(const k of ['taskId','jobId','historyOutputId','outputId'])delete v[k];return v;});
   if(d.groupId){if(ids.has(d.groupId))d.groupId=ids.get(d.groupId);else delete d.groupId;}
   if(d.nodeIds)d.nodeIds=d.nodeIds.map(id=>ids.get(id)).filter(Boolean);
   if(d.nodeOffsets)d.nodeOffsets=Object.fromEntries(Object.entries(d.nodeOffsets).filter(([id])=>ids.has(id)).map(([id,v])=>[ids.get(id),v]));
   for(const f of d.aiApp?.inputNodes||[])if(f.binding){const id=ids.get(f.binding.sourceNodeId);if(id)f.binding.sourceNodeId=id;else delete f.binding;}
   n.data=d;return n;
  });
  const edges=graph.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)).map((e,i)=>({...clone(e),id:prefix+'-edge-'+i,source:ids.get(e.source),target:ids.get(e.target)}));
  return {...graph,nodes,edges};
 };
 const historyPatch=(batch,output,current,restoreParams,appBindingPolicy='preserve',effectiveFields)=>{
  const selected={historyOutputId:String(output.outputId),taskId:String(batch.taskId),url:output.url,outputType:output.outputType};
  for(const key of ['mediaId','originalUrl','width','height','durationMs'])if(output[key]!=null)selected[key]=clone(output[key]);
  if(output.thumbnailUrl)selected.thumbnail=output.thumbnailUrl;
  const patch={output:[selected],selectedHistoryBatchId:String(batch.batchId),selectedHistoryOutputId:String(output.outputId)};
  if(restoreParams){
   if(!batch.paramsSnapshot||typeof batch.paramsSnapshot!=='object'||Array.isArray(batch.paramsSnapshot))throw Error('HISTORY_PARAMS_UNAVAILABLE');
   if(current.aiApp?.id){
    const saved=batch.paramsSnapshot.nodeInfoList,fields=current.aiApp.inputNodes;
    if(String(batch.nodeConfigSnapshot?.modelCode)!==String(current.aiApp.id)||!Array.isArray(saved)||!Array.isArray(fields)||saved.length!==fields.length||new Set(saved.map(key)).size!==saved.length||saved.some(f=>!fields.some(x=>key(x)===key(f))))throw Error('HISTORY_APP_SCHEMA_MISMATCH');
    if(!['preserve','detach_changed'].includes(appBindingPolicy))throw Error('INVALID_BINDING_POLICY');
    patch.aiApp=clone(current.aiApp);
    for(const f of patch.aiApp.inputNodes){const historic=saved.find(x=>key(x)===key(f)),effective=(effectiveFields||fields).find(x=>key(x)===key(f));validateValue(f,historic.fieldValue);
     if(f.binding&&F.canonical(effective.fieldValue)!==F.canonical(historic.fieldValue)){if(appBindingPolicy!=='detach_changed')throw Error('HISTORY_BOUND_INPUT_CONFLICT: '+key(f)+'; explicitly choose detach_changed to restore literals without editing shared references');delete f.binding;}
     f.fieldValue=clone(historic.fieldValue);
    }
    if(Number.isInteger(batch.nodeConfigSnapshot.generateNum))patch.generateNum=batch.nodeConfigSnapshot.generateNum;
    return patch;
   }
   patch.params=clone(batch.paramsSnapshot);
   for(const [k,v]of Object.entries(patch.params))if(v==='[HIDDEN_SYSTEM_PROMPT_APPLIED]'){if(Object.hasOwn(current.params||{},k))patch.params[k]=clone(current.params[k]);else delete patch.params[k];}
   const config=batch.nodeConfigSnapshot||{};
   for(const k of ['modelCode','subType','generateNum','toolsType','currentModel','presetSelections','panorama','audioModelListType','audioVoiceSelection'])if(Object.hasOwn(config,k)&&(k!=='presetSelections'||Array.isArray(config[k])))patch[k]=clone(config[k]);
   const prompt=config.userPromptSnapshot;
   if(prompt&&typeof prompt.paramName==='string'&&prompt.paramName&&typeof prompt.value==='string')patch.params[prompt.paramName]=prompt.value;
   else {const presets=patch.presetSelections||current.presetSelections;if(Array.isArray(presets))patch.presetSelections=presets.filter(p=>p&&typeof p==='object'&&(String(p.promptCode||'').trim()||!['prompt','prefixPrompt','suffixPrompt','prefix','suffix','STYLE_PROMPTS','FILM_FILTER_PROMPTS','VIEW_MODE_PROMPTS','stylePrompt','des'].some(k=>typeof p[k]==='string'&&p[k].trim())));}
  }
  return patch;
 };
 globalThis.RHProductionFeatures={validateValue,resolvedApp,appPreflight,cloneGraph,historyPatch,
 create({api,withMutation,readSnapshot,toYValue,models,uploadImage,isCurrent=()=>true}){
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
  const insertGraph=async(c,graph)=>patch(c,s=>{const copy=cloneGraph(graph,{prefix:c.prefix,keepOutputs:c.keepOutputs!==false,sourceCanvasId:graph.canvasId});for(const n of copy.nodes){if(s.nodes.some(old=>old.id===n.id))throw Error('COPY_ALREADY_EXISTS');n.position={x:Number(n.position?.x||0)+c.x,y:Number(n.position?.y||0)+c.y};}s.nodes.push(...copy.nodes);s.edges.push(...copy.edges);s.changed=copy.nodes.map(n=>n.id);return s;});
  const applyWorkflow=async c=>{const detail=await api('/canvas/workflow/detail',{id:c.workflowId});let graph=detail.workflowContent;for(let i=0;i<4&&typeof graph==='string';i++)graph=JSON.parse(graph);if(!Array.isArray(graph?.nodes)||!Array.isArray(graph?.edges))throw Error('WORKFLOW_SCHEMA_UNSUPPORTED');return insertGraph(c,graph);};
  const cloneNodes=async c=>{const s=await readSnapshot(),chosen=new Set(c.nodeIds);if(!chosen.size||c.nodeIds.some(id=>!s.nodes.some(n=>n.id===id)))throw Error('NODE_NOT_FOUND');return insertGraph(c,{...s,nodes:s.nodes.filter(n=>chosen.has(n.id)),edges:s.edges.filter(e=>chosen.has(e.source)&&chosen.has(e.target))});};

  const addTaskOutput=async c=>{
   const data=await api('/canvas/task/batchStatus',{taskIds:[c.taskId],includeResults:true});const task=data.tasks?.find(t=>String(t.taskId)===c.taskId);if(!task)throw new Error('TASK_NOT_FOUND');const plans=task.plans||[];const plan=c.planId?plans.find(p=>String(p.planId)===c.planId):plans.length===1?plans[0]:null;if(!plan)throw new Error('TASK_PLAN_REQUIRED');const output=plan.outputs?.[c.outputIndex];if(!output?.url)throw new Error('TASK_OUTPUT_NOT_FOUND');const ext=String(output.outputType||'').toLowerCase();const kind=['mp4','mov','webm','video'].includes(ext)?'video':['wav','mp3','m4a','aac','flac','ogg','audio'].includes(ext)?'audio':['png','jpg','jpeg','webp','image'].includes(ext)?'image':null;if(!kind)throw new Error('OUTPUT_MEDIA_KIND_UNSUPPORTED');
   return patch(c,s=>{const existing=s.nodes.find(n=>F.mediaUrls(n,kind).includes(output.url));if(existing){s.changed=[existing.id];return s;}if(s.nodes.some(n=>n.id===c.nodeId))throw new Error('NODE_ID_EXISTS');s.nodes.push({id:c.nodeId,type:'rh-'+kind,position:{x:c.x,y:c.y},data:{title:c.title||'History output',label:c.title||'History output',width:380,height:kind==='audio'?160:240,status:'idle',sourceObjects:[output.url],[kind+'Url']:output.url,historySource:{taskId:c.taskId,planId:String(plan.planId),outputIndex:c.outputIndex}}});s.changed=[c.nodeId];return s;});
  };
  // Native task history is server-owned. Repair only its Yjs pointer, never synthesize entries.
  const historyIdentity=(page,canvasId,nodeId)=>{
   if(!page || String(page.canvasId)!==canvasId || page.nodeId!==nodeId)throw Error('HISTORY_IDENTITY_MISMATCH');
   if(page.schemaVersion!==1 || !Array.isArray(page.batches) || !Number.isSafeInteger(page.resultCount) || page.resultCount<0 || !Number.isSafeInteger(page.totalBatchCount) || page.totalBatchCount<0)throw Error('HISTORY_SCHEMA_UNSUPPORTED');
   if(page.resultCount && (typeof page.historyId!=='string' || !page.historyId || typeof page.revision!=='string'))throw Error('HISTORY_INDEX_INVALID');
   return page;
  };
  const nodeHistory=async ({nodeId,pageNum=1,pageSize=20,historyId,knownRevision}={})=>{
   const canvasId=globalThis.RHCanvasSitePolicy.parseCanvas(location.href).canvasId;
   // The first page resolves this node's own index, even if a copied/stale pointer exists.
   return historyIdentity(await api('/canvas/node-history/page',{canvasId,nodeId,pageNum,pageSize,...(pageNum>1?{historyId,knownRevision}:{})}),canvasId,nodeId);
  };
  const syncNodeHistory=async c=>{
   const before=await readSnapshot(),node=before.nodes.find(n=>n.id===c.nodeId);
   if(!node)throw Error('NODE_NOT_FOUND');
   const canvasId=globalThis.RHCanvasSitePolicy.parseCanvas(location.href).canvasId;
   let expectedSuccess=false;
   if(c.taskId){
    const tasks=await api('/canvas/task/batchStatus',{taskIds:[c.taskId],includeResults:true});
    const task=tasks.tasks?.find(t=>String(t.taskId)===c.taskId);
    if(!task || String(task.canvasId)!==canvasId || !task.plans?.some(p=>p.nodeId===node.id))throw Error('HISTORY_TASK_NODE_MISMATCH');
    expectedSuccess=task.status==='SUCCESS';
    if(!['SUCCESS','FAILED','CANCELED','CANCELLED'].includes(task.status))return {pending:true,reason:'TASK_RUNNING',taskId:c.taskId};
   }
   const first=await nodeHistory({nodeId:node.id});
   if(!first.resultCount){
    if(expectedSuccess)return {pending:true,reason:'HISTORY_NOT_PERSISTED',taskId:c.taskId};
    const previous=node.data?.historyStorage;
    if(previous?.source==='remote'&&previous.resultCount>0){
     const historyStorage={source:'remote',schemaVersion:1,...first.historyId?{historyId:first.historyId}:{},...typeof first.revision==='string'?{revision:first.revision}:{},resultCount:0};
     return withMutation(c,({Y,doc,nodes})=>{const data=nodes.toArray().find(n=>n.get('id')===node.id)?.get('data');if(!data||F.canonical(data.get('historyStorage')?.toJSON?.()??data.get('historyStorage'))!==F.canonical(previous))throw Error('EDIT_CONFLICT');doc.transact(()=>data.set('historyStorage',toYValue(Y,historyStorage)));return {nodeId:node.id,changed:true,historyStorage,historyButtonEligible:false};});
    }
    return {changed:false,reason:'NO_NATIVE_HISTORY',nodeId:node.id};
   }
   const batches=[...first.batches];let page=first;
   for(let num=2;page.hasNext;num++){
    if(num>500)throw Error('HISTORY_PAGINATION_LIMIT');
    page=await nodeHistory({nodeId:node.id,pageNum:num,historyId:first.historyId,knownRevision:first.revision});
    if(page.historyId!==first.historyId || page.revision!==first.revision || page.resultCount!==first.resultCount || page.totalBatchCount!==first.totalBatchCount)throw Error('HISTORY_CHANGED_DURING_READ');
    batches.push(...page.batches);
   }
   const outputIds=new Set(),batchIds=new Set(),taskIds=new Set();
   for(const b of batches){
    if(typeof b.taskId!=='string' || !b.taskId || !b.batchId || batchIds.has(b.batchId) || !Array.isArray(b.outputs))throw Error('HISTORY_BATCH_INVALID');
    batchIds.add(b.batchId);taskIds.add(b.taskId);
    for(const o of b.outputs){if(typeof o.outputId!=='string' || !o.outputId || outputIds.has(o.outputId) || !o.url)throw Error('HISTORY_OUTPUT_INVALID');outputIds.add(o.outputId);}
   }
   if(batches.length!==first.totalBatchCount || outputIds.size!==first.resultCount)throw Error('HISTORY_COUNT_MISMATCH');
   if(expectedSuccess&&!taskIds.has(c.taskId))return {pending:true,reason:'HISTORY_NOT_PERSISTED',taskId:c.taskId};
   // Independently confirm each batch's task, plan, node, and output; never borrow an index.
   const verified=new Map(),ids=[...taskIds];
   for(let i=0;i<ids.length;i+=20){const result=await api('/canvas/task/batchStatus',{taskIds:ids.slice(i,i+20),includeResults:true});for(const t of result.tasks||[])verified.set(String(t.taskId),t);}
   let archivedTasks=0;
   for(const b of batches){
    const t=verified.get(b.taskId),plans=t?.plans?.filter(p=>p.nodeId===node.id)||[];
    if(!t){
     if(node.data?.historyStorage?.source==='remote'&&node.data.historyStorage.historyId===first.historyId&&b.taskId!==c.taskId){archivedTasks++;continue;}
     throw Error('HISTORY_TASK_UNAVAILABLE: '+b.taskId);
    }
    if(String(t.canvasId)!==canvasId || !plans.length)throw Error('HISTORY_TASK_NODE_MISMATCH: '+b.taskId);
    const urls=new Set(plans.flatMap(p=>p.outputs||[]).flatMap(o=>[o.url,o.originalUrl].filter(Boolean)));
    if(b.outputs.some(o=>!urls.has(o.url)&&!urls.has(o.originalUrl)))throw Error('HISTORY_TASK_OUTPUT_MISMATCH: '+b.taskId);
   }
   const historyStorage={source:'remote',schemaVersion:1,historyId:first.historyId,revision:first.revision,resultCount:first.resultCount};
   return withMutation(c,({Y,doc,nodes})=>{
    if(!isCurrent())throw Error('RUNTIME_REPLACED: reconcile history on the current connection');
    const live=nodes.toArray().find(n=>n.get('id')===node.id),data=live?.get('data');
    if(!data || typeof data.set!=='function')throw Error('NODE_DATA_SCHEMA_UNSUPPORTED');
    if(F.canonical(data.get('historyStorage')?.toJSON?.()??data.get('historyStorage'))!==F.canonical(node.data?.historyStorage) || data.get('taskId')!==node.data?.taskId)throw Error('EDIT_CONFLICT: history or task changed');
    const changed=F.canonical(node.data?.historyStorage)!==F.canonical(historyStorage);
    if(changed)doc.transact(()=>data.set('historyStorage',toYValue(Y,historyStorage)));
    return {nodeId:node.id,changed,historyStorage,verifiedTasks:ids.length-archivedTasks,archivedTasks,historyButtonEligible:first.resultCount>=2};
   });
  };
  const selectHistory=async c=>{
   const snapshot=await readSnapshot(),node=snapshot.nodes.find(n=>n.id===c.nodeId);
   if(!node)throw Error('NODE_NOT_FOUND');
   if(/running|queued|processing/i.test(node.data?.status||''))throw Error('NODE_BUSY');
   const first=await nodeHistory({nodeId:c.nodeId});
   if(first.historyId!==c.historyId||first.revision!==c.knownRevision)throw Error('HISTORY_REVISION_CONFLICT');
   let page=first;
   for(let num=1;num<=500;num++){
    if(page.historyId!==first.historyId||page.revision!==first.revision)throw Error('HISTORY_REVISION_CONFLICT');
    for(const batch of page.batches){const output=batch.outputs.find(o=>o.outputId===c.outputId);if(output)return {snapshot,node,first,batch,output};}
    if(!page.hasNext)break;
    page=await nodeHistory({nodeId:c.nodeId,pageNum:num+1,historyId:first.historyId,knownRevision:first.revision});
   }
   throw Error('HISTORY_OUTPUT_NOT_FOUND');
  };
  const applyNodeHistory=async c=>{
   const {snapshot,node,batch,output}=await selectHistory(c),effective=node.data.aiApp?.id&&c.restoreParams?resolvedApp(snapshot,node.id).node.data.aiApp.inputNodes:undefined,update=historyPatch(batch,output,node.data,c.restoreParams===true,c.appBindingPolicy,effective);
   return patch(c,s=>{const current=s.nodes.find(n=>n.id===c.nodeId);if(F.canonical(current)!==F.canonical(node))throw Error('EDIT_CONFLICT');Object.assign(current.data,update);s.changed=[c.nodeId];return s;});
  };
  const deleteNodeHistory=async c=>{
   const {node,first,output}=await selectHistory(c);
   if(node.data?.selectedHistoryOutputId===c.outputId||F.mediaUrls(node,'video').concat(F.mediaUrls(node,'image'),F.mediaUrls(node,'audio')).some(url=>[output.url,output.originalUrl].includes(url)))throw Error('CURRENT_OUTPUT_DELETE_REFUSED');
   if(c.dryRun)return {dryRun:true,nodeId:c.nodeId,outputId:c.outputId,expectedRevision:first.revision};
   const result=await api('/canvas/node-history/delete-output',{canvasId:first.canvasId,nodeId:c.nodeId,historyId:first.historyId,outputId:c.outputId,expectedRevision:first.revision});
   // The deletion is not retried if this follow-up fails. Re-read its native index.
   try {return {deleted:true,result,sync:await syncNodeHistory(c)};}catch(error){return {deleted:true,result,syncPending:true,error:error.message};}
  };
  const processBrowserMedia=async c=>{
   const before=await readSnapshot(),node=before.nodes.find(n=>n.id===c.sourceNodeId);
   if(!node||F.canonical(node)!==c.sourceSnapshot)throw Error('SOURCE_CHANGED_REPLAN');
   if(!['capture_frame','crop','resize','rotate','flip'].includes(c.operation))throw Error('BROWSER_OPERATION_UNSUPPORTED');
   const kind=c.operation==='capture_frame'?'video':'image';
   if(!F.mediaUrls(node,kind).includes(c.sourceUrl))throw Error('SOURCE_MEDIA_MISMATCH');
   if(before.nodes.some(n=>n.id===c.outputNodeId))throw Error('OUTPUT_NODE_ALREADY_EXISTS');
   if(c.dryRun)return {dryRun:true,operation:c.operation,generationTriggered:false};
   const p=c.options||{},media=document.createElement(kind==='video'?'video':'img');media.crossOrigin='anonymous';
   const event=(name,action)=>new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);media.removeEventListener(name,ok);media.removeEventListener('error',fail);};const ok=()=>{done();resolve();};const fail=()=>{done();reject(Error('MEDIA_DECODE_FAILED'));};const timer=setTimeout(()=>{done();reject(Error('MEDIA_DECODE_TIMEOUT'));},20000);media.addEventListener(name,ok,{once:true});media.addEventListener('error',fail,{once:true});action();});
   try{
    await event(kind==='video'?'loadeddata':'load',()=>{media.src=c.sourceUrl;});
    let width=media.videoWidth||media.naturalWidth,height=media.videoHeight||media.naturalHeight;
    if(!width||!height||width*height>16777216)throw Error('BROWSER_PIXEL_LIMIT');
    if(kind==='video'){if(!Number.isFinite(p.time)||p.time<0||p.time>=media.duration)throw Error('FRAME_OUT_OF_RANGE');if(p.time!==media.currentTime)await event('seeked',()=>{media.currentTime=p.time;});}
    if(['crop','resize'].includes(c.operation)){if(!Number.isInteger(p.width)||!Number.isInteger(p.height)||p.width<2||p.height<2||p.width*p.height>16777216)throw Error('INVALID_DIMENSIONS');}
    if(c.operation==='crop'&&(!Number.isInteger(p.x)||!Number.isInteger(p.y)||p.x<0||p.y<0||p.x+p.width>width||p.y+p.height>height))throw Error('CROP_OUT_OF_BOUNDS');
    if(c.operation==='rotate'&&![90,180,270].includes(p.degrees))throw Error('INVALID_ROTATION');
    if(c.operation==='flip'&&!['horizontal','vertical'].includes(p.axis))throw Error('INVALID_FLIP');
    const canvas=document.createElement('canvas');canvas.width=['crop','resize'].includes(c.operation)?p.width:c.operation==='rotate'&&p.degrees!==180?height:width;canvas.height=['crop','resize'].includes(c.operation)?p.height:c.operation==='rotate'&&p.degrees!==180?width:height;
    const ctx=canvas.getContext('2d');if(!ctx)throw Error('CANVAS_CONTEXT_UNAVAILABLE');
    if(c.operation==='rotate'){ctx.translate(canvas.width/2,canvas.height/2);ctx.rotate(p.degrees*Math.PI/180);ctx.drawImage(media,-width/2,-height/2);}
    else if(c.operation==='flip'){ctx.translate(p.axis==='horizontal'?width:0,p.axis==='vertical'?height:0);ctx.scale(p.axis==='horizontal'?-1:1,p.axis==='vertical'?-1:1);ctx.drawImage(media,0,0);}
    else if(c.operation==='crop')ctx.drawImage(media,p.x,p.y,p.width,p.height,0,0,p.width,p.height);
    else ctx.drawImage(media,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob||blob.size>30*1024*1024)throw Error('PROCESSED_IMAGE_TOO_LARGE');
    const current=await readSnapshot();if(!isCurrent()||F.canonical(current.nodes.find(n=>n.id===node.id))!==c.sourceSnapshot)throw Error('SOURCE_CHANGED_REPLAN');
    const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
    const result=await uploadImage({file:{name:c.operation+'.png',type:'image/png',base64:dataUrl.split(',')[1]},config:{id:c.outputNodeId,title:({capture_frame:'截帧',crop:'裁剪',resize:'缩放',rotate:'旋转',flip:'翻转'}[c.operation])+'｜'+(node.data?.title||node.data?.label||'素材'),x:Number(node.position?.x||0)+Number(node.data?.width||380)+80,y:Number(node.position?.y||0)}});
    await patch({},s=>{const added=s.nodes.find(n=>n.id===c.outputNodeId);if(!added)throw Error('OUTPUT_NODE_NOT_FOUND');added.data.bridgeSource={nodeId:node.id,operation:c.operation,options:p};s.changed=[added.id];return s;});
    return {...result,operation:c.operation,cost:{runningHubCredits:0},generationTriggered:false};
   }finally{media.removeAttribute('src');if(kind==='video')media.load();}
  };
  const runMediaOperation=async c=>{
   if(c.dryRun)return {dryRun:true,request:c.request};
   const s=await readSnapshot(),node=s.nodes.find(n=>n.id===c.nodeId),canvasId=globalThis.RHCanvasSitePolicy.parseCanvas(location.href).canvasId;
   if(!node||F.canonical(node)!==c.expectedNode)throw Error('EDIT_CONFLICT');
   if(c.request?.nodeId!==c.nodeId||String(c.request.bizId)!==canvasId||c.request.bizType!=='CANVAS'||c.request.executor!=='FFMPEG')throw Error('MEDIA_REQUEST_SCOPE_MISMATCH');
   if(!c.mediaGrant)throw Error('USER_CONSENT_REQUIRED');
   return api('/canvas/media/task/run',c.request);
  };
  const platformRead=async c=>{
   if(c.operation==='nodeHistory')return nodeHistory(c.body||{});
   const endpoints={assetTypes:'/canvas/asset/type/list',apps:c.view==='mine'?'/api/webapp/user/list':'/api/webapp/list',tasks:'/canvas/task/batchStatus',history:'/canvas/his/list',historyInputs:'/canvas/his/generate/param/detail',workflows:'/canvas/workflow/list',workflow:'/canvas/workflow/detail'};
   if(!endpoints[c.operation])throw new Error('PLATFORM_OPERATION_INVALID');return api(endpoints[c.operation],c.body||{});
  };
  const platformWrite=async c=>{
   if(c.operation==='syncNodeHistory')return syncNodeHistory({...c,nodeId:c.body?.nodeId,taskId:c.body?.taskId});
   const endpoints={cancel:'/canvas/task/cancel',renameCanvas:'/canvas/rename',createCanvas:'/canvas/create',createFolder:'/canvas/folder/create',renameFolder:'/canvas/folder/update',moveCanvas:'/canvas/move/v1/submit',renameAsset:'/canvas/asset/user/group/item/rename',renameAssetFolder:'/canvas/asset/user/group/rename',createAssetFolder:'/canvas/asset/user/folder/create',moveAssets:'/canvas/asset/user/folder/move',saveWorkflow:'/canvas/workflow/save',saveAsset:'/canvas/asset/user/folder/item/batch-add'};
   if(!endpoints[c.operation])throw new Error('PLATFORM_OPERATION_INVALID');if(c.operation==='cancel'){const current=await api('/canvas/task/batchStatus',{taskIds:[c.body.taskId]});const task=current.tasks?.find(t=>String(t.taskId)===String(c.body.taskId));if(!task)throw new Error('TASK_NOT_FOUND');if(String(task.canvasId)!==String(globalThis.RHCanvasSitePolicy.parseCanvas(location.href).canvasId))throw new Error('TASK_CANVAS_MISMATCH');if(['SUCCESS','FAILED','CANCELED','CANCELLED'].includes(task.status))return {cancelled:false,terminal:true,status:task.status};}if(c.dryRun)return {dryRun:true,request:{endpoint:endpoints[c.operation],body:c.body}};return api(endpoints[c.operation],c.body||{});
  };
  return {processBrowserMedia,runMediaOperation,nodeHistory,syncNodeHistory,applyNodeHistory,deleteNodeHistory,cloneNodes,addTaskOutput,appSchema,createApp,configureApp,createModel,editGroups,transformNodes,applyWorkflow,platformRead,platformWrite,appPreflight:async c=>appPreflight(await readSnapshot(),c.nodeId)};
 }
 };
})();
