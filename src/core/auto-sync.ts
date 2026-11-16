export interface AutoSyncTarget { key: string; run(): Promise<string> }
export interface AutoSyncOutcome { key: string; status: 'running' | 'completed' | 'failed'; message?: string }

/** Captures each connection before starting; serializes switches without mixing libraries. */
export class AutoSync {
  private active: { key: string; promise: Promise<void> } | null = null;
  private stopped = false;
  private lastAttempt: { key: string; at: number } | null = null;
  constructor(private target: () => AutoSyncTarget | null, private report: (outcome: AutoSyncOutcome) => void, private now: () => number = Date.now) {}
  request(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const target = this.target();
    if (!target) return Promise.resolve();
    if (this.active) return this.active.key === target.key ? this.active.promise : this.active.promise.then(() => this.request());
    if (this.lastAttempt?.key === target.key && this.now() - this.lastAttempt.at < 15_000) return Promise.resolve();
    this.lastAttempt = { key: target.key, at: this.now() };
    const active = { key: target.key, promise: Promise.resolve() };
    this.active = active;
    active.promise = Promise.resolve().then(async () => {
      if (this.stopped) return;
      this.report({ key: target.key, status: 'running' });
      try {
        const message = await target.run();
        if (!this.stopped) this.report({ key: target.key, status: 'completed', message });
      } catch (error) {
        if (!this.stopped) this.report({ key: target.key, status: 'failed', message: error instanceof Error ? error.message : '同步失败' });
      }
    }).finally(() => { if (this.active === active) this.active = null; });
    return active.promise;
  }
  stop() { this.stopped = true; }
}
