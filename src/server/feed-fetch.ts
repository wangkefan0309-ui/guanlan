import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { publicAddress } from './public-fetch';
import { webUrl } from '../core/model';
import { sourceProxy } from './source-proxy';

export interface FeedRequest { etag?: string; lastModified?: string; signal?: AbortSignal }
export interface FeedResponse { status: 200 | 304; body: string; url: string; etag?: string; lastModified?: string; originalJson?: string; collectionMethod?: 'feed' | 'direct-api' | 'browser' | 'public-page' }
export async function fetchFeed(input: string, options: FeedRequest = {}, redirects = 0): Promise<FeedResponse> {
  const url = new URL(webUrl.parse(input));
  options.signal?.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  // Only a saved subscription can access literal loopback. Article imports keep their public-only policy.
  const loopback = hostname === '127.0.0.1' || hostname === '::1';
  if (!addresses.length || addresses.some(item => loopback ? !['127.0.0.1', '::1'].includes(item.address) : !publicAddress(item.address))) throw new Error('订阅仅支持公网地址或明确填写的本机回环地址');
  const address = addresses.find(item => item.family === 4) ?? addresses[0]!;
  const agent = sourceProxy(url);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal: options.signal, family: address.family, ...(agent ? { agent } : {}),
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: {
        'User-Agent': 'SourceWorkbench/0.2', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
        ...(options.etag ? { 'If-None-Match': options.etag } : {}),
        ...(options.lastModified ? { 'If-Modified-Since': options.lastModified } : {}),
      },
    }, response => {
      const status = response.statusCode;
      if (status && status >= 300 && status < 400 && status !== 304 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url);
        if (next.origin !== url.origin || redirects >= 3) return reject(new Error('订阅重定向只能在同一地址内，最多三次'));
        fetchFeed(next.toString(), options, redirects + 1).then(resolve, reject); return;
      }
      const metadata = { url: url.toString(), etag: response.headers.etag, lastModified: response.headers['last-modified'] };
      if (status === 304) { response.resume(); resolve({ status, body: '', ...metadata }); return; }
      if (status !== 200) {
        response.resume();
        const reasons: Record<string, string> = { '200013': '微信文章接口限流（200013），采集端已暂停请求并会自动重试', authorization_required: '微信采集授权需重新确认', awaiting_first_check: '采集端尚在等待首次文章检查', identity_mismatch: '采集端返回的文章账号与登记不符，未导入', missing_article_list: '采集端未返回可核对的文章列表' };
        const reason = loopback && typeof response.headers['x-source-error'] === 'string' ? reasons[response.headers['x-source-error']] : undefined;
        reject(new Error(reason ?? `订阅返回 HTTP ${status}`)); return;
      }
      if (!/^(application\/(rss\+xml|atom\+xml|xml)|text\/(xml|plain))\b/i.test(response.headers['content-type'] ?? '')) { response.resume(); reject(new Error('更新链接未返回 XML，请检查采集端或授权状态')); return; }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4_000_000) request.destroy(new Error('订阅 XML 超过 4 MB')); else chunks.push(chunk); });
      response.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8'), ...metadata }));
      response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new Error('订阅读取超时')), 25_000);
    request.on('close', () => clearTimeout(timer)); request.on('error', reject); request.end();
  });
}
