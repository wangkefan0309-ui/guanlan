import { describe, expect, it } from 'vitest';
import { SubscriptionCollector } from '../src/server/subscriptions';
import type { FileStore, Material } from '../src/core/model';
import { YoutubeApiAccess, type YoutubeApiRequest } from '../src/server/youtube-api';
import { parseRss } from '../src/server/rss';
import { createSourceServer } from '../src/server/service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const channel = 'UCKV2yWPB3wn0RTZh3cTD8YA', video = 'pC3QbOu7_s4';
function files() { const data = new Map<string, string>(); return { data, read: async (p: string) => data.get(p) ?? null, write: async (p: string, v: string) => { data.set(p, v); }, readBinary: async () => null, writeBinary: async () => {} } satisfies FileStore & { data: Map<string, string> }; }
const atom = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><id>yt:channel:${channel}</id><title>硅谷101</title><author><name>硅谷101</name><uri>https://www.youtube.com/channel/${channel}</uri></author><entry><id>yt:video:${video}</id><yt:videoId>${video}</yt:videoId><title>实际近期视频</title><author><name>硅谷101</name><uri>https://www.youtube.com/channel/${channel}</uri></author><link href="https://www.youtube.com/watch?v=${video}"/><published>2026-10-18T08:00:00Z</published></entry></feed>`;
const key = 'fixture-only-youtube-api-key-12345', playlist = 'UUKV2yWPB3wn0RTZh3cTD8YA';
const channelData = (id = channel) => ({ items: [{ id, snippet: { title: '硅谷101' }, contentDetails: { relatedPlaylists: { uploads: playlist } } }] });
const entry = () => ({ snippet: { channelId: channel, videoOwnerChannelId: channel, playlistId: playlist, title: '实际近期视频', publishedAt: '2026-10-19T08:00:00Z', resourceId: { kind: 'youtube#video', videoId: video } }, contentDetails: { videoId: video, videoPublishedAt: '2026-10-18T08:00:00Z' }, status: { privacyStatus: 'public' } });
async function configured(store = files(), request: YoutubeApiRequest = async resource => resource === 'channels' ? channelData() : { items: [entry()] }, now = () => new Date('2026-10-19T04:00:00Z')) {
  const access = new YoutubeApiAccess({ files: store, request, now });
  await access.configure({ revision: (await access.status()).revision, key }, channel); return access;
}

describe('YouTube公开页面受限后的独立接入', () => {
  it('官方接口已配置时不再依赖受限播放器，七天窗口补收原发布日期且不重复', async () => {
    let now = new Date('2026-10-13T04:00:00Z'), feeds = 0, pages = 0, api = 0; const saved: Material[] = [];
    const deps = { files: files(), now: () => now, save: async (m: Material) => { saved.push(m); return true; }, readFeed: async () => { feeds++; throw Error('RSS HTTP 404'); }, readYoutubePage: async () => { pages++; throw Error('LOGIN_REQUIRED'); }, readYoutubeApi: async () => { api++; return { status: 200 as const, url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`, body: atom, collectionMethod: 'direct-api' as const }; } };
    const c = new SubscriptionCollector(deps), before = await c.list();
    const config = before.sources.find(s => s.config.platform === 'youtube')!.config;
    await c.configure({ revision: before.revision, catchupDays: 7, sources: [{ ...config, accountId: channel, feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`, enabled: true, topic: 'cognition', categoryId: 'cognition' }] });
    now = new Date('2026-10-19T04:00:00Z'); await c.poll(true); await c.poll(true);
    expect((await c.list()).sources[0]).toMatchObject({ status: 'ok', collectionMethod: 'direct-api' });
    expect(saved).toHaveLength(1); expect(saved[0]?.publishedAt).toBe('2026-10-18T08:00:00.000Z'); expect([feeds, pages, api]).toEqual([0, 0, 2]);
  });
  it('官方接口失败时仍可用RSS；暂停来源不发出官方请求', async () => {
    let api = 0, feeds = 0; const deps = { files: files(), now: () => new Date('2026-10-18T10:00:00Z'), save: async () => true, readFeed: async () => { feeds++; return { status: 200 as const, url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`, body: atom }; }, readYoutubeApi: async () => { api++; throw Error('模拟官方接口配额已用完'); } };
    const c = new SubscriptionCollector(deps), v = await c.list(), original = v.sources.find(s => s.config.platform === 'youtube')!.config;
    let state = await c.configure({ revision: v.revision, sources: [{ ...original, accountId: channel, feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`, enabled: true, topic: 'cognition', categoryId: 'cognition' }] });
    await c.poll(true); expect((await c.list()).sources[0]?.status).toBe('ok'); expect([api, feeds]).toEqual([1, 1]);
    state = await c.list(); await c.configure({ revision: state.revision, sources: state.sources.map(s => ({ ...s.config, enabled: false })) }); await c.poll(true); expect([api, feeds]).toEqual([1, 1]);
  });
});

describe('官方接口凭据、原始日期和调用上限', () => {
  it('未配置不发请求；密钥不出现在状态、原件和错误回执中', async () => {
    const store = files(); let calls = 0;
    const request: YoutubeApiRequest = async resource => { calls++; return resource === 'channels' ? channelData() : { items: [entry()], echoed: key }; };
    const access = new YoutubeApiAccess({ files: store, request }); expect(await access.read(channel, 'today', 7)).toBeNull(); expect(calls).toBe(0);
    await access.configure({ revision: (await access.status()).revision, key }, channel); const feed = await access.read(channel, 'today', 7);
    expect(JSON.stringify(await access.status())).not.toContain(key); expect(feed!.originalJson).not.toContain(key); expect(calls).toBe(2);
    expect(parseRss(feed!.body, feed!.url, false, { platform: 'youtube', accountId: channel })[0]?.publishedAt).toBe('2026-10-18T08:00:00.000Z');
    await access.read(channel, 'today', 7); expect(calls).toBe(2);
  });
  it('错误密钥验证和保存失败均保留已验证旧配置，清除需要显式操作', async () => {
    const store = files(); const access = await configured(store, async (resource, _parameters, input) => { if (input !== key) throw Error('拒绝 ' + input); return resource === 'channels' ? channelData() : { items: [entry()] }; });
    const before = store.data.get('youtube-access.json'), state = await access.status();
    await expect(access.configure({ revision: state.revision, key: 'another-fixture-key-invalid' }, channel)).rejects.toThrow('<REDACTED>'); expect(store.data.get('youtube-access.json')).toBe(before);
    const write = store.write; store.write = async () => { throw Error('模拟磁盘失败'); };
    await expect(access.configure({ revision: state.revision, clear: true }, channel)).rejects.toThrow('磁盘失败'); expect((await access.status()).configured).toBe(true);
    store.write = write; await access.configure({ revision: state.revision, clear: true }, channel); expect((await access.status()).configured).toBe(false); expect(await access.read(channel, 'today', 7)).toBeNull();
  });
  it.each(['owner', 'playlist', 'video', 'date'])('拒绝%s不符，列表加入日期不代替视频发布日期', async mismatch => {
    const item = entry(); if (mismatch === 'owner') item.snippet.videoOwnerChannelId = 'UCYO_jab_esuFRV4b17AJtAw'; if (mismatch === 'playlist') item.snippet.playlistId = 'other-playlist'; if (mismatch === 'video') item.contentDetails.videoId = 'abcdefghijk'; if (mismatch === 'date') delete (item.contentDetails as any).videoPublishedAt;
    const access = await configured(files(), async resource => resource === 'channels' ? channelData() : { items: [item] });
    await expect(access.read(channel, 'today', 7)).rejects.toThrow(); expect((await access.status()).lastError).not.toBe('');
  });
  it('配额用完后本日不反复请求，次日才再尝试，重启保留暂停状态', async () => {
    const store = files(); let calls = 0, now = new Date('2026-10-19T12:00:00Z'), fail = true;
    const request: YoutubeApiRequest = async resource => { calls++; if (resource === 'channels') return channelData(); if (fail) throw Error('官方接口配额已用完，今日暂停此路线'); return { items: [entry()] }; };
    const access = await configured(store, request, () => now); await expect(access.read(channel, 'today', 7)).rejects.toThrow('配额'); const used = calls;
    const resumed = new YoutubeApiAccess({ files: store, request, now: () => now }); expect((await resumed.status()).paused).toBe(true); await expect(resumed.read(channel, 'today', 7)).rejects.toThrow('上限'); expect(calls).toBe(used);
    now = new Date('2026-10-20T12:00:00Z'); fail = false; expect(await resumed.read(channel, 'today', 7)).not.toBeNull(); expect((await resumed.status()).paused).toBe(false);
  });
  it('本地1000次上限在请求前持久化，回执保存失败不发请求', async () => {
    const store = files(); let calls = 0; const request: YoutubeApiRequest = async resource => { calls++; return resource === 'channels' ? channelData() : { items: [entry()] }; };
    const access = await configured(store, request); const state = JSON.parse(store.data.get('youtube-access.json')!); state.requests = 1000; store.data.set('youtube-access.json', JSON.stringify(state)); const resumed = new YoutubeApiAccess({ files: store, request, now: () => new Date('2026-10-19T04:00:00Z') });
    await expect(resumed.read(channel, 'today', 7)).rejects.toThrow('上限'); expect(calls).toBe(1);
    store.write = async () => { throw Error('模拟回执保存失败'); }; await expect(access.read(channel, 'today', 7)).rejects.toThrow('保存失败'); expect(calls).toBe(1);
  });
  it('慢验证不能覆盖新配置，旧密钥的在途结果不能越过配置修订', async () => {
    const store = files(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), ready = new Promise<void>(r => entered = r);
    const access = await configured(store, async (_resource, _parameters, input) => { if (input !== key) { entered(); await gate; } return channelData(); });
    const v = await access.status(), pending = access.configure({ revision: v.revision, key: 'slow-validation-fixture-key' }, channel); await ready; await access.configure({ revision: v.revision, clear: true }, channel); release(); await expect(pending).rejects.toThrow('较新'); expect((await access.status()).configured).toBe(false);
  });
  it('清除密钥后，在途官方读取不发布旧结果；停服等待配置验证完成', async () => {
    const store = files(); let release!: () => void, entered!: () => void;
    let gate = new Promise<void>(r => release = r), ready = new Promise<void>(r => entered = r);
    const access = await configured(store, async resource => { if (resource === 'channels') return channelData(); entered(); await gate; return { items: [entry()] }; });
    const read = access.read(channel, 'today', 7); await ready; const status = await access.status(); await access.configure({ revision: status.revision, clear: true }, channel); release(); await expect(read).rejects.toThrow('配置已变化');
    gate = new Promise<void>(r => release = r); ready = new Promise<void>(r => entered = r);
    const slow = new YoutubeApiAccess({ files: files(), request: async () => { entered(); await gate; return channelData(); } });
    const saving = slow.configure({ revision: (await slow.status()).revision, key }, channel); await ready; let stopped = false; const stop = slow.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false); release(); await saving; await stop; expect((await slow.status()).configured).toBe(true);
  });
  it('分页最多两页，跳过私有条目，保持作者视频日期', async () => {
    let lists = 0; const access = await configured(files(), async resource => resource === 'channels' ? channelData() : { items: lists++ === 0 ? [{ status: { privacyStatus: 'private' } }] : [entry()], nextPageToken: 'another' });
    const feed = await access.read(channel, 'today', 7); expect(lists).toBe(2); expect(parseRss(feed!.body, feed!.url, false, { platform: 'youtube', accountId: channel })).toHaveLength(1); expect(JSON.parse(feed!.originalJson!).hasMore).toBe(true);
  });
  it('HTTP配置接口鉴权，拒绝无效输入，GET从不回显密钥', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'source-youtube-api-')), token = crypto.randomUUID(); let requests = 0;
    const server = createSourceServer({ directory, token, youtubeApiRequest: async (_resource, parameters) => { requests++; return channelData(parameters.id); } });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw Error('端口缺失');
    const url = `http://127.0.0.1:${address.port}/v1/youtube/access`, headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    try {
      expect((await fetch(url)).status).toBe(401); const state = await fetch(url, { headers }).then(r => r.json());
      expect((await fetch(url, { headers, method: 'POST', body: JSON.stringify({ revision: state.revision, key: 'bad' }) })).status).toBe(400); expect(requests).toBe(0);
      const configured = await fetch(url, { headers, method: 'POST', body: JSON.stringify({ revision: state.revision, key }) }).then(r => r.json()); expect(configured.configured).toBe(true); expect(JSON.stringify(configured)).not.toContain(key);
      expect((await fetch(url, { headers }).then(r => r.text()))).not.toContain(key); expect(requests).toBe(1);
    } finally { await new Promise<void>(done => server.close(() => done())); if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('source-youtube-api-')) throw Error('临时目录身份不符'); await rm(directory, { recursive: true, force: true }); }
  });
});
