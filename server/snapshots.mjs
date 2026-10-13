import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import './canvas-features.js';
export const snapshotDigest=s=>createHash('sha256').update(globalThis.RHCanvasFeatures.canonical(s)).digest('hex');
export class Snapshots{
 constructor(root=process.env.RH_SNAPSHOT_DIR||join(homedir(),'.runninghub-canvas-bridge','snapshots')){this.root=root;}
 async save(canvasUrl,snapshot,label=''){const id=randomUUID();await mkdir(this.root,{recursive:true});const record={id,canvasUrl,label,createdAt:new Date().toISOString(),digest:snapshotDigest(snapshot),snapshot};await writeFile(join(this.root,id+'.json'),JSON.stringify(record),{flag:'wx',mode:0o600});return this.summary(record);}
 summary({snapshot,...r}){return {...r,counts:{nodes:snapshot.nodes.length,edges:snapshot.edges.length}};}
 async get(id){if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('SNAPSHOT_ID_INVALID');return JSON.parse(await readFile(join(this.root,id+'.json'),'utf8'));}
 async list(canvasUrl){await mkdir(this.root,{recursive:true});const records=await Promise.all((await readdir(this.root)).filter(f=>f.endsWith('.json')).map(f=>this.get(f.slice(0,-5))));return {ok:true,snapshots:records.filter(r=>r.canvasUrl===canvasUrl).map(r=>this.summary(r))};}
}
