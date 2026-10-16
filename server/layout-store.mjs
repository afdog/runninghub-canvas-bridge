import { readFile,writeFile,mkdir,rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join,dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import './layout-template.js';
import '../extension/site-policy.js';
const template=globalThis.RHLayoutTemplate.rules;
export class LayoutStore {
  constructor(path=process.env.RH_LAYOUT_FILE || join(homedir(),'.runninghub-canvas-bridge','layout-preferences.json')){this.path=path;this.queue=Promise.resolve();}
  key(url){const c=globalThis.RHCanvasSitePolicy.parseCanvas(url);if(!c)throw new Error('INVALID_CANVAS_URL');return c.key;}
  async read(){try{return JSON.parse(await readFile(this.path,'utf8'));}catch(e){if(e.code==='ENOENT')return {version:1,default:{templateId:template.id,options:{}},canvases:{}};throw e;}}
  async get(url){const config=await this.read();const selected=(url && config.canvases[this.key(url)]) || config.default;return {ok:true,source:url && config.canvases[this.key(url)]?'canvas':'default',...selected,template};}
  async set({canvasUrl,options={}}){
    for(const [key,value] of Object.entries(options)){if(!['x','y','gap','groupGap','padding','maxColumns'].includes(key)||!Number.isFinite(value)||(key==='maxColumns'?(!Number.isInteger(value)||value<1||value>12):(!['x','y'].includes(key)&&value<20)))throw new Error('LAYOUT_OPTIONS_INVALID');}
    const action=async()=>{const config=await this.read();const entry={templateId:template.id,options};if(canvasUrl)config.canvases[this.key(canvasUrl)]=entry;else config.default=entry;await mkdir(dirname(this.path),{recursive:true});const temp=this.path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600});await rename(temp,this.path);return this.get(canvasUrl);};
    const next=this.queue.then(action);this.queue=next.catch(()=>{});return next;
  }
}
