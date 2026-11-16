import { z } from 'zod';
import { request as httpsRequest } from 'node:https';
import type { FileStore } from '../core/model';
import type { CollectionScope } from '../core/subscriptions';
import { beijingDate } from '../core/daily';
import { youtubeAccessUpdateSchema, type YoutubeAccessView } from '../core/youtube-access';
import { sourceProxy } from './source-proxy';
import type { FeedResponse } from './feed-fetch';

const channelPattern = /^UC[\w-]{22}$/, playlistPattern = /^[\w-]{10,100}$/, videoPattern = /^[\w-]{11}$/;
const nameSchema = z.string().trim().min(1).max(160);
const channelSchema = z.object({ id: z.string().regex(channelPattern), snippet: z.object({ title: nameSchema }), contentDetails: z.object({ relatedPlaylists: z.object({ uploads: z.string().regex(playlistPattern) }) }) });
const stateSchema = z.object({
  schema: z.literal(1), revision: z.string().uuid(), key: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9_-]{20,200}$/)]), verifiedAt: z.string().datetime().nullable(),
  usageDay: z.string(), requests: z.number().int().nonnegative(), pausedDay: z.string().nullable(), lastError: z.string(),
  channels: z.record(z.string(), z.object({ name: nameSchema, uploads: z.string().regex(playlistPattern), at: z.string().datetime() })),
}).strict();
type State = z.infer<typeof stateSchema>;
export type YoutubeApiRequest = (resource: 'channels' | 'playlistItems', parameters: Record<string, string>, key: string, signal?: AbortSignal) => Promise<unknown>;
interface Dependencies { files: FileStore; request?: YoutubeApiRequest; now?: () => Date }
const quotaDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date);
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const errorText = (e: unknown, key: string) => (e instanceof z.ZodError ? '官方接口返回的数据格式无法核验' : e instanceof Error ? e.message : '官方接口读取失败').split(key || '\0').join('<REDACTED>').replace(/https?:\/\/\S+/g, '<URL>').slice(0, 400);

/** Fixed Google endpoint only; never forwards a credential through a redirect. */
export const requestYoutubeApi: YoutubeApiRequest = async (resource, parameters, key, signal) => {
  signal?.throwIfAborted();
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { signal, agent: sourceProxy(url), headers: { Accept: 'application/json', 'X-Goog-Api-Key': key } }, response => {
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4_000_000) request.destroy(Error('官方接口响应过大')); else chunks.push(chunk); });
      response.on('end', () => {
        let data: any; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(Error('官方接口未返回有效JSON')); return; }
        if (response.statusCode !== 200) {
          const reason = data?.error?.errors?.[0]?.reason;
          const invalidKey = ['keyInvalid', 'accessNotConfigured', 'ipRefererBlocked', 'forbidden'].includes(reason) || /API key not valid|API_KEY_INVALID|API_KEY_SERVICE_BLOCKED|API_KEY_IP_ADDRESS_BLOCKED|SERVICE_DISABLED/.test(JSON.stringify(data?.error?.details ?? []) + String(data?.error?.message ?? ''));
          reject(Error(['quotaExceeded', 'dailyLimitExceeded'].includes(reason) ? '官方接口配额已用完，今日暂停此路线' : invalidKey ? '官方接口密钥、启用状态或密钥限制不符，请检查配置' : `官方接口返回HTTP ${response.statusCode}`)); return;
        }
        if (!/^application\/json\b/i.test(response.headers['content-type'] ?? '')) { reject(Error('官方接口未返回JSON')); return; }
        resolve(data);
      });
      response.on('error', () => reject(Error('官方接口响应中断')));
    });
    const timer = setTimeout(() => request.destroy(Error('官方接口读取超时')), 20_000);
    request.on('close', () => clearTimeout(timer)); request.on('error', e => reject(signal?.aborted ? signal.reason : Error((e as Error).message === '官方接口读取超时' ? '官方接口读取超时' : '官方接口连接失败'))); request.end();
  });
};

/** Public channel metadata with one locally held key. No Google login cookies. */
export class YoutubeApiAccess {
  private state: State | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, { revision: string; at: number; feed: FeedResponse }>();
  private active = new Set<Promise<unknown>>();
  private stopping = false;
  private now: () => Date;
  private request: YoutubeApiRequest;
  constructor(private dependencies: Dependencies) { this.now = dependencies.now ?? (() => new Date()); this.request = dependencies.request ?? requestYoutubeApi; }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  private track<T>(fn: () => Promise<T>): Promise<T> { if (this.stopping) return Promise.reject(Error('官方接口正在停止')); const task = fn(); this.active.add(task); void task.finally(() => this.active.delete(task)).catch(() => {}); return task; }
  async stop() { this.stopping = true; await Promise.allSettled([...this.active]); await this.queue; }
  private async load() {
    if (this.state) return this.state;
    const text = await this.dependencies.files.read('youtube-access.json');
    this.state = text ? stateSchema.parse(JSON.parse(text)) : { schema: 1, revision: crypto.randomUUID(), key: '', verifiedAt: null, usageDay: '', requests: 0, pausedDay: null, lastError: '', channels: {} }; return this.state;
  }
  private async commit(next: State) { await this.dependencies.files.write('youtube-access.json', JSON.stringify(next)); this.state = next; }
  async status(): Promise<YoutubeAccessView> {
    return this.serial(async () => { const state = await this.load(), day = quotaDay(this.now()); return { revision: state.revision, configured: !!state.key, verifiedAt: state.verifiedAt, requestsToday: state.usageDay === day ? state.requests : 0, dailyLimit: 1000, paused: state.pausedDay === day || (state.usageDay === day && state.requests >= 1000), lastError: state.lastError }; });
  }
  configure(input: unknown, channelId: string): Promise<YoutubeAccessView> { return this.track(() => this.configureInner(input, channelId)); }
  private async configureInner(input: unknown, channelId: string): Promise<YoutubeAccessView> {
    const update = youtubeAccessUpdateSchema.parse(input);
    if (!channelPattern.test(channelId)) throw Error('请先配置一个有效的YouTube频道');
    await this.serial(async () => { if ((await this.load()).revision !== update.revision) throw Error('官方接口配置已变化，请重新打开后再保存'); });
    let channel: z.infer<typeof channelSchema> | undefined;
    if ('key' in update) {
      try { const data = z.object({ items: z.array(channelSchema).length(1) }).parse(await this.request('channels', { part: 'snippet,contentDetails', id: channelId }, update.key)); channel = data.items[0]!; if (channel.id !== channelId) throw Error('官方接口返回了其他频道'); }
      catch (e) { throw Error(errorText(e, update.key)); }
    }
    await this.serial(async () => {
      const previous = await this.load(); if (previous.revision !== update.revision) throw Error('官方接口配置已变化，未覆盖较新的配置');
      const at = this.now().toISOString();
      await this.commit({ ...previous, revision: crypto.randomUUID(), key: 'key' in update ? update.key : '', verifiedAt: channel ? at : null, usageDay: quotaDay(this.now()), requests: channel ? 1 : 0, pausedDay: null, lastError: '', channels: channel ? { [channelId]: { name: channel.snippet.title, uploads: channel.contentDetails.relatedPlaylists.uploads, at } } : {} }); this.cache.clear();
    });
    return this.status();
  }
  read(channelId: string, scope: CollectionScope, catchupDays: number, signal?: AbortSignal): Promise<FeedResponse | null> { return this.track(() => this.readInner(channelId, scope, catchupDays, signal)); }
  private async readInner(channelId: string, scope: CollectionScope, catchupDays: number, signal?: AbortSignal): Promise<FeedResponse | null> {
    if (!channelPattern.test(channelId)) throw Error('YouTube频道编号无效'); signal?.throwIfAborted();
    const state = await this.serial(async () => structuredClone(await this.load())); if (!state.key) return null;
    const cacheKey = `${channelId}:${scope}:${catchupDays}`, cached = this.cache.get(cacheKey);
    if (cached?.revision === state.revision && this.now().getTime() - cached.at >= 0 && this.now().getTime() - cached.at < 300_000) return structuredClone(cached.feed);
    const call = async (resource: 'channels' | 'playlistItems', parameters: Record<string, string>) => {
      signal?.throwIfAborted();
      await this.serial(async () => {
        const current = await this.load(), day = quotaDay(this.now()); if (current.revision !== state.revision) throw Error('官方接口配置已变化，本次读取取消');
        const requests = current.usageDay === day ? current.requests : 0;
        if (current.pausedDay === day || requests >= 1000) throw Error('官方接口达到今日本地请求上限，稍后使用其他路线');
        await this.commit({ ...current, usageDay: day, requests: requests + 1 });
      });
      signal?.throwIfAborted(); return this.request(resource, parameters, state.key, signal);
    };
    try {
      let channel = state.channels[channelId]; const originals: unknown[] = [];
      if (!channel || this.now().getTime() - Date.parse(channel.at) >= 86_400_000) {
        const data = await call('channels', { part: 'snippet,contentDetails', id: channelId }); originals.push(data);
        const actual = z.object({ items: z.array(channelSchema).length(1) }).parse(data).items[0]!;
        if (actual.id !== channelId) throw Error('官方接口频道身份不符');
        channel = { name: actual.snippet.title, uploads: actual.contentDetails.relatedPlaylists.uploads, at: this.now().toISOString() };
      }
      const videos: { id: string; title: string; publishedAt: string }[] = []; let pageToken: string | undefined;
      const today = beijingDate(this.now()), earliest = new Date(Date.parse(today) - catchupDays * 86_400_000).toISOString().slice(0, 10);
      for (let page = 0; page < 2; page++) {
        const data = await call('playlistItems', { part: 'snippet,contentDetails,status', playlistId: channel.uploads, maxResults: '50', ...(pageToken ? { pageToken } : {}) }); originals.push(data);
        const list = z.object({ items: z.array(z.any()).max(50), nextPageToken: z.string().max(1024).optional() }).parse(data);
        for (const item of list.items) {
          if (item.status?.privacyStatus && item.status.privacyStatus !== 'public') continue;
          if (item.snippet?.channelId !== channelId || (item.snippet?.videoOwnerChannelId && item.snippet.videoOwnerChannelId !== channelId) || item.snippet?.playlistId !== channel.uploads || item.snippet?.resourceId?.videoId !== item.contentDetails?.videoId || item.snippet?.resourceId?.kind !== 'youtube#video') throw Error('官方接口视频与频道身份不符');
          const stamp = item.contentDetails?.videoPublishedAt;
          if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(stamp) || !Number.isFinite(Date.parse(stamp))) throw Error('官方接口缺少真实视频发布日期');
          videos.push({ id: z.string().regex(videoPattern).parse(item.contentDetails.videoId), title: z.string().trim().min(1).max(240).parse(item.snippet.title), publishedAt: new Date(stamp).toISOString() });
        }
        pageToken = list.nextPageToken;
        if (!pageToken || scope !== 'today' || videos.some(v => beijingDate(new Date(v.publishedAt)) < earliest)) break;
      }
      signal?.throwIfAborted();
      const author = `<author><name>${xml(channel.name)}</name><uri>https://www.youtube.com/channel/${channelId}</uri></author>`;
      const entries = [...new Map(videos.map(v => [v.id, v])).values()].map(v => `<entry><id>yt:video:${v.id}</id><yt:videoId>${v.id}</yt:videoId><title>${xml(v.title)}</title>${author}<link rel="alternate" href="https://www.youtube.com/watch?v=${v.id}"/><published>${v.publishedAt}</published></entry>`).join('');
      const feed: FeedResponse = { status: 200, url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, collectionMethod: 'direct-api', body: `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><id>yt:channel:${channelId}</id><title>${xml(channel.name)}</title>${author}${entries}</feed>`, originalJson: JSON.stringify({ schema: 1, channelId, route: 'youtube-data-api', checkedAt: this.now().toISOString(), window: 100, hasMore: !!pageToken, originals }).split(state.key).join('<REDACTED>') };
      await this.serial(async () => { const current = await this.load(); if (current.revision !== state.revision) throw Error('官方接口配置已变化，本次结果未使用'); const channels = { ...current.channels, [channelId]: channel }; if (Object.keys(channels).length > 100) delete channels[Object.keys(channels)[0]!]; await this.commit({ ...current, lastError: '', channels }); this.cache.set(cacheKey, { revision: state.revision, at: this.now().getTime(), feed }); });
      return structuredClone(feed);
    } catch (e) {
      const message = errorText(e, state.key);
      if (!signal?.aborted) await this.serial(async () => { const current = await this.load(); if (current.revision === state.revision) await this.commit({ ...current, lastError: message, pausedDay: /配额已用完/.test(message) ? quotaDay(this.now()) : current.pausedDay }); });
      throw Error(message);
    }
  }
}
