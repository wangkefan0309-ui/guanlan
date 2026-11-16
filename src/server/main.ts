import { mkdir, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createSourceServer } from './service';

const directory = resolve(process.env.SOURCE_DATA_DIR || '.local/server'); await mkdir(directory, { recursive: true });
const port = Number(process.env.SOURCE_PORT || 27183); const host = process.env.SOURCE_HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SOURCE_PORT 必须是 1 到 65535 的整数');
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('首轮服务只监听本机；云端部署需先增加 TLS 和运维配置');
const tokenPath = join(directory, 'token.txt');
let token = process.env.SOURCE_TOKEN;
if (!token) { try { token = (await readFile(tokenPath, 'utf8')).trim(); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;token = crypto.randomUUID(); await writeFile(tokenPath, token, { mode: 0o600, flag:'wx' }); } }
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  server.close(async error => { await cleanup(); if (error) process.exitCode = 1; else process.exit(0); });
  server.closeIdleConnections();
};
const server = createSourceServer({ directory, token, onShutdown: shutdown });
const lockPath = join(directory, 'server.lock');
const lock = await open(lockPath, 'wx').catch(() => { throw new Error('数据目录已有服务锁。先确认进程已退出，再移除 server.lock 后重启。'); });
server.requestTimeout = 60_000;
let cleaned=false;
async function cleanup() { if(cleaned) return;cleaned=true;await lock.close(); await unlink(lockPath).catch(() => {}); }
try {
  await lock.writeFile(String(process.pid));
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);resolve();});});
  console.log(`信息源本地服务 http://${host}:${port}；${process.env.SOURCE_TOKEN?'令牌由 SOURCE_TOKEN 提供':`令牌保存在 ${tokenPath}`}；订阅配置和实际采集回执见 /v1/subscriptions。`);
} catch(error) { await cleanup();throw error; }
server.on('error', async error => { console.error(error.message); await server.collector.stop(); await cleanup(); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
