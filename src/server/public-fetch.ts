import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { webUrl } from '../core/model';
import { sourceProxy } from './source-proxy';
import { HttpsProxyAgent } from 'https-proxy-agent';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number); const first = parts[0]!, second = parts[1]!;
    return !(first === 0 || first === 10 || first === 127 || first >= 224 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && [0, 168].includes(second)) || (first === 100 && second >= 64 && second <= 127) || (first === 198 && [18, 19].includes(second)));
  }
  if (isIP(address) === 6) return /^2[0-9a-f]{3}:/i.test(address); // public global unicast only; no mapped IPv4 or link-local
  return false;
}
export async function fetchPublicHtml(input: string, redirects = 0, signal?: AbortSignal, discovery = false, exploration = false): Promise<string> {
  return fetchPublicDocument(input, redirects, signal, discovery, exploration, 'html');
}
export async function fetchPublicDocument(input: string, redirects = 0, signal?: AbortSignal, discovery = false, exploration = false, format: 'html'|'text' = 'text'): Promise<string> {
  signal?.throwIfAborted();
  const url = new URL(webUrl.parse(input));
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('网页导入仅支持标准 HTTP/HTTPS 端口');
  const address = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!address.length || address.some(item => !publicAddress(item.address))) throw new Error('网页导入仅支持公网地址');
  const first = address.find(item => item.family === 4) ?? address[0]!;
  const proxy=process.env.HTTPS_PROXY??process.env.https_proxy;
  const pinnedProxy=exploration&&url.protocol==='https:'&&proxy?new HttpsProxyAgent(proxy,{timeout:10_000}):undefined;
  const agent = pinnedProxy??(discovery && url.hostname === 'www.youtube.com' ? sourceProxy(url) : undefined);
  const target=new URL(url);
  // CONNECT to the validated IP, while retaining the original TLS name and Host.
  // A proxy must not re-resolve an arbitrary candidate hostname to private space.
  if(pinnedProxy)target.hostname=first.family===6?`[${first.address}]`:first.address;
  return new Promise<string>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      signal,
      ...(agent ? { agent } : {}),
      ...(pinnedProxy?{servername:url.hostname}:{}),
      headers: { 'User-Agent': 'Mozilla/5.0 SourceWorkbench/0.1', Accept: 'text/html,application/xhtml+xml',Host:url.host },
      family: first.family,
      // Pin the validated address to avoid DNS rebinding between validation and connection.
      lookup: (_hostname, _options, callback) => callback(null, first.address, first.family),
    }, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); if (redirects >= 3) return reject(new Error('网页重定向次数过多'));
        const next = new URL(response.headers.location, url);
        if (discovery && next.origin !== url.origin) return reject(new Error('频道主页重定向到了其他网站，请使用完整频道主页'));
        fetchPublicDocument(next.toString(), redirects + 1, signal, discovery, exploration, format).then(resolve, reject); return;
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error(`原文返回 HTTP ${response.statusCode}`)); }
      if (format === 'html' && !/text\/html|application\/xhtml\+xml/i.test(response.headers['content-type'] ?? '')) { response.resume(); return reject(new Error('链接未返回 HTML，请使用文件导入')); }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 12_000_000) request.destroy(new Error('网页超过 12 MB')); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new Error('原文读取超时')), 25_000);
    request.on('close', () => clearTimeout(timer)); request.on('error', reject); request.end();
  });
}
