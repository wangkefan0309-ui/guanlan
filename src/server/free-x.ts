import { z } from 'zod';
import { hash, materialSchema, type FileStore } from '../core/model';
import { beijingDate } from '../core/daily';
import { socialDataQueries } from '../core/discovery-topics';
import { freeXPostSchema, freeXRequestSchema, freeXStatusSchema } from '../core/free-x-contract';
import { searchResultSchema, type ExplorationSearchResult, type ExplorationCandidate } from '../core/exploration';
import { tweetCandidates, tweetSchema } from './socialdata';
import { xContent } from './x-content';

export interface FreeXRuntime {
  ready(): Promise<{ configured: boolean; reason: string }>;
  login(): Promise<void>;
  search(query: string): Promise<string>;
}
const attemptSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), query: z.string().max(512),
  status: z.enum(['started', 'ok', 'failed']), returned: z.number().int().min(0).max(20).optional(),
  receiptHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), observedAt: z.iso.datetime().optional(),
  postIds: z.array(z.string().regex(/^\d+$/)).max(20).optional(),
}).strict().superRefine((attempt, ctx) => {
  if (attempt.status === 'ok' && (attempt.returned === undefined || !attempt.receiptHash || !attempt.observedAt)) ctx.addIssue({ code: 'custom', message: '免费X回执缺少原件依据' });
});
const batchSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), attempts: z.array(attemptSchema).max(3), result: searchResultSchema.optional() }).strict();
const stateSchema = z.object({ schema: z.literal(1), batches: z.array(batchSchema).max(400) }).strict().refine(state => new Set(state.batches.map(batch => batch.date)).size === state.batches.length, '免费X日期重复');
type State = z.infer<typeof stateSchema>;
type Batch = State['batches'][number];
const payloadSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), tweets: z.array(z.unknown()).max(20), raw: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), reason: z.string().max(100) }).strict(),
]);
const STATE = 'free-x/state.json';

/** Share one batch per Beijing date across plugins. Save intent before requests;
 * interruptions pause the day; write retries never resend an external search. */
export class FreeXDiscovery {
  private queue: Promise<unknown> = Promise.resolve();
  private state?: State;
  private pending?: { state: State; receipts: { path: string; text: string }[] };
  constructor(private files: FileStore, private runtime: FreeXRuntime, private now = () => new Date()) {}
  private serial<T>(work: () => Promise<T>) { const result = this.queue.then(work); this.queue = result.catch(() => {}); return result; }
  private async flush() {
    if (!this.pending) return;
    for (const receipt of this.pending.receipts) await this.files.write(receipt.path, receipt.text);
    await this.files.write(STATE, JSON.stringify(this.pending.state));
    this.state = structuredClone(this.pending.state); this.pending = undefined;
  }
  private async save(state: State, receipts: { path: string; text: string }[] = []) {
    this.pending = { state: stateSchema.parse(state), receipts }; await this.flush();
  }
  private async load() {
    if (!this.state) { const saved = await this.files.read(STATE); this.state = saved ? stateSchema.parse(JSON.parse(saved)) : { schema: 1, batches: [] }; }
    return structuredClone(this.state);
  }
  private statusFor(state: State, ready: { configured: boolean; reason: string }) {
    const date = beijingDate(this.now()), batch = state.batches.find(batch => batch.date === date);
    const paused = Boolean(batch && (!batch.result || batch.attempts.some(attempt => attempt.status !== 'ok')));
    const verified = state.batches.some(batch => batch.attempts.some(attempt => attempt.status === 'ok' && attempt.returned! > 0));
    return freeXStatusSchema.parse({ provider: 'twscrape', ...ready, verified, date,
      requestsToday: batch?.attempts.length ?? 0, returnedPosts: batch?.attempts.reduce((sum, attempt) => sum + (attempt.returned ?? 0), 0) ?? 0, paused,
      reason: !ready.configured ? ready.reason : paused ? '本日搜索中断或失败，已暂停；已取得的回执保留，其他渠道继续运行' : batch ? '免费X今日结果已缓存，重复打开不会再次搜索' : '免费X已配置；每日最多三个Top首页，不翻页',
    });
  }
  async status() {
    return this.serial(async () => {
      await this.flush(); const state = await this.load(), ready = await this.runtime.ready(), status = this.statusFor(state, ready);
      const latest = state.batches.filter(batch => batch.attempts.some(attempt => attempt.status === 'ok')).at(-1);
      for (const attempt of latest?.attempts.filter(attempt => attempt.status === 'ok') ?? []) {
        const text = await this.files.read(`free-x/receipts/${attempt.id}.json`);
        if (text === null || await hash(text) !== attempt.receiptHash) return { ...status, verified: false, paused: true, reason: '免费X原始回执缺失或校验失败；保留日限制，不重发，其他渠道继续运行' };
      }
      return status;
    });
  }
  async login() { await this.runtime.login(); return { opened: true }; }
  async stop() { await this.queue; await this.flush(); }
  private async result(state: State, batch: Batch, cached: boolean): Promise<ExplorationSearchResult> {
    const result = batch.result ? structuredClone(batch.result) : searchResultSchema.parse({ candidates: [], snapshots: [], warnings: ['免费X上次批次中断；本日不重发'], credits: 0 });
    result.snapshots = [];
    const groups: ExplorationCandidate[][] = [];
    for (const attempt of batch.attempts.filter(attempt => attempt.status === 'ok')) {
      const text = await this.files.read(`free-x/receipts/${attempt.id}.json`);
      if (text === null || await hash(text) !== attempt.receiptHash) throw new Error('免费X原始回执缺失或校验失败；保留日限制，不重发');
      result.snapshots.push({ source: 'twscrape 免费X搜索原件', query: attempt.query.slice(0, 240), json: text });
      // Rebuild metadata from verified originals, including older saved batches.
      const until = Date.parse(attempt.observedAt!), since = until - 7 * 86400_000;
      groups.push((await tweetCandidates(text, attempt.query, attempt.observedAt!)).filter(item => item.date && Date.parse(item.date) >= since && Date.parse(item.date) <= until));
    }
    result.candidates = this.balance(groups);
    return searchResultSchema.parse({ ...result, freeXUsage: { provider: 'twscrape', returnedPosts: batch.attempts.reduce((sum, attempt) => sum + (attempt.returned ?? 0), 0), requestsToday: batch.attempts.length, cached, paused: !batch.result || batch.attempts.some(attempt => attempt.status !== 'ok') } });
  }
  private balance(groups: ExplorationCandidate[][]) {
    const candidates: ExplorationCandidate[] = [], seen = new Set<string>();
    while (groups.some(group => group.length) && candidates.length < 9) for (const group of groups) {
      const item = group.shift(); if (item && !seen.has(item.id)) { candidates.push(item); seen.add(item.id); }
      if (candidates.length === 9) break;
    }
    return candidates;
  }
  async post(input: unknown) {
    const captured = freeXPostSchema.parse(input), requested = new URL(captured.url);
    const match = requested.pathname.match(/^\/([A-Za-z0-9_]{1,30})\/status\/(\d{1,30})(?:\/video\/\d+)?\/?$/);
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(requested.hostname) || requested.port || !match) throw new Error('需要真实X帖子链接');
    return this.serial(async () => {
      await this.flush(); const state = await this.load();
      for (const batch of state.batches.slice().reverse()) {
        for (const attempt of batch.attempts.filter(attempt => attempt.status === 'ok')) {
          if (attempt.postIds && !attempt.postIds.includes(match[2]!)) continue;
          const text = await this.files.read(`free-x/receipts/${attempt.id}.json`);
          if (text === null || await hash(text) !== attempt.receiptHash) throw new Error('免费X原始回执缺失或校验失败，未收录正文');
          const payload = payloadSchema.parse(JSON.parse(text)); if (!payload.ok) throw new Error('免费X原件格式异常');
          const value = payload.tweets.find(value => tweetSchema.safeParse(value).data?.id_str === match[2]);
          if (!value) continue;
          const tweet = tweetSchema.parse(value);
          if (tweet.user.screen_name.toLowerCase() !== match[1]!.toLowerCase()) throw new Error('帖子作者与抓取原件不符');
          if (!tweet.full_text.trim()) throw new Error('原帖没有可收录的文字正文');
          const url = `https://x.com/${tweet.user.screen_name}/status/${tweet.id_str}`, content = xContent(payload.raw, tweet.id_str, tweet.entities);
          // Plain tweet text must not become Obsidian embeds, HTML or instructions.
          // Its exact source and original API object remain in the attached receipt.
          const body = tweet.full_text.replace(/([\\`*_{}\[\]<>()#!|])/g, '\\$1');
          const source = { tweet, original: content.original ?? null, observedAt: attempt.observedAt, responseHash: attempt.receiptHash };
          const original = `# X公开帖子接口采集原件\n\n这是原始接口记录的Markdown容器，不是作者撰写的Markdown或AI解读。\n\n\`\`\`json\n${JSON.stringify(source, null, 2)}\n\`\`\`\n`;
          return materialSchema.parse({ identity: url, url, title: tweet.full_text.replace(/\s+/g, ' ').slice(0, 180), source: `X · @${tweet.user.screen_name}`, topic: captured.topic, kind: 'article',
            capturedAt: attempt.observedAt!, publishedAt: tweet.tweet_created_at, body, coverage: 'full', guideKind: 'excerpt', guide: tweet.full_text.replace(/\s+/g, ' ').slice(0, 180),
            gaps: ['完整范围仅指本条公开帖文；视频文字稿、外链正文、回复及完整讨论串未采集。', '赞、转发及回复是抓取时的观测，原帖主张尚未独立核验。'],
            original: { extension: 'md', base64: Buffer.from(original).toString('base64') },
          });
        }
      }
      throw new Error('未找到本帖的已校验采集原件；未收录，不抓取X登录页');
    });
  }
  async search(input: unknown): Promise<ExplorationSearchResult> {
    const captured = freeXRequestSchema.parse(input);
    return this.serial(async () => {
      await this.flush(); const state = await this.load(), now = this.now(), date = beijingDate(now);
      const existing = state.batches.find(batch => batch.date === date); if (existing) return this.result(state, existing, true);
      const ready = await this.runtime.ready();
      if (!ready.configured) return searchResultSchema.parse({ candidates: [], snapshots: [], warnings: [ready.reason], credits: 0 });
      if (state.batches.length >= 400) throw new Error('免费X回执达到保留上限，归档前不发送新请求');
      const batch: Batch = { date, attempts: [] }; state.batches.push(batch); await this.save(state);
      const groups: ExplorationCandidate[][] = [], warnings: string[] = [];
      for (const query of socialDataQueries(captured.topics, now)) {
        const attempt: Batch['attempts'][number] = { id: await hash(`${date}:${query}`), query, status: 'started' };
        batch.attempts.push(attempt); await this.save(state);
        let text: string;
        try {
          text = await this.runtime.search(query);
          if (Buffer.byteLength(text) > 2_000_000) throw new Error('oversized');
          const payload = payloadSchema.parse(JSON.parse(text));
          if (!payload.ok) throw new Error('search-failed');
          attempt.returned = payload.tweets.length;
          attempt.postIds = payload.tweets.flatMap(value => { const parsed = tweetSchema.safeParse(value); return parsed.success ? [parsed.data.id_str] : []; });
        } catch {
          attempt.status = 'failed'; warnings.push('免费X登录状态、网络或接口暂不可用；本日停止后续搜索，其他渠道继续运行'); await this.save(state); break;
        }
        attempt.status = 'ok'; attempt.receiptHash = await hash(text); attempt.observedAt = now.toISOString();
        // Receipt write failures keep this exact response in memory for saving only.
        await this.save(state, [{ path: `free-x/receipts/${attempt.id}.json`, text }]);
        const candidates = await tweetCandidates(text, query, attempt.observedAt);
        const since = now.getTime() - 7 * 86400_000;
        groups.push(candidates.filter(item => item.date && Date.parse(item.date) >= since && Date.parse(item.date) <= now.getTime()));
      }
      batch.result = searchResultSchema.parse({ candidates: this.balance(groups), warnings, snapshots: [], credits: 0 });
      await this.save(state); return this.result(state, batch, false);
    });
  }
}
