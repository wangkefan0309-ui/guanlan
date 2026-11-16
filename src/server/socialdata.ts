import { z } from 'zod';
import { hash, type FileStore } from '../core/model';
import { beijingDate } from '../core/daily';
import { socialDataQueries } from '../core/discovery-topics';
import { socialDataRequestSchema, socialDataStatusSchema, type SocialDataStatus } from '../core/socialdata-contract';
import { searchResultSchema, candidateSchema, type ExplorationSearchResult, type ExplorationCandidate } from '../core/exploration';
import { candidateUrl, searchTransport, SearchHttpError } from './exploration-search';
import { xContent } from './x-content';

// Integer microdollars avoid cumulative floating-point billing drift.
const PRICE = 200, LIMIT = 500_000, RESERVE = 100_000;
const STATE = 'socialdata/state.json';
const requestSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), query: z.string().max(512),
  status: z.enum(['started', 'ok', 'rejected', 'unknown']), returned: z.number().int().nonnegative().optional(),
  journalHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), httpStatus: z.number().int().optional(), observedAt: z.string().datetime().optional(),
}).strict();
const batchSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), status: z.enum(['started', 'completed']),
  requests: z.array(requestSchema).max(3), result: searchResultSchema.optional(),
}).strict();
const stateSchema = z.object({ schema: z.literal(1), batches: z.array(batchSchema).max(400) }).strict().superRefine((state, ctx) => {
  if (new Set(state.batches.map(batch => batch.date)).size !== state.batches.length) ctx.addIssue({ code: 'custom', message: 'X日回执重复' });
  for (const batch of state.batches) for (const request of batch.requests) {
    if (request.status === 'ok' && (request.returned === undefined || !request.journalHash || !request.observedAt)) ctx.addIssue({ code: 'custom', message: 'X成功请求缺少计费或原件依据' });
  }
});
type State = z.infer<typeof stateSchema>;
type Batch = z.infer<typeof batchSchema>;
export type SocialDataTransport = (query: string, key: string) => Promise<{ status: number; text: string }>;
export const socialDataTransport: SocialDataTransport = async (query, key) => {
  const url = new URL('https://api.socialdata.tools/twitter/search');
  url.search = new URLSearchParams({ query, type: 'Top' }).toString();
  try { return { status: 200, text: await searchTransport(url, undefined, key) }; }
  catch (error) { if (error instanceof SearchHttpError) return { status: error.status, text: '' }; throw new Error('X搜索连接或响应未知；保留费用预留，不自动重发'); }
};
const observedCount = z.number().int().nonnegative().nullish().transform(value=>value??undefined);
export const tweetSchema = z.object({
  id_str: z.string().regex(/^\d+$/), full_text: z.string().max(100_000), tweet_created_at: z.string().nullish().transform(value=>value??undefined),
  user: z.object({ screen_name: z.string().regex(/^[A-Za-z0-9_]{1,30}$/) }),
  favorite_count: observedCount, retweet_count: observedCount,
  reply_count: observedCount, views_count: observedCount,
  entities: z.object({ urls: z.array(z.object({ expanded_url: z.string().optional() }).passthrough()).max(100).optional() }).passthrough().optional(),
}).passthrough();

export async function tweetCandidates(json: string, query: string, observedAt: string): Promise<ExplorationCandidate[]> {
  const payload = z.object({ tweets: z.array(z.unknown()), raw: z.unknown().optional() }).parse(JSON.parse(json));
  const result: ExplorationCandidate[] = [];
  for (const value of payload.tweets) {
    const parsed = tweetSchema.safeParse(value); if (!parsed.success || !parsed.data.full_text.trim()) continue;
    const tweet = parsed.data, url = `https://x.com/${tweet.user.screen_name}/status/${tweet.id_str}`;
    let text = tweet.full_text;
    // Expanded URLs are supplied by the retrieved post, never invented by a model.
    for (const raw of tweet.entities?.urls ?? []) {
      const expanded = raw.expanded_url && candidateUrl(raw.expanded_url);
      const short = (raw as { url?: unknown }).url;
      if (expanded && typeof short === 'string') text = text.replaceAll(short, expanded);
    }
    const content = xContent(payload.raw, tweet.id_str, tweet.entities);
    const attachment = content.media ? `\n\n接口观测到本帖附带可打开的X原始视频${content.media.durationSeconds ? `，最长视频附件时长${content.media.durationSeconds}秒` : '，时长未取得'}；尚未观看或取得视频文字稿。` : '';
    const excerpt = (text.slice(0, attachment ? 2200 : 2400) + attachment).slice(0, 2400), date = tweet.tweet_created_at && Number.isFinite(Date.parse(tweet.tweet_created_at)) ? new Date(tweet.tweet_created_at).toISOString() : undefined;
    result.push(candidateSchema.parse({ id: await hash(url), title: text.replace(/\s+/g, ' ').slice(0, 180), url, source: `X · @${tweet.user.screen_name}`, excerpt,
      evidence: [...text.match(/[\s\S]{1,600}/g)!.slice(0,3), ...(attachment ? [attachment.trim()] : [])].slice(0,4), date, dateKind: date ? 'published' : 'unknown', query: query.slice(0,240), coverage: text.trim().length >= 40 || content.media ? 'search-excerpt' : 'metadata', media: content.media, contentLinks: content.links.length ? content.links : undefined,
      engagement: tweet.favorite_count!==undefined&&tweet.retweet_count!==undefined&&tweet.reply_count!==undefined ? { likes: tweet.favorite_count, reposts: tweet.retweet_count, replies: tweet.reply_count, views: tweet.views_count, observedAt } : undefined,
    }));
  }
  const popularity=(item:ExplorationCandidate)=>(item.engagement?.likes??0)+(item.engagement?.reposts??0)*2;
  return result.sort((a,b) => popularity(b)-popularity(a));
}
/** One paid batch per Beijing date for the entire service, independent of Vault
 * root, key changes or section changes. Unknown responses pause the month.
 * 500 posts are reserved per request; the provider documents ~20, not a hard
 * maximum. An unexpectedly larger response is recorded and pauses further calls. */
export class SocialDataDiscovery {
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { state: State; journals: { path: string; json: string }[] };
  constructor(private files: FileStore, private transport: SocialDataTransport = socialDataTransport, private now = () => new Date()) {}
  private serial<T>(work: () => Promise<T>) { const result = this.queue.then(work); this.queue = result.catch(() => {}); return result; }
  private async load(): Promise<State> {
    const text = await this.files.read(STATE);
    return stateSchema.parse(text === null ? { schema: 1, batches: [] } : JSON.parse(text));
  }
  private async flush() {
    if (!this.pending) return;
    for (const journal of this.pending.journals) {
      const previous = await this.files.read(journal.path);
      if (previous !== journal.json) { if (previous !== null) throw new Error('X原始回执已修改，保留原内容'); await this.files.write(journal.path, journal.json, null); }
    }
    const previous = await this.files.read(STATE);
    await this.files.write(STATE, JSON.stringify(stateSchema.parse(this.pending.state), null, 2), previous);
    this.pending = undefined;
  }
  private async save(state: State, journals: { path: string; json: string }[] = []) { this.pending = { state: structuredClone(state), journals }; await this.flush(); }
  private summary(state: State, date: string): SocialDataStatus {
    let spent = 0, reserved = 0, unknown = false, excessive = false;
    for (const batch of state.batches.filter(batch => batch.date.startsWith(date.slice(0,7)))) for (const request of batch.requests) {
      if (request.status === 'ok') { spent += request.returned! * PRICE; if (request.returned! > RESERVE / PRICE) excessive = true; }
      if (request.status === 'started' || request.status === 'unknown') { reserved += RESERVE; unknown = true; }
    }
    const paused = unknown || excessive || spent + reserved + RESERVE > LIMIT;
    const reason = unknown ? '存在结果未知的X请求，本月暂停付费检索；请核对提供方账单' : excessive ? '单页返回量超过费用预留，本月暂停并核对账单' : paused ? '本月X剩余额度不足以预留下一次请求，已停止检索' : 'X按日检查；每天最多三个首页，不自动翻页';
    return socialDataStatusSchema.parse({ month: date.slice(0,7), limitUsd: 0.5, spentUsd: spent / 1_000_000, reservedUsd: reserved / 1_000_000, availableUsd: Math.max(0,LIMIT-spent-reserved) / 1_000_000, requestsToday: state.batches.find(batch=>batch.date===date)?.requests.length ?? 0, paused, reason });
  }
  async status() { return this.serial(async () => { await this.flush(); return this.summary(await this.load(), beijingDate(this.now())); }); }
  async stop() { await this.queue; await this.flush(); }
  private async result(state: State, batch: Batch, cached: boolean): Promise<ExplorationSearchResult> {
    const saved: ExplorationSearchResult = batch.result ? structuredClone(batch.result) : { candidates: [], warnings: ['上次X批次中断，保留已取得回执；本日不重发'], snapshots: [], credits: 0 };
    const groups: ExplorationCandidate[][] = [];
    for (const request of batch.requests.filter(request => request.status === 'ok')) {
      const json = await this.files.read(`socialdata/receipts/${request.id}.json`);
      if (json === null || await hash(json) !== request.journalHash) throw new Error('X原始回执缺失或校验失败；保留费用记录，不重发');
      saved.snapshots.push({ source: 'SocialData X搜索原件', query: request.query.slice(0,240), json });
      if (!batch.result) groups.push(await tweetCandidates(json,request.query,request.observedAt!));
    }
    if (!batch.result) saved.candidates = this.balance(groups);
    const status = this.summary(state,beijingDate(this.now()));
    const returned = batch.requests.filter(request=>request.status==='ok').reduce((sum,request)=>sum+request.returned!,0);
    return searchResultSchema.parse({ ...saved, xUsage: { returnedPosts: returned, chargedUsd: returned * PRICE / 1_000_000, month: status.month, monthlyLimitUsd: status.limitUsd, monthlyAccountedUsd: status.spentUsd, reservedUsd: status.reservedUsd, paused: status.paused, cached } });
  }
  private balance(groups: ExplorationCandidate[][]) {
    const candidates: ExplorationCandidate[] = [], seen = new Set<string>();
    while (candidates.length < 9) { let added = false; for (const group of groups) { const candidate = group.shift(); if (candidate && !seen.has(candidate.id)) { seen.add(candidate.id); candidates.push(candidate); added = true; if (candidates.length===9) break; } } if (!added && !groups.some(group=>group.length)) break; }
    return candidates;
  }
  async search(input: unknown): Promise<ExplorationSearchResult> {
    const captured = socialDataRequestSchema.parse(input);
    return this.serial(async () => {
      await this.flush(); const state = await this.load(); const now = this.now(), date = beijingDate(now);
      const existing = state.batches.find(batch=>batch.date===date); if (existing) return this.result(state,existing,true);
      if (state.batches.length >= 400) throw new Error('X回执达到保留上限，归档前不发送新请求');
      const batch: Batch = { date, status: 'started', requests: [] }; state.batches.push(batch); await this.save(state);
      const groups: ExplorationCandidate[][] = [], warnings: string[] = [];
      for (const query of socialDataQueries(captured.topics,now)) {
        const status = this.summary(state,date); if (status.paused) { warnings.push(status.reason); break; }
        const request: z.infer<typeof requestSchema> = { id: await hash(`socialdata:${date}:${batch.requests.length}:${query}`), query, status: 'started' };
        batch.requests.push(request); await this.save(state); // Reserve durably before sending.
        let response: Awaited<ReturnType<SocialDataTransport>>;
        try { response = await this.transport(query,captured.key); }
        catch { request.status = 'unknown'; warnings.push('X请求结果未知，保留费用预留，本月停止检索'); await this.save(state); break; }
        if (response.status !== 200) { request.status = 'rejected'; request.httpStatus=response.status; warnings.push(`SocialData返回HTTP ${response.status}；本日不重发，请检查Key、余额或服务状态`); await this.save(state); break; }
        let json: string;
        try {
          if (response.text.length > 2_000_000) throw new Error('响应过大');
          const payload = z.object({ tweets: z.array(z.unknown()) }).passthrough().parse(JSON.parse(response.text));
          // Provider-supplied text must not cause a configured secret to be archived.
          json = JSON.stringify(payload); if (json.includes(captured.key)) throw new Error('响应包含凭证');
          request.returned = payload.tweets.length; request.status='ok'; request.journalHash=await hash(json); request.observedAt=this.now().toISOString();
        } catch { request.status='unknown'; warnings.push('X成功HTTP响应无法核验计费数量，保留费用预留，本月停止检索'); await this.save(state); break; }
        await this.save(state,[{path:`socialdata/receipts/${request.id}.json`,json}]);
        groups.push(await tweetCandidates(json,query,now.toISOString()));
        if (request.returned! > RESERVE / PRICE) { warnings.push('X返回数量超过单次预留；已记录实际返回量并停止后续请求'); break; }
      }
      batch.result=searchResultSchema.parse({candidates:this.balance(groups),warnings:warnings.slice(0,8),snapshots:[],credits:0}); batch.status='completed'; await this.save(state);
      return this.result(state,batch,false);
    });
  }
}
