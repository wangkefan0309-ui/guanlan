export type ComponentName = 'materials' | 'rsshub';
export type ComponentState = 'ready' | 'starting' | 'blocked' | 'offline';
export interface LocalRuntimeState {
  checkedAt: string;
  materials: ComponentState;
  rsshub: ComponentState;
  networkReady: boolean;
  pendingCheck: boolean;
  lastCheck: string | null;
  error: string;
}
export interface LocalRuntimeDependencies {
  ensure(name: ComponentName): Promise<ComponentState>;
  network(): Promise<boolean>;
  poll(): Promise<boolean>;
  report(state: LocalRuntimeState): Promise<void>;
  now?: () => number;
}

/** Keep process recovery separate from source receipts and their persisted backoff. */
export class LocalSupervisor {
  private active: Promise<LocalRuntimeState> | null = null;
  private stopped = false;
  private pending = true;
  private previousTick: number | null = null;
  private previousNetwork = false;
  private previousRsshub: ComponentState = 'offline';
  private previousMaterials: ComponentState = 'offline';
  private lastCheck: number | null = null;
  private now: () => number;
  constructor(private dependencies: LocalRuntimeDependencies) { this.now = dependencies.now ?? Date.now; }
  requestCheck() { this.pending = true; }
  async stop(): Promise<void> { this.stopped = true; await this.active?.catch(() => {}); }
  tick(): Promise<LocalRuntimeState> {
    if (this.active) return this.active;
    const work = this.run();
    this.active = work.finally(() => { this.active = null; });
    return this.active;
  }
  private async run(): Promise<LocalRuntimeState> {
    const at = this.now();
    const state: LocalRuntimeState = { checkedAt: new Date(at).toISOString(), materials: 'offline', rsshub: 'offline', networkReady: false, pendingCheck: this.pending, lastCheck: this.lastCheck === null ? null : new Date(this.lastCheck).toISOString(), error: '' };
    if (this.stopped) return state;
    if (this.previousTick !== null && at - this.previousTick > 90_000) this.pending = true;
    this.previousTick = at;
    try { state.networkReady = await this.dependencies.network(); }
    catch { state.error = '网络检查暂不可用'; }
    if (state.networkReady && !this.previousNetwork) this.pending = true;
    this.previousNetwork = state.networkReady;
    for (const name of ['rsshub', 'materials'] as const) {
      if (this.stopped) return state;
      try { state[name] = await this.dependencies.ensure(name); }
      catch { state[name] = 'blocked'; state.error = `${name === 'materials' ? '材料服务' : 'RSSHub'}启动检查失败，原数据保留`; }
    }
    if (state.rsshub === 'ready' && this.previousRsshub !== 'ready') this.pending = true;
    this.previousRsshub = state.rsshub;
    if (state.materials === 'ready' && this.previousMaterials !== 'ready') this.pending = true;
    this.previousMaterials = state.materials;
    if (!this.stopped && this.pending && state.materials === 'ready' && state.networkReady && (this.lastCheck === null || at - this.lastCheck >= 60_000)) {
      try {
        if (await this.dependencies.poll()) { this.lastCheck = at; this.pending = false; }
      } catch { state.error = '补抓请求未确认，稍后重试；不代表已取得新材料'; }
    }
    state.lastCheck = this.lastCheck === null ? null : new Date(this.lastCheck).toISOString();
    state.pendingCheck = this.pending;
    if (!this.stopped) await this.dependencies.report(state);
    return state;
  }
}
