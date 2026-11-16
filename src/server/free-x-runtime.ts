import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FreeXRuntime } from './free-x';

/** Credentials are read by Python from the dedicated local profile only.
 * No browser-wide cookie export, credential arguments or upstream error output. */
export function createFreeXRuntime(root = process.cwd()): FreeXRuntime {
  const directory = resolve(root, '.local/x-free');
  const python = join(directory, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const bridge = join(root, 'scripts/x-free-bridge.py');
  let login: ChildProcess | undefined;
  return {
    async ready() {
      try {
        await Promise.all([access(python), access(bridge)]);
        const auth = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'));
        if (['authToken', 'ct0'].every(key => typeof auth[key] === 'string' && auth[key].length >= 16)) return { configured: true, reason: 'X登录状态已在本机配置；以真实搜索回执为准' };
      } catch { /* Missing or damaged local configuration. */ }
      return { configured: false, reason: '请先连接X账号；无需购买API，其他发现渠道继续运行' };
    },
    async login() {
      await Promise.all([access(python), access(bridge)]).catch(() => { throw new Error('免费X采集库尚未安装，请先运行 npm run x:setup'); });
      if (login && login.exitCode === null && login.signalCode === null) return;
      login = spawn(process.execPath, [join(root, 'scripts/x-free-login.mjs')], { cwd: root, windowsHide: true, detached: true, stdio: 'ignore' });
      const child = login;
      await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', () => { login = undefined; reject(new Error('X专用登录窗口未能打开')); }); });
      child.unref();
    },
    search(query) {
      return new Promise<string>((done, reject) => {
        const child = spawn(python, [bridge], { cwd: root, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', TWS_HTTP_BACKEND: 'curl' }, stdio: ['pipe', 'pipe', 'ignore'] });
        const chunks: Buffer[] = []; let bytes = 0, settled = false;
        const finish = (error?: Error) => {
          if (settled) return; settled = true; clearTimeout(timer);
          if (error) { child.kill(); reject(error); } else done(Buffer.concat(chunks).toString('utf8'));
        };
        const timer = setTimeout(() => finish(new Error('免费X搜索超时；本日暂停，不自动重发')), 65_000);
        child.stdout.on('data', chunk => { if (settled) return; bytes += chunk.length; if (bytes > 2_000_000) finish(new Error('免费X回执超过2MB；本日暂停')); else chunks.push(chunk); });
        child.once('error', () => finish(new Error('免费X采集进程未能启动')));
        child.stdin.on('error', () => finish(new Error('免费X采集进程未接收请求')));
        child.once('close', code => finish(code === 0 ? undefined : new Error('免费X采集进程未完成；本日暂停')));
        child.stdin.end(JSON.stringify({ directory, query }));
      });
    },
  };
}
