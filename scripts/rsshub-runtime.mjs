// Own the wrapper, leave the pinned RSSHub source unchanged.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { timingSafeEqual } from 'node:crypto';

const configPath = resolve(process.argv[2]);
const settings = JSON.parse((await readFile(configPath, 'utf8')).trim());
const directory = dirname(configPath);
const token = (await readFile(resolve(directory, 'control-token.txt'), 'utf8')).trim();
const existingProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
Object.assign(process.env, {
  NODE_ENV: 'dev', PORT: String(settings.port), LISTEN_INADDR_ANY: '0', ENABLE_CLUSTER: '0',
  CACHE_TYPE: 'memory', REQUEST_RETRY: '0', REQUEST_TIMEOUT: '15000', CACHE_REQUEST_TIMEOUT: '180',
  CACHE_EXPIRE: '3600', NO_LOGFILES: '1', LOGGER_LEVEL: 'info',
  BILIBILI_EXCLUDE_SUBTITLES: '1', CHROMIUM_EXECUTABLE_PATH: settings.chrome,
});
for (const key of Object.keys(process.env)) {
  if (key.startsWith('BILIBILI_COOKIE_') || /^(PROXY_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|PUPPETEER_WS_ENDPOINT|PLAYWRIGHT_)/i.test(key)) delete process.env[key];
}
if (settings.reuseHttpsProxy !== false && existingProxy) {
  const proxy = new URL(existingProxy);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('Existing HTTPS_PROXY requires an HTTP(S) proxy');
  process.env.PROXY_URI = existingProxy;
  process.env.PROXY_URL_REGEX = '^https://(?:[^/]+\\.)?(?:bilibili\\.com|hdslb\\.com)(?::443)?/';
}
const require = createRequire(resolve(settings.upstream, 'package.json'));
// Match the installed Chromium rather than the upstream's older default UA.
// This also avoids the header-generator error observed with the pinned release.
const { chromium } = require('patchright');
const probe = await chromium.launch({ executablePath: settings.chrome, headless: true });
try {
  const page = await probe.newPage();
  process.env.UA = await page.evaluate(() => navigator.userAgent);
} finally { await probe.close(); }
const { serve } = require('@hono/node-server');
const app = (await import(pathToFileURL(resolve(settings.upstream, 'lib/app.ts')).href)).default;
const receipt = { instance: 'source-workbench-rsshub', pid: process.pid, host: '127.0.0.1', port: settings.port,
  startedAt: new Date().toISOString(), node: process.version, upstreamCommit: settings.commit, dependencyVersion: settings.dependencyVersion,
  existingHttpsProxy: settings.reuseHttpsProxy !== false && Boolean(existingProxy) };
let closing = false;
const authorized = request => {
  const supplied = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from('Bearer ' + token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};
const close = () => {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  server.closeIdleConnections();
};
const server = serve({ hostname: '127.0.0.1', port: settings.port, serverOptions: { maxHeaderSize: 32 * 1024 },
  fetch: (request, ...args) => {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/_workbench/')) {
      if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      if (pathname === '/_workbench/rsshub' && request.method === 'GET') return Response.json({ ...receipt, closing });
      if (pathname === '/_workbench/rsshub/stop' && request.method === 'POST') {
        setTimeout(close, 100);
        return Response.json({ stopping: true });
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    return app.fetch(request, ...args);
  },
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
if (!server.listening) await new Promise((done, fail) => { server.once('listening', done); server.once('error', fail); });
await writeFile(resolve(directory, 'runtime.json'), JSON.stringify(receipt, null, 2));
console.log('RSSHUB_READY ' + JSON.stringify(receipt));
process.on('SIGINT', close);
process.on('SIGTERM', close);
