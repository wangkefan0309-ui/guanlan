import { chromium } from 'playwright-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// This profile belongs only to the workbench. Never inspect an existing profile.
const root = resolve(import.meta.dirname, '..');
const directory = join(root, '.local/x-free');
await mkdir(directory, { recursive: true });
const statusPath = join(directory, 'login-status.json');
const status = async state => {
  const temporary = `${statusPath}.tmp`;
  await writeFile(temporary, JSON.stringify({ state, updatedAt: new Date().toISOString() }));
  await rename(temporary, statusPath);
};
let context;
try {
  const config = JSON.parse((await readFile(join(root, '.local/rsshub/config.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const execute = promisify(execFile);
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue;[pscustomobject]@{enabled=[bool]$p.ProxyEnable;server=$p.ProxyServer}|ConvertTo-Json -Compress"], { windowsHide: true, timeout: 10_000 });
  const network = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  let proxy;
  if (network.enabled && network.server) {
    const value = network.server.includes('=') ? network.server.split(';').find(part => part.startsWith('https='))?.slice(6) ?? network.server.split(';').find(part => part.startsWith('http='))?.slice(5) : network.server;
    if (value) {
      const parsed = new URL(value.includes('://') ? value : `http://${value}`);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('unsupported-proxy');
      proxy = { server: parsed.href };
    }
  }
  context = await chromium.launchPersistentContext(join(directory, 'browser-profile'), {
    executablePath: config.chrome, headless: false, proxy, timeout: 20_000,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: null,
  });
  await status('waiting-for-login');
  const page = context.pages()[0] ?? await context.newPage();
  // Existing cookies may be expired. The reconnect action must require a fresh
  // sign-in rather than treating cookie presence as proof of a valid session.
  await context.clearCookies({ name: /^(auth_token|ct0)$/ });
  // A human completes sign-in and any account verification in this window.
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  let finished = false;
  context.on('close', () => { finished = true; });
  const deadline = Date.now() + 30 * 60_000;
  while (!finished && Date.now() < deadline) {
    const cookies = await context.cookies('https://x.com').catch(() => []);
    const authToken = cookies.find(cookie => cookie.name === 'auth_token')?.value;
    const ct0 = cookies.find(cookie => cookie.name === 'ct0')?.value;
    if (authToken && ct0) {
      const temporary = join(directory, `auth-${process.pid}.tmp`);
      await writeFile(temporary, JSON.stringify({ authToken, ct0, savedAt: new Date().toISOString() }), { mode: 0o600 });
      await rename(temporary, join(directory, 'auth.json'));
      await status('configured-unverified');
      console.log('X 登录状态已在本机保存，尚未完成真实搜索验证。');
      await context.close();
      finished = true;
      break;
    }
    await new Promise(done => setTimeout(done, 2000));
  }
  if (!finished || !(await readFile(statusPath, 'utf8')).includes('configured-unverified')) await status('cancelled');
} catch {
  await status('login-window-error');
  console.error('X 登录窗口未完成配置；请关闭专用窗口后重新运行 npm run x:login。');
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
}
