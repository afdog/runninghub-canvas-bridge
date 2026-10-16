// Shared planner and checker. Geometry is derived from media, never from generation defaults alone.
(() => {
  const rules=Object.freeze({id:'scene-columns-v1',version:2,name:'场次行列与真实画幅排版',
    sceneDirection:'vertical',shotDirection:'horizontal',maxColumns:4,
    publicLibraries:['角色','声音','道具与动作','原作与分镜参考','补充空间'],
    imageThumbnail:{landscape:{width:320,height:180},portrait:{width:180,height:320},square:{width:240,height:240},preserveAspectRatio:true},
    rules:[
      '场次分组从上到下；同场镜头从左到右，每行默认4个镜头，满行换行。公共资产同样使用网格，不把所有节点塞进一个长列。',
      '独立节点用nodeIds自动成网格；columns的每一列仅代表同一镜头的制作节点、参考或短状态卡。需要长竖列时明确layoutMode=stack。',
      '先读取当前媒体真实宽高，再读取生成比例；横屏适配320×180，竖屏适配180×320，方图适配240×240。不能用默认横屏框排列竖屏结果。',
      '同步node/style/data/measured尺寸、opResize及图片显示锁，按每行最高节点预留空间；预览、刷新后再检查同组重叠和组边界。',
      '公共角色、声音、道具动作、原作分镜、补充空间分区复用；使用原生组名，避免冗余大标题和同版媒体副本。',
      '排版只改变几何和分组。用户已明确淘汰/不要的节点用rh_cleanup_canvas预览并清理，不因旧的保留一切规则继续占位；已有明确指示无需重复确认。',
      'pass可能表示通过，不能仅凭标题/英文PASS推断淘汰。清理核对用户决定和准确节点，保留已采用、运行中、被继续引用的素材；冲突返回原因。',
      '优先rh_create_app直接创建应用，不产生空占位输入；配置后清理原生拖入附带的空、未绑定、未被其他节点使用的输入。媒体库与历史不随画布清理删除。',
      '新对话先读取持久模板；修改后使用rh_check_layout，未确定归属的节点不自行移动或删除。'
    ]});
  const positive=v=>Number.isFinite(Number(v))&&Number(v)>0?Number(v):null;
  const size=n=>({width:positive(n.data?.width)||positive(n.style?.width)||positive(n.width)||positive(n.measured?.width)||380,height:positive(n.data?.height)||positive(n.style?.height)||positive(n.height)||positive(n.measured?.height)||240});
  const overlaps=(a,b)=>a.x<b.x+b.width && a.x+a.width>b.x && a.y<b.y+b.height && a.y+a.height>b.y;
  const ratio=v=>{const m=String(v??'').match(/^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)(?:\s|$)/);return m&&Number(m[1])>0&&Number(m[2])>0?Number(m[1])/Number(m[2]):null;};
  const metadata=v=>{if(!v||typeof v!=='object')return null;for(const obj of [v,v.size,v.dimensions,v.metadata]){const width=positive(obj?.width)||positive(obj?.imageWidth)||positive(obj?.videoWidth)||positive(obj?.naturalWidth),height=positive(obj?.height)||positive(obj?.imageHeight)||positive(obj?.videoHeight)||positive(obj?.naturalHeight);if(width&&height)return {width,height};}return null;};
  function media(n){
    const d=n.data||{},out=Array.isArray(d.output)?d.output:d.output?[d.output]:[];
    const selected=out.find(o=>d.selectedHistoryOutputId && String(o?.historyOutputId||o?.outputId)===String(d.selectedHistoryOutputId))||out[Number(d.selectedOutputHistoryIndex)||0]||out[0];
    const item=selected||d.videoUrl||d.imageUrl||d.sourceObjects?.[0];
    const url=typeof item==='string'?item:item?.originalUrl||item?.url||item?.videoUrl||item?.imageUrl||item?.fileUrl;
    const type=String(item?.outputType||d.aiNodeOutputType||'').toLowerCase();
    const kind=n.type==='rh-video'||/video|mp4|webm|mov/.test(type)||/\.(mp4|webm|mov)(?:\?|$)/i.test(url||'')?'video':n.type==='rh-image'||/image|png|jpg|jpeg|webp/.test(type)||/\.(png|jpg|jpeg|webp)(?:\?|$)/i.test(url||'')?'image':null;
    return {item,url,kind};
  }
  function aspect(n,known){
    const d=n.data||{},m=media(n),intrinsic=metadata(known)||metadata(m.item)||metadata({width:d.videoWidth||d.imageWidth,height:d.videoHeight||d.imageHeight});
    if(intrinsic)return {ratio:intrinsic.width/intrinsic.height,source:'media'};
    for(const field of [d.aspectRatio,...Object.entries(d.params||{}).filter(([k])=>/^(aspect_?ratio|ratio)$/i.test(k)).map(([,v])=>v),...(d.aiApp?.inputNodes||[]).filter(f=>/^(aspect_?ratio|ratio)$/i.test(f.fieldName)).map(f=>f.fieldValue)]){const r=ratio(field);if(r)return {ratio:r,source:'parameters'};}
    const dims=metadata(d.params);if(dims)return {ratio:dims.width/dims.height,source:'parameters'};
    return {ratio:size(n).width/size(n).height,source:'display'};
  }
  function dimensions(n,width,height){
    n.width=width;n.height=height;n.style={...n.style,width,height};if(n.measured)n.measured={...n.measured,width,height};
    n.data={...n.data,width,height,opResize:true,...(['rh-image','rh-ai'].includes(n.type)?{imageDisplaySizeLocked:true}:{})};return n;
  }
  function normalize(n,known){
    const copy=structuredClone(n);if(!['rh-image','rh-video','rh-ai'].includes(n.type))return copy;
    const a=aspect(n,known);
    const box=a.ratio<0.9?rules.imageThumbnail.portrait:a.ratio>1.1?rules.imageThumbnail.landscape:rules.imageThumbnail.square;
    const width=Math.min(box.width,box.height*a.ratio),height=width/a.ratio;
    return dimensions(copy,Math.round(width*100)/100,Math.round(height*100)/100);
  }
  // Decode only metadata, never play or submit media. A bounded deadline avoids holding a large canvas indefinitely.
  async function resolveMediaSizes(snapshot,ids,{deadlineMs=12000}={}){
    const sizes={},unresolved=[],queue=snapshot.nodes.filter(n=>ids.includes(n.id)&&media(n).url&&!metadata(media(n).item)),end=Date.now()+deadlineMs;
    if(typeof document==='undefined'||typeof document.createElement!=='function')return {sizes,unresolved:queue.map(n=>n.id)};
    await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(queue.length){const n=queue.shift(),m=media(n);if(!m.kind||Date.now()>=end){unresolved.push(n.id);continue;}
      const result=await new Promise(resolve=>{const el=document.createElement(m.kind==='video'?'video':'img');let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);el.onload=el.onloadedmetadata=el.onerror=null;el.removeAttribute('src');if(m.kind==='video')el.load();resolve(value);};const timer=setTimeout(()=>finish(null),Math.max(1,Math.min(5000,end-Date.now())));const loaded=()=>finish(metadata({width:el.videoWidth||el.naturalWidth,height:el.videoHeight||el.naturalHeight}));el.onload=loaded;el.onloadedmetadata=loaded;el.onerror=()=>finish(null);if(m.kind==='video')el.preload='metadata';el.src=m.url;});
      if(result)sizes[n.id]=result;else unresolved.push(n.id);
    }}));return {sizes,unresolved};
  }
  function columnsFor(g){
    if(Boolean(g.nodeIds)===Boolean(g.columns))throw Error('LAYOUT_USE_NODE_IDS_OR_COLUMNS');
    const columns=g.nodeIds?g.nodeIds.map(id=>[id]):g.columns;
    if(!columns.length||columns.some(c=>!c.length))throw Error('LAYOUT_EMPTY_COLUMN');
    if(g.layoutMode!=='stack'&&columns.some(c=>c.length>3))throw Error('LAYOUT_LONG_COLUMN: use nodeIds for a grid; columns hold one shot with at most 3 cards, or explicitly use layoutMode=stack');
    return columns;
  }
  function plan(snapshot,groups,{x=0,y=0,gap=60,groupGap=160,padding=60,maxColumns=4,mediaSizes={}}={}){
    if(!groups?.length)throw Error('LAYOUT_GROUPS_REQUIRED');if(!Number.isInteger(maxColumns)||maxColumns<1||maxColumns>12)throw Error('LAYOUT_COLUMNS_INVALID');
    const normalizedGroups=groups.map(g=>({...g,columns:columnsFor(g)})),byId=new Map(snapshot.nodes.map(n=>[n.id,n]));
    const memberIds=normalizedGroups.flatMap(g=>g.columns.flat()),selected=new Set(memberIds),groupIds=new Set(groups.map(g=>g.id));
    if(selected.size!==memberIds.length||groupIds.size!==groups.length)throw Error('LAYOUT_DUPLICATE_ID');
    for(const id of groupIds)if(selected.has(id))throw Error('LAYOUT_GROUP_MEMBER_COLLISION');
    for(const g of normalizedGroups){const old=byId.get(g.id);if(old&&old.type!=='group')throw Error('LAYOUT_GROUP_ID_OCCUPIED');
      for(const id of new Set([...(old?.data?.nodeIds||[]),...snapshot.nodes.filter(n=>n.data?.groupId===g.id).map(n=>n.id)]))if(byId.has(id)&&!selected.has(id))throw Error('LAYOUT_INCLUDE_ALL_GROUP_MEMBERS');
      for(const id of g.columns.flat()){const n=byId.get(id);if(!n||n.type==='group')throw Error('LAYOUT_NODE_NOT_FOUND: '+id);if(n.parentId||n.parentNode)throw Error('LAYOUT_NESTED_PARENT_UNSUPPORTED');if(n.data?.groupId&&!groupIds.has(n.data.groupId))throw Error('LAYOUT_INCLUDE_SOURCE_GROUP: '+n.data.groupId);for(const old of snapshot.nodes.filter(n=>n.type==='group'&&n.data?.nodeIds?.includes(id)))if(!groupIds.has(old.id))throw Error('LAYOUT_INCLUDE_SOURCE_GROUP: '+old.id);}
    }
    const obstacles=snapshot.nodes.filter(n=>!selected.has(n.id)&&!groupIds.has(n.id)).map(n=>({...n.position,...size(n)})),updates=[];let cursor=y;
    for(const g of normalizedGroups){
      const cols=g.columns.map(c=>c.map(id=>normalize(byId.get(id),mediaSizes[id]))),count=Math.min(g.layoutMode==='stack'?1:maxColumns,cols.length);
      const widths=Array.from({length:count},(_,i)=>Math.max(...cols.filter((_,j)=>j%count===i).flat().map(n=>size(n).width)));
      const positioned=[];let rowY=padding+32;
      for(let row=0;row<cols.length;row+=count){let colX=padding,rowHeight=0;
        for(let i=0;i<count&&row+i<cols.length;i++){let yy=rowY;for(const n of cols[row+i]){n.position={x:colX,y:yy};n.data={...n.data,groupId:g.id,addNewGroup:false};positioned.push(n);yy+=size(n).height+gap;}rowHeight=Math.max(rowHeight,yy-rowY-gap);colX+=widths[i]+gap;}rowY+=rowHeight+gap;
      }
      const width=padding*2+widths.reduce((a,b)=>a+b,0)+(count-1)*gap,height=rowY-gap+padding,rect={x,y:cursor,width,height};
      for(let tries=0;;tries++){const collisions=obstacles.filter(o=>overlaps(rect,o));if(!collisions.length)break;if(tries>obstacles.length+1)throw Error('LAYOUT_NO_SPACE');rect.y=Math.max(...collisions.map(o=>o.y+o.height+groupGap));}
      const offsets=Object.fromEntries(positioned.map(n=>[n.id,{...n.position}]));for(const n of positioned){n.position={x:rect.x+n.position.x,y:rect.y+n.position.y};updates.push(n);}
      const old=byId.get(g.id);updates.push({...old,id:g.id,type:'group',position:{x:rect.x,y:rect.y},width,height,zIndex:-1000,selectable:false,style:{...old?.style,width,height},data:{...old?.data,title:old?.data?.title||'节点',groupName:g.title,width,height,nodeIds:positioned.map(n=>n.id),nodeOffsets:offsets,status:old?.data?.status||'idle'}});
      obstacles.push(rect);cursor=rect.y+height+groupGap;
    }
    return {templateId:rules.id,templateVersion:rules.version,updates,nodeIds:memberIds,groupIds:[...groupIds],edgesChanged:0,deletedNodes:0};
  }
  function check(snapshot,{mediaSizes={}}={}){
    const issues=[],byId=new Map(snapshot.nodes.map(n=>[n.id,n]));
    for(const n of snapshot.nodes){const group=n.data?.groupId&&byId.get(n.data.groupId);if(n.data?.groupId&&group?.type!=='group')issues.push({code:'MISSING_GROUP',nodeId:n.id});
      if(n.type==='group')for(const id of n.data?.nodeIds||[]){if(!byId.has(id))issues.push({code:'MISSING_MEMBER',nodeId:n.id,memberId:id});else if(byId.get(id).data?.groupId!==n.id)issues.push({code:'GROUP_MEMBERSHIP_MISMATCH',nodeId:n.id,memberId:id});}
      if(group){if(!group.data?.nodeIds?.includes(n.id))issues.push({code:'GROUP_MEMBERSHIP_MISMATCH',nodeId:n.id});const ns=size(n),gs=size(group),o=group.data?.nodeOffsets?.[n.id];if(!o||Math.abs(o.x-(n.position.x-group.position.x))>1||Math.abs(o.y-(n.position.y-group.position.y))>1)issues.push({code:'GROUP_OFFSET_MISMATCH',nodeId:n.id});if(n.position.x<group.position.x||n.position.y<group.position.y||n.position.x+ns.width>group.position.x+gs.width+1||n.position.y+ns.height>group.position.y+gs.height+1)issues.push({code:'OUTSIDE_GROUP',nodeId:n.id});}
      if(['rh-image','rh-video','rh-ai'].includes(n.type)){const a=aspect(n,mediaSizes[n.id]),s=size(n);if(a.source!=='display'&&Math.abs(s.width/s.height/a.ratio-1)>0.03)issues.push({code:'MEDIA_ASPECT_MISMATCH',nodeId:n.id,expectedRatio:a.ratio});if(media(n).url&&!n.data?.opResize)issues.push({code:'PREVIEW_RESIZE_RISK',nodeId:n.id});}
    }
    const boxes=snapshot.nodes.map(n=>({node:n,...n.position,...size(n)}));
    for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];if(a.node.type==='group'&&b.node.data?.groupId===a.node.id||b.node.type==='group'&&a.node.data?.groupId===b.node.id)continue;if(overlaps(a,b))issues.push({code:'OVERLAP',nodeIds:[a.node.id,b.node.id]});}
    return {ok:true,passes:!issues.length,issues,templateVersion:rules.version};
  }
  globalThis.RHLayoutTemplate={rules,plan,size,aspect,normalize,dimensions,resolveMediaSizes,check};
})();
