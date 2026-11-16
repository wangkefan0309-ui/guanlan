import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { createSourceServer } from '../src/server/service';
import { extractPdf } from '../src/server/extract';
import { blankPdf, samplePdf } from './pdf-fixture';
import { ReadingLibrary, selectDaily } from '../src/core/library';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const resources: {directory:string;server:Server}[]=[]; const token='test-token-at-least-16-characters';
async function start(directory?:string) {
  directory??=await mkdtemp(join(tmpdir(),'source-workbench-')); const server=createSourceServer({directory,token});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve)); resources.push({directory,server});
  const address=server.address(); if(!address||typeof address==='string') throw new Error('测试端口不可用');
  return { server,directory,url:`http://127.0.0.1:${address.port}` };
}
async function close(server:Server) { if(server.listening) await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
afterEach(async()=>{
  const current = resources.splice(0);
  for (const resource of current) await close(resource.server);
  for (const directory of new Set(current.map(resource => resource.directory))) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !/^(source-workbench-|source-close-drain-)/.test(basename(target))) throw new Error('测试清理路径不在专用临时目录');
    await rm(target, { recursive: true, force: true });
  }
});
describe('HTTP 接入及持久化',()=>{
  it('主动检索需要鉴权与限定请求，不改订阅配置或材料feed',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'source-workbench-'));let calls=0;
    const server=createSourceServer({directory,token,explorationTransport:async()=>{calls++;return JSON.stringify({results:[{title:'真实检索样例',url:'https://example.org/article',content:'根据检索接口返回的摘选'}],usage:{credits:1}});}});
    resources.push({directory,server});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('无端口');const url=`http://127.0.0.1:${address.port}`;
    const body=JSON.stringify({provider:'tavily',queries:['AI教程'],key:'test-secret'});const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};const before=(await fetch(`${url}/v1/subscriptions`,{headers}).then(r=>r.json())).sources.map((source:{config:unknown})=>source.config);
    expect((await fetch(`${url}/v1/exploration/search`,{method:'POST',body})).status).toBe(401);expect(calls).toBe(0);
    const invalid=await fetch(`${url}/v1/exploration/search`,{method:'POST',headers,body:JSON.stringify({provider:'tavily',queries:['AI教程'],key:'test-secret',endpoint:'http://127.0.0.1'})});expect(invalid.status).toBe(400);expect(calls).toBe(0);
    const response=await fetch(`${url}/v1/exploration/search`,{method:'POST',headers,body});expect(response.status).toBe(200);const results=await response.json();expect(results.candidates).toHaveLength(1);expect(JSON.stringify(results)).not.toContain('test-secret');expect(calls).toBe(1);
    expect((await fetch(`${url}/v1/feed`,{headers}).then(r=>r.json())).items).toHaveLength(0);expect((await fetch(`${url}/v1/subscriptions`,{headers}).then(r=>r.json())).sources.map((source:{config:unknown})=>source.config)).toEqual(before);
  });
  it('后台停止入口要求服务鉴权和空请求体，未启用回调的服务不提供停止能力', async () => {
    const existing = await start();
    expect((await fetch(existing.url+'/v1/runtime/identity')).status).toBe(401);
    const identity=await fetch(existing.url+'/v1/runtime/identity',{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json());
    expect(identity).toMatchObject({instance:'source-workbench-material-runtime',pid:process.pid,stopEnabled:false});
    expect((await fetch(existing.url + '/v1/runtime/stop', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    const directory = await mkdtemp(join(tmpdir(), 'source-workbench-')); let stops = 0;
    const server = createSourceServer({ directory, token, onShutdown: () => { stops++; } }); resources.push({ directory, server });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('无端口');
    const url = `http://127.0.0.1:${address.port}/v1/runtime/stop`;
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"force":true}' })).status).toBe(400);
    expect(stops).toBe(0);
    expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(202);
    await new Promise(done => setTimeout(done, 100)); expect(stops).toBe(1);
  });
  it('关闭回调等待正在采集的恢复回执落盘，之后同目录可以安全重开', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'source-close-drain-'));
    let begin!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = createSourceServer({ directory, token, subscriptionDependencies: {
      readFeed: async () => { begin(); await gate; throw new Error('采集中断'); },
    } });
    resources.push({ directory, server });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await server.collector.poll();
    const view = await server.collector.list();
    await server.collector.configure({ revision: view.revision, sources: view.sources.map((source, index) =>
      index ? source.config : { ...source.config, enabled: true, topic: 'law', feedUrl: 'http://127.0.0.1:1/feed' }) });
    const pending = server.collector.poll(true); await started;
    let finished = false;
    const httpClosed = new Promise<void>(resolve => server.once('close', resolve));
    const drained = new Promise<void>((resolve, reject) => server.close(error => {
      finished = true; error ? reject(error) : resolve();
    }));
    try { await httpClosed; expect(finished).toBe(false); }
    finally { release(); await pending; await drained; }
    const receipt = JSON.parse(await readFile(join(directory, 'subscriptions.json'), 'utf8')).sources[0];
    expect(receipt).toMatchObject({ phase: 'error', lastSuccess: null, nextDue: null });
    const restarted = await start(directory);
    await restarted.server.collector.stop();
    expect((await restarted.server.collector.list()).sources[0]!.lastSuccess).toBeNull();
  });
  it('未授权访问被拒绝；导入后的增量 feed 可读且重启保留，重复导入不新增游标',async()=>{
    const service=await start(); expect((await fetch(`${service.url}/v1/feed`)).status).toBe(401);
    const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    const payload={format:'markdown',title:'试读材料',content:'第一段说明复利的基础概念。',topic:'finance'};
    expect((await fetch(`${service.url}/v1/import`,{method:'POST',headers,body:JSON.stringify(payload)})).status).toBe(200);
    let feed=await fetch(`${service.url}/v1/feed`,{headers}).then(r=>r.json()); expect(feed.items).toHaveLength(1); expect(feed.cursor).toBe(1);
    await fetch(`${service.url}/v1/import`,{method:'POST',headers,body:JSON.stringify(payload)});
    const increment=await fetch(`${service.url}/v1/feed?after=1&instance=${feed.instance}`,{headers}).then(r=>r.json()); expect(increment.items).toHaveLength(0); expect(increment.cursor).toBe(1);
    await close(service.server); const restarted=await start(service.directory); const restored=await fetch(`${restarted.url}/v1/feed`,{headers}).then(r=>r.json()); expect(restored.instance).toBe(feed.instance); expect(restored.items[0].title).toBe('试读材料');
  });
  it('手动 PDF 保留页码与无文本页缺口，并保留可复核的原件',async()=>{
    const bytes=samplePdf(); const item=await extractPdf(bytes,{title:'基础报告'});
    expect(item.body).toContain('## 第 1 页'); expect(item.body).toContain('Financial basics: interest and time.'); expect(item.body).toContain('## 第 2 页'); expect(item.gaps.join('')).toContain('第 2 页没有文本层'); expect(item.coverage).toBe('partial'); expect(Buffer.from(item.original!.base64,'base64')).toEqual(Buffer.from(bytes));
  });
  it('服务端拒绝以抓取网页访问本机地址',async()=>{
    const service=await start(); const response=await fetch(`${service.url}/v1/import`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({format:'url',url:'http://127.0.0.1/'})});
    expect(response.status).toBe(400); expect((await response.json()).error).toContain('公网地址');
  });
  it('正文相同的网页追踪脚本更新不新增 feed 版本',async()=>{
    const service=await start();const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    for(const script of ['firstCapture()','secondCapture()']){
      const payload={format:'html',url:'https://mp.weixin.qq.com/s/a',content:`<html><body><h1 id="activity-name">题目</h1><a id="js_name">来源</a><div id="js_content"><p>原正文没有改变，仍然介绍相同的概念和条件。</p></div><script>${script}</script></body></html>`};
      expect((await fetch(`${service.url}/v1/import`,{method:'POST',headers,body:JSON.stringify(payload)})).status).toBe(200);
    }
    const feed=await fetch(`${service.url}/v1/feed`,{headers}).then(response=>response.json());expect(feed.cursor).toBe(1);expect(feed.items).toHaveLength(1);
  });
  it('40 页扫描 PDF 保留原件和所有页码缺口，300 页边界也可以导入',async()=>{
    for(const pages of [40,300]){const bytes=blankPdf(pages);const material=await extractPdf(bytes,{title:'扫描报告'});expect(material.coverage).toBe('metadata');expect(material.gaps.length).toBeLessThan(40);expect(material.gaps.join('')).toContain(String(pages));expect(Buffer.from(material.original!.base64,'base64')).toEqual(Buffer.from(bytes));}
  });
  it('同一文件的内容更新关联版本，今日阅读仅推荐新版；不同来源标识独立保存',async()=>{
    const service=await start();const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    for(const content of ['第一版','第二版']) await fetch(`${service.url}/v1/import`,{method:'POST',headers,body:JSON.stringify({format:'markdown',title:'同一文件',content,topic:'law'})});
    const feed=await fetch(`${service.url}/v1/feed`,{headers}).then(response=>response.json());expect(feed.items[0].identity).toBe(feed.items[1].identity);
    const data=new Map<string,Uint8Array>();const library=new ReadingLibrary({read:async path=>data.has(path)?new TextDecoder().decode(data.get(path)):null,readBinary:async path=>data.get(path)??null,write:async(path,text)=>{data.set(path,new TextEncoder().encode(text));},writeBinary:async(path,bytes)=>{data.set(path,bytes);}},'09_信息源');
    await library.sync(feed);expect(await library.list()).toHaveLength(2);expect(selectDaily(await library.list()).map(item=>item.body)).toEqual(['第二版']);
    const distinct=await fetch(`${service.url}/v1/import`,{method:'POST',headers,body:JSON.stringify({format:'markdown',title:'同一文件',content:'第三版',identity:'另一份同名文件'})}).then(response=>response.json());await library.import(distinct.material);expect(selectDaily(await library.list())).toHaveLength(2);
  });
  it('无效令牌、端口及端口被占用导致启动失败时不留下锁',async()=>{
    const service=await start();const run=promisify(execFile);
    for(const env of [{SOURCE_TOKEN:'short',SOURCE_PORT:'27183'},{SOURCE_TOKEN:token,SOURCE_PORT:'70000'},{SOURCE_TOKEN:token,SOURCE_PORT:new URL(service.url).port}]) {
      await expect(run(process.execPath,['--import','tsx','src/server/main.ts'],{env:{...process.env,SOURCE_DATA_DIR:service.directory,...env},timeout:10_000})).rejects.toThrow();
      await expect(access(join(service.directory,'server.lock'))).rejects.toThrow();
    }
  },20_000);
});
