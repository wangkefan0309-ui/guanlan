import { expect, it } from 'vitest';
import { LocalSupervisor, type ComponentName, type ComponentState, type LocalRuntimeState } from '../src/server/local-supervisor';

function fixture() {
  let time = Date.parse('2026-10-11T00:00:00Z'), online = true, running = false;
  const components: Record<ComponentName, ComponentState> = { materials: 'ready', rsshub: 'ready' };
  const calls: ComponentName[] = [], reports: LocalRuntimeState[] = [];
  let polls = 0;
  const supervisor = new LocalSupervisor({ now: () => time, network: async () => online,
    ensure: async name => { calls.push(name); return components[name]; },
    poll: async () => { if (running) return false; polls++; return true; }, report: async state => { reports.push(state); },
  });
  return { supervisor, components, calls, reports, get polls() { return polls; }, advance: (ms: number) => { time += ms; }, online: (value: boolean) => { online = value; }, running: (value: boolean) => { running = value; } };
}
it('开机补抓一次，正常检查不重复强制抓取；RSSHub不可用不阻止其他平台', async () => {
  const f = fixture(); f.components.rsshub = 'blocked';
  expect(await f.supervisor.tick()).toMatchObject({ materials: 'ready', rsshub: 'blocked', pendingCheck: false });
  f.advance(30_000); await f.supervisor.tick(); expect(f.polls).toBe(1);
  expect(f.calls).toContain('materials');
});
it('网络晚到时不丢开机补抓；网络恢复后最多触发一轮', async () => {
  const f = fixture(); f.online(false); await f.supervisor.tick(); expect(f.polls).toBe(0);
  f.advance(30_000); f.online(true); await f.supervisor.tick(); expect(f.polls).toBe(1);
  f.advance(30_000); await f.supervisor.tick(); expect(f.polls).toBe(1);
});
it('材料服务恢复后补抓，端口冲突期间不发请求，其他服务保持检查', async () => {
  const f = fixture(); await f.supervisor.tick();
  f.components.materials = 'blocked'; f.advance(30_000); await f.supervisor.tick(); expect(f.polls).toBe(1);
  f.components.materials = 'ready'; f.advance(30_000); await f.supervisor.tick(); expect(f.polls).toBe(2);
  expect(f.calls.filter(name => name === 'rsshub')).toHaveLength(3);
});
it('休眠造成长间隔后补抓，正在抓取和短间隔请求合并', async () => {
  const f = fixture(); await f.supervisor.tick(); f.advance(4 * 60 * 60_000); f.running(true);
  expect(await f.supervisor.tick()).toMatchObject({ pendingCheck: true }); expect(f.polls).toBe(1);
  f.advance(30_000); f.running(false); await f.supervisor.tick(); expect(f.polls).toBe(2);
  f.supervisor.requestCheck(); f.advance(30_000); await f.supervisor.tick(); expect(f.polls).toBe(2);
  f.advance(30_000); await f.supervisor.tick(); expect(f.polls).toBe(3);
});
it('并发tick共享执行，停止后不再启动进程或发出补抓', async () => {
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  let starts = 0, polls = 0;
  const supervisor = new LocalSupervisor({ network: async () => { await gate; return true; }, ensure: async () => { starts++; return 'ready'; }, poll: async () => { polls++; return true; }, report: async () => {} });
  const a = supervisor.tick(), b = supervisor.tick(); expect(a).toBe(b); supervisor.stop(); release(); await a;
  await supervisor.tick(); expect(starts).toBe(0); expect(polls).toBe(0);
});
