// A local lease closes the check-idle / stop-service race during upgrades.
export class UpdateMaintenance {
  constructor({busy, pause=()=>{}, resume=()=>{}, now=Date.now}) {
    Object.assign(this,{busy,pause,resume,now});this.lease=null;this.requests=0;
  }
  status() {
    if(this.lease && this.lease.until<=this.now()){this.lease=null;this.resume();}
    const activity={...this.busy(),requests:this.requests};
    return {maintenance:!!this.lease,idle:Object.values(activity).every(v=>v===0),activity};
  }
  acquire(id) {
    if(!/^[a-f0-9-]{36}$/.test(id||''))throw Error('INVALID_UPDATE_LEASE');
    const state=this.status();
    if(this.lease && this.lease.id!==id)return {ok:false,reason:'UPDATE_ALREADY_PENDING'};
    if(!state.idle)return {ok:false,reason:'BRIDGE_BUSY',...state};
    this.pause();this.lease={id,until:this.now()+120000};return {ok:true,expiresAt:this.lease.until};
  }
  release(id) {if(this.lease?.id===id){this.lease=null;this.resume();}return {ok:true};}
}
