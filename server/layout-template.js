// Shared browser/Node planner: scene rows, shot columns and separate public libraries.
(() => {
  const rules=Object.freeze({id:'scene-columns-v1',version:1,name:'场次分组与镜头横排',
    sceneDirection:'vertical',shotDirection:'horizontal',publicLibraries:['角色','声音','道具与动作','原作与分镜参考','补充空间'],
    imageThumbnail:{maxWidth:320,maxHeight:180,preserveAspectRatio:true},
    rules:[
      '每个场次使用一个原生分组，场次从上到下，同场镜头从左到右。',
      '每个镜头保留一个当前查看位置和至多一张短状态卡；优先让原制作节点兼任看片，不复制同版媒体。',
      '加工版来源、旧生成与必要历史入口放回所属镜头附近，不另设分散制作区。',
      '公共角色、声音、道具动作、原作分镜、补充空间分区复用；共用空白模板集中在小工具组。',
      '使用原生组名作标题，不额外创建大标题卡。图片按原比例适配320×180框，视频保持真实画幅。',
      '排版只改几何与分组；保留完整正文、参数、媒体、槽位、连线、身份、采用状态。整理不自动删除任何节点。',
      '维护节点、style、data尺寸以及opResize、组成员、nodeOffsets与组边界；应用后回读检查。',
      '新对话先读取持久模板。先确认镜头/场次归属，再传入精确节点ID；未确定归属的节点保留。'
    ]});
  const size=n=>({width:Number(n.width || n.style?.width || n.data?.width)||380,height:Number(n.height || n.style?.height || n.data?.height)||240});
  const overlaps=(a,b)=>a.x<b.x+b.width && a.x+a.width>b.x && a.y<b.y+b.height && a.y+a.height>b.y;
  function plan(snapshot,groups,{x=0,y=0,gap=60,groupGap=160,padding=60}={}){
    if(!groups?.length)throw new Error('LAYOUT_GROUPS_REQUIRED');
    const byId=new Map(snapshot.nodes.map(n=>[n.id,n]));
    const memberIds=groups.flatMap(g=>g.columns.flat());
    const selected=new Set(memberIds),groupIds=new Set(groups.map(g=>g.id));
    if(selected.size!==memberIds.length || groupIds.size!==groups.length)throw new Error('LAYOUT_DUPLICATE_ID');
    for(const id of groupIds)if(selected.has(id))throw new Error('LAYOUT_GROUP_MEMBER_COLLISION');
    for(const group of groups){
      const existing=byId.get(group.id);
      if(existing && existing.type!=='group')throw new Error('LAYOUT_GROUP_ID_OCCUPIED');
      for(const id of existing?.data?.nodeIds || [])if(byId.has(id) && !selected.has(id))throw new Error('LAYOUT_INCLUDE_ALL_GROUP_MEMBERS');
      for(const id of group.columns.flat()){
        const n=byId.get(id);if(!n || n.type==='group')throw new Error('LAYOUT_NODE_NOT_FOUND: '+id);
        if(n.parentId || n.parentNode)throw new Error('LAYOUT_NESTED_PARENT_UNSUPPORTED');
        if(n.data?.groupId && !groupIds.has(n.data.groupId))throw new Error('LAYOUT_INCLUDE_SOURCE_GROUP: '+n.data.groupId);
        for(const old of snapshot.nodes.filter(n=>n.type==='group' && n.data?.nodeIds?.includes(id)))if(!groupIds.has(old.id))throw new Error('LAYOUT_INCLUDE_SOURCE_GROUP: '+old.id);
      }
    }
    const obstacles=snapshot.nodes.filter(n=>!selected.has(n.id)&&!groupIds.has(n.id)).map(n=>({...n.position,...size(n)}));
    const updates=[];let cursor=y;
    for(const g of groups){
      let colX=padding;const positioned=[];
      for(const column of g.columns){
        let rowY=padding+32,colWidth=0;
        for(const id of column){
          const n=structuredClone(byId.get(id));let {width,height}=size(n);
          if(n.type==='rh-image'){
            const ratio=Math.min(320/width,180/height,1);width=Math.round(width*ratio);height=Math.round(height*ratio);
            n.width=width;n.height=height;n.style={...n.style,width,height};n.data={...n.data,width,height,opResize:true};
          }
          n.position={x:colX,y:rowY};n.data={...n.data,groupId:g.id,addNewGroup:false};
          positioned.push(n);rowY+=height+gap;colWidth=Math.max(colWidth,width);
        }
        colX+=colWidth+gap;
      }
      const width=Math.max(padding*2,colX-gap+padding),height=Math.max(padding*2,...positioned.map(n=>n.position.y+size(n).height+padding));
      const rect={x,y:cursor,width,height};
      for(let tries=0;;tries++){
        const collisions=obstacles.filter(o=>overlaps(rect,o));if(!collisions.length)break;
        if(tries>obstacles.length+1)throw new Error('LAYOUT_NO_SPACE');rect.y=Math.max(...collisions.map(o=>o.y+o.height+groupGap));
      }
      const offsets=Object.fromEntries(positioned.map(n=>[n.id,{...n.position}]));
      for(const n of positioned){n.position={x:rect.x+n.position.x,y:rect.y+n.position.y};updates.push(n);}
      const old=byId.get(g.id);
      updates.push({...old,id:g.id,type:'group',position:{x:rect.x,y:rect.y},width,height,zIndex:-1000,selectable:false,style:{...old?.style,width,height},
        data:{...old?.data,title:old?.data?.title || '节点',groupName:g.title,width,height,nodeIds:positioned.map(n=>n.id),nodeOffsets:offsets,status:old?.data?.status || 'idle'}});
      obstacles.push(rect);cursor=rect.y+height+groupGap;
    }
    return {templateId:rules.id,updates,nodeIds:memberIds,groupIds:[...groupIds],edgesChanged:0,deletedNodes:0};
  }
  globalThis.RHLayoutTemplate={rules,plan};
})();
