import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { createSourceServer } from '../src/server/service';
import { defaultCategories } from '../src/core/categories';
import { makeSourceConfig, useConfiguredBilibiliFeed } from '../src/core/source-management';
import { currentCategory } from '../src/ui/workbench';
import { resolveSource } from '../src/server/source-discovery';
import { materialSchema, materialVersion, type ReadingItem } from '../src/core/model';

const channel = 'UCFDMMIHbtRdrVhHlGXVzApA';
const atom = (id = channel) => `<feed xmlns="http://www.w3.org/2005/Atom"><title>测试频道</title><author><uri>https://www.youtube.com/channel/${id}</uri></author></feed>`;
const rss = '<rss version="2.0"><channel><title>测试公众号</title><item><title>正文测试</title><link>https://mp.weixin.qq.com/s/test</link><description>一段摘要</description></item></channel></rss>';
const servers: Server[] = [];
const token = 'source-management-testing-token';
afterEach(async () => { for (const server of servers.splice(0)) if (server.listening) await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); });
describe('工作台添加来源与分类管理', () => {
  it('新增 UP 沿用已选 RSSHub，拒绝混用服务，保持其他平台和不匹配的订阅原样', () => {
    const source = { platform: 'bilibili' as const, name: '新 UP', accountId: '12345', feedUrl: 'https://space.bilibili.com/12345' };
    const saved = makeSourceConfig({ ...source, accountId: '946974', feedUrl: 'http://127.0.0.1:1200/bilibili/user/video/946974/noembed' }, defaultCategories()[5]!);
    expect(useConfiguredBilibiliFeed(source, [saved]).feedUrl).toBe('http://127.0.0.1:1200/bilibili/user/video/12345/noembed');
    expect(useConfiguredBilibiliFeed(source, [{ ...saved, enabled: false }]).feedUrl).toContain('/12345/noembed');
    for (const feedUrl of ['https://example.org/bilibili/user/video/0000/noembed', saved.feedUrl + '?token=secret', 'https://example.org/custom.xml']) {
      expect(useConfiguredBilibiliFeed(source, [{ ...saved, feedUrl }])).toEqual(source);
    }
    expect(useConfiguredBilibiliFeed({ ...source, platform: 'wechat' }, [saved]).feedUrl).toBe(source.feedUrl);
    expect(() => useConfiguredBilibiliFeed(source, [saved, { ...saved, feedUrl: saved.feedUrl.replace('127.0.0.1:1200', '127.0.0.1:1201') }])).toThrow('多个 RSSHub');
  });
  it('公众号 RSS 自动识别名称，普通 RSS 单独识别，网页和损坏 XML 拒绝添加', async () => {
    const input = { input: 'https://example.org/feed.xml' };
    const readFeed = async (url: string) => ({ status: 200 as const, body: rss, url });
    await expect(resolveSource(input, { readFeed })).resolves.toMatchObject({ platform: 'wechat', name: '测试公众号' });
    await expect(resolveSource(input, { readFeed: async url => ({ status: 200, body: rss.replace('mp.weixin.qq.com', 'example.org'), url }) })).resolves.toMatchObject({ platform: 'rss' });
    for (const body of ['<html><body>验证页</body></html>', rss.slice(0,-6), '<!DOCTYPE rss>'+rss]) {
      await expect(resolveSource(input, { readFeed: async url => ({ status: 200, body, url }) })).rejects.toThrow();
    }
  });
  it('接受明确的本机 RSS 端口与普通 Atom，识别不创建配置，空 feed 可先添加', async () => {
    const input = 'http://127.0.0.1:1200/custom.xml';
    const body = '<feed xmlns="http://www.w3.org/2005/Atom"><title>独立博客</title><entry><title>新文章</title><link href="https://example.org/post"/><published>2026-10-18T00:00:00Z</published></entry></feed>';
    const source = await resolveSource({ input }, { readFeed: async url => ({ status: 200, body, url }) });
    expect(source).toMatchObject({ platform: 'rss', name: '独立博客', feedUrl: input });
    expect(makeSourceConfig(source, defaultCategories()[0]!).id).toMatch(/^RSS-/);
    await expect(resolveSource({ input }, { readFeed: async url => ({ status: 200, body: '<rss><channel><title>暂无文章</title></channel></rss>', url }) })).resolves.toMatchObject({ platform: 'rss', name: '暂无文章' });
  });
  it('YouTube handle 只取频道自己的身份，忽略推荐视频 ID，并通过 Atom 复核；B站只承诺主页身份', async () => {
    const unrelated = 'UC' + 'x'.repeat(22);
    let requested = '';
    const dependencies = {
      readPage: async () => `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${channel}"></head><body><script>{"channelId":"${unrelated}"}</script></body></html>`,
      readFeed: async (url: string) => { requested = url; return { status: 200 as const, body: atom(), url }; },
    };
    await expect(resolveSource({ input: 'https://www.youtube.com/@laozhou/videos' }, dependencies)).resolves.toMatchObject({ accountId: channel, name: '测试频道' });
    expect(new URL(requested).searchParams.get('channel_id')).toBe(channel);
    await expect(resolveSource({ input: 'https://youtube.com/channel/'+channel }, { ...dependencies, readFeed: async url => ({ status: 200, body: atom(unrelated), url }) })).rejects.toThrow('身份');
    await expect(resolveSource({ input: 'https://youtube.com/@someone' }, { ...dependencies, readPage: async () => `<script>{"channelId":"${unrelated}"}</script>` })).rejects.toThrow('身份');
    await expect(resolveSource({ input: 'https://youtube.com/watch?v=12345678901' }, dependencies)).rejects.toThrow('主页');
    await expect(resolveSource({ input: 'https://space.bilibili.com/946974/video?tid=0' }, { readFeed: async () => { throw new Error('不应读取动态接口'); } })).resolves.toMatchObject({ platform:'bilibili', accountId:'946974', name:'影视飓风', feedUrl:'https://space.bilibili.com/946974' });
  });
  it('分类和新来源经授权 HTTP 保存、重开保留；旧客户端写入保留分类；重复来源与使用中分类删除被拒绝', async () => {
    const directory = resolve('.local/source-management-tests/'+crypto.randomUUID()); await mkdir(directory, { recursive:true });
    const dependencies = { readFeed: async (url:string) => ({ status:200 as const, body:atom(), url }) };
    const start = async () => {
      const server = createSourceServer({ directory,token, discoveryDependencies:dependencies, subscriptionDependencies:dependencies });
      await new Promise<void>(done => server.listen(0,'127.0.0.1',done)); servers.push(server);
      return { server, url:'http://127.0.0.1:'+(server.address() as {port:number}).port };
    };
    let service = await start();
    const headers = { Authorization:'Bearer '+token,'Content-Type':'application/json' };
    const request = async (path:string, body?:unknown) => fetch(service.url+path, { headers, method:body===undefined?'GET':'POST', ...(body===undefined?{}:{body:JSON.stringify(body)}) });
    expect((await fetch(service.url+'/v1/sources/resolve',{method:'POST',body:JSON.stringify({input:'https://youtube.com/channel/'+channel})})).status).toBe(401);
    const before = await request('/v1/subscriptions').then(r=>r.json());
    const resolved = await request('/v1/sources/resolve',{input:'https://youtube.com/channel/'+channel}).then(r=>r.json());
    expect((await request('/v1/subscriptions').then(r=>r.json())).revision).toBe(before.revision);
    const category = { id:'cat-'+crypto.randomUUID(),name:'美食',topic:'leisure' as const };
    const config = { ...makeSourceConfig(resolved,category), enabled:false };
    let response = await request('/v1/subscriptions',{revision:before.revision,sources:[config],categories:[...defaultCategories(),category]});
    expect(response.status).toBe(200); let view = await response.json();
    await new Promise<void>(done=>service.server.close(()=>done())); service = await start();
    view = await request('/v1/subscriptions').then(r=>r.json()); expect(view.categories.at(-1).name).toBe('美食'); expect(view.sources[0].config.id).toBe(config.id);
    response = await request('/v1/subscriptions',{revision:view.revision,sources:[config]}); expect(response.status).toBe(200); view=await response.json(); expect(view.categories).toHaveLength(defaultCategories().length+1);
    expect((await request('/v1/subscriptions',{revision:view.revision,sources:[config],categories:defaultCategories()})).status).toBe(400);
    expect((await request('/v1/subscriptions',{revision:view.revision,sources:[config,{...config,id:'YT-'+crypto.randomUUID()}]})).status).toBe(400);
    expect((await request('/v1/subscriptions',{revision:before.revision,sources:[config]})).status).toBe(400);
    view.categories.at(-1).name='吃播与美食';
    response=await request('/v1/subscriptions',{revision:view.revision,sources:[config],categories:view.categories}); expect(response.status).toBe(200);
    expect(JSON.parse(await readFile(directory+'/subscriptions.json','utf8')).categories.at(-1).name).toBe('吃播与美食');
    expect((await request('/v1/feed').then(r=>r.json())).items).toHaveLength(0);
  });
  it('已有材料按来源的当前分类显示，移动和改名不改变内容版本或写正文', async () => {
    const category={id:'cat-'+crypto.randomUUID(),name:'美食',topic:'leisure' as const};
    const material=materialSchema.parse({title:'旧视频',source:'原频道',topic:'headlines',kind:'article',identity:'youtube:12345678901',coverage:'metadata',body:'',capturedAt:'2026-10-10T00:00:00Z',gaps:[],guide:'',guideKind:'none'});
    const item={...material} as ReadingItem;
    const sources=[{registry_id:'YT-001',display_name:'自定显示名称',original_name:'原频道',verification_status:'subscription',categoryId:category.id}];
    expect(currentCategory(item,sources,[...defaultCategories(),category])).toEqual({id:category.id,name:'美食'});
    expect(currentCategory(item,sources,[...defaultCategories(),{...category,name:'吃播'}]).name).toBe('吃播');
    expect(await materialVersion(material)).toBe(await materialVersion({...material,categoryId:category.id,categoryName:category.name,sourceId:'YT-001'}));
  });
});
