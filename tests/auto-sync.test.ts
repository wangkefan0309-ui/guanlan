import { expect, it } from 'vitest';
import { AutoSync, type AutoSyncOutcome, type AutoSyncTarget } from '../src/core/auto-sync';

it('打开与定时检查重叠只发一次，短时间重复打开不重复请求', async () => {
  let calls = 0, release!: () => void, now = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const outcomes: AutoSyncOutcome[] = [];
  const sync = new AutoSync(() => ({ key: 'first', run: async () => { calls++; await gate; return '已保存'; } }), outcome => outcomes.push(outcome), () => now);
  const first = sync.request(); const second = sync.request();
  await Promise.resolve(); expect(calls).toBe(1); release(); await Promise.all([first, second]);
  await sync.request(); expect(calls).toBe(1); now = 300_000; await sync.request(); expect(calls).toBe(2);
  expect(outcomes.map(outcome => outcome.status)).toEqual(['running', 'completed', 'running', 'completed']);
});
it('连接切换先完成捕获的旧库，再检查新连接', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const writes: string[] = [];
  let target: AutoSyncTarget = { key: 'old', run: async () => { await gate; writes.push('old-library'); return 'old'; } };
  const sync = new AutoSync(() => target, () => {});
  const old = sync.request(); await Promise.resolve();
  target = { key: 'new', run: async () => { writes.push('new-library'); return 'new'; } };
  const next = sync.request(); expect(writes).toEqual([]); release(); await Promise.all([old, next]);
  expect(writes).toEqual(['old-library', 'new-library']);
});
it('离线失败可在下次定时检查恢复，失败不产生完成回执', async () => {
  let now = 0, online = false; const outcomes: AutoSyncOutcome[] = [];
  const sync = new AutoSync(() => ({ key: 'cloud', run: async () => { if (!online) throw new Error('离线'); return '已保存'; } }), outcome => outcomes.push(outcome), () => now);
  await sync.request(); expect(outcomes.at(-1)?.status).toBe('failed');
  online = true; now = 300_000; await sync.request(); expect(outcomes.at(-1)).toMatchObject({ status: 'completed', message: '已保存' });
});
it('禁用或未配置不请求，卸载后不启动排队的新连接或更新界面', async () => {
  let calls = 0, release!: () => void; const outcomes: AutoSyncOutcome[] = [];
  let target: AutoSyncTarget | null = null; const sync = new AutoSync(() => target, outcome => outcomes.push(outcome));
  await sync.request(); expect(calls).toBe(0);
  const gate = new Promise<void>(resolve => { release = resolve; });
  target = { key: 'one', run: async () => { calls++; await gate; return 'one'; } };
  const first = sync.request(); await Promise.resolve();
  target = { key: 'two', run: async () => { calls++; return 'two'; } }; const next = sync.request();
  sync.stop(); release(); await Promise.all([first, next]); await sync.request();
  expect(calls).toBe(1); expect(outcomes.map(outcome => outcome.status)).toEqual(['running']);
});
