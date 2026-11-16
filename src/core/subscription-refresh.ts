import type { SubscriptionsView } from './subscriptions';

interface Dependencies {
  check(): Promise<SubscriptionsView>;
  read(): Promise<SubscriptionsView>;
  sync(): Promise<string>;
  report(view: SubscriptionsView): void;
  wait(milliseconds: number): Promise<void>;
  now?: () => number;
  maxWaitMs?: number;
}

/** Dependencies are captured by the caller, including its connection and target library. */
export async function checkAndSyncSubscriptions(dependencies: Dependencies): Promise<string> {
  const now = dependencies.now ?? Date.now, started = now();
  let view = await dependencies.check(); dependencies.report(view);
  let message = await dependencies.sync();
  while (view.running && now() - started < (dependencies.maxWaitMs ?? 180_000)) {
    await dependencies.wait(2000);
    view = await dependencies.read(); dependencies.report(view);
    if (!view.running) message = await dependencies.sync();
  }
  if (view.running) return `${message}；后台仍在采集，请稍后查看进度`;
  const failed = view.sources.filter(source => source.config.enabled && source.status === 'error');
  const pending = view.sources.filter(source => source.config.enabled && source.status === 'waiting');
  return `${message}${failed.length ? `；${failed.length} 个来源未完成，原因和自动重试时间见信源` : pending.length ? '；积压材料仍在分批采集' : '；当前采集检查已结束'}`;
}
