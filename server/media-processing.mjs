import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {inspectMedia,sha256} from './media.mjs';
const exec=promisify(execFile);
export const localOperations=['capture_frame','trim','crop','speed','reverse','rotate','flip','extract_audio','resize'];
export const aiOperations=['image_repaint','image_erase','image_expand','image_cutout','image_upscale','video_upscale','video_repair','vocal_separation','ambient_separation'];
export async function ffmpegPath(){
 const candidates=[process.env.RH_FFMPEG,process.env.RH_FFPROBE&&join(dirname(process.env.RH_FFPROBE),process.platform==='win32'?'ffmpeg.exe':'ffmpeg'),...(process.platform==='win32'?[join(homedir(),'.local','bin','ffmpeg.exe'),'ffmpeg.exe']:[join(homedir(),'.local','bin','ffmpeg'),'/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg','ffmpeg'])].filter(Boolean);
 for(const path of candidates)try{await exec(path,['-version'],{windowsHide:true,timeout:10000,maxBuffer:65536});return path;}catch{}
 throw Error('FFMPEG_REQUIRED: install FFmpeg or set RH_FFMPEG');
}
const num=(v,min,max,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error('INVALID_'+label);return v;};
const integer=(v,min,max,label)=>{num(v,min,max,label);if(!Number.isInteger(v))throw Error('INVALID_'+label);return v;};
export function validateOperation(operation,options={}){
 const schemas={capture_frame:['time'],trim:['start','end'],crop:['x','y','width','height'],speed:['rate'],reverse:[],rotate:['degrees'],flip:['axis'],extract_audio:[],resize:['width','height']};
 if(!schemas[operation])throw Error('LOCAL_OPERATION_UNSUPPORTED');
 if(!options||Array.isArray(options)||Object.keys(options).some(k=>!schemas[operation].includes(k)))throw Error('UNKNOWN_MEDIA_OPTION');
 const p={...options};
 if(operation==='capture_frame')num(p.time,0,86400,'FRAME_TIME');
 if(operation==='trim'){num(p.start,0,86400,'TRIM_START');num(p.end,p.start+0.001,86400,'TRIM_END');}
 if(operation==='crop'){integer(p.x,0,16384,'CROP_X');integer(p.y,0,16384,'CROP_Y');}
 if(['crop','resize'].includes(operation)){integer(p.width,2,8192,'WIDTH');integer(p.height,2,8192,'HEIGHT');}
 if(operation==='speed')num(p.rate,0.25,4,'SPEED');
 if(operation==='rotate'&&![90,180,270].includes(p.degrees))throw Error('INVALID_ROTATION');
 if(operation==='flip'&&!['horizontal','vertical'].includes(p.axis))throw Error('INVALID_FLIP');
 return p;
}
export function processingArgs(operation,options,media,input,output){
 const p=validateOperation(operation,options),image=media.kind==='image',hasAudio=media.channels>0;
 if(!['image','video','audio'].includes(media.kind))throw Error('UNSUPPORTED_MEDIA');
 if(['capture_frame','reverse','rotate','flip','crop','resize'].includes(operation)&&media.kind==='audio')throw Error('VIDEO_OR_IMAGE_REQUIRED');
 if(image&&['trim','speed','reverse','extract_audio','capture_frame'].includes(operation))throw Error('VIDEO_REQUIRED');
 if(operation==='extract_audio'&&!hasAudio)throw Error('AUDIO_TRACK_NOT_FOUND');
 if(operation==='capture_frame'&&p.time>=media.duration)throw Error('FRAME_OUT_OF_RANGE');
 if(operation==='trim'&&p.end>media.duration+0.001)throw Error('TRIM_OUT_OF_RANGE');
 if(operation==='crop'&&(p.x+p.width>media.width||p.y+p.height>media.height))throw Error('CROP_OUT_OF_BOUNDS');
 if(!image&&['crop','resize'].includes(operation)&&(p.width%2||p.height%2))throw Error('VIDEO_DIMENSIONS_MUST_BE_EVEN');
 if(operation==='reverse'&&(media.duration>120||media.width*media.height>1920*1080))throw Error('REVERSE_MEMORY_LIMIT: use a shorter or smaller clip');
 const args=['-nostdin','-v','error','-n','-i',input],vf=[],af=[];
 if(operation==='capture_frame')args.push('-ss',String(p.time),'-frames:v','1');
 if(operation==='trim')args.push('-ss',String(p.start),'-t',String(p.end-p.start));
 if(operation==='crop')vf.push(`crop=${p.width}:${p.height}:${p.x}:${p.y}`);
 if(operation==='resize')vf.push(`scale=${p.width}:${p.height}:flags=lanczos`);
 if(operation==='rotate')vf.push(p.degrees===180?'hflip,vflip':p.degrees===90?'transpose=1':'transpose=2');
 if(operation==='flip')vf.push(p.axis==='horizontal'?'hflip':'vflip');
 if(operation==='reverse'){vf.push('reverse');if(hasAudio)af.push('areverse');}
 if(operation==='speed'){if(media.kind==='video')vf.push(`setpts=PTS/${p.rate}`);if(hasAudio){let r=p.rate;while(r<0.5){af.push('atempo=0.5');r/=0.5;}while(r>2){af.push('atempo=2');r/=2;}af.push('atempo='+r);}}
 const still=image||operation==='capture_frame',audio=operation==='extract_audio'||media.kind==='audio';
 if(vf.length)args.push('-vf',vf.join(','));if(af.length)args.push('-af',af.join(','));
 if(still)args.push('-an','-frames:v','1','-c:v','png');
 else if(audio)args.push('-vn','-c:a','pcm_s16le');
 else args.push('-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart');
 args.push(output);return args;
}
export async function processLocal({operation,options,input,directory}){
 const media=await inspectMedia(input),ext=media.kind==='image'||operation==='capture_frame'?'.png':operation==='extract_audio'||media.kind==='audio'?'.wav':'.mp4';
 const output=join(directory,'result'+ext),args=processingArgs(operation,options,media,input,output);
 try{await exec(await ffmpegPath(),args,{windowsHide:true,timeout:300000,maxBuffer:1024*1024});}catch(error){throw Error(error.killed?'MEDIA_PROCESSING_TIMEOUT':'MEDIA_PROCESSING_FAILED');}
 if(await sha256(input)!==media.sha256)throw Error('SOURCE_CHANGED_DURING_PROCESSING');
 const result=await inspectMedia(output);return {path:output,media:result,sourceSha256:media.sha256};
}
export function nativeMediaRequest({canvasId,nodeId,url,operation,options,media}){
 const p=validateOperation(operation,options);
 if(!['crop','speed','reverse','rotate','flip','trim'].includes(operation))throw Error('CANVAS_MEDIA_OPERATION_UNSUPPORTED');
 const clip={input:'a'};
 if(operation==='crop')clip.crop={...p};
 if(operation==='speed')clip.speed=p.rate;
 if(operation==='reverse')clip.reverse=true;
 if(operation==='rotate')clip.rotate=p.degrees;
 if(operation==='flip')clip.mirror=p.axis;
 if(operation==='trim')clip.trim={startMs:Math.round(p.start*1000),endMs:Math.round(p.end*1000)};
 // Native contracts: Cbn/Ebn for transforms; Aut for split/trim.
 const spec=operation==='trim'?{inputs:[{id:'a',url}],tracks:[{type:'split',clips:[clip]}]}:{version:1,output:{container:'mp4',videoCodec:'h264',audioCodec:'aac',bucket:'canvas',fps:media?.fps||24},inputs:[{id:'a',url}],tracks:[{type:'video',clips:[clip]}]};
 return {bizId:String(canvasId),nodeId,spec,operateType:({crop:'CROP',speed:'SPEED',reverse:'REVERSE',rotate:'ROTATE',flip:'MIRROR',trim:'CROP_DURATION'})[operation],bizType:'CANVAS',executor:'FFMPEG'};
}
