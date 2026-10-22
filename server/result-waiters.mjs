// Subscribe before checking the result, so completion cannot fall between check and wait.
export class ResultWaiters {
 constructor(){this.waiters=new Map();}
 notify(id){for(const wake of [...(this.waiters.get(id)||[])])wake();}
 wait(id,read,{waitMs=0,response}={}){
  waitMs=Math.max(0,Math.min(20000,Number(waitMs)||0));
  if(!waitMs)return Promise.resolve(read());
  return new Promise(resolve=>{
   const bucket=this.waiters.get(id)||new Set();this.waiters.set(id,bucket);
   let timer,done=false;
   const finish=value=>{if(done)return;done=true;clearTimeout(timer);bucket.delete(wake);if(!bucket.size)this.waiters.delete(id);response?.off('close',closed);resolve(value);};
   const wake=()=>{const result=read();if(result)finish(result);};
   const closed=()=>finish(null);
   bucket.add(wake);response?.once('close',closed);timer=setTimeout(()=>finish(read()),waitMs);
   if(response?.destroyed)closed();else wake();
  });
 }
}
