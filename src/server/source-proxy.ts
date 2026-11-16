import { HttpsProxyAgent } from 'https-proxy-agent';

const knownHosts = new Set(['feed.zoro.build', 'www.youtube.com', 'www.googleapis.com', 'api.bilibili.com']);
/** Reuse the operator's HTTPS proxy only for these fixed provider hosts.
 * Arbitrary subscription URLs retain DNS-pinned direct transport. */
export function sourceProxy(url: URL, value = process.env.HTTPS_PROXY ?? process.env.https_proxy) {
  if (!value || url.protocol !== 'https:' || !knownHosts.has(url.hostname) || url.port) return undefined;
  const proxy = new URL(value);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('来源代理需要 HTTP 或 HTTPS 地址');
  return new HttpsProxyAgent(proxy, { timeout: 20_000 });
}
