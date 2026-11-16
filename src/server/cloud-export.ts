import { subscriptionsViewSchema } from '../core/subscriptions';
import { ledgerSchema } from './ledger';
import { updateSourceId } from '../core/updates';

/** A complete ledger snapshot and fresh discovery receipts cannot skip a concurrently saved page. */
export function cloudSnapshot(input: unknown, ledgerText: string) {
  const view = subscriptionsViewSchema.parse(input); const ledger = ledgerSchema.parse(JSON.parse(ledgerText));
  const ids = new Set(view.sources.map(source => source.config.id));
  const identities=view.sources.map(source=>({registry_id:source.config.id,display_name:source.name,original_name:source.config.accountName,platform:source.config.platform}));
  if (ledger.entries.some(entry => !ids.has(updateSourceId(entry.material, identities) ?? ''))) throw new Error('账本包含非订阅材料，请先分离订阅服务，避免把手动原件带到云端');
  const sources = view.sources.map(source => {
    const config = { ...source.config };
    const url = config.feedUrl ? new URL(config.feedUrl) : null;
    if (url && ['127.0.0.1', '[::1]'].includes(url.hostname)) {
      if (config.platform !== 'bilibili' || !url.pathname.startsWith(`/bilibili/user/video/${config.accountId}/`)) throw new Error('订阅仍依赖本机采集端，需先确定云端接法');
      config.feedUrl = `http://127.0.0.1:1200${url.pathname}${url.search}`;
    }
    return { config, phase: 'waiting', seen: {}, etag: null, lastModified: null, responseUrl: null, lastAttempt: null, lastSuccess: null, nextDue: null, error: '', imported: 0, pending: 0, failures: 0 };
  });
  return { ledger: ledgerText, subscriptions: JSON.stringify({ schema: 1, revision: crypto.randomUUID(), ledgerInstance: ledger.instance, sources, categories: view.categories, collectionScope: view.collectionScope ?? 'today', collectionStartedAt: view.collectionStartedAt }), sources: sources.length, materials: ledger.entries.length, instance: ledger.instance };
}
