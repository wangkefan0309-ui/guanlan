import { it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSourceServer } from '../src/server/service';

it('免费X入口需鉴权，状态不触发搜索，并发共享日缓存且不调用付费API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-free-x-')); const token = 'unit-free-service-token';
  let calls = 0, logins = 0;
  const server = createSourceServer({ directory, token, socialDataTransport: async () => { throw new Error('禁止付费回退'); }, freeXRuntime: {
    async ready() { return { configured: true, reason: 'configured' }; }, async login() { logins++; },
    async search() { calls++; return JSON.stringify({ ok: true, tweets: [], raw: {} }); },
  } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    expect((await fetch(`${base}/v1/exploration/x/free/login`, { method: 'POST', body: '{}' })).status).toBe(401); expect(logins).toBe(0);
    expect((await fetch(`${base}/v1/exploration/x/free/status`, { headers })).status).toBe(200); expect(calls).toBe(0);
    const body = JSON.stringify({ topics: ['domestic', 'international', 'business', 'investing', 'finance', 'life', 'growth', 'technology'] });
    const results = await Promise.all([1, 2].map(() => fetch(`${base}/v1/exploration/x/free/search`, { method: 'POST', headers, body })));
    for (const result of results) { expect(result.status).toBe(200); expect((await result.json()).freeXUsage.requestsToday).toBe(3); }
    expect(calls).toBe(3);
    expect((await fetch(`${base}/v1/exploration/x/free/login`, { method: 'POST', headers, body: '{}' })).status).toBe(200); expect(logins).toBe(1);
  } finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await rm(directory, { recursive: true, force: true }); }
});

it('X端点鉴权，HTTP并发按服务共享每日额度，预算读取不调用付费API',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'source-x-'));const token='unit-service-token-123456';let calls=0;
  const server=createSourceServer({directory,token,socialDataTransport:async(query,key)=>{expect(key).toBe('provider-local-key');expect(query).toContain('since_time:');calls++;return {status:200,text:JSON.stringify({tweets:[{id_str:'1234',full_text:'国内商业、经济以及生活中值得关注的一条具体消息，保留真实文字及来源范围。',user:{screen_name:'example'}}]})};}});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  try{
    expect((await fetch(`${base}/v1/exploration/x/status`)).status).toBe(401);
    const requests=await Promise.all([1,2].map(()=>fetch(`${base}/v1/exploration/x/search`,{method:'POST',headers,body:JSON.stringify({key:'provider-local-key',topics:['domestic','international','business','investing','finance','life','growth','technology']})})));
    for(const response of requests){expect(response.status).toBe(200);expect((await response.json()).xUsage.returnedPosts).toBe(3);}expect(calls).toBe(3);
    const status=await (await fetch(`${base}/v1/exploration/x/status`,{headers})).json();expect(status.requestsToday).toBe(3);expect(status.spentUsd).toBe(0.0006);expect(calls).toBe(3);
    expect((await readFile(join(directory,'socialdata','state.json'),'utf8'))).not.toContain('provider-local-key');expect(await readdir(join(directory,'socialdata','receipts'))).toHaveLength(3);
  }finally{await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));await rm(directory,{recursive:true,force:true});}
});

it('X收录只取已校验缓存，需鉴权，不写订阅feed或再次调用外部接口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-free-post-')), token = 'unit-post-service-token'; let calls = 0;
  const server = createSourceServer({ directory, token, freeXRuntime: {
    async ready() { return { configured: true, reason: 'ready' }; }, async login() {},
    async search() { calls++; return JSON.stringify({ ok: true, tweets: [{ id_str: '10000', full_text: '这是一条可以用于投资与人工智能讨论的原始公开帖子，正文完整保存，不是登录页面。', tweet_created_at: new Date(Date.now()-60_000).toISOString(), user: { screen_name: 'author' } }], raw: {} }); },
  } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body = JSON.stringify({ url: 'https://x.com/author/status/10000', topic: 'finance' });
  try {
    expect((await fetch(`${base}/v1/exploration/x/free/post`, { method: 'POST', body })).status).toBe(401);
    await fetch(`${base}/v1/exploration/x/free/search`, { method: 'POST', headers, body: JSON.stringify({ topics: ['technology'] }) });
    const feedBefore = await (await fetch(`${base}/v1/feed`, { headers })).json();
    const response = await fetch(`${base}/v1/exploration/x/free/post`, { method: 'POST', headers, body });
    expect(response.status).toBe(200); expect((await response.json()).material).toMatchObject({ topic: 'finance', source: 'X · @author', coverage: 'full' });
    expect(await (await fetch(`${base}/v1/feed`, { headers })).json()).toEqual(feedBefore); expect(calls).toBe(1);
  } finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await rm(directory, { recursive: true, force: true }); }
});
