#!/usr/bin/env node
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {defaultRemoteConfig,validatePublicUrl,startRemote} from '../server/mcp-http.mjs';
import {secret,digest,savePrivateJson} from '../server/remote-auth.mjs';

const [action,...args]=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const configPath=resolve(option('--config')||process.env.RH_REMOTE_CONFIG||defaultRemoteConfig());
if(action==='init'){
 if(existsSync(configPath))throw Error('Remote configuration already exists; refusing to replace its credentials');
 const publicUrl=validatePublicUrl(option('--public-url'));
 const key=secret(),keyPath=resolve(dirname(configPath),'connection-key.txt');
 mkdirSync(dirname(configPath),{recursive:true,mode:0o700});
 writeFileSync(keyPath,key+'\n',{mode:0o600,flag:'wx'});
 savePrivateJson(configPath,{version:1,publicUrl,port:18766,ownerSecretHash:digest(key)});
 console.log(JSON.stringify({ok:true,configPath,connectionKeyFile:keyPath,publicMcpUrl:publicUrl+'/mcp'}));
}else if(action==='serve'){
 startRemote(configPath);
}else if(action==='status'){
 const config=JSON.parse(readFileSync(configPath,'utf8'));
 try{const r=await fetch(`http://127.0.0.1:${config.port}/health`,{signal:AbortSignal.timeout(3000)});console.log(JSON.stringify({online:r.ok,publicMcpUrl:config.publicUrl+'/mcp',health:await r.json()}));}
 catch{console.log(JSON.stringify({online:false,publicMcpUrl:config.publicUrl+'/mcp'}));process.exitCode=1;}
}else{
 console.log('Usage: node scripts/rh-remote.mjs init --public-url https://mcp.example.com [--config /private/path/config.json]\n       node scripts/rh-remote.mjs serve|status [--config /private/path/config.json]');
 if(action)process.exitCode=1;
}
