import {gunzipSync} from 'node:zlib';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
// npm tarballs use regular files, directories and PAX long-path records. Reject
// links, traversal, devices and ambiguous Windows names before writing any file.
export async function extractPackage(bytes,destination){
  const tar=gunzipSync(bytes,{maxOutputLength:300*1024*1024});const files=[];let pax={};
  const text=b=>b.toString('utf8').replace(/\0.*$/s,'');
  for(let offset=0;offset+512<=tar.length;){
    const h=tar.subarray(offset,offset+512);if(h.every(b=>b===0))break;
    const size=parseInt(text(h.subarray(124,136)).trim(),8)||0,type=text(h.subarray(156,157));
    const checksum=parseInt(text(h.subarray(148,156)).trim(),8);
    if(h.reduce((n,b,i)=>n+(i>=148&&i<156?32:b),0)!==checksum)throw Error('INVALID_TAR_CHECKSUM');
    if(!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length)throw Error('INVALID_TAR_SIZE');
    const body=tar.subarray(offset+512,offset+512+size);offset+=512+Math.ceil(size/512)*512;
    if(type==='x'){
      pax={};let pos=0;while(pos<body.length){const space=body.indexOf(32,pos);const length=Number(body.subarray(pos,space).toString());if(!Number.isInteger(length)||length<4||pos+length>body.length)throw Error('INVALID_PAX');const entry=body.subarray(space+1,pos+length-1).toString();const eq=entry.indexOf('=');pax[entry.slice(0,eq)]=entry.slice(eq+1);pos+=length;}continue;
    }
    if(!['','0','5'].includes(type)||pax.linkpath)throw Error('ARCHIVE_LINKS_NOT_ALLOWED');
    const prefix=text(h.subarray(345,500));const name=pax.path||((prefix?prefix+'/':'')+text(h.subarray(0,100)));pax={};
    if(!name.startsWith('package/')||name.includes('\\')||name.includes(':'))throw Error('INVALID_ARCHIVE_PATH');
    const relative=name.slice(8).replace(/\/$/,'');
    if(!relative && type==='5')continue;
    if(!relative||relative.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)))throw Error('INVALID_ARCHIVE_PATH');
    files.push({relative,type,body,mode:parseInt(text(h.subarray(100,108)).trim(),8)&0o111?0o755:0o644});
  }
  const names=new Set();for(const f of files){const name=f.relative.toLowerCase();if(names.has(name))throw Error('DUPLICATE_ARCHIVE_PATH');names.add(name);}
  for(const f of files){const p=join(destination,f.relative);if(f.type==='5')await mkdir(p,{recursive:true});else{await mkdir(dirname(p),{recursive:true});await writeFile(p,f.body,{mode:f.mode,flag:'wx'});}}
}
