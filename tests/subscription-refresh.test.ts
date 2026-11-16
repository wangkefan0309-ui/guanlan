import { expect, it } from 'vitest';
import type { SubscriptionsView } from '../src/core/subscriptions';
import { checkAndSyncSubscriptions } from '../src/core/subscription-refresh';
import { collectionIssueAdvice, collectionIssueKind, subscriptionStatusText } from '../src/core/subscription-health';

function fixture() {
  const view: SubscriptionsView = { revision: crypto.randomUUID(), running: true, categories: [], sources: [] };
  let time = 0, reads = 0, checks = 0, syncs = 0;
  const reports: boolean[] = [];
  const dependencies = { now: () => time, check: async () => { checks++; return view; },
    read: async () => { reads++; return { ...view, running: reads < 2 }; },
    sync: async () => { syncs++; return '已同步后台保存的材料'; }, report: (v: SubscriptionsView) => { reports.push(v.running); },
    wait: async (ms: number) => { time += ms; } };
  return { view, dependencies, reports, get counts() { return { reads, checks, syncs }; } };
}
it('单次操作先收已有材料，检查完成后再收新材料，不要求用户连续点击', async () => {
  const f = fixture(); const result = await checkAndSyncSubscriptions(f.dependencies);
  expect(f.counts).toEqual({ checks: 1, reads: 2, syncs: 2 });
  expect(f.reports).toEqual([true, true, false]); expect(result).toContain('检查已结束');
});
it('部分来源失败时同步独立材料，并明确告知未完成及重试信息', async () => {
  const f = fixture(); f.view.running = false;
  f.view.sources = [{ config: { enabled: true }, status: 'error' } as SubscriptionsView['sources'][number]];
  expect(await checkAndSyncSubscriptions(f.dependencies)).toContain('1 个来源未完成');
  expect(f.counts).toEqual({ checks: 1, reads: 0, syncs: 1 });
});
it('长时间采集只显示仍在运行，不把等待结束当作抓取成功或重复发起采集', async () => {
  const f = fixture(); f.dependencies.read = async () => { return f.view; };
  expect(await checkAndSyncSubscriptions({ ...f.dependencies, maxWaitMs: 4000 })).toContain('后台仍在采集');
  expect(f.counts.checks).toBe(1); expect(f.counts.syncs).toBe(1);
});
it('连接中断和超时提示自动重试，只有真实授权问题才提示检查配置', () => {
  for (const error of ['官方接口连接失败', 'TLS socket disconnected', '订阅读取超时', '订阅返回 HTTP 503']) {
    expect(collectionIssueKind(error)).toBe('network');
    expect(subscriptionStatusText({ status: 'error', error, nextDue: '2026-11-02T02:01:00Z' })).toContain('自动重试');
  }
  expect(collectionIssueAdvice('官方接口密钥、启用状态或密钥限制不符')).toContain('检查对应来源');
  expect(collectionIssueKind('原页面账号不匹配，请检查采集端授权与更新链接')).toBe('authorization');
  expect(collectionIssueKind('官方接口连接失败；RSS：订阅返回 HTTP 429')).toBe('rate-limit');
  expect(collectionIssueKind('网络超时；ENOSPC 写入失败')).toBe('storage');
});
