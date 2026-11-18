import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fetchVideoTranscript } from './transcript';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalIdentity, hash, materialSchema, materialVersion, topics, webUrl } from '../core/model';
import type { Material } from '../core/model';
import { DirectoryStore } from './store';
import { extractHtml, extractPdf } from './extract';
import { fetchPublicHtml } from './public-fetch';
import { SubscriptionCollector } from './subscriptions';
import { resolveSource, type DiscoveryDependencies } from './source-discovery';
import { searchExploration, type SearchTransport } from './exploration-search';
import { enrichExploration } from './exploration-evidence';
import { MaterialLedger, legacyFile } from './material-ledger';
import packageInfo from '../../package.json';
import { SocialDataDiscovery, type SocialDataTransport } from './socialdata';
import { FreeXDiscovery, type FreeXRuntime } from './free-x';
import { createFreeXRuntime } from './free-x-runtime';
import { YoutubeApiAccess, type YoutubeApiRequest } from './youtube-api';

const importSchema = z.object({
  format: z.enum(['url', 'html', 'pdf', 'markdown']),
  url: webUrl.optional(), title: z.string().min(1).max(240).optional(), source: z.string().min(1).max(160).optional(),
  identity: z.string().min(1).max(4096).optional(),
  topic: z.enum(topics).default('ai-learning'), content: z.string().max(36_000_000).optional(),
}).strict();
export function createSourceServer(options: { directory: string; token: string; onShutdown?: () => void; explorationTransport?: SearchTransport; socialDataTransport?: SocialDataTransport; freeXRuntime?: FreeXRuntime; discoveryDependencies?: DiscoveryDependencies; youtubeApiRequest?: YoutubeApiRequest; subscriptionDependencies?: Partial<Pick<ConstructorParameters<typeof SubscriptionCollector>[0], 'readFeed' | 'readArticle' | 'readBilibiliBrowser' | 'readYoutubePage' | 'now'>> }) {
  if (options.token.length < 16) throw new Error('服务令牌至少需要 16 个字符');
  const files = new DirectoryStore(options.directory);
  const xDiscovery = new SocialDataDiscovery(files, options.socialDataTransport);
  const freeXDiscovery = new FreeXDiscovery(files, options.freeXRuntime ?? createFreeXRuntime());
  const youtubeAccess = new YoutubeApiAccess({ files, request: options.youtubeApiRequest, now: options.subscriptionDependencies?.now });
  const ledger=new MaterialLedger(files,()=>legacyFile(options.directory));let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  async function load() {
    return ledger.load();
  }
  async function save(material: Material): Promise<boolean> {
    const version = await hash(`${canonicalIdentity(material.identity)}:${await materialVersion(material)}`);
    return ledger.append(material,version);
  }
  const collector = new SubscriptionCollector({ ...options.subscriptionDependencies, readYoutubeApi: (channel, scope, days, signal) => youtubeAccess.read(channel, scope, days, signal), files, save: material => serial(() => save(material)), ledgerInstance: () => serial(async () => (await load()).instance) });
  const server = createServer((request, response) => {
    handle(request, response).catch(error => { if (!response.headersSent) json(response, 400, { error: error instanceof z.ZodError ? error.issues.map(issue => issue.message).join('；').slice(0, 600) : error instanceof Error ? error.message.slice(0, 600) : '请求失败' }); else response.end(); });
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  const collectDue = () => { void collector.poll().catch(error => console.error('订阅检查失败：', error instanceof Error ? error.message.slice(0, 600) : '存储错误')); };
  server.on('listening', () => { collectDue(); timer = setInterval(collectDue, 30_000); timer.unref(); });
  // HTTP close can finish while an async poll is still writing its receipt.
  // Drain it before reporting close completion to a caller that may reopen or
  // remove the same data directory.
  const closeHttp = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    clearInterval(timer); const stopped = Promise.all([collector.stop(),xDiscovery.stop(),freeXDiscovery.stop(),youtubeAccess.stop()]);
    closeHttp(error => { void stopped.then(() => callback?.(error), failure => {
      const reason = failure instanceof Error ? failure : new Error('采集停止失败');
      if (callback) callback(reason); else server.emit('error', reason);
    }); });
    return server;
  }) as typeof server.close;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    const expected = Buffer.from(`Bearer ${options.token}`), received = Buffer.from(request.headers.authorization ?? '');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return json(response, 401, { error: '服务令牌无效' });
    const url = new URL(request.url ?? '/', 'http://localhost');
    if(request.method==='GET'&&url.pathname==='/v1/runtime/identity')return json(response,200,{instance:'source-workbench-material-runtime',version:packageInfo.version,pid:process.pid,stopEnabled:!!options.onShutdown});
    if (request.method === 'POST' && url.pathname === '/v1/runtime/stop' && options.onShutdown) {
      z.object({}).strict().parse(await readJson(request));
      json(response, 202, { stopping: true });
      setTimeout(options.onShutdown, 50);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      const state = await collector.list(); const enabled = state.sources.filter(source => source.config.enabled).length;
      return json(response, 200, { version: packageInfo.version, mode: enabled ? 'local-subscriptions' : 'local-import', subscriptions: enabled ? 'configured' : 'not-configured', enabled, running: state.running, errors: state.sources.filter(source => source.config.enabled && source.status === 'error').length });
    }
    if (request.method === 'GET' && url.pathname === '/v1/subscriptions') return json(response, 200, await collector.list());
    if (request.method === 'GET' && url.pathname === '/v1/youtube/access') return json(response, 200, await youtubeAccess.status());
    if (request.method === 'POST' && url.pathname === '/v1/youtube/access') {
      const input = await readJson(request), channel = (await collector.list()).sources.find(s => s.config.platform === 'youtube')?.config.accountId;
      if (!channel) throw Error('请先添加一个YouTube频道');
      return json(response, 200, await youtubeAccess.configure(input, channel));
    }
    if (request.method === 'POST' && url.pathname === '/v1/exploration/search') return json(response, 200, await searchExploration(await readJson(request), options.explorationTransport));
    if (request.method === 'POST' && url.pathname === '/v1/exploration/evidence') return json(response,200,await enrichExploration(await readJson(request)));
    if (request.method === 'GET' && url.pathname === '/v1/exploration/x/status') return json(response,200,await xDiscovery.status());
    if (request.method === 'POST' && url.pathname === '/v1/exploration/x/search') return json(response,200,await xDiscovery.search(await readJson(request)));
    if (request.method === 'GET' && url.pathname === '/v1/exploration/x/free/status') return json(response,200,await freeXDiscovery.status());
    if (request.method === 'POST' && url.pathname === '/v1/exploration/x/free/search') return json(response,200,await freeXDiscovery.search(await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/v1/exploration/x/free/post') return json(response,200,{material:await freeXDiscovery.post(await readJson(request))});
    if (request.method === 'POST' && url.pathname === '/v1/exploration/x/free/login') {
      z.object({}).strict().parse(await readJson(request)); return json(response,200,await freeXDiscovery.login());
    }
    if (request.method === 'POST' && url.pathname === '/v1/sources/resolve') return json(response, 200, await resolveSource(await readJson(request), options.discoveryDependencies));
    if (request.method === 'POST' && url.pathname === '/v1/subscriptions') return json(response, 200, await collector.configure(await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/v1/subscriptions/poll') {
      const input = z.object({ recoverNetwork: z.boolean().optional() }).strict().parse(await readJson(request));
      void collector.poll(input.recoverNetwork ? 'network-recovery' : true).catch(error => console.error('订阅检查失败：', error instanceof Error ? error.message.slice(0, 600) : '存储错误'));
      return json(response, 200, await collector.list());
    }
    if (request.method === 'GET' && url.pathname === '/v1/feed') {
      const after = Number(url.searchParams.get('after') ?? '0');
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('同步游标无效');
      return serial(async () => {
        const state = await load(); const start = url.searchParams.get('instance') === state.instance ? after : 0;
        const pending = state.entries.filter(entry => entry.seq > start);
        const picked: Awaited<ReturnType<MaterialLedger['entry']>>[] = []; let bytes = 0;
        for (const ref of pending) {
          const entry=await ledger.entry(ref);
          const size = Buffer.byteLength(JSON.stringify(entry.material));
          if (picked.length && (bytes + size > 24_000_000 || picked.length === 20)) break;
          picked.push(entry); bytes += size;
        }
        json(response, 200, { instance: state.instance, cursor: picked.at(-1)?.seq ?? state.entries.at(-1)?.seq ?? 0, items: picked.map(entry => entry.material), hasMore: picked.length < pending.length });
      });
    }
    if (request.method === 'POST' && url.pathname === '/v1/transcript') {
      return json(response, 200, await fetchVideoTranscript(await readJson(request)));
    }
    if (request.method === 'POST' && url.pathname === '/v1/import') {
      const input = importSchema.parse(await readJson(request)); let material: Material;
      if (input.format === 'url') {
        if (!input.url) throw new Error('请提供原文链接');
        material = extractHtml(await fetchPublicHtml(input.url), input);
      } else if (input.format === 'html') {
        if (!input.content) throw new Error('请提供 HTML 内容'); material = extractHtml(input.content, input);
      } else if (input.format === 'pdf') {
        if (!input.content || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.content)) throw new Error('PDF 编码无效');
        const bytes = Buffer.from(input.content, 'base64'); if (bytes.length > 25_000_000) throw new Error('PDF 超过 25 MB');
        material = await extractPdf(bytes, input);
      } else {
        if (!input.content?.trim() || !input.title) throw new Error('请提供 Markdown 标题及正文');
        material = materialSchema.parse({ title: input.title, source: input.source || '手动导入', identity: input.identity || input.url || `local:markdown:${input.title}`, url: input.url, topic: input.topic, kind: 'markdown', capturedAt: new Date().toISOString(), body: input.content, coverage: 'full', gaps: ['用户投放的 Markdown 原件，未核验其中事实。'], guideKind: 'excerpt', guide: input.content.replace(/\s+/g, ' ').slice(0, 180), original: { extension: 'md', base64: Buffer.from(input.content).toString('base64') } });
      }
      await serial(() => save(material)); return json(response, 200, { material });
    }
    json(response, 404, { error: '接口不存在' });
  }
  return Object.assign(server, { collector, xDiscovery, freeXDiscovery });
}
function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); }
async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { size += chunk.length; if (size > 40_000_000) throw new Error('请求超过 40 MB'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
