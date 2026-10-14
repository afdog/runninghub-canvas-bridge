import {readFile,writeFile,mkdir,access,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {userInfo,homedir} from 'node:os';
export const exists=async p=>{try{await access(p);return true;}catch{return false;}};
export const delay=ms=>new Promise(r=>setTimeout(r,ms));
export const readJson=async p=>JSON.parse(await readFile(p,'utf8'));
export function run(command,args,options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],...options});let output='';
    const collect=b=>{output=(output+b.toString()).slice(-16000);};child.stdout.on('data',collect);child.stderr.on('data',collect);
    const timer=setTimeout(()=>child.kill(),options.timeout||300000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error('PROCESS_FAILED: '+command.split(/[\\/]/).at(-1)+' ('+code+')'));});
  });
}
const psQuote=s=>"'"+s.replaceAll("'","''")+"'";
const powershell=source=>run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop'; "+source,'utf16le').toString('base64')]);
const alive=async p=>{let value;try{value=await readJson(p);}catch(e){if(e.code==='ENOENT')return false;throw e;}if(!Number.isInteger(value.pid)||value.pid<1)throw Error('INVALID_SERVICE_PID');try{process.kill(value.pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
export async function discoverServices(config) {
  const services=[];
  if(process.platform==='win32'){
    const dir=config.data,bridge=join(dir,'service.json');
    if(await exists(bridge)){
      const b=await readJson(bridge);if(resolve(b.root)!==resolve(config.root))throw Error('SERVICE_ROOT_MISMATCH');
      if(await alive(join(dir,'service.pid')))services.push({kind:'windows',name:'bridge',dir,prefix:'service',launcher:join(dir,'start-bridge.vbs'),task:config.bridgeTask||null});
    }
    const dir2=join(dir,'remote-runtime'),runtime=join(dir2,'runtime.json');
    if(await exists(runtime)){
      const r=await readJson(runtime);
      if(r.services.some(s=>resolve(s.cwd)!==resolve(config.root)))throw Error('REMOTE_SERVICE_ROOT_MISMATCH');
      if(await alive(join(dir2,'runtime.pid')))services.push({kind:'windows',name:'remote',dir:dir2,prefix:'runtime',launcher:join(dir2,'start.vbs'),task:config.remoteTask||'RunningHub Remote MCP'});
    }
  }else if(process.platform==='darwin'){
    for(const label of ['cn.runninghub.canvas-bridge','cn.runninghub.remote-mcp']){
      const plist=join(homedir(),'Library/LaunchAgents',label+'.plist');
      if(!await exists(plist))continue;
      const source=await readFile(plist,'utf8');
      const escaped=config.root.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
      if(!source.includes(escaped))continue;
      try{await run('launchctl',['print',`gui/${userInfo().uid}/${label}`]);services.push({kind:'launchd',label,plist});}catch{}
    }
  }
  return services;
}
export async function stopServices(services) {
  // Stop the public gateway first. Credentials and service definitions stay in place.
  for(const s of [...services].reverse()){
    if(s.kind==='windows'){
      if(!await alive(join(s.dir,s.prefix+'.pid')))continue;
      await writeFile(join(s.dir,s.prefix+'.stop'),'update');
      for(let i=0;i<160 && await alive(join(s.dir,s.prefix+'.pid'));i++)await delay(250);
      if(await alive(join(s.dir,s.prefix+'.pid')))throw Error('SERVICE_STOP_TIMEOUT');
    }else await run('launchctl',['bootout',`gui/${userInfo().uid}/${s.label}`]);
  }
}
export async function startServices(services) {
  for(const s of services){
    if(s.kind==='windows'){
      if(await alive(join(s.dir,s.prefix+'.pid')))continue;
      await unlink(join(s.dir,s.prefix+'.stop')).catch(()=>{});
      if(s.task)await powershell('Start-ScheduledTask -TaskName '+psQuote(s.task));
      else await run('wscript.exe',[s.launcher],{timeout:15000});
    }else{
      try{await run('launchctl',['print',`gui/${userInfo().uid}/${s.label}`]);}
      catch{await run('launchctl',['bootstrap',`gui/${userInfo().uid}`,s.plist]);}
    }
  }
}
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const cmdQuote=s=>'"'+s.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';
export async function schedule(config,enabled){
  const dir=join(config.data,'updater'),engine=join(dir,'rh-update.mjs'),cfg=join(dir,'config.json');
  if(process.platform==='win32'){
    const task='RunningHub Automatic Updates';
    if(!enabled){await powershell('Unregister-ScheduledTask -TaskName '+psQuote(task)+' -Confirm:$false -ErrorAction SilentlyContinue');return;}
    const launcher=join(dir,'check.vbs');
    const command=[config.node,engine,'apply','--config',cfg].map(cmdQuote).join(' ');
    await writeFile(launcher,Buffer.from('\ufeffSet shell = CreateObject("WScript.Shell")\r\nshell.Run "'+command.replaceAll('"','""')+'", 0, False\r\n','utf16le'));
    await powershell(`$action=New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psQuote(cmdQuote(launcher))}; $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10) -RepetitionInterval (New-TimeSpan -Hours 6); $login=New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name); $principal=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited; $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30); Register-ScheduledTask -TaskName '${task}' -Action $action -Trigger @($trigger,$login) -Principal $principal -Settings $settings -Force | Out-Null`);
  }else if(process.platform==='darwin'){
    const label='cn.runninghub.auto-update',plist=join(homedir(),'Library/LaunchAgents',label+'.plist');
    await run('launchctl',['bootout',`gui/${userInfo().uid}/${label}`]).catch(()=>{});
    if(!enabled){await unlink(plist).catch(()=>{});return;}
    await mkdir(dirname(plist),{recursive:true});
    await writeFile(plist,`<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[config.node,engine,'apply','--config',cfg].map(s=>'<string>'+xml(s)+'</string>').join('')}</array><key>RunAtLoad</key><true/><key>StartInterval</key><integer>21600</integer><key>StandardOutPath</key><string>${xml(join(dir,'scheduler.log'))}</string><key>StandardErrorPath</key><string>${xml(join(dir,'scheduler.log'))}</string></dict></plist>`);
    await run('launchctl',['bootstrap',`gui/${userInfo().uid}`,plist]);
  }else throw Error('AUTOMATIC_SERVICE_UPDATE_REQUIRES_WINDOWS_OR_MACOS');
}
