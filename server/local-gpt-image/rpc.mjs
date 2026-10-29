import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import {join,delimiter} from 'node:path';

// Modified 2026-10-29: portable Codex lookup; keep account secrets in Codex itself.
export function codexEnvironment(source=process.env){
  const env={};
  for(const key of ['HOME','USER','LOGNAME','SHELL','PATH','LANG','LC_ALL','TMPDIR','CODEX_HOME','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','SystemRoot','SYSTEMROOT','SystemDrive','COMSPEC','PATHEXT','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP'])if(source[key])env[key]=source[key];
  const extra=process.platform==='win32'?[]:['/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'];
  env.PATH=[source.PATH,join(homedir(),'.local','bin'),...extra].filter(Boolean).join(delimiter);
  return env;
}

export class CodexRpc {
  constructor({binary=process.env.RH_CODEX_BIN||'codex',onRequest=async()=>({}),onEvent=()=>{}}={}) {
    this.binary=binary;this.onRequest=onRequest;this.onEvent=onEvent;this.pending=new Map();this.nextId=1;this.child=null;this.ready=null;
  }
  async start() {
    if(this.ready)return this.ready;
    this.ready=this.initialize().catch(error=>{this.ready=null;throw error;});
    return this.ready;
  }
  async initialize() {
    const disabled=['apps','plugins','shell_tool','multi_agent','browser_use','computer_use','view_image','workspace_dependencies','in_app_browser','in_app_chat','skill_search','hooks','memories','chronicle','in_app_local_automation'];
    const args=['app-server','--stdio','--enable','image_generation',...disabled.flatMap(name=>['--disable',name]),'-c','web_search="disabled"','-c','mcp_servers.node_repl.enabled=false','-c','mcp_servers.runninghub-canvas.enabled=false','-c','mcp_servers.computer-use.enabled=false'];
    const env=codexEnvironment();
    this.child=spawn(this.binary,args,{stdio:['pipe','pipe','pipe'],env});
    this.child.stderr.on('data',()=>{});
    this.child.on('error',error=>this.fail(error));
    this.child.on('exit',()=>{this.fail(new Error('本机 Codex 进程已退出，请重试连接。'));this.child=null;this.ready=null;this.onEvent({method:'local/disconnected',params:{}});});
    createInterface({input:this.child.stdout}).on('line',line=>{
      let message;try{message=JSON.parse(line);}catch{return;}
      if(message.method&&message.id!==undefined){
        Promise.resolve(this.onRequest(message)).then(result=>this.write({id:message.id,result}),error=>this.write({id:message.id,error:{code:-32000,message:String(error.message).slice(0,600)}})).catch(()=>{});
      }else if(message.id!==undefined){
        const waiter=this.pending.get(message.id);if(!waiter)return;
        this.pending.delete(message.id);clearTimeout(waiter.timer);
        message.error?waiter.reject(new Error(message.error.message||'Codex 请求失败')):waiter.resolve(message.result);
      }else if(message.method)this.onEvent(message);
    });
    const hello=await this.request('initialize',{clientInfo:{name:'runninghub_codex_local',title:'RunningHub Codex Local',version:'0.1.0'},capabilities:{experimentalApi:true}},20000);
    this.write({method:'initialized',params:{}});
    return hello;
  }
  write(value){if(!this.child?.stdin.writable)throw Error('Codex 尚未连接');this.child.stdin.write(JSON.stringify(value)+'\n');}
  request(method,params={},timeout=60000){
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex 连接超时；请检查当前请求状态后再继续。'));},timeout);timer.unref();
      this.pending.set(id,{resolve,reject,timer});
      try{this.write({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  fail(error){for(const waiter of this.pending.values()){clearTimeout(waiter.timer);waiter.reject(error);}this.pending.clear();}
  close(){this.child?.kill('SIGTERM');}
}
