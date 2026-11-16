import { z } from 'zod';
import { materialSchema, webUrl } from './model';
import type { Material, Topic } from './model';

export const transcriptInputSchema=z.object({url:webUrl,topic:z.enum(['ai-learning','ai-news','finance','law','headlines','leisure','cognition','opinion']).default('ai-learning')}).strict();
export function videoIdentity(input: string): { platform:'youtube'|'bilibili'; id:string; url:string } {
  const url=new URL(webUrl.parse(input));if(url.protocol!=='https:'||url.port)throw new Error('请使用标准 HTTPS 视频地址');
  const host=url.hostname.toLowerCase();
  if(['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(host)){
    const id=host==='youtu.be'?url.pathname.slice(1):url.pathname==='/watch'?url.searchParams.get('v'):url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)$/)?.[1];
    if(!id || !/^[\w-]{11}$/.test(id))throw new Error('YouTube 视频编号无效');return{platform:'youtube',id,url:`https://www.youtube.com/watch?v=${id}`};
  }
  if(['bilibili.com','www.bilibili.com'].includes(host)){
    const id=url.pathname.match(/^\/video\/(BV[\w]{10})(?:\/|$)/)?.[1];if(!id)throw new Error('请使用 B站 BV 视频地址');
    if(url.searchParams.has('p')&&url.searchParams.get('p')!=='1')throw new Error('目前只支持视频第一分P，请把指定分P字幕作为文件导入');
    return{platform:'bilibili',id,url:`https://www.bilibili.com/video/${id}`};
  }
  throw new Error('当前自动文字稿支持 YouTube 和 B站；其他平台可导入 Markdown、SRT 或 VTT');
}
export type Cue={start:number;end:number;text:string;timingIssue?:string};
function seconds(time:string) { const parts=time.replace(',','.').split(':').map(Number);if(parts.slice(-2).some(part=>part>=60))throw new Error('字幕时间范围无效');return parts.reduce((total,part)=>total*60+part,0); }
function clean(text:string){return text.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;|&apos;/g,"'").replace(/&quot;/g,'"').trim();}
export function parseSubtitles(content:string,tolerateTiming=false):Cue[]{
  if(content.length>1_500_000)throw new Error('字幕超过大小限制，请分段导入');
  const blocks=content.replace(/^\uFEFF/,'').replace(/\r/g,'').split(/\n\s*\n/);const cues:Cue[]=[];
  for(const block of blocks){
    if(/^\s*(?:NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block))continue;
    const lines=block.split('\n');const index=lines.findIndex(line=>line.includes('-->'));if(index<0)continue;
    const match=lines[index]!.match(/^\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})(?:\s.*)?$/);
    if(!match)throw new Error('字幕时间格式无效');
    const start=seconds(match[1]!),end=seconds(match[2]!);const text=clean(lines.slice(index+1).join('\n'));
    if(!Number.isFinite(start)||start<0 || start>360_000 || end>360_000 || cues.length>=50_000)throw new Error('字幕时间范围无效');
    if(end<=start&&!tolerateTiming)throw new Error('字幕时间范围无效');
    if(text)cues.push({start,end,text,...(end<=start?{timingIssue:`原字幕时间码 ${match[1]}—${match[2]} 无效，正文保留，时间定位需核对`}:{})});
  }
  if(!cues.length)throw new Error('字幕文件没有有效的时间段及正文');
  // Preserve overlapping captions. Sorting must not erase repeated or revised speech.
  return cues.sort((a,b)=>a.start-b.start);
}
export function timeLabel(time:number){const n=Math.floor(time);return [Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(v=>String(v).padStart(2,'0')).join(':');}
export function transcriptMaterial(options:{title:string;source:string;url?:string;identity:string;topic:Topic;cues:Cue[];original:NonNullable<Material['original']>;duration?:number;language?:string;automatic?:boolean},now=new Date().toISOString()):Material{
  const {cues}=options;if(!cues.length)throw new Error('文字稿为空');
  let last=0;const gaps:string[]=[];
  for(const cue of cues){if(!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<0||cue.end<0||(cue.end<=cue.start&&!cue.timingIssue)||!cue.text.trim())throw new Error('文字稿时间段无效');if(cue.timingIssue)gaps.push(cue.timingIssue);if(cue.start>last+30)gaps.push(`${timeLabel(last)}—${timeLabel(cue.start)} 没有字幕，可能为停顿、画面或遗漏`);last=Math.max(last,cue.end,cue.start);}
  const summary=[`字幕覆盖 ${timeLabel(cues[0]!.start)}—${timeLabel(last)}${options.duration?` / 视频时长 ${timeLabel(options.duration)}`:'；视频总时长未核验'}；字幕不覆盖画面、演示及屏幕文字。`];
  if(options.duration&&last<options.duration-30)gaps.push(`${timeLabel(last)}—${timeLabel(options.duration)} 片尾无字幕`);
  if(options.automatic)summary.push('平台自动字幕，专有名词、数字和说话人可能有识别错误。');
  if(options.language)summary.push(`字幕语言 ${options.language}；保留原语言，未自动翻译。`);
  if(gaps.length>40-summary.length)summary.push('时间缺口超过展示上限；完整字幕及异常时间码保留在正文和原件中。');
  const body=cues.map(cue=>`[${cue.timingIssue?'时间码待核对 · ':''}${timeLabel(cue.start)}—${timeLabel(cue.end)}]\n${cue.text}`).join('\n\n');
  return materialSchema.parse({title:options.title,source:options.source,url:options.url,identity:options.identity,topic:options.topic,kind:'markdown',capturedAt:now,body,coverage:'partial',gaps:[...summary,...gaps].slice(0,40),guideKind:'none',original:options.original});
}
