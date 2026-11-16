import { z } from 'zod';
import { hash, materialSchema } from '../core/model';
import type { FileStore, Material } from '../core/model';
import { subscriptionConfigSchema, subscriptionUpdateSchema, collectionScopeSchema, catchupDaysSchema, dailyCollectionSchema, type CollectionScope } from '../core/subscriptions';
import { beijingDate } from '../core/daily';
import { dayDisposition, publicationDay } from '../core/subscription-days';
import type { SubscriptionConfig, SubscriptionsView } from '../core/subscriptions';
import { defaultSubscriptions, registeredSource } from '../core/source-registry';
import { extractHtml, identifyWechat, wechatPublishedAt } from './extract';
import { fetchPublicHtml } from './public-fetch';
import { fetchFeed, type FeedRequest, type FeedResponse } from './feed-fetch';
import { parseRss, type RssEntry } from './rss';
import { fetchBilibiliFeed } from './bilibili';
import { createBilibiliBrowserReader } from './bilibili-browser';
import { fetchYoutubePageFeed } from './youtube';
import { categoriesSchema, defaultCategories } from '../core/categories';
import { collectionIssueKind, redactCollectionError, subscriptionCheckSchema } from '../core/subscription-health';

const receiptSchema = z.object({
  config: subscriptionConfigSchema,
  phase: z.enum(['waiting', 'running', 'ok', 'error']),
  seen: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.string().regex(/^[a-f0-9]{64}$/)),
  etag: z.string().nullable(), lastModified: z.string().nullable(), responseUrl: z.string().nullable(),
  lastAttempt: z.string().nullable(), lastSuccess: z.string().nullable(), nextDue: z.string().nullable(),
  lastFullCheck: z.string().datetime().nullable().default(null),
  catchupImported: z.number().int().nonnegative().default(0),
  error: z.string(), imported: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), failures: z.number().int().nonnegative(),
  recentChecks: z.array(subscriptionCheckSchema).max(12).default([]),
  lastFailure: subscriptionCheckSchema.optional(),
  collectionMethod: z.enum(['feed', 'direct-api', 'browser', 'public-page']).optional(),
  daily: dailyCollectionSchema.optional(),
  publicationDates: z.record(z.string(), z.string().datetime().nullable()).default({}),
  publicationAttempts: z.record(z.string(),z.number().int().nonnegative()).default({}),
}).strict();
const stateSchema = z.object({ schema: z.literal(1), revision: z.string().uuid(), ledgerInstance: z.string().nullable().default(null), sources: z.array(receiptSchema).min(1).max(100), categories: categoriesSchema.default(defaultCategories), collectionScope: collectionScopeSchema.default('feed-window'), collectionStartedAt: z.string().datetime().optional(), catchupDays: catchupDaysSchema.default(0) }).strict();
type State = z.infer<typeof stateSchema>;
type Receipt = z.infer<typeof receiptSchema>;
interface Dependencies {
  files: FileStore;
  save(material: Material): Promise<boolean>;
  readFeed?: (url: string, options: FeedRequest) => Promise<FeedResponse>;
  readYoutubePage?: (channelId:string,signal?:AbortSignal,scope?:CollectionScope)=>Promise<FeedResponse>;
  readYoutubeApi?: (channelId:string,scope:CollectionScope,catchupDays:number,signal?:AbortSignal)=>Promise<FeedResponse|null>;
  readBilibiliBrowser?: (uid: string, signal?: AbortSignal) => Promise<FeedResponse>;
  readArticle?: (url: string, signal: AbortSignal) => Promise<string>;
  now?: () => Date;
  ledgerInstance?: () => Promise<string>;
}
function fresh(config: SubscriptionConfig): Receipt {
  return { config, phase: 'waiting', seen: {}, publicationDates: {}, publicationAttempts:{}, etag: null, lastModified: null, responseUrl: null, lastAttempt: null, lastSuccess: null, nextDue: null, lastFullCheck: null, catchupImported: 0, error: '', imported: 0, pending: 0, failures: 0, recentChecks: [] };
}
function transientNetworkError(message: string): boolean {
  return collectionIssueKind(message) === 'network';
}
function retryMinutes(failures: number, error: string): number {
  if (transientNetworkError(error)) return [1, 2, 5, 10, 15][Math.min(failures, 4)]!;
  return Math.min(transientCollectionError(error) ? 60 : 1440, 5 * 2 ** Math.min(failures, 9));
}
function transientCollectionError(error: string): boolean {
  return transientNetworkError(error) || /原页面账号信息不完整|原页面需要验证|正文未取得/.test(error);
}
async function networkRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try { return await read(); }
  catch (error) {
    signal.throwIfAborted();
    if (!transientNetworkError(error instanceof Error ? error.message : '')) throw error;
    return read();
  }
}
function collectable(item: { publishedAt?: string }, day: string, scope: CollectionScope, catchupDays: number, startedAt?: string): boolean {
  if (scope !== 'today') return true;
  const published = publicationDay(item);
  if (!published || published > day) return false;
  if (published === day) return true;
  if (!catchupDays) return false;
  const earliest = new Date(Date.parse(day + 'T00:00:00Z') - catchupDays * 86_400_000).toISOString().slice(0, 10);
  return published >= earliest && (!startedAt || published >= beijingDate(new Date(startedAt)));
}

/** AIHOT's RSS discovery feeds this module; durable receipts only acknowledge saved materials. */
export class SubscriptionCollector {
  private state: State | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private activeSource: { config: SubscriptionConfig; scope: CollectionScope; catchupDays: number; controller: AbortController } | null = null;
  private stopped = false;
  private readonly now: () => Date;
  private readonly browserRead: Dependencies['readBilibiliBrowser'];
  constructor(private dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.browserRead = dependencies.readBilibiliBrowser ?? (process.env.SOURCE_CHROME_PATH ? createBilibiliBrowserReader(process.env.SOURCE_CHROME_PATH) : undefined);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work); this.queue = result.catch(() => {}); return result;
  }
  private async load(): Promise<State> {
    if (this.state) return this.state;
    const saved = await this.dependencies.files.read('subscriptions.json');
    const candidate: State = saved ? stateSchema.parse(JSON.parse(saved)) : {
      schema: 1, revision: crypto.randomUUID(), ledgerInstance: null, sources: defaultSubscriptions().map(fresh), categories: defaultCategories(), collectionScope: 'today', collectionStartedAt: this.now().toISOString(), catchupDays: 0,
    };
    subscriptionUpdateSchema.parse({ revision: candidate.revision, sources: candidate.sources.map(source => source.config), categories: candidate.categories });
    const ledgerInstance = await this.dependencies.ledgerInstance?.() ?? null;
    if (candidate.ledgerInstance !== ledgerInstance) {
      candidate.sources = candidate.sources.map(source => fresh(source.config));
      candidate.ledgerInstance = ledgerInstance;
    }
    for (const source of candidate.sources) if (source.phase === 'running') {
      source.phase = 'error'; source.error = '上次采集中断，已保存材料保留，下次检查会继续'; source.nextDue = null;
      source.etag = null; source.lastModified = null; source.responseUrl = null;
    }
    // Older builds persisted up to a day of backoff even for a broken socket.
    // Bound that wait on restart as well, without bypassing rate limits or authorization failures.
    for (const source of candidate.sources) if (source.phase === 'error' && source.lastAttempt && source.nextDue && transientCollectionError(source.error)) {
      const due = Date.parse(source.lastAttempt) + (transientNetworkError(source.error) ? 15 : 60) * 60_000;
      if (Number.isFinite(due) && Date.parse(source.nextDue) > due) source.nextDue = new Date(due).toISOString();
    }
    await this.dependencies.files.write('subscriptions.json', JSON.stringify(candidate)); this.state = candidate; return candidate;
  }
  private async commit(next: State): Promise<void> {
    await this.dependencies.files.write('subscriptions.json', JSON.stringify(next)); this.state = next;
  }
  async list(): Promise<SubscriptionsView> {
    return this.serial(async () => {
      const state = await this.load();
      return { revision: state.revision, running: this.running !== null, collectionScope: state.collectionScope, collectionStartedAt: state.collectionStartedAt, catchupDays: state.catchupDays || undefined, categories: structuredClone(state.categories), sources: state.sources.map(receipt => ({
        config: structuredClone(receipt.config), name: receipt.config.name ?? registeredSource(receipt.config.id)?.display_name ?? receipt.config.id,
        status: !receipt.config.feedUrl ? 'not-configured' : !receipt.config.enabled ? 'paused' : receipt.phase,
        lastAttempt: receipt.lastAttempt, lastSuccess: receipt.lastSuccess, nextDue: receipt.nextDue,
        error: receipt.error, imported: receipt.imported, pending: receipt.pending,
        recentChecks: structuredClone(receipt.recentChecks),
        lastFailure: receipt.lastFailure && structuredClone(receipt.lastFailure),
        catchupImported: receipt.catchupImported || undefined,
        collectionMethod: receipt.collectionMethod,
        daily: receipt.daily && structuredClone(receipt.daily),
        publicationDates: structuredClone(receipt.publicationDates),
      })) };
    });
  }
  async configure(input: unknown): Promise<SubscriptionsView> {
    const update = subscriptionUpdateSchema.parse(input);
    await this.serial(async () => {
      const state = await this.load();
      if (state.revision !== update.revision) throw new Error('订阅配置已在其他窗口更新，请重新打开后再保存');
      const categories = update.categories ?? state.categories;
      const collectionScope = update.collectionScope ?? state.collectionScope;
      const catchupDays = update.catchupDays ?? state.catchupDays;
      const policyChanged = collectionScope !== state.collectionScope || catchupDays !== state.catchupDays;
      if (update.sources.some(source => source.categoryId && !categories.some(category => category.id === source.categoryId && category.topic === source.topic))) throw new Error('来源分类不存在或方向不符；使用中的分类请先移动来源再删除');
      const sources = update.sources.map(config => {
        const previous = state.sources.find(source => source.config.id === config.id);
        if (!previous) return fresh(config);
        if (!policyChanged && JSON.stringify(previous.config) === JSON.stringify(config)) return previous;
        const retain = previous.config.feedUrl === config.feedUrl && previous.config.summaryIsBody === config.summaryIsBody && previous.config.platform === config.platform && previous.config.accountId === config.accountId;
        return { ...fresh(config), ...(retain ? { seen: previous.seen, publicationDates: previous.publicationDates, publicationAttempts:previous.publicationAttempts,lastSuccess: previous.lastSuccess, recentChecks: previous.recentChecks, lastFailure: previous.lastFailure } : {}) };
      });
      await this.commit({ ...state, revision: crypto.randomUUID(), sources, categories, collectionScope, catchupDays,
        collectionStartedAt: collectionScope === 'today' ? state.collectionStartedAt ?? this.now().toISOString() : state.collectionStartedAt });
      const active = this.activeSource;
      if (active && (active.scope !== collectionScope || active.catchupDays !== catchupDays || JSON.stringify(sources.find(source => source.config.id === active.config.id)?.config) !== JSON.stringify(active.config))) active.controller.abort();
    });
    return this.list();
  }
  /** Repeated manual/scheduled polls share one task. force skips due-time, never saved-item checks. */
  poll(force: boolean | 'network-recovery' = false): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped) return Promise.reject(new Error('采集器正在停止'));
    this.controller = new AbortController();
    this.running = this.run(force, this.controller.signal).finally(() => { this.running = null; this.controller = null; });
    return this.running;
  }
  async stop(): Promise<void> { this.stopped = true; this.controller?.abort(); await this.running?.catch(() => {}); await this.queue; }
  private async run(force: boolean | 'network-recovery', signal: AbortSignal): Promise<void> {
    const snapshot = await this.serial(async () => structuredClone(await this.load()));
    for (const source of snapshot.sources) {
      if (signal.aborted) break;
      const at = this.now().getTime();
      const networkRecovered = force === 'network-recovery' && source.phase === 'error' && transientNetworkError(source.error)
        && !!source.lastAttempt && at - Date.parse(source.lastAttempt) >= 60_000;
      if (!source.config.enabled || (force !== true && !networkRecovered && source.nextDue && Date.parse(source.nextDue) > at)) continue;
      const controller = new AbortController();
      this.activeSource = { config: source.config, scope: snapshot.collectionScope, catchupDays: snapshot.catchupDays, controller };
      try { await this.collect(source, AbortSignal.any([signal, controller.signal]), snapshot.collectionScope, snapshot.catchupDays, snapshot.collectionStartedAt); }
      finally { this.activeSource = null; }
    }
  }
  private async update(config: SubscriptionConfig, change: (receipt: Receipt) => Receipt, scope: CollectionScope, catchupDays: number): Promise<boolean> {
    return this.serial(async () => {
      const state = await this.load(); const previous = state.sources.find(source => source.config.id === config.id);
      if (state.collectionScope !== scope || state.catchupDays !== catchupDays) return false;
      if (!previous) return false;
      if (JSON.stringify(previous.config) !== JSON.stringify(config)) return false;
      const next = change(structuredClone(previous));
      if (previous.phase === 'running' && next.phase !== 'running') {
        next.recentChecks = [...previous.recentChecks, { checkedAt: this.now().toISOString(), status: next.phase,
          kind: next.error ? collectionIssueKind(next.error) : undefined, message: redactCollectionError(next.error) }].slice(-12);
        if (next.phase === 'error') next.lastFailure = next.recentChecks.at(-1);
      }
      const sources = state.sources.map(source => source === previous ? next : source);
      await this.commit({ ...state, sources }); return true;
    });
  }
  private async collect(previous: Receipt, signal: AbortSignal, scope: CollectionScope, catchupDays: number, startedAt?: string): Promise<void> {
    const config = previous.config;
    const update = (change: (receipt: Receipt) => Receipt) => this.update(config, change, scope, catchupDays);
    const allowed = (item: { publishedAt?: string }) => collectable(item, beijingDate(this.now()), scope, catchupDays, startedAt);
    const day = beijingDate(this.now());
    let daily = previous.daily?.date === day ? { ...previous.daily } : { date: day, eligible: 0, older: 0, undated: 0, future: 0 };
    if (!await update(receipt => ({ ...receipt, phase: 'running', lastAttempt: this.now().toISOString(), error: '', imported: 0, catchupImported: 0, etag: null, lastModified: null, responseUrl: null }))) return;
    const seen = { ...previous.seen }; let imported = 0; let pending = 0; let catchupImported = 0;
    const publicationDates = { ...previous.publicationDates };
    const publicationAttempts={...previous.publicationAttempts};
    try {
      signal.throwIfAborted();
      const directBilibili = config.platform === 'bilibili' && config.feedUrl === `https://space.bilibili.com/${config.accountId}`;
      const read = this.dependencies.readFeed ?? (directBilibili ? (_url: string, options: FeedRequest) => fetchBilibiliFeed(config.accountId!, options.signal) : fetchFeed);
      const readWithFallback = async (options: FeedRequest): Promise<FeedResponse> => {
        let apiIssue = '';
        if (config.platform === 'youtube' && config.feedUrl === `https://www.youtube.com/feeds/videos.xml?channel_id=${config.accountId}`) {
          try { const result = await this.dependencies.readYoutubeApi?.(config.accountId!, scope, catchupDays, signal); if (result) return result; }
          catch (error) { signal.throwIfAborted(); apiIssue = error instanceof Error ? error.message : '官方接口读取失败'; }
        }
        if (config.platform === 'bilibili' && previous.pending > 0 && previous.collectionMethod === 'browser' && this.browserRead) {
          return this.browserRead(config.accountId!, signal);
        }
        try {
          // GET is safe to retry once; authorization, rate limits and invalid XML are not network failures.
          const response = await networkRead(() => read(config.feedUrl, options), signal);
          if (config.platform === 'bilibili' && response.status === 200) parseRss(response.body, response.url, false, { platform: 'bilibili', accountId: config.accountId });
          return response;
        } catch (error) {
          signal.throwIfAborted();
          const youtube=this.dependencies.readYoutubePage??(!this.dependencies.readFeed?fetchYoutubePageFeed:undefined);
          if(config.platform==='youtube'&&youtube&&config.feedUrl===`https://www.youtube.com/feeds/videos.xml?channel_id=${config.accountId}`){
            try{const recovered=await youtube(config.accountId!,signal,scope);if(recovered.originalJson)recovered.originalJson=JSON.stringify({primaryIssue:error instanceof Error?error.message:'读取失败',apiIssue:apiIssue||undefined,publicPage:JSON.parse(recovered.originalJson)});return recovered;}catch(fallback){throw Error(`YouTube 更新检查暂时失败，已保留旧材料${apiIssue?`；官方接口：${apiIssue}`:''}；RSS：${error instanceof Error?error.message:'读取失败'}；主页备用：${fallback instanceof Error?fallback.message:'读取失败'}`);}
          }
          if (config.platform !== 'bilibili' || !this.browserRead) throw error;
          return this.browserRead(config.accountId!, signal);
        }
      };
      const fullCheckDue = !previous.lastFullCheck || this.now().getTime() - Date.parse(previous.lastFullCheck) >= 6 * 3_600_000;
      const conditional = !fullCheckDue && (scope !== 'today' || (previous.daily?.date === day && (config.platform !== 'wechat' || (Object.keys(publicationDates).length > 0 && previous.daily.undated === 0))));
      let response = await readWithFallback({ etag: conditional ? previous.etag ?? undefined : undefined, lastModified: conditional ? previous.lastModified ?? undefined : undefined, signal });
      signal.throwIfAborted();
      if (response.status === 304 && (!conditional || !previous.responseUrl || response.url !== previous.responseUrl || !(previous.etag || previous.lastModified))) {
        response = await readWithFallback({ signal });
        if (response.status === 304) throw new Error('订阅对无条件请求返回 304，请检查上游');
      }
      const errors: string[] = [];
      signal.throwIfAborted();
      if (response.status === 200) {
        const entries = parseRss(response.body, response.url, config.summaryIsBody, { platform: config.platform, accountId: config.accountId,
          expectedName: new URL(config.feedUrl).hostname === 'feed.zoro.build' ? config.accountName ?? registeredSource(config.id)?.display_name ?? config.name : undefined });
        const snapshotHash = await hash(response.body);
        // Keep exact upstream XML separately from the entry HTML and extracted Markdown.
        await this.dependencies.files.write(`subscription-snapshots/${snapshotHash}.xml`, response.body);
        if (response.originalJson) await this.dependencies.files.write(`subscription-snapshots/${await hash(response.originalJson)}.json`, response.originalJson);
        daily = { date: day, eligible: 0, older: 0, undated: 0, future: 0 };
        const eligible = entries.filter(entry => {
          if (scope !== 'today') return true;
          const disposition = dayDisposition(publicationDates[entry.url] ? { publishedAt: publicationDates[entry.url]! } : entry, day);
          if (disposition === 'today') daily.eligible++; else daily[disposition]++;
          return allowed(publicationDates[entry.url] ? { publishedAt: publicationDates[entry.url]! } : entry);
        });
        const candidates = await Promise.all(eligible.map(async entry => ({ entry, key: await hash(entry.url), fingerprint: await hash(JSON.stringify(entry)) })));
        const changed = candidates.filter(candidate => seen[candidate.key] !== candidate.fingerprint || (scope === 'today' && config.platform === 'wechat' && dayDisposition(candidate.entry, day) === 'today' && !publicationDates[candidate.entry.url]));
        pending = Math.max(0, changed.length - 30);
        // Oldest first when dates are known; reverse newest-first feeds otherwise.
        changed.reverse().sort((a, b) => (scope==='today'&&config.platform==='wechat'?(publicationAttempts[a.key]??0)-(publicationAttempts[b.key]??0):0)||(Date.parse(a.entry.publishedAt ?? '') || 0) - (Date.parse(b.entry.publishedAt ?? '') || 0));
        for (const candidate of changed.slice(0, 30)) {
          signal.throwIfAborted();
          const datedEntry = publicationDates[candidate.entry.url] ? { publishedAt: publicationDates[candidate.entry.url]! } : candidate.entry;
          if (!allowed(datedEntry)) continue;
          if(scope==='today'&&config.platform==='wechat'){
            publicationAttempts[candidate.key]=(publicationAttempts[candidate.key]??0)+1;
            if(Object.keys(publicationAttempts).length>5000)delete publicationAttempts[Object.keys(publicationAttempts)[0]!];
            if(!await update(receipt=>({...receipt,publicationAttempts:{...publicationAttempts}})))return;
          }
          try {
            signal.throwIfAborted();
            const material = await this.material(candidate.entry, config, signal, scope === 'today');
            if (scope === 'today') {
              if (config.platform === 'wechat') publicationDates[candidate.entry.url] = material.publishedAt ?? null;
              const disposition = dayDisposition(material, beijingDate(this.now()));
              const original = dayDisposition(datedEntry, day);
              if (disposition !== original) {
                const before = original === 'today' ? 'eligible' : original;
                const after = disposition === 'today' ? 'eligible' : disposition;
                daily[before] = Math.max(0, daily[before] - 1); daily[after]++;
              }
              if (!allowed(material)) { if(!await update(receipt => ({ ...receipt, publicationDates: {...publicationDates} })))return;continue; }
              if (config.platform === 'wechat' && material.coverage === 'metadata') throw new Error(`${config.name ?? config.id}：正文未取得，下次继续检查`);
            }
            // Configuration changes during I/O must not acknowledge the old source's results.
            const saved = await this.serial(async () => {
              if (signal.aborted) return null;
              const current = await this.load();
              if (current.collectionScope !== scope || current.catchupDays !== catchupDays) return null;
              if (JSON.stringify(current.sources.find(source => source.config.id === config.id)?.config) !== JSON.stringify(config)) return null;
              return this.dependencies.save(material);
            });
            if (saved === null) return;
            if (saved) { imported++; if (scope === 'today' && dayDisposition(material, beijingDate(this.now())) === 'older') catchupImported++; }
            seen[candidate.key] = candidate.fingerprint;
            // Bound receipt growth. Evicted items remain protected by ledger version deduplication.
            if (Object.keys(seen).length > 5000) delete seen[Object.keys(seen)[0]!];
            if (!await update(receipt => ({ ...receipt, seen: { ...seen }, publicationDates: {...publicationDates}, imported, catchupImported }))) return;
          } catch (error) {
            if (signal.aborted) throw error;
            pending++; errors.push(error instanceof Error ? error.message : '材料保存失败');
          }
        }
      }
      const failed = errors.length > 0;
      await update(receipt => ({
        ...receipt, phase: failed ? 'error' : pending ? 'waiting' : 'ok', imported, pending, catchupImported,
        lastFullCheck: response.status === 200 ? this.now().toISOString() : previous.lastFullCheck,
        error: errors.slice(0, 3).join('；').slice(0, 600), failures: failed ? previous.failures + 1 : 0,
        lastSuccess: failed || pending ? receipt.lastSuccess : this.now().toISOString(),
        nextDue: new Date(this.now().getTime() + (failed ? retryMinutes(previous.failures, errors.join('；')) : pending ? 1 : config.intervalMinutes) * 60_000).toISOString(),
        etag: failed || pending ? null : response.etag ?? (response.status === 304 ? previous.etag : null),
        lastModified: failed || pending ? null : response.lastModified ?? (response.status === 304 ? previous.lastModified : null),
        responseUrl: failed || pending ? null : response.url,
        collectionMethod: response.collectionMethod ?? 'feed',
        daily: scope === 'today' ? daily : undefined,
        publicationDates,
      }));
    } catch (error) {
      // A canceled source may already have been re-enabled with the same config.
      // Do not let the old task overwrite that new waiting state.
      if (signal.aborted && !this.controller?.signal.aborted) return;
      await update(receipt => ({ ...receipt, phase: 'error', imported, pending, catchupImported, failures: previous.failures + 1,
        error: signal.aborted ? '采集中断，已保存材料保留，下次检查会继续' : (error instanceof Error ? error.message : '采集失败').slice(0, 600),
        nextDue: signal.aborted ? null : new Date(this.now().getTime() + retryMinutes(previous.failures, error instanceof Error ? error.message : '') * 60_000).toISOString(),
        daily: scope === 'today' ? daily : undefined,
      }));
    }
  }
  private async material(entry: RssEntry, config: SubscriptionConfig, signal: AbortSignal, authorDate = false): Promise<Material> {
    const source = registeredSource(config.id);
    const name = config.name ?? source?.display_name ?? config.id;
    const category = this.state?.categories.find(category => category.id === (config.categoryId ?? config.topic));
    const options = { url: entry.url, identity: entry.identity ?? entry.url, title: entry.title, source: name, sourceId: config.id, categoryId: config.categoryId ?? config.topic!, categoryName: category?.name,
      topic: config.topic!, capturedAt: this.now().toISOString() };
    if (config.platform === 'youtube' || config.platform === 'bilibili') return materialSchema.parse({ ...options, kind: 'article', purpose: 'reading', body: '', coverage: 'metadata',
      publishedAt: entry.publishedAt, gaps: ['已取得视频标题、频道、发布时间和原链接；本轮只采集链接，未获取字幕、音频或画面内容。'], guide: '', guideKind: 'none' });
    // AIHOT's body/summary distinction: short teasers require original-page extraction.
    const teaser = /(?:read more|continue reading|阅读全文|…|\.\.\.)\s*$/i.test(entry.bodyHtml.replace(/<[^>]*>/g, '').trim());
    if ((!authorDate || config.platform === 'rss') && entry.bodyHtml.trim() && !teaser) {
      const material = extractHtml(`<html><body><div id="js_content">${entry.bodyHtml}</div></body></html>`, options);
      if (material.coverage !== 'metadata') return materialSchema.parse({ ...material, title: entry.title, source: name, publishedAt: entry.publishedAt,
        original: { extension: 'html', base64: Buffer.from(entry.bodyHtml).toString('base64') },
        gaps: [...material.gaps, config.platform === 'rss' ? '正文来自 RSS 正文字段；HTML 原件保留该字段，未核对原网页全文覆盖。' : '正文来自采集端 RSS 正文字段；HTML 原件是该字段内容，并非公众号原页面。订阅对应账号由配置指定，未从这份字段重新核验身份。'],
      });
    }
    const readArticle = this.dependencies.readArticle ?? ((url: string, abort: AbortSignal) => fetchPublicHtml(url, 0, abort));
    const html = await networkRead(() => readArticle(entry.url, signal), signal);
    signal.throwIfAborted();
    if (config.platform === 'rss') {
      const material = extractHtml(html, options);
      if (material.coverage === 'metadata') throw new Error(`${name}：正文未取得，下次继续检查`);
      return materialSchema.parse({ ...material, publishedAt: material.publishedAt ?? entry.publishedAt });
    }
    const identified = identifyWechat(html);
    const wrongAccount = source?.biz ? identified.biz !== source.biz : identified.name !== (config.accountName ?? name);
    const material = extractHtml(html, options);
    if (wrongAccount || material.coverage === 'metadata' || (authorDate && !wechatPublishedAt(html))) {
      const snapshot = await hash(html);
      await this.dependencies.files.write(`subscription-snapshots/${snapshot}.html`, html);
      await this.dependencies.files.write(`subscription-snapshots/${snapshot}-${config.id}.json`, JSON.stringify({ capturedAt: this.now().toISOString(), sourceId: config.id, url: entry.url, expected: source?.biz || config.accountName || name, identified, coverage: material.coverage, publishedAt: material.publishedAt ?? null }));
    }
    if (wrongAccount) {
      const incomplete = source?.biz ? !identified.biz : !identified.name;
      const issue = incomplete ? /环境异常|完成验证|访问过于频繁|访问受限/.test(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, '')) ? '原页面需要验证，暂未取得账号和正文' : '原页面账号信息不完整，下次继续检查' : '原页面账号不匹配，请检查采集端授权与更新链接';
      throw new Error(`${name}：${issue}`);
    }
    if (authorDate && !wechatPublishedAt(html)) return materialSchema.parse({...material, publishedAt: undefined});
    if (authorDate && dayDisposition(material, beijingDate(this.now())) !== 'today') return material;
    if (material.coverage === 'metadata') throw new Error(`${name}：正文未取得，下次继续检查`);
    return materialSchema.parse({ ...material, publishedAt: authorDate ? material.publishedAt : material.publishedAt ?? entry.publishedAt });
  }
}
