import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
export const mediaRoot=()=>process.env.RH_MEDIA_OPERATIONS_DIR||join(homedir(),'.runninghub-canvas-bridge','media-operations');
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const validId=id=>/^[0-9a-f-]{36}$/.test(id||'');
export async function saveJson(path,data){const tmp=path+'.'+randomBytes(6).toString('hex')+'.tmp';await writeFile(tmp,JSON.stringify(data),{mode:0o600});await rename(tmp,path);}
export async function ownerHash(root=mediaRoot(),configPath=process.env.RH_REMOTE_CONFIG||join(homedir(),'.runninghub-canvas-bridge','remote','config.json')){
 try {const config=JSON.parse(await readFile(configPath,'utf8'));if(!/^[a-f0-9]{64}$/.test(config.ownerSecretHash||''))throw Error('OWNER_CONFIGURATION_INVALID');return config.ownerSecretHash;}catch(e){if(e.code!=='ENOENT')throw e;}
 await mkdir(root,{recursive:true,mode:0o700});const keyPath=join(root,'owner-key.txt');
 try{await writeFile(keyPath,randomBytes(32).toString('base64url'),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
 return hash((await readFile(keyPath,'utf8')).trim());
}
const html=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export class MediaConsent {
 constructor({root=mediaRoot(),origin,secretHash}){this.root=root;this.origin=origin;this.secretHash=secretHash;this.pending=new Map();}
 async page(id){
  if(!validId(id))throw Error('PLAN_NOT_FOUND');
  const p=JSON.parse(await readFile(join(this.root,id+'.json'),'utf8'));
  if(p.expiresAt<Date.now()||!['planned','awaiting_consent'].includes(p.state))throw Error('PLAN_EXPIRED_OR_ALREADY_USED');
  this.secretHash ||= await ownerHash(this.root);
  const csrf=randomBytes(24).toString('base64url');this.pending.set(csrf,{id,digest:p.digest,expiresAt:Date.now()+600000});
  for(const [k,v]of this.pending)if(v.expiresAt<Date.now())this.pending.delete(k);
  return {csrf,html:`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>确认媒体处理费用</title><style>body{font:16px/1.6 system-ui;background:#101827;color:#edf2ff;margin:32px auto;max-width:720px;padding:20px}main{padding:28px;border:1px solid #456;border-radius:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#172337;padding:16px}input,button{font:inherit;padding:12px;margin:8px 0;width:100%;box-sizing:border-box}button{cursor:pointer}</style><main><h1>确认这一次媒体处理</h1><p>此授权仅用于以下画布、节点、参数和一次提交；更改参数需要重新确认。</p><p>素材：<strong>${html(p.sourceTitle||p.sourceNodeId||'所选素材')}</strong></p><p>处理：<strong>${html(({image_repaint:'局部重绘',image_erase:'智能擦除',image_expand:'扩图',image_cutout:'抠图',image_upscale:'图片超分',video_upscale:'视频超分',video_repair:'视频修复',vocal_separation:'人声分离',ambient_separation:'环境音分离',crop:'视频裁剪',trim:'片段剪裁',speed:'调整倍速',reverse:'视频倒放',rotate:'旋转',flip:'翻转'})[p.operation]||p.operation)}</strong></p><p>执行模型或引擎：<strong>${html(p.processingSummary?.appName||p.processingSummary?.modelCode||(p.provider==='canvas-media'?'RunningHub 原生视频处理':'已配置的应用'))}</strong></p><p>选择原因：${html(p.routingReason||'按本次任务选择')}</p><p><a style="color:#aaccff" href="${html(p.canvasUrl||'#')}">查看目标画布</a></p><details><summary>查看具体参数与模型</summary><pre>${html(JSON.stringify({options:p.options,processing:p.processingSummary},null,2))}</pre></details><p>${p.cost?.kind==='quoted'&&Number.isFinite(Number(p.cost.runningHubCredits))?`平台报价：${html(p.cost.runningHubCredits)}${p.cost.currency?` ${html(p.cost.currency)}`:''}。授权只覆盖这一次调用。`:p.cost?.kind==='unknown'?'平台费用尚未确认，本次可能消耗积分。只有你明确接受本次费用不确定的调用时才授权。':'本次需要付费授权。'}</p><form method="post" action="/media-approval/${id}"><input type="hidden" name="csrf" value="${csrf}"><label>本机连接密钥</label><input name="ownerSecret" type="password" required autocomplete="off"><label><input type="checkbox" name="consent" value="yes" required style="width:auto"> 我同意上述这一次调用及其可能产生的费用</label><button>授权一次</button></form><p>此页只记录授权；执行仍由原任务发起。原有账号连接授权不会被修改。</p></main></html>`};
 }
 async approve(id,{csrf,ownerSecret,consent},cookie,origin){
  const pending=this.pending.get(csrf);if(origin!==this.origin||!same(csrf,cookie)||!pending||pending.id!==id||pending.expiresAt<Date.now()||consent!=='yes')throw Error('CONSENT_INVALID');
  if(!same(hash(ownerSecret||''),this.secretHash||await ownerHash()))throw Error('OWNER_KEY_INVALID');
  const p=JSON.parse(await readFile(join(this.root,id+'.json'),'utf8'));if(p.digest!==pending.digest||p.expiresAt<Date.now()||!['planned','awaiting_consent'].includes(p.state))throw Error('PLAN_CHANGED_OR_EXPIRED');
  await saveJson(join(this.root,id+'.approval.json'),{planId:id,digest:p.digest,expiresAt:p.expiresAt,approvedAt:Date.now()});this.pending.delete(csrf);return {approved:true,planId:id};
 }
}
