import { describe, expect, it, vi } from 'vitest';
import type { FileStore, Material, ReadingItem } from '../src/core/model';
import { defaultCategories, categoriesSchema } from '../src/core/categories';
import { dayDisposition, publicationDay, subscriptionDays, updatesForDay, updatesByDay } from '../src/core/subscription-days';
import { SubscriptionCollector } from '../src/server/subscriptions';
import { parseRss } from '../src/server/rss';
import { currentCategory } from '../src/ui/workbench';
import { correctedSourceGroups } from '../src/core/source-groups';
import { wechatPublishedAt, identifyWechat } from '../src/server/extract';

function files() { const data = new Map<string, string>(); return { data, read: async (p: string) => data.get(p) ?? null, write: async (p: string, v: string) => { data.set(p, v); }, readBinary: async () => null, writeBinary: async () => {} } satisfies FileStore & {data:Map<string,string>}; }
const time = '2026-10-13T04:00:00.000Z';
const todayPage = '<html><script>var biz="MzU0MjYwNDU2Mw==";var create_time="2026-10-13 12:00";</script><body><div id="js_content"><p>当天的原页面正文。</p></div></body></html>';
function rss(entries: { id: string; date?: string; body?: string }[]) {
  return `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>日期测试</title>${entries.map(e => `<item><title>${e.id}</title><link>https://mp.weixin.qq.com/s/${e.id}</link>${e.date ? `<pubDate>${e.date}</pubDate>` : ''}<content:encoded><![CDATA[${e.body ?? '<p>当天的测试正文。</p>'}]]></content:encoded></item>`).join('')}</channel></rss>`;
}
async function enable(collector:SubscriptionCollector) {
  const state=await collector.list();
  return collector.configure({ revision:state.revision, sources:[{...state.sources[0]!.config,enabled:true,feedUrl:'https://example.org/feed',topic:'opinion',categoryId:'opinion'}] });
}

describe('订阅每日页面和来源分组',()=>{
  it('一次归档分组保持跨日版本、来源优先级和未知日期保护',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T04:00:00Z'));
    try{
      const sources=[{registry_id:'WX-004',display_name:'优先来源',platform:'wechat',publicationDates:{'https://mp.weixin.qq.com/s/known':time}},{registry_id:'YT-001',display_name:'视频',platform:'youtube'}];
      const input=[{id:'same',version:'old',sourceId:'YT-001',publishedAt:'2026-10-12T02:00:00Z'},{id:'same',version:'new',sourceId:'YT-001',publishedAt:time},{id:'known',version:'1',sourceId:'WX-004',url:'https://mp.weixin.qq.com/s/known',publishedAt:time},{id:'unknown',version:'1',sourceId:'WX-004',url:'https://mp.weixin.qq.com/s/unknown',publishedAt:time},{id:'missing',version:'1',sourceId:'YT-001'},{id:'unregistered',version:'1',sourceId:'YT-999',publishedAt:time}] as ReadingItem[];
      const grouped=updatesByDay(input,sources);
      for(const day of ['2026-10-12','2026-10-13'])expect(grouped.get(day)).toEqual(updatesForDay(input,sources,day));
      expect(grouped.get('2026-10-13')!.map(i=>i.id)).toEqual(['known','same']);
    }finally{vi.useRealTimers();}
  });
  it('按北京时间分日，不以导入时间或未知日期替代发布时间',()=>{
    expect(publicationDay({publishedAt:'2026-10-12T16:00:00Z'})).toBe('2026-10-13');
    expect(dayDisposition({publishedAt:'2026-10-13T15:59:59Z'},'2026-10-13')).toBe('today');
    expect(dayDisposition({publishedAt:'2026-10-13T16:00:00Z'},'2026-10-13')).toBe('future');
    expect(dayDisposition({publishedAt:'invalid'},'2026-10-13')).toBe('undated');
    expect(publicationDay({})).toBeNull();
  });
  it('每天都有页面，旧存档也按真实日期保留且不冒充今天',()=>{
    expect(subscriptionDays('2026-10-11T20:00:00Z',new Date(time))).toEqual(['2026-10-13','2026-10-12']);
    expect(subscriptionDays(undefined,new Date(time))).toEqual(['2026-10-13']);
    expect(subscriptionDays(time,new Date(time),['2026-07-02','2026-10-12'])).toEqual(['2026-10-13','2026-10-12','2026-07-02']);
  });
  it('日期筛选只含当前关注来源的指定日期，旧存档和陌生来源仍留在材料库',()=>{
    const input=[{id:'a',version:'1',sourceId:'WX-001',publishedAt:time,capturedAt:time},{id:'b',version:'1',sourceId:'WX-001',publishedAt:'2026-10-12T02:00:00Z',capturedAt:time},{id:'c',version:'1',sourceId:'WX-999',publishedAt:time,capturedAt:time},{id:'d',version:'1',sourceId:'WX-001',capturedAt:time}] as ReadingItem[];
    expect(updatesForDay(input,[{registry_id:'WX-001',display_name:'来源'}],'2026-10-13').map(i=>i.id)).toEqual(['a']);
    expect(input).toHaveLength(4);
  });
  it('同一材料不同日期的历史版本仍各自在日期页，不被较新日期版本吞掉',()=>{
    const old={id:'same',version:'old',sourceId:'WX-001',publishedAt:'2026-10-12T04:00:00Z',capturedAt:time}as ReadingItem,next={...old,version:'new',publishedAt:time},sources=[{registry_id:'WX-001',display_name:'来源'}];
    expect(updatesForDay([old,next],sources,'2026-10-12').map(item=>item.version)).toEqual(['old']);expect(updatesForDay([old,next],sources,'2026-10-13').map(item=>item.version)).toEqual(['new']);
  });
  it('认知和观点分组兼容旧分类，已保存的旧标签不会覆盖当前来源分组',()=>{
    expect(categoriesSchema.parse(defaultCategories().slice(0,6))).toHaveLength(6);
    const item={sourceId:'WX-002',source:'请辩',topic:'law',categoryName:'法律'} as ReadingItem;
    expect(currentCategory(item,[{registry_id:'WX-002',display_name:'请辩',categoryId:correctedSourceGroups['WX-002'],verification_status:'subscription'}],defaultCategories())).toEqual({id:'opinion',name:'观点'});
    expect(correctedSourceGroups['WX-003']).toBe('cognition');expect(correctedSourceGroups['WX-009']).toBe('cognition');expect(correctedSourceGroups['YT-001']).toBe('cognition');
    expect(item.topic).toBe('law');
  });
  it('Atom只有更新时间时不将其当作新发布时间',()=>{
    const xml='<feed><entry><title>旧内容修改</title><link href="https://mp.weixin.qq.com/s/old"/><updated>2026-10-13T04:00:00Z</updated></entry></feed>';
    expect(parseRss(xml,'https://example.org/feed')[0]?.publishedAt).toBeUndefined();
  });
  it('公众号作者日期支持北京时间文本与秒时间戳，拒绝无效日期和普通JS变量',()=>{
    expect(wechatPublishedAt("create_time: '2026-10-13 00:34',")).toBe('2026-10-12T16:34:00.000Z');
    expect(wechatPublishedAt('var ct=1791864000;')).toBe(new Date(1791864000*1000).toISOString());
    expect(wechatPublishedAt("var ct=et(r,G);create_time: '2026-02-30 12:00',")).toBeUndefined();
    expect(wechatPublishedAt('var updated=1791864000;')).toBeUndefined();
  });
  it('公众号页面前置的空变量不遮蔽后续实际作者元数据',()=>{
    const html='<script>var biz="";var nick_name="";</script><script>var biz="verified-biz";var nick_name="真实账号";var create_time="2026-10-13 00:34";</script>';
    expect(identifyWechat(html)).toMatchObject({name:'真实账号',biz:'verified-biz'});
    expect(wechatPublishedAt(html)).toBe('2026-10-12T16:34:00.000Z');
  });
  it('已核验作者日期优先于旧RSS日期，未核验的今天记录不进入首页且原索引保持原样',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date(time));
    try {
    const items=[{id:'a',version:'1',url:'https://mp.weixin.qq.com/s/a',sourceId:'WX-001',publishedAt:time,capturedAt:time},{id:'b',version:'1',url:'https://mp.weixin.qq.com/s/b',sourceId:'WX-001',publishedAt:time,capturedAt:time}] as ReadingItem[];
    const sources=[{registry_id:'WX-001',platform:'wechat',display_name:'来源',publicationDates:{'https://mp.weixin.qq.com/s/a':'2026-10-12T02:00:00.000Z'}}];
    expect(updatesForDay(items,sources,'2026-10-12').map(i=>i.id)).toEqual(['a']);
    expect(updatesForDay(items,sources,'2026-10-13')).toEqual([]);
    expect(items[0]?.publishedAt).toBe(time);
    } finally {vi.useRealTimers();}
  });
});

describe('采集端在正文提取前筛选日期',()=>{
  it.each(['undated','network'])('前30项%s不阻塞后续真实当天内容，重启后仍公平继续',async mode=>{
    const store=files(),saved:string[]=[];let reads=0;const entries=Array.from({length:35},(_,i)=>({id:`item-${i}`,date:new Date(Date.parse(time)+i*1000).toISOString()}));
    const deps={files:store,now:()=>new Date(time),save:async(m:Material)=>{saved.push(m.title);return true;},readFeed:async()=>({status:200 as const,url:'https://example.org/feed',body:rss(entries)}),readArticle:async(url:string)=>{reads++;const n=Number(url.split('-').at(-1));if(n<30){if(mode==='network')throw Error('模拟原页面网络失败');return todayPage.replace('2026-10-13 12:00','');}return todayPage;}};
    const first=new SubscriptionCollector(deps);await enable(first);await first.poll(true);expect(saved).toEqual([]);
    const resumed=new SubscriptionCollector(deps);await resumed.poll(true);expect(saved).toHaveLength(5);expect(reads).toBe(mode==='network'?115:60);
  });
  it('作者日期缓存为今天时，后来RSS错误标昨天仍可更新当天正文',async()=>{
    let changed=false;const saved:Material[]=[];const collector=new SubscriptionCollector({files:files(),now:()=>new Date(time),save:async material=>{saved.push(material);return true;},readFeed:async()=>({status:200,url:'https://example.org/feed',body:rss([{id:'today',date:changed?'2026-10-12T04:00:00Z':time,body:changed?'<p>新摘要</p>':undefined}])}),readArticle:async()=>todayPage});
    await enable(collector);await collector.poll(true);changed=true;await collector.poll(true);expect(saved).toHaveLength(2);expect(saved.every(item=>item.publishedAt===time)).toBe(true);expect((await collector.list()).sources[0]!.pending).toBe(0);
  });
  it('尝试回执未保存就不请求原文，修复保存后才继续',async()=>{
    const store=files(),write=store.write;let failed=true,reads=0;
    store.write=async(path,text)=>{const state=path==='subscriptions.json'?JSON.parse(text):null;if(failed&&state?.sources.some((source:any)=>Object.keys(source.publicationAttempts??{}).length))throw Error('尝试回执保存失败');await write(path,text);};
    const collector=new SubscriptionCollector({files:store,now:()=>new Date(time),save:async()=>true,readFeed:async()=>({status:200,url:'https://example.org/feed',body:rss([{id:'today',date:time}])}),readArticle:async()=>{reads++;return todayPage;}});
    await enable(collector);await collector.poll(true);expect(reads).toBe(0);failed=false;await collector.poll(true);expect(reads).toBe(1);expect((await collector.list()).sources[0]!.status).toBe('ok');
  });
  it('新服务默认当天，只保存当天条目；旧、未来和未知不调用原文抓取',async()=>{
    const store=files(),saved:Material[]=[];let pageReads=0;
    const collector=new SubscriptionCollector({files:store,now:()=>new Date(time),save:async m=>{saved.push(m);return true;},readFeed:async()=>({status:200,url:'https://example.org/feed',body:rss([{id:'today',date:time},{id:'old',date:'2026-10-12T02:00:00Z',body:''},{id:'unknown',body:''},{id:'future',date:'2026-10-14T02:00:00Z',body:''}])}),readArticle:async url=>{pageReads++;expect(url).toContain('/today');return todayPage;}});
    expect((await enable(collector)).collectionScope).toBe('today');await collector.poll(true);
    expect(saved.map(m=>m.title)).toEqual(['today']);expect(pageReads).toBe(1);
    const state=await collector.list();expect(state.sources[0]!.daily).toEqual({date:'2026-10-13',eligible:1,older:1,undated:1,future:1});expect(state.sources[0]!.pending).toBe(0);expect(state.sources[0]!.status).toBe('ok');
    await collector.poll(true);expect(saved).toHaveLength(1);expect(pageReads).toBe(1);
  });
  it('跨日不沿用条件缓存，未来日期当天到来才保存，不补抓昨天',async()=>{
    const store=files(),saved:string[]=[],requests:unknown[]=[];let at=new Date(time);
    const xml=rss([{id:'day13',date:time},{id:'day14',date:'2026-10-14T02:00:00Z'}]);
    const collector=new SubscriptionCollector({files:store,now:()=>at,save:async m=>{saved.push(m.title);return true;},readFeed:async(_url,options)=>{requests.push(options.etag);return{status:200,url:'https://example.org/feed',body:xml,etag:'"unchanged"'};},readArticle:async url=>url.includes('day14')?todayPage.replace('2026-10-13','2026-10-14'):todayPage});
    await enable(collector);await collector.poll(true);at=new Date('2026-10-14T04:00:00Z');await collector.poll(true);
    expect(saved).toEqual(['day13','day14']);expect(requests).toEqual([undefined,undefined]);expect((await collector.list()).sources[0]!.daily?.date).toBe('2026-10-14');
  });
  it('RSS日期与实际原页面不符时，正文取得后仍不保存旧文章',async()=>{
    let saves=0,reads=0;const oldSeconds=Math.floor(Date.parse('2026-10-12T02:00:00Z')/1000);
    const collector=new SubscriptionCollector({files:files(),now:()=>new Date(time),save:async()=>{saves++;return true;},readFeed:async()=>({status:200,url:'https://example.org/feed',body:rss([{id:'mismatch',date:time,body:''}])}),readArticle:async()=>{reads++;return `<html><script>var biz="MzU0MjYwNDU2Mw==";var ct=${oldSeconds};</script><body><div id="js_content"><p>原页面的旧正文。</p></div></body></html>`;}});
    await enable(collector);await collector.poll(true);expect(reads).toBe(1);expect(saves).toBe(0);expect((await collector.list()).sources[0]?.daily?.older).toBe(1);
  });
  it('RSS已有全文也必须核验作者日期；旧文、日期不明不保存，重启保留核验结果',async()=>{
    const store=files();let saves=0,reads=0;
    const deps={files:store,now:()=>new Date(time),save:async()=>{saves++;return true;},readFeed:async()=>({status:200 as const,url:'https://example.org/feed',body:rss([{id:'old-relayed-today',date:time},{id:'no-author-date',date:time}])}),readArticle:async(url:string)=>{reads++;return url.includes('old-relayed')?todayPage.replace('2026-10-13','2026-10-12'):todayPage.replace('2026-10-13 12:00','');}};
    const collector=new SubscriptionCollector(deps);await enable(collector);await collector.poll(true);
    expect(reads).toBe(2);expect(saves).toBe(0);expect((await collector.list()).sources[0]?.daily).toMatchObject({eligible:0,older:1,undated:1});
    const restored=new SubscriptionCollector(deps);expect((await restored.list()).sources[0]?.publicationDates).toMatchObject({'https://mp.weixin.qq.com/s/old-relayed-today':'2026-10-12T04:00:00.000Z','https://mp.weixin.qq.com/s/no-author-date':null});
    await restored.poll(true);expect(reads).toBe(3);expect(saves).toBe(0);
  });
  it('当天保存失败不确认指纹，重试只保存失败项',async()=>{
    const saved:string[]=[],store=files();let fail=true;
    const collector=new SubscriptionCollector({files:store,now:()=>new Date(time),save:async m=>{if(m.title==='two'&&fail)throw new Error('磁盘失败');saved.push(m.title);return true;},readFeed:async()=>({status:200,url:'https://example.org/feed',body:rss([{id:'two',date:time},{id:'one',date:time}]),etag:'"v"'}),readArticle:async()=>todayPage});
    await enable(collector);await collector.poll(true);expect((await collector.list()).sources[0]!.status).toBe('error');fail=false;await collector.poll(true);
    expect(saved).toEqual(['one','two']);expect((await collector.list()).sources[0]!.status).toBe('ok');
  });
  it('切换到当天规则时，正在运行的历史窗口任务不再入库或回写旧状态',async()=>{
    const store=files();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let saves=0;
    const collector=new SubscriptionCollector({files:store,now:()=>new Date(time),save:async()=>{saves++;return true;},readFeed:async()=>{entered();await gate;return{status:200,url:'https://example.org/feed',body:rss([{id:'old',date:'2026-10-12T02:00:00Z'}])};}});
    let state=await enable(collector);state=await collector.configure({revision:state.revision,sources:state.sources.map(s=>s.config),collectionScope:'feed-window'});
    const task=collector.poll(true);await ready;state=await collector.list();await collector.configure({revision:state.revision,sources:state.sources.map(s=>s.config),collectionScope:'today'});release();await task;
    expect(saves).toBe(0);expect((await collector.list()).sources[0]!.status).toBe('waiting');
  });
  it('旧数据可读取并明确切换策略，不重置原件或来源去重记录',async()=>{
    const store=files(),dependencies={files:store,now:()=>new Date(time),save:async()=>true};
    const initial=new SubscriptionCollector(dependencies);await initial.list();const legacy=JSON.parse(store.data.get('subscriptions.json')!);delete legacy.collectionScope;delete legacy.collectionStartedAt;legacy.categories=legacy.categories.slice(0,6);store.data.set('subscriptions.json',JSON.stringify(legacy));
    const restored=new SubscriptionCollector(dependencies);const state=await restored.list();expect(state.collectionScope).toBe('feed-window');
    const next=await restored.configure({revision:state.revision,sources:state.sources.map(s=>s.config),collectionScope:'today'});expect(next.collectionStartedAt).toBe(time);expect(next.sources.map(s=>s.config)).toEqual(state.sources.map(s=>s.config));
  });
});
