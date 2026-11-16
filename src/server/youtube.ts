import {z} from 'zod';
import {fetchPublicHtml} from './public-fetch';
import type {FeedResponse} from './feed-fetch';
import type {CollectionScope} from '../core/subscriptions';
import {beijingDate} from '../core/daily';

type Reader=(url:string,signal?:AbortSignal)=>Promise<string>;
interface Dependencies {readPage?:Reader;now?:()=>Date}
const channelPattern=/^UC[\w-]{22}$/,videoPattern=/^[\w-]{11}$/;
function embedded(html:string,name:string):any{
 const marker=new RegExp(`(?:var\\s+${name}|window\\["${name}"\\])\\s*=\\s*`).exec(html);
 if(!marker)throw Error('YouTube 公开页未提供可核验数据，可能需要登录或页面结构变化');
 const start=html.indexOf('{',marker.index+marker[0].length);let depth=0,quoted=false,escaped=false;
 for(let i=start;i<html.length;i++){const c=html[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0)return JSON.parse(html.slice(start,i+1));}
 throw Error('YouTube 公开页数据不完整');
}
const xml=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
function older(label:string):boolean{
 const match=label.match(/\b(\d+)\s*(days?|d|weeks?|w|months?|mo|years?|y)\s+ago\b/i);
 return !!match&&(Number(match[1])>=2||(!/^d(?:ays?)?$/i.test(match[2]!)&&Number(match[1])>=1));
}
function candidates(data:any):{id:string;label:string}[]{
 const tab=data.contents?.twoColumnBrowseResultsRenderer?.tabs?.find((t:any)=>t.tabRenderer?.selected)?.tabRenderer;
 const grid=tab?.content?.richGridRenderer??tab?.content?.sectionListRenderer;
 if(!grid||!Array.isArray(grid.contents))throw Error('YouTube 频道视频列表结构无法核验');
 const result:{id:string;label:string}[]=[];
 const walk=(node:any)=>{
  if(!node||typeof node!=='object')return;
  if(node.lockupViewModel){const v=node.lockupViewModel;if(v.contentType!=='LOCKUP_CONTENT_TYPE_VIDEO'||!videoPattern.test(v.contentId??''))throw Error('YouTube 视频列表身份无效');const parts=v.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.flatMap((r:any)=>r.metadataParts??[])??[];result.push({id:v.contentId,label:parts.map((p:any)=>p.text?.content??'').join(' ')});return;}
  if(node.videoRenderer){const v=node.videoRenderer;if(!videoPattern.test(v.videoId??''))throw Error('YouTube 视频编号无效');result.push({id:v.videoId,label:v.publishedTimeText?.simpleText??v.publishedTimeText?.runs?.map((r:any)=>r.text).join('')??''});return;}
  if(node.shortsLockupViewModel){const v=node.shortsLockupViewModel;const id=v.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId??v.entityId?.match(/(?:^|-)([\w-]{11})$/)?.[1];if(!videoPattern.test(id??''))throw Error('YouTube Shorts 视频编号无法核验');result.push({id,label:''});return;}
  if(node.reelItemRenderer){const id=node.reelItemRenderer.videoId;if(!videoPattern.test(id??''))throw Error('YouTube Shorts 视频编号无效');result.push({id,label:''});return;}
  if(node.richItemRenderer){const content=node.richItemRenderer.content;if(!content||!['lockupViewModel','videoRenderer','shortsLockupViewModel','reelItemRenderer'].some(key=>content[key]))throw Error('YouTube 视频列表出现未知布局');}
  for(const value of Object.values(node))walk(value);
 };
 walk(grid);return [...new Map(result.map(v=>[v.id,v])).values()].slice(0,15);
}
/** Public channel tabs only. Exact publication time comes from each video's own
 * page; relative ages only exclude items older than two days in today's scope. */
export async function fetchYoutubePageFeed(channelId:string,signal?:AbortSignal,scope:CollectionScope='today',dependencies:Dependencies={}):Promise<FeedResponse>{
 if(!channelPattern.test(channelId))throw Error('YouTube 频道编号无效');signal?.throwIfAborted();
 const read:Reader=dependencies.readPage??((url,abort)=>fetchPublicHtml(url,0,abort,true));
 const pageData=async(url:string,marker:string)=>{
  for(let attempt=0;;attempt++){
   try{signal?.throwIfAborted();const html=await read(url,signal);return{html,data:embedded(html,marker)};}
   catch(error){signal?.throwIfAborted();const code=(error as NodeJS.ErrnoException).code??'',message=error instanceof Error?error.message:'';
    const retryable=['ECONNRESET','ETIMEDOUT','EPIPE','ECONNABORTED','ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC'].includes(code)||/公开页未提供可核验数据|公开页数据不完整|原文读取超时|HTTP (?:429|5\d\d)|decryption failed or bad record mac/.test(message);
    if(attempt>=1||!retryable)throw error;await new Promise(r=>setTimeout(r,500));signal?.throwIfAborted();}
  }
 };
 const channelPage=async(url:string)=>{const {data}=await pageData(url,'ytInitialData');if(data.metadata?.channelMetadataRenderer?.externalId!==channelId)throw Error('YouTube 频道身份不匹配');return data;};
 const base=`https://www.youtube.com/channel/${channelId}`,pages:any[]=[];
 const data=await channelPage(`${base}/videos?hl=en`);
 const name=z.string().trim().min(1).max(160).parse(data.metadata?.channelMetadataRenderer?.title);
 pages.push(data);const tabs=data.contents?.twoColumnBrowseResultsRenderer?.tabs??[];
 const paths=['shorts','streams'].filter(path=>tabs.some((t:any)=>t.tabRenderer?.endpoint?.commandMetadata?.webCommandMetadata?.url?.replace(/\?.*$/,'').endsWith(`/${path}`)));
 await Promise.all(paths.map(async path=>{pages.push(await channelPage(`${base}/${path}?hl=en`));}));
 const listed=[...new Map(pages.flatMap(candidates).map(v=>[v.id,v])).values()];
 const selected=scope==='today'?listed.filter(v=>!older(v.label)):listed;
 const videos:any[]=[],inspected:any[]=[];let next=0;
 await Promise.all(Array.from({length:Math.min(3,selected.length)},async()=>{
  while(next<selected.length){signal?.throwIfAborted();const item=selected[next++]!,url=`https://www.youtube.com/watch?v=${item.id}&hl=en`;
   const {html,data:player}=await pageData(url,'ytInitialPlayerResponse'),details=player.videoDetails,meta=player.microformat?.playerMicroformatRenderer;
   if(!details){
    const info=embedded(html,'ytInitialData'),rows=info.contents?.twoColumnWatchNextResults?.results?.results?.contents??[];
    const owner=rows.find((r:any)=>r.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.browseId;
    if(info.currentVideoEndpoint?.watchEndpoint?.videoId!==item.id||owner!==channelId)throw Error('YouTube 视频页面身份无法核验');
    inspected.push({videoId:item.id,player,watch:info});
    const date=rows.find((r:any)=>r.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer?.dateText?.simpleText;
    const time=typeof date==='string'&&/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(date)?Date.parse(`${date} 00:00:00 GMT`):NaN;
    // An old displayed calendar date is enough to exclude a historical video;
    // it is never converted to a fabricated publication timestamp.
    const day=Date.parse(beijingDate(dependencies.now?.()??new Date()));
    if(scope==='today'&&Number.isFinite(time)&&time<day-86400_000)continue;
    throw Error('YouTube暂时限制匿名读取，本轮无法核对精确发布时间；已保留旧材料并按计划重试，可配置官方接口减少此类影响');
   }
   if(details.videoId!==item.id||details.channelId!==channelId||(meta?.externalChannelId&&meta.externalChannelId!==channelId))throw Error('YouTube 视频所属频道不匹配');
   // A date without an offset cannot establish the author's Beijing publication day.
   const stamp=meta?.liveBroadcastDetails?.startTimestamp??meta?.publishDate;
   if(typeof stamp!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(stamp)||!Number.isFinite(Date.parse(stamp)))throw Error('YouTube 视频缺少带时区的真实发布日期');
   inspected.push({videoId:item.id,player});
   videos.push({id:item.id,title:z.string().trim().min(1).max(240).parse(details.title),publishedAt:new Date(stamp).toISOString(),player});
  }
 }));
 signal?.throwIfAborted();videos.sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
 const now=(dependencies.now?.()??new Date()).toISOString(),url=`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
 const author=`<author><name>${xml(name)}</name><uri>${base}</uri></author>`;
 const entries=videos.map(v=>`<entry><id>yt:video:${v.id}</id><yt:videoId>${v.id}</yt:videoId><title>${xml(v.title)}</title><link rel="alternate" href="https://www.youtube.com/watch?v=${v.id}"/>${author}<published>${v.publishedAt}</published><updated>${v.publishedAt}</updated></entry>`).join('');
 return{status:200,url,collectionMethod:'public-page',body:`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><id>yt:channel:${channelId}</id><title>${xml(name)}</title>${author}<updated>${now}</updated>${entries}</feed>`,originalJson:JSON.stringify({schema:1,channelId,scope,checkedAt:now,windowPerTab:15,olderSkipped:listed.length-selected.length,pages,inspected})};
}
