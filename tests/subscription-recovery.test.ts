import { expect, it } from 'vitest';
import type { FileStore } from '../src/core/model';
import { SubscriptionCollector } from '../src/server/subscriptions';
import { createSourceServer } from '../src/server/service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { subscriptionsViewSchema } from '../src/core/subscriptions';

class Files implements FileStore {
  texts = new Map<string, string>();
  async read(path: string) { return this.texts.get(path) ?? null; }
  async write(path: string, content: string) { this.texts.set(path, content); }
  async readBinary(path: string) { const text = await this.read(path); return text === null ? null : new TextEncoder().encode(text); }
  async writeBinary(path: string, content: Uint8Array) { await this.write(path, new TextDecoder().decode(content)); }
}

async function fixture() {
  const files = new Files(); let time = new Date('2026-11-02T02:00:00Z');
  const errors = new Map<string, string>(), calls: string[] = [];
  const dependencies = { files, now: () => time, save: async () => true,
    readFeed: async (url: string) => {
      const id = new URL(url).pathname; calls.push(id);
      if (errors.has(id)) throw Error(errors.get(id));
      return { status: 200 as const, url, body: '<rss><channel><title>测试</title></channel></rss>' };
    } };
  const collector = new SubscriptionCollector(dependencies), view = await collector.list();
  await collector.configure({ revision: view.revision, collectionScope: 'feed-window', sources: view.sources.map((s, i) => ({ ...s.config,
    enabled: i < 4, feedUrl: `https://example.org/${i}`, topic: 'law', intervalMinutes: 60 })) });
  return { files, collector, errors, calls, dependencies, advance: (ms: number) => { time = new Date(time.getTime() + ms); } };
}

it('开机网络未就绪后一分钟自动再检查，不要求手动同步或重填API', async () => {
  const f = await fixture(); f.errors.set('/0', 'Client network socket disconnected before secure TLS connection was established');
  await f.collector.poll();
  expect((await f.collector.list()).sources[0]!.nextDue).toBe('2026-11-02T02:01:00.000Z');
  f.errors.clear(); f.calls.length = 0; f.advance(60_000);
  await new SubscriptionCollector(f.dependencies).poll();
  expect(f.calls).toEqual(['/0']);
  expect((await new SubscriptionCollector(f.dependencies).list()).sources[0]!.status).toBe('ok');
});

it('网络恢复提前检查网络错误，保护健康来源、授权和限流的等待期限', async () => {
  const f = await fixture();
  f.errors.set('/0', '官方接口连接失败'); f.errors.set('/1', '官方接口密钥、启用状态或密钥限制不符，请检查配置');
  f.errors.set('/2', '订阅返回 HTTP 429');
  await f.collector.poll(); f.advance(60_000); await f.collector.poll(true);
  f.errors.clear(); f.calls.length = 0; f.advance(60_000);
  await f.collector.poll('network-recovery');
  expect(f.calls).toEqual(['/0']);
  const view = await f.collector.list();
  expect(view.sources.map(s => s.status).slice(0, 4)).toEqual(['ok', 'error', 'error', 'ok']);
});

it('失败原因在成功和重启后保留，凭据不进入诊断历史；历史有界', async () => {
  const f = await fixture();
  f.errors.set('/0', '网络超时 https://private.example/feed?token=secret-feed-token');
  await f.collector.poll(); f.errors.clear(); f.advance(60_000); await f.collector.poll();
  const source = (await new SubscriptionCollector(f.dependencies).list()).sources[0]!;
  expect(source.status).toBe('ok'); expect(source.error).toBe('');
  expect(source.recentChecks).toEqual([
    expect.objectContaining({ status: 'error', kind: 'network', message: expect.stringContaining('网络超时') }),
    expect.objectContaining({ status: 'ok' }),
  ]);
  expect(JSON.stringify(source.recentChecks)).not.toContain('secret-feed-token');
  for (let i = 0; i < 15; i++) { f.advance(3600_000); await f.collector.poll(); }
  expect((await f.collector.list()).sources[0]!.recentChecks).toHaveLength(12);
  expect((await f.collector.list()).sources[0]!.lastFailure).toMatchObject({ kind: 'network', status: 'error' });
});

it('网络恢复请求合并且不立即重复请求；网络与429混合错误不能绕过限流', async () => {
  const f = await fixture(); f.errors.set('/0', 'YouTube 更新失败；官方接口：官方接口连接失败；RSS：订阅返回 HTTP 429');
  f.errors.set('/1', '订阅读取超时'); await f.collector.poll();
  f.errors.clear(); f.calls.length = 0;
  const first = f.collector.poll('network-recovery'); expect(f.collector.poll('network-recovery')).toBe(first); await first;
  expect(f.calls).toEqual([]);
  f.advance(60_000); await f.collector.poll('network-recovery'); expect(f.calls).toEqual(['/1']);
});

it('HTTP网络恢复入口鉴权并校验输入，按选择恢复，回执契约保留失败历史', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-recovery-http-')), token = 'isolated-recovery-test-token';
  let time = new Date('2026-11-02T02:00:00Z'), offline = true;
  const calls: string[] = [];
  const server = createSourceServer({ directory, token, subscriptionDependencies: { now: () => time,
    readFeed: async url => {
      const id = new URL(url).pathname; calls.push(id);
      if (offline) throw Error(id === '/0' ? '官方接口连接失败' : '订阅返回 HTTP 429');
      return { status: 200, url, body: '<rss><channel><title>测试</title></channel></rss>' };
    } } });
  try {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); await server.collector.poll();
    const address = server.address(); if (!address || typeof address === 'string') throw Error('缺少测试端口');
    const base = `http://127.0.0.1:${address.port}`, headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const view = await server.collector.list();
    await server.collector.configure({ revision: view.revision, collectionScope: 'feed-window', sources: view.sources.map((s, i) => ({ ...s.config,
      enabled: i < 2, topic: 'law', feedUrl: `https://example.org/${i}` })) });
    await server.collector.poll(); time = new Date(time.getTime() + 60_000); await server.collector.poll(true);
    calls.length = 0; offline = false; time = new Date(time.getTime() + 60_000);
    expect((await fetch(base + '/v1/subscriptions/poll', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status).toBe(401);
    expect((await fetch(base + '/v1/subscriptions/poll', { method: 'POST', headers, body: '{"recoverNetwork":"yes"}' })).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await fetch(base + '/v1/subscriptions/poll', { method: 'POST', headers, body: '{"recoverNetwork":true}' })).status).toBe(200);
    await server.collector.poll(); expect(calls).toEqual(['/0']);
    const after = subscriptionsViewSchema.parse(await fetch(base + '/v1/subscriptions', { headers }).then(r => r.json()));
    expect(after.sources[0]).toMatchObject({ status: 'ok', lastFailure: { kind: 'network' } });
    expect(after.sources[1]!.status).toBe('error');
  } finally {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('source-recovery-http-')) throw Error('测试清理范围不符');
    await rm(target, { recursive: true, force: true });
  }
});
