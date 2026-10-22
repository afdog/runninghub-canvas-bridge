// Derive durable routing failures from the existing command journal. No new credentials/state store.
export class HistoryRouteFailures {
  constructor(records, results) { this.records=records;this.results=results; }
  forNode(mutationKey,nodeId) {
    if(!nodeId)return null;
    let latest=null;
    for(const [id,r] of this.records){
      if(r.mutationKey!==mutationKey || r.nodeId!==nodeId || !['canvas.runNode','canvas.generateVideoNode'].includes(r.type))continue;
      const e=this.results.get(id),run=e?.result?.run || e?.result;
      const rejected=e?.ok===false && (e.errorCode==='HISTORY_ROUTE_CONFLICT' && e.submissionState==='rejected' || /RUN_REJECTED: 301: 节点历史路由不属于当前画布(?:\n|$)/.test(e.error||''));
      const succeeded=e?.ok===true && run?.submitted===true && run?.task?.taskId;
      if(!rejected&&!succeeded)continue;
      const time=r.createdAt||0;
      if(latest && latest.time>=time)continue;
      latest={time,failure:rejected?{requestId:id,nodeId,historyId:e.historyRoute?.historyId || null,revision:e.historyRoute?.revision ?? null,platformCode:301,observedAt:r.completedAt||time}:null};
    }
    return latest?.failure || null;
  }
}
