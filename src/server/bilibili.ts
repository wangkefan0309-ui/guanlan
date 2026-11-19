import { field } from '../core/structured';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { z } from 'zod';
import { publicAddress } from './public-fetch';
import type { FeedResponse } from './feed-fetch';
import { sourceProxy } from './source-proxy';

const permutation = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
type ReadJson = (url: URL, uid: string, signal?: AbortSignal) => Promise<string>;
async function readPublicJson(url: URL, uid: string, signal?: AbortSignal): Promise<string> {
  if (url.origin !== 'https://api.bilibili.com') throw new Error('B站列表仅请求固定官方 API');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('B站 API 未解析到公网地址');
  const address = addresses.find(item => item.family === 4) ?? addresses[0]!;
  return new Promise((resolve, reject) => {
    const agent = sourceProxy(url);
    const req = request(url, { signal, family: address.family, ...(agent ? { agent } : {}), lookup: (_host, _options, done) => done(null, address.address, address.family), headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Referer: `https://space.bilibili.com/${uid}`, Accept: 'application/json',
    } }, response => {
      if (response.statusCode !== 200 || !/^application\/json\b/i.test(response.headers['content-type'] ?? '')) { response.resume(); reject(new Error(`B站列表返回 HTTP ${response.statusCode} 或非 JSON，请稍后重试`)); return; }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2_000_000) req.destroy(new Error('B站列表超过 2 MB')); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); response.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('B站列表读取超时')), 20_000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end();
  });
}
const videoSchema = z.object({ mid: z.number().int().positive(), bvid: z.string().regex(/^BV[\w]{10}$/), title: z.string().min(1), author: z.string().min(1), created: z.number().int().positive() });
function escape(value: string) { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!); }

/** Public upload metadata only. API errors are failures, never empty successful feeds. */
export async function fetchBilibiliFeed(uid: string, signal?: AbortSignal, read: ReadJson = readPublicJson, now = new Date()): Promise<FeedResponse> {
  if (!/^\d{1,20}$/.test(uid)) throw new Error('B站 UID 无效');
  const nav: unknown = JSON.parse(await read(new URL('https://api.bilibili.com/x/web-interface/nav'), uid, signal));
  const keys = z.object({ img_url: z.url(), sub_url: z.url() }).parse(field(nav, 'data', 'wbi_img'));
  const key = [keys.img_url, keys.sub_url].map(value => new URL(value).pathname.split('/').at(-1)!.split('.')[0]).join('');
  if (!/^[a-f\d]{64}$/i.test(key)) throw new Error('B站未返回有效的 WBI 密钥');
  const mixed = permutation.map(index => key[index]).join('').slice(0, 32);
  const params = new URLSearchParams({ mid: uid, order: 'pubdate', pn: '1', ps: '10', wts: String(Math.floor(now.getTime() / 1000)) }); params.sort();
  const query = params.toString(); params.set('w_rid', createHash('md5').update(query + mixed).digest('hex'));
  const raw = await read(new URL(`https://api.bilibili.com/x/space/wbi/arc/search?${params}`), uid, signal);
  return { ...bilibiliFeedFromJson(uid, raw, 30), collectionMethod: 'direct-api' };
}

/** The API and the public page share the same identity/empty-result checks. */
export function bilibiliFeedFromJson(uid: string, raw: string, maximum = 200): FeedResponse {
  if (!/^\d{1,20}$/.test(uid)) throw new Error('B站 UID 无效');
  if (Buffer.byteLength(raw) > 2_000_000) throw new Error('B站列表超过大小限制');
  const result: unknown = JSON.parse(raw);
  const code = field(result, 'code');
  if (code !== 0) throw new Error(`B站列表未取得（接口代码 ${String(code).slice(0, 20)}），将按退避间隔重试`);
  const videos = z.array(videoSchema).max(maximum).parse(field(result, 'data', 'list', 'vlist'));
  if (videos.some(video => String(video.mid) !== uid)) throw new Error('B站返回的视频作者 UID 与订阅不符');
  if (!videos.length && field(result, 'data', 'page', 'count') !== 0) throw new Error('B站列表为空且缺少可核对的零投稿数量');
  if (videos.some(video => !video.title.trim() || !Number.isFinite(new Date(video.created * 1000).getTime()))) throw new Error('B站标题或发布时间无效');
  const url = `https://space.bilibili.com/${uid}`;
  const body = `<rss version="2.0"><channel><title>${escape(videos[0]?.author ?? uid)}</title><link>${url}</link>${videos.map(video => `<item><title>${escape(video.title)}</title><link>https://www.bilibili.com/video/${video.bvid}</link><pubDate>${new Date(video.created * 1000).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
  return { status: 200, body, url, originalJson: raw };
}
