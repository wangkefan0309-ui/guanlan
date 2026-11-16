import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { canonicalIdentity, hash } from '../core/model';
import { candidateSchema, explorationRequestSchema, searchResultSchema, type ExplorationCandidate, type ExplorationSearchResult } from '../core/exploration';
import { fetchPublicHtml, publicAddress } from './public-fetch';
import { extractHtml } from './extract';
import { publicSearchQuery } from '../core/discovery-supply';

const hosts = new Set(['hn.algolia.com', 'api.github.com', 'api.tavily.com', 'api.socialdata.tools']);
export type SearchTransport = (url: URL, body?: string, key?: string) => Promise<string>;
export class SearchHttpError extends Error {
  constructor(readonly status: number, host: string) { super(`${host} 检索返回 HTTP ${status}；本批不自动重发`); }
}
/** Fixed provider URLs only, pinned public DNS, no redirects or provider error bodies. */
export const searchTransport: SearchTransport = async (url, body, key) => {
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) throw new Error('检索地址不在允许的提供方中');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('检索提供方未解析为公网地址');
  const address = addresses.find(item => item.family === 4) ?? addresses[0]!;
  return new Promise<string>((resolve,reject) => {
    const request = httpsRequest(url, {
      method: body ? 'POST' : 'GET', family: address.family,
      lookup: (_host,_options,callback) => callback(null,address.address,address.family),
      headers: { 'User-Agent': 'SourceWorkbench/0.9', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new SearchHttpError(response.statusCode ?? 0, url.hostname)); return; }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2_000_000) request.destroy(new Error('检索响应超过2MB')); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new Error('检索超时，结果未知；本批不自动重发')), url.hostname==='api.socialdata.tools'?30_000:8_000);
    request.on('close', () => clearTimeout(timer)); request.on('error', () => reject(new Error(`${url.hostname} 检索连接失败；请检查网络，本批不自动重发`))); request.end(body);
  });
};
export function candidateUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) return null;
    const host = url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
    if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost' || (isIP(host) && !publicAddress(host))) return null;
    return canonicalIdentity(url.toString());
  } catch { return null; }
}
const clean = (value: string, maximum: number) => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g,' ').trim().slice(0,maximum);
async function candidate(input: Omit<ExplorationCandidate, 'id' | 'coverage' | 'evidence'>): Promise<ExplorationCandidate | null> {
  const url = candidateUrl(input.url); const excerpt = clean(input.excerpt,2400), title = clean(input.title,240);
  if (!url || !title || !excerpt) return null;
  const evidence = excerpt.match(/[\s\S]{1,600}/g)?.slice(0,4) ?? [excerpt.slice(0,600)];
  return candidateSchema.parse({ ...input, url, title, excerpt, id: await hash(url), evidence, coverage: 'search-excerpt' });
}
const hnSchema = z.object({ hits: z.array(z.object({ title: z.string().nullable(), url: z.string().nullable(), story_text: z.string().nullable().optional(), points: z.number().nullable(), num_comments: z.number().nullable(), created_at: z.string(), objectID: z.string() })).max(50) });
const ghSchema = z.object({ items: z.array(z.object({ full_name: z.string(), html_url: z.string(), description: z.string().nullable(), stargazers_count: z.number(), pushed_at: z.string(), archived: z.boolean(), fork: z.boolean() })).max(50) });
const tavilySchema = z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), content: z.string(), published_date: z.string().optional() })).max(50), usage: z.object({ credits: z.number().nonnegative() }).optional() });

export async function searchExploration(input: unknown, transport: SearchTransport = searchTransport, now = new Date(), readPage?: (url: string) => Promise<string>): Promise<ExplorationSearchResult> {
  const request = explorationRequestSchema.parse(input);
  if (request.provider === 'tavily' && !request.key.trim()) throw new Error('Tavily搜索Key未配置；可先用免Key公开检索');
  const candidates: ExplorationCandidate[] = [], warnings: string[] = [], snapshots: ExplorationSearchResult['snapshots'] = [];
  let credits = 0;
  const add = async (item: Parameters<typeof candidate>[0]) => { const next = await candidate(item); if (next && !candidates.some(item => item.id === next.id)) candidates.push(next); };
  for (const [index, originalQuery] of request.queries.entries()) {
    const query = request.provider === 'public' ? publicSearchQuery(originalQuery, now, index) : originalQuery;
    if (query !== originalQuery) warnings.push(`公开技术检索已将兴趣清单改写为“${query}”；综合板块可使用综合网页检索`);
    if (request.provider === 'tavily') {
      // Explicit basic/auto_parameters=false avoids automatic upgrades to advanced search.
      const json = await transport(new URL('https://api.tavily.com/search'), JSON.stringify({ query, search_depth: 'basic', auto_parameters: false, max_results: 6, include_answer: false, include_raw_content: false, include_usage: true, include_published_date: true, topic: 'general' }), request.key);
      snapshots.push({ source: 'Tavily', query, json }); const result = tavilySchema.parse(JSON.parse(json)); credits += result.usage?.credits ?? 1;
      for (const item of result.results) await add({ title: item.title, url: item.url, excerpt: item.content, source: new URL(candidateUrl(item.url) ?? 'https://invalid.example').hostname, query, date: item.published_date, dateKind: item.published_date ? 'published' : 'unknown' });
    } else {
      const hn = new URL('https://hn.algolia.com/api/v1/search'); hn.search = new URLSearchParams({ query, tags: 'story', hitsPerPage: '6', numericFilters: `created_at_i>${Math.floor(now.getTime()/1000)-7*86400},points>5` }).toString();
      try {
        const json = await transport(hn); snapshots.push({ source: 'Hacker News', query, json });
        for (const item of hnSchema.parse(JSON.parse(json)).hits) if (item.title && item.url) { await add({ title: item.title, url: item.url, excerpt: `${item.title}. ${clean(item.story_text ?? '',1800)}\nHacker News提交记录：${item.points ?? 0} points，${item.num_comments ?? 0} 条讨论。热度尚未核验内容。`, source: 'Hacker News 链接检索', query, date: item.created_at, dateKind: 'submitted' }); const added=candidates.find(next=>next.url===candidateUrl(item.url!)); if(added && !item.story_text?.trim())added.coverage='metadata'; }
      } catch { warnings.push(`Hacker News“${query}”检索失败，未取得该渠道结果`); }
      const gh = new URL('https://api.github.com/search/repositories'); gh.search = new URLSearchParams({ q: `${query} stars:>100 archived:false fork:false`, sort: 'updated', order: 'desc', per_page: '6' }).toString();
      try {
        const json = await transport(gh); snapshots.push({ source: 'GitHub', query, json });
        for (const item of ghSchema.parse(JSON.parse(json)).items) if (!item.archived && !item.fork && item.description && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(item.html_url)) await add({ title: item.full_name, url: item.html_url, excerpt: `${item.description}\n仓库目录元数据：${item.stargazers_count} stars；尚未阅读README或验证功能。`, source: 'GitHub 仓库检索', query, date: item.pushed_at, dateKind: 'updated' });
      } catch { warnings.push(`GitHub“${query}”检索失败，未取得该渠道结果`); }
    }
  }
  if (!snapshots.length) throw new Error('所有检索渠道均失败；没有候选，不调用AI');
  // Alternate result channels so a prolific provider cannot fill the entire AI batch.
  const balanced: ExplorationCandidate[] = []; const groups = new Map<string,ExplorationCandidate[]>();
  for (const item of candidates) { const key = `${item.query}:${item.source}`; const group = groups.get(key) ?? []; group.push(item); groups.set(key,group); }
  while (balanced.length < 12) { let added = false; for (const group of groups.values()) { const item = group.shift(); if (item) { balanced.push(item); added = true; if (balanced.length === 12) break; } } if (!added) break; }
  // The production path samples three article pages and three README files. Tests
  // using injected search transports do not unexpectedly make real network calls.
  if (request.provider === 'public' && (transport === searchTransport || readPage)) {
    const pages = balanced.filter(item=>item.source==='Hacker News 链接检索').slice(0,3);
    const repos = balanced.filter(item=>item.source==='GitHub 仓库检索').slice(0,3);
    for (const group of [pages,repos]) await Promise.all(group.map(async item=>{
      try {
        let excerpt: string, json: string;
        if (item.source==='GitHub 仓库检索') {
          json=await transport(new URL(`https://api.github.com/repos${new URL(item.url).pathname}/readme`));
          const result=z.object({content:z.string().max(1_800_000),encoding:z.literal('base64')}).parse(JSON.parse(json)); excerpt=Buffer.from(result.content,'base64').toString('utf8').slice(0,2400);
        } else {
          const html=await (readPage ?? (url=>fetchPublicHtml(url,0,AbortSignal.timeout(10_000))))(item.url);
          if(html.length>1_800_000)throw new Error('原页超出证据保存上限');
          const material=extractHtml(html,{url:item.url});if(material.coverage==='metadata')throw new Error('无正文');
          excerpt=material.body.slice(0,2400);json=JSON.stringify({url:item.url,html});
        }
        if(!excerpt.trim()||json.length>2_000_000)throw new Error('摘选为空或超过原件上限');
        item.excerpt=excerpt;item.evidence=excerpt.match(/[\s\S]{1,600}/g)!.slice(0,4);item.coverage='page-excerpt';
        snapshots.push({source:`页面摘选：${item.url}`.slice(0,160),query:item.query,json});
      } catch { warnings.push(`${item.title.slice(0,60)}：原页/README未取得，保留原检索覆盖说明`); }
    }));
  }
  if(warnings.length>8)warnings.length=8;
  if (!balanced.length) warnings.unshift('网页检索返回零候选；公开索引偏技术，并不覆盖所有中文兴趣板块');
  return searchResultSchema.parse({ candidates: balanced, snapshots, warnings: warnings.slice(0, 8), credits });
}
