import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { cloudSnapshot } from '../src/server/cloud-export';
import { createSourceServer } from '../src/server/service';
import { defaultCategories } from '../src/core/categories';
import { ReadingLibrary } from '../src/core/library';
import type { FileStore, Material } from '../src/core/model';

const instance = crypto.randomUUID();
const article: Material = { title: '已有文章', source: '记忆承载', sourceId: 'WX-001', identity: 'https://mp.weixin.qq.com/s/cloud-old', url: 'https://mp.weixin.qq.com/s/cloud-old', topic: 'finance', kind: 'article', purpose: 'reading', capturedAt: '2026-10-10T01:00:00.000Z', body: '原有正文和阅读位置必须保留。', coverage: 'partial', gaps: [], guide: '', guideKind: 'none', original: { extension: 'html', base64: Buffer.from('<article>原有正文</article>').toString('base64') } };
const ledger = JSON.stringify({ instance, entries: [{ seq: 7, version: 'a'.repeat(64), material: article }] });
function view() {
  return { revision: crypto.randomUUID(), running: true, categories: defaultCategories(), sources: [
    { config: { id: 'WX-001', platform: 'wechat', enabled: true, feedUrl: 'https://example.org/private-feed', topic: 'finance', intervalMinutes: 60, summaryIsBody: false }, name: '记忆承载', status: 'running', lastAttempt: null, lastSuccess: null, nextDue: null, error: '', imported: 0, pending: 0 },
    { config: { id: 'BL-001', platform: 'bilibili', accountId: '946974', enabled: true, feedUrl: 'http://127.0.0.1:13938/bilibili/user/video/946974/noembed', topic: 'leisure', intervalMinutes: 60, summaryIsBody: false }, name: '影视飓风', status: 'ok', lastAttempt: null, lastSuccess: null, nextDue: null, error: '', imported: 0, pending: 0 },
  ] };
}
const directories: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) if (server.listening) await new Promise<void>(done => server.close(() => done()));
  for (const directory of directories.splice(0)) { const target=resolve(directory); if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('source-cloud-'))throw new Error('清理路径越界');await rm(target,{recursive:true,force:true}); }
});
it('迁移保留实例、顺序和原件，重置发现回执，B站只改内部 RSSHub 端口', () => {
  const input=view(); const snapshot=cloudSnapshot(input,ledger); const state=JSON.parse(snapshot.subscriptions);
  expect(snapshot.ledger).toBe(ledger); expect(state.ledgerInstance).toBe(instance);
  expect(state.sources[0]).toMatchObject({ phase:'waiting',seen:{},etag:null,nextDue:null,lastSuccess:null });
  expect(state.sources[1].config.feedUrl).toBe('http://127.0.0.1:1200/bilibili/user/video/946974/noembed');
  expect(input.sources[1]!.config.feedUrl).toContain('13938'); expect(state.categories).toEqual(input.categories);
});
it('拒绝仍指向本机公众号采集端的配置，也不迁移手动原件', () => {
  const input=view(); input.sources[0]!.config.feedUrl='http://127.0.0.1:8001/feed';
  expect(()=>cloudSnapshot(input,ledger)).toThrow('本机采集端');
  expect(()=>cloudSnapshot(view(),JSON.stringify({instance,entries:[{seq:1,version:'v',material:{...article,sourceId:undefined,source:'手动文档',url:undefined,identity:'local:markdown:document',kind:'markdown'}}]}))).toThrow('非订阅材料');
});
it('旧版无来源ID的原稿按唯一作者和平台链接兼容，陌生域名不据同名入库', () => {
  const old=JSON.stringify({instance,entries:[{seq:7,version:'a'.repeat(64),material:{...article,sourceId:undefined}}]});
  expect(cloudSnapshot(view(),old).ledger).toBe(old);
  expect(()=>cloudSnapshot(view(),JSON.stringify({instance,entries:[{seq:7,version:'a'.repeat(64),material:{...article,sourceId:undefined,url:'https://example.org/private'}}]}))).toThrow('非订阅材料');
});
it('恢复后的真实 HTTP 增量接续旧游标，并保留旧正文及阅读位置', async () => {
  const snapshot=cloudSnapshot({...view(),collectionScope:'feed-window'},ledger);const directory=await mkdtemp(join(tmpdir(),'source-cloud-'));directories.push(directory);
  await writeFile(join(directory,'ledger.json'),snapshot.ledger);await writeFile(join(directory,'subscriptions.json'),snapshot.subscriptions);
  const token='cloud-test-token-more-than-16';
  const rss='<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>测试订阅</title><item><title>新增文章</title><link>https://mp.weixin.qq.com/s/cloud-new</link><content:encoded><![CDATA[<p>这是一篇独立新增的文章，验证迁移后的增量和旧材料保留。</p>]]></content:encoded></item></channel></rss>';
  const server=createSourceServer({directory,token,subscriptionDependencies:{readFeed:async url=>{if(url.includes('127.0.0.1'))throw new Error('模拟B站离线');return{status:200,body:rss,url};}}});servers.push(server);
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));await server.collector.poll();const address=server.address();if(!address||typeof address==='string')throw new Error('缺少端口');
  const url=`http://127.0.0.1:${address.port}`; const headers={Authorization:`Bearer ${token}`};
  expect((await fetch(`${url}/v1/feed`)).status).toBe(401);
  const storage=new Map<string,Uint8Array>(); const files:FileStore={read:async p=>storage.has(p)?new TextDecoder().decode(storage.get(p)):null,readBinary:async p=>storage.get(p)??null,write:async(p,v)=>{storage.set(p,new TextEncoder().encode(v));},writeBinary:async(p,v)=>{storage.set(p,v);}};
  const library=new ReadingLibrary(files,'09_云端测试');await library.sync({instance,cursor:7,items:[article],hasMore:false});const old=(await library.list())[0]!;await library.updateProgress(old.id,old.version,'reading','原位置');
  const feed=await(await fetch(`${url}/v1/feed?after=7&instance=${instance}`,{headers})).json();expect(feed.instance).toBe(instance);expect(feed.items).toHaveLength(1);expect(feed.cursor).toBe(8);await library.sync(feed);
  expect(await library.list()).toHaveLength(2);expect((await library.list()).find(item=>item.id===old.id)).toMatchObject({progress:'reading',position:'原位置',body:article.body});
  expect((await fetch(`${url}/v1/feed`,{headers}).then(r=>r.json())).items).toHaveLength(2);
  expect(await readFile(join(directory,'ledger.json'),'utf8')).toBe(snapshot.ledger);
});
