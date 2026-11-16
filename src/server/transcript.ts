import { transcriptInputSchema, transcriptMaterial, videoIdentity } from '../core/transcript';
import { fetchPublicDocument } from './public-fetch';
import { z } from 'zod';
type Reader=(url:string)=>Promise<string>;
const cueSchema=z.object({start:z.number().finite().nonnegative(),end:z.number().finite().positive(),text:z.string().trim().min(1).max(100_000)});
function embeddedJson(html:string,marker:string):any{
  const pos=html.indexOf(marker);if(pos<0)throw new Error('公开页面没有字幕信息，可能需登录或平台限制；可以导入自己的字幕文件');
  const start=html.indexOf('{',pos+marker.length);let depth=0,quoted=false,escaped=false;
  for(let i=start;i<html.length;i++){const char=html[i];if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}else if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0)return JSON.parse(html.slice(start,i+1));}
  throw new Error('页面字幕信息不完整');
}
/** Public captions only; no model request, audio download, login, or fake synopsis. */
export async function fetchVideoTranscript(input:unknown,read:Reader=url=>fetchPublicDocument(url,0,undefined,false,true)) {
  const options=transcriptInputSchema.parse(input);const video=videoIdentity(options.url);
  if(video.platform==='youtube'){
    const html=await read(video.url);const player=embeddedJson(html,'ytInitialPlayerResponse');
    if(player.playabilityStatus?.status && player.playabilityStatus.status!=='OK')throw new Error('YouTube 当前要求登录或拒绝公开访问；请导入自己的字幕文件，尚未取得文字稿');
    if(player.videoDetails?.videoId!==video.id)throw new Error('视频页面身份不匹配');
    const tracks=z.array(z.object({baseUrl:z.string(),languageCode:z.string(),kind:z.string().optional()})).max(200).parse(player.captions?.playerCaptionsTracklistRenderer?.captionTracks??[]);
    const track=[...tracks].sort((a,b)=>(Number(!/^zh/i.test(a.languageCode))-Number(!/^zh/i.test(b.languageCode)))||Number(a.kind==='asr')-Number(b.kind==='asr'))[0];
    if(!track)throw new Error('视频没有公开字幕；请导入 SRT/VTT/Markdown 文字稿。当前未配置语音转写');
    const url=new URL(track.baseUrl);if(url.protocol!=='https:'||!['www.youtube.com','youtube.com'].includes(url.hostname)||url.port||url.username||url.password||url.pathname!=='/api/timedtext'||url.searchParams.get('v')!==video.id)throw new Error('平台字幕地址不安全或视频编号不匹配');
    url.searchParams.set('fmt','json3');const raw=await read(url.toString());let captions:any;try{captions=JSON.parse(raw);}catch{throw new Error('字幕接口未返回文字稿，可能需登录或平台限制；请导入字幕文件');}
    const events=z.array(z.object({tStartMs:z.number().nonnegative(),dDurationMs:z.number().nonnegative().optional(),segs:z.array(z.object({utf8:z.string()})).optional()})).max(50_000).parse(captions.events);
    const cues=events.flatMap(e=>{const text=e.segs?.map(s=>s.utf8).join('').trim();return text&&e.dDurationMs? [{start:e.tStartMs/1000,end:(e.tStartMs+e.dDurationMs)/1000,text}]:[];}).map(c=>cueSchema.parse(c)).sort((a,b)=>a.start-b.start);
    const title=z.string().trim().min(1).max(230).parse(player.videoDetails.title),source=z.string().trim().min(1).max(150).parse(player.videoDetails.author);
    const duration=Number(player.videoDetails.lengthSeconds);const original=JSON.stringify({schema:1,platform:video.platform,videoId:video.id,url:video.url,title,source,language:track.languageCode,automatic:track.kind==='asr',duration:Number.isFinite(duration)?duration:null,captions});
    return {material:transcriptMaterial({title:`${title} · 文字稿`,source,url:video.url,identity:`transcript:${video.url}:${track.languageCode}`,topic:options.topic,cues,language:track.languageCode,automatic:track.kind==='asr',duration:duration>0?duration:undefined,original:{extension:'json',base64:Buffer.from(original).toString('base64')}})};
  }
  const metadata=JSON.parse(await read(`https://api.bilibili.com/x/web-interface/view?bvid=${video.id}`));
  if(metadata.code!==0||metadata.data?.bvid!==video.id)throw new Error('B站视频信息未取得或身份不匹配');
  const data=metadata.data;const cid=z.number().int().positive().parse(data.pages?.[0]?.cid);
  const info=JSON.parse(await read(`https://api.bilibili.com/x/player/v2?bvid=${video.id}&cid=${cid}`));
  if(info.code!==0)throw new Error('B站字幕接口未接通，可能需要登录；请导入字幕文件');
  const tracks=z.array(z.object({subtitle_url:z.string(),lan:z.string()})).max(100).parse(info.data?.subtitle?.subtitles??[]);
  const track=tracks.find(t=>/^zh/.test(t.lan))??tracks[0];if(!track)throw new Error('B站没有可访问的公开字幕，可能需要登录；请导入字幕文件。当前未配置语音转写');
  const url=new URL(track.subtitle_url,'https://api.bilibili.com');if(url.protocol!=='https:'||!['aisubtitle.hdslb.com','subtitle.bilibili.com'].includes(url.hostname)||url.port||url.username||url.password)throw new Error('B站字幕地址不安全');
  const raw=await read(url.toString()),captions=JSON.parse(raw);
  const cues=z.array(z.object({from:z.number().finite().nonnegative(),to:z.number().finite().positive(),content:z.string().trim().min(1)})).max(50_000).parse(captions.body).map(c=>cueSchema.parse({start:c.from,end:c.to,text:c.content})).sort((a,b)=>a.start-b.start);
  const title=z.string().trim().min(1).max(230).parse(data.title),source=z.string().trim().min(1).max(160).parse(data.owner?.name);
  const original=JSON.stringify({schema:1,platform:video.platform,videoId:video.id,cid,url:video.url,language:track.lan,duration:data.pages[0].duration,captions});
  return {material:transcriptMaterial({title:`${title} · 文字稿`,source,url:video.url,identity:`transcript:${video.url}:${track.lan}`,topic:options.topic,cues,language:track.lan,automatic:track.lan.startsWith('ai-'),duration:Number(data.pages[0].duration)||undefined,original:{extension:'json',base64:Buffer.from(original).toString('base64')}})};
}
