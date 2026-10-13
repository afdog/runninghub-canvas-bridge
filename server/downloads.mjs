import {createReadStream,createWriteStream,constants} from 'node:fs';
import {mkdir,readFile,writeFile,rename,stat,copyFile,readdir,unlink} from 'node:fs/promises';
import {join,resolve,isAbsolute,basename} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform,Readable} from 'node:stream';
import {inspectMedia} from './media.mjs';
import {checkOutputUrl} from './archive.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
const safeName=s=>String(s).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,100)||'output';
const checkFileUrl=value=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||!(['oaiusercontent.com','openai.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))||/^oai[a-z0-9]+\.blob\.core\.windows\.net$/.test(u.hostname)))throw new Error('CHATGPT_FILE_HOST_UNSUPPORTED: '+u.protocol+'//'+u.hostname);return u;};
export class Downloads {
 constructor(root=process.env.RH_DOWNLOAD_DIR || join(homedir(),'.runninghub-canvas-bridge','downloads'),fetcher=fetch){this.root=root;this.fetcher=fetcher;this.jobs=new Map();this.active=new Set();this.running=new Map();}
 async init(){await mkdir(this.root,{recursive:true});for(const f of await readdir(this.root)){if(!f.endsWith('.json'))continue;const j=JSON.parse(await readFile(join(this.root,f),'utf8'));if(['queued','downloading'].includes(j.state))j.state='interrupted';this.jobs.set(j.id,j);}}
 async save(j){const p=join(this.root,j.id+'.json'),tmp=p+'.tmp';await writeFile(tmp,JSON.stringify(j),{mode:0o600});await rename(tmp,p);}
 public(j){if(!j)return {ok:false,error:'DOWNLOAD_NOT_FOUND'};return {ok:true,id:j.id,state:j.state,error:j.error,files:j.files.map(({url,...f})=>f),destination:j.destination};}
 status(id){return id?this.public(this.jobs.get(id)):{ok:true,jobs:[...this.jobs.values()].map(j=>this.public(j))};}
 async add({requestId,files,destination}){
  if(!/^[\w-]{8,128}$/.test(requestId))throw new Error('INVALID_REQUEST_ID');
  if(!isAbsolute(destination)||!files?.length||files.length>100)throw new Error('DOWNLOAD_INPUT_INVALID');
  for(const f of files){(f.chatgpt?checkFileUrl:checkOutputUrl)(f.url);}
  const id=digest(requestId),identity=digest(JSON.stringify({files,destination}));
  if(this.jobs.has(id)){const j=this.jobs.get(id);if(j.identity!==identity)throw new Error('DOWNLOAD_REQUEST_CONFLICT');return this.public(j);}
  const j={id,identity,destination:resolve(destination),state:'queued',files:files.map((f,index)=>({...f,index,name:safeName(f.name || 'output-'+index),bytes:0})),createdAt:new Date().toISOString()};
  this.jobs.set(id,j);await this.save(j);this.start(j);return this.public(j);
 }
 start(j){const pending=this.run(j).catch(()=>{}).finally(()=>this.running.delete(j.id));this.running.set(j.id,pending);}
 async retry(id){const j=this.jobs.get(id);if(!j)throw new Error('DOWNLOAD_NOT_FOUND');if(j.state==='failed'&&this.running.has(id))await this.running.get(id);if(j.state==='complete'||this.active.has(id))return this.public(j);j.state='queued';delete j.error;await this.save(j);this.start(j);return this.public(j);}
 async run(j){
  if(this.active.has(j.id))return;this.active.add(j.id);
  try{
   j.state='downloading';await this.save(j);await mkdir(j.destination,{recursive:true});
   for(const f of j.files){
    if(f.path){const media=await inspectMedia(f.path);if(media.sha256!==f.sha256)throw new Error('DOWNLOADED_FILE_CHANGED');continue;}
    const part=join(this.root,j.id+'-'+f.index+'.part');let offset=await stat(part).then(s=>s.size).catch(()=>0);
    const check=f.chatgpt?checkFileUrl:checkOutputUrl;let current=String(check(f.url)),response;
    // Only resume when the server supplied a stable validator.
    if(offset&&!f.validator){await unlink(part);offset=0;}
    for(let redirect=0;redirect<5;redirect++){
     response=await this.fetcher(current,{redirect:'manual',headers:offset?{Range:`bytes=${offset}-`,'If-Range':f.validator}:{},signal:AbortSignal.timeout(180000)});
     if([301,302,303,307,308].includes(response.status)){current=String(check(new URL(response.headers.get('location'),current)));await response.body?.cancel();continue;}break;
    }
    if(!response?.ok||!response.body)throw new Error('DOWNLOAD_HTTP_'+response?.status);
    if(offset&&response.status===206){if(!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`))throw new Error('DOWNLOAD_RANGE_MISMATCH');}
    else {offset=0;}
    f.validator=response.headers.get('etag')||response.headers.get('last-modified')||null;
    const limit=500*1024**2;let total=offset;f.totalBytes=Number(response.headers.get('content-length'))+offset || null;
    if(Number(response.headers.get('content-length'))+offset>limit)throw new Error('DOWNLOAD_OVER_500_MIB');
    await this.save(j);
    const counter=new Transform({transform:(chunk,enc,next)=>{total+=chunk.length;f.bytes=total;if(total>limit)return next(new Error('DOWNLOAD_OVER_500_MIB'));next(null,chunk);}});
    await pipeline(Readable.fromWeb(response.body),counter,createWriteStream(part,{flags:offset?'a':'w',mode:0o600}));
    const media=await inspectMedia(part);const path=join(j.destination,`${f.name}-${j.id.slice(0,8)}-${f.index}${media.extension}`);
    try{await copyFile(part,path,constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST'||(await inspectMedia(path)).sha256!==media.sha256)throw e;}
    Object.assign(f,{path,sha256:media.sha256,mime:media.type,kind:media.kind,bytes:media.size});await this.save(j);await unlink(part);
   }
   j.state='complete';await this.save(j);
  }catch(error){j.state='failed';j.error=String(error.message).replace(/https?:\/\/\S+/g,'[URL]').slice(0,250);await this.save(j);}finally{this.active.delete(j.id);}
 }
}
