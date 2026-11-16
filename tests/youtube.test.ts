import {describe,it,expect} from 'vitest';
import {fetchYoutubePageFeed} from '../src/server/youtube';
import {parseRss} from '../src/server/rss';
import {SubscriptionCollector} from '../src/server/subscriptions';
import {resolveSource} from '../src/server/source-discovery';

const channel='UCFDMMIHbtRdrVhHlGXVzApA',id='abcdefghijk';
const page=(rows:unknown[]=[])=>`<script>var ytInitialData = ${JSON.stringify({metadata:{channelMetadataRenderer:{externalId:channel,title:'作者'}},contents:{twoColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{richGridRenderer:{contents:rows}}}}]}}})};</script>`;
const row=(published='1 hour ago')=>({richItemRenderer:{content:{lockupViewModel:{contentId:id,contentType:'LOCKUP_CONTENT_TYPE_VIDEO',metadata:{lockupMetadataViewModel:{title:{content:'真实视频'},metadata:{contentMetadataViewModel:{metadataRows:[{metadataParts:[{text:{content:published}}]}]}}}}}}}});
const watch=(overrides:Record<string,unknown>={})=>`<script>var ytInitialPlayerResponse = ${JSON.stringify({videoDetails:{videoId:id,channelId:channel,title:'真实视频'},microformat:{playerMicroformatRenderer:{externalChannelId:channel,publishDate:'2026-10-14T02:00:00-07:00'}},...overrides})};</script>`;
describe('YouTube RSS 失效时的公开主页检查',()=>{
 it('公开页临时TLS失败只补读一次，停止信号不再发请求',async()=>{
  let calls=0;const feed=await fetchYoutubePageFeed(channel,undefined,'today',{readPage:async()=>{if(++calls===1)throw Object.assign(Error('decryption failed or bad record mac'),{code:'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC'});return page();}});expect(calls).toBe(2);expect(parseRss(feed.body,feed.url,false,{platform:'youtube',accountId:channel})).toHaveLength(0);
  const controller=new AbortController();controller.abort();await expect(fetchYoutubePageFeed(channel,controller.signal,'today',{readPage:async()=>{calls++;return page();}})).rejects.toThrow();expect(calls).toBe(2);
 });
 it('RSS 404 后可登记来源并同步今日视频；重复检查不重复保存，双路失败保留上次成功',async()=>{
  const files=new Map<string,string>(),saved:string[]=[];let fail=false;
  const readPage=async(url:string)=>{if(fail)throw Error('平台验证');return url.includes('/watch')?watch():page([row()]);};
  const deps={files:{read:async(p:string)=>files.get(p)??null,write:async(p:string,v:string)=>{files.set(p,v);},readBinary:async()=>null,writeBinary:async()=>{}},save:async(m:any)=>{saved.push(m.identity);return true;},now:()=>new Date('2026-10-14T10:00:00Z'),readFeed:async()=>{throw Error('订阅返回 HTTP 404');},readYoutubePage:(id:string,signal?:AbortSignal,scope?:any)=>fetchYoutubePageFeed(id,signal,scope,{readPage})};
  const identified=await resolveSource({input:`https://www.youtube.com/channel/${channel}`},{readFeed:deps.readFeed,readPage});expect(identified.accountId).toBe(channel);
  const collector=new SubscriptionCollector(deps),initial=await collector.list(),config=initial.sources.find(s=>s.config.id==='YT-001')!.config;
  await collector.configure({revision:initial.revision,collectionScope:'today',sources:[{...config,enabled:true,topic:'ai-learning',feedUrl:identified.feedUrl}]});
  await collector.poll(true);await collector.poll(true);expect(saved).toEqual([`youtube:${id}`]);
  const before=(await collector.list()).sources[0]!;expect(before).toMatchObject({status:'ok',collectionMethod:'public-page'});expect([...files.keys()].some(p=>p.startsWith('subscription-snapshots/')&&p.endsWith('.json'))).toBe(true);
  fail=true;await collector.poll(true);const after=(await collector.list()).sources[0]!;expect(after.status).toBe('error');expect(after.lastSuccess).toBe(before.lastSuccess);expect(after.error).toContain('RSS');expect(after.error).toContain('平台验证');
 });
 it('仅从当前频道选中页取视频，并核验视频所属频道及带时区的发布日期',async()=>{
  const feed=await fetchYoutubePageFeed(channel,undefined,'today',{now:()=>new Date('2026-10-14T10:00:00Z'),readPage:async url=>url.includes('/watch')?watch():page([row()])});
  const entries=parseRss(feed.body,feed.url,false,{platform:'youtube',accountId:channel});
  expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({title:'真实视频',publishedAt:'2026-10-14T09:00:00.000Z',url:`https://www.youtube.com/watch?v=${id}`});expect(feed.collectionMethod).toBe('public-page');
 });
 it('两天前的视频可据主页相对日期跳过；真实空频道也允许成功，但验证页不能冒充空更新',async()=>{
  let watchCalls=0;const feed=await fetchYoutubePageFeed(channel,undefined,'today',{readPage:async url=>{if(url.includes('/watch'))watchCalls++;return page([row('2 days ago')]);}});
  expect(parseRss(feed.body,feed.url,false,{platform:'youtube',accountId:channel})).toHaveLength(0);expect(watchCalls).toBe(0);
  await expect(fetchYoutubePageFeed(channel,undefined,'today',{readPage:async()=>'<html>Sign in</html>'})).rejects.toThrow();
 });
 it('播放验证页只可排除已核对身份的历史日期，不能把当日视频算作无更新',async()=>{
  const blocked=(date:string)=>`<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED"}};</script><script>var ytInitialData = ${JSON.stringify({currentVideoEndpoint:{watchEndpoint:{videoId:id}},contents:{twoColumnWatchNextResults:{results:{results:{contents:[{videoPrimaryInfoRenderer:{dateText:{simpleText:date}}},{videoSecondaryInfoRenderer:{owner:{videoOwnerRenderer:{navigationEndpoint:{browseEndpoint:{browseId:channel}}}}}}]}}}}})};</script>`;
  const read=(date:string)=>(url:string)=>Promise.resolve(url.includes('/watch')?blocked(date):page([row()]));
  const deps={now:()=>new Date('2026-10-14T10:00:00Z')};
  const feed=await fetchYoutubePageFeed(channel,undefined,'today',{...deps,readPage:read('Oct 10, 2026')});expect(parseRss(feed.body,feed.url,false,{platform:'youtube',accountId:channel})).toHaveLength(0);
  await expect(fetchYoutubePageFeed(channel,undefined,'today',{...deps,readPage:read('Oct 14, 2026')})).rejects.toThrow('精确发布时间');
 });
 it('频道和视频身份冲突、日期只有年月日或视频读取失败都保留失败',async()=>{
  for(const video of [watch({videoDetails:{videoId:id,channelId:'UCYO_jab_esuFRV4b17AJtAw'}}),watch({microformat:{playerMicroformatRenderer:{publishDate:'2026-10-14'}}})]){
   await expect(fetchYoutubePageFeed(channel,undefined,'today',{readPage:async url=>url.includes('/watch')?video:page([row()])})).rejects.toThrow();
  }
  await expect(fetchYoutubePageFeed(channel,undefined,'today',{readPage:async url=>{if(url.includes('/watch'))throw Error('网络失败');return page([row()]);}})).rejects.toThrow('网络失败');
 });
 it('不接受只含推荐内容的未选中页、未知列表布局和越界频道编号',async()=>{
  await expect(fetchYoutubePageFeed('bad-id',undefined,'today',{readPage:async()=>page()})).rejects.toThrow();
  const unknown=page([{richItemRenderer:{content:{newRenderer:{id}}}}]);
  await expect(fetchYoutubePageFeed(channel,undefined,'today',{readPage:async()=>unknown})).rejects.toThrow();
 });
});
