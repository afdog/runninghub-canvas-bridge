// Canvas-only cleanup. Never removes stored media or native history.
(() => {
  const empty=v=>v==null||(typeof v==='string'&&v.trim()==='')||v==='None'||(Array.isArray(v)?v.every(empty):typeof v==='object'?Object.values(v).every(empty):false);
  const placeholder=n=>(n.data?.autoCreatedByAiApp===true||(n.type==='rh-text'&&n.data?.autoCreatedByAiApp===false&&n.data?.labelLocked===true&&typeof n.data?._originalLabel==='string'))&&!n.data?.taskId&&!n.data?.modelCode&&!n.data?.aiApp&&['output','sourceObjects','imageUrl','videoUrl','audioUrl','text','content','prompt','params'].every(k=>empty(n.data[k]));
  const protectedNode=n=>n.type==='group'||n.data?.adopted===true||n.data?.accepted===true||['adopted','accepted'].includes(n.data?.adoptionStatus)||['adopted','accepted'].includes(n.data?.adoption?.state)||['adopted','accepted'].includes(n.data?.adoption?.status)||/^(running|queued|pending|processing|uploading)$/i.test(n.data?.status||'');
  const strings=(v,skip=new Set())=>typeof v==='string'?[v]:Array.isArray(v)?v.flatMap(x=>strings(x,skip)):v&&typeof v==='object'?Object.entries(v).filter(([k])=>!skip.has(k)).flatMap(([,x])=>strings(x,skip)):[];
  const ignored=new Set(['title','label','groupId','nodeIds','nodeOffsets','bridgeSource','historySource','historyStorage','nodeOutputHistory','outputHistory']);
  const bound=(n,id)=>(n.data?.aiApp?.inputNodes||[]).some(f=>f.binding?.sourceNodeId===id);
  function inspect(snapshot,entries=[],appNodeId){
    const ids=new Set(entries.map(e=>e.nodeId));if(ids.size!==entries.length)throw Error('CLEANUP_DUPLICATE_ID');
    const candidates=snapshot.nodes.filter(n=>placeholder(n)&&(!appNodeId||snapshot.edges.some(e=>e.source===n.id&&e.target===appNodeId))).map(n=>({nodeId:n.id,reason:'unused_app_input'}));
    const selected=[],blocked=[];
    for(const entry of entries){const n=snapshot.nodes.find(n=>n.id===entry.nodeId);if(!n){blocked.push({nodeId:entry.nodeId,reason:'NODE_NOT_FOUND'});continue;}
      if(!['user_rejected','unused_app_input'].includes(entry.reason)||!entry.decisionNote?.trim()){blocked.push({nodeId:n.id,reason:'EXPLICIT_DECISION_REQUIRED'});continue;}
      if(protectedNode(n)){blocked.push({nodeId:n.id,reason:'ADOPTED_RUNNING_OR_GROUP'});continue;}
      if(entry.reason==='unused_app_input'&&!placeholder(n)){blocked.push({nodeId:n.id,reason:'NOT_EMPTY_APP_PLACEHOLDER'});continue;}
      const urls=new Set(strings([n.data?.output,n.data?.sourceObjects,n.data?.imageUrl,n.data?.videoUrl,n.data?.audioUrl]).filter(v=>/^https?:/.test(v)));
      const users=snapshot.nodes.filter(other=>!ids.has(other.id)&&other.type!=='group').filter(other=>{
        if(strings(other.data,ignored).some(v=>v===n.id||urls.has(v)))return true;
        return snapshot.edges.some(e=>e.source===n.id&&e.target===other.id)&&!(entry.reason==='unused_app_input'&&other.type==='rh-ai'&&!bound(other,n.id));
      });
      if(users.length){blocked.push({nodeId:n.id,reason:'STILL_REFERENCED',by:users.map(x=>x.id)});continue;}
      selected.push({nodeId:n.id,reason:entry.reason,decisionNote:entry.decisionNote});
    }
    return {candidates,selected,blocked,canApply:entries.length>0&&!blocked.length,deletedMedia:0,deletedHistory:0};
  }
  function remove(snapshot,entries){const report=inspect(snapshot,entries);if(!report.canApply)throw Error('CLEANUP_BLOCKED: '+JSON.stringify(report.blocked));const ids=new Set(report.selected.map(e=>e.nodeId));const affected=new Set(snapshot.nodes.filter(n=>ids.has(n.id)).map(n=>n.data?.groupId).filter(Boolean));snapshot.nodes=snapshot.nodes.filter(n=>!ids.has(n.id));snapshot.edges=snapshot.edges.filter(e=>!ids.has(e.source)&&!ids.has(e.target));report.removedGroups=snapshot.nodes.filter(n=>n.type==='group'&&affected.has(n.id)&&!snapshot.nodes.some(m=>m.data?.groupId===n.id)&&!snapshot.edges.some(e=>e.source===n.id||e.target===n.id)).map(n=>n.id);snapshot.nodes=snapshot.nodes.filter(n=>!report.removedGroups.includes(n.id));return report;}
  globalThis.RHCanvasCleanup={inspect,remove,placeholder};
})();
