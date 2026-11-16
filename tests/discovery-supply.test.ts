import { describe, expect, it } from 'vitest';
import { searchExploration } from '../src/server/exploration-search';
import { subscriptionDiscoveryCandidates } from '../src/core/discovery-supply';
import type { ReadingItem } from '../src/core/model';
import { hash } from '../src/core/model';
import { ExplorationLibrary } from '../src/core/exploration';
import type { FileStore } from '../src/core/model';

const now = new Date('2026-10-19T04:00:00Z');
describe('推荐候选补给', () => {
  it('连续三天先排除已推荐链接再补池，每天得到3条且无重复', async () => {
    const data = new Map<string, string>();
    const files: FileStore = { read: async path => data.get(path) ?? null, readBinary: async () => null, writeBinary: async () => {}, write: async (path, content, expected) => { if (expected !== undefined && (data.get(path) ?? null) !== expected) throw Error('写入冲突'); data.set(path, content); } };
    let date = now, calls = 0;
    const library = new ExplorationLibrary(files, '09_测试', () => date);
    const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), version: 'v1', title: `近期教程 ${i}`, source: `作者 ${i % 3}`, url: `https://example.org/daily/${i}`, identity: `https://example.org/daily/${i}`, body: '已保存的正文包含具体的适用条件、方法步骤、案例和限制。'.repeat(5), capturedAt: now.toISOString(), publishedAt: now.toISOString(), purpose: 'reading', coverage: 'partial', progress: 'unread', topic: 'ai-learning' }) as ReadingItem);
    const selected: string[] = [];
    for (let day = 0; day < 3; day++) {
      date = new Date(now.getTime() + day * 86400_000);
      const run = await library.run({ provider: 'public', queries: ['AI'], goals: '关注具体教程', model: 'test', endpoint: 'https://example.org', maxItems: 3, sections: ['technology'] },
        async () => subscriptionDiscoveryCandidates(items, ['technology'], date, await library.excludedIds()),
        async messages => { calls++; return { content: JSON.stringify({ items: JSON.parse(messages.at(-1)!.content).candidates.map((c: { id: string }) => ({ id: c.id, score: 0, assessment: { basis: 'content', substance: 8, novelty: 8, relevance: 8, utility: 8, support: 'attributed' }, label: 'PASS', kind: 'learning', section: 'technology', reason: '有具体方法可读', uncertainty: '未核验效果', quoteIndex: 0, event: '' })) }) }; });
      expect(run.selected).toHaveLength(3); selected.push(...run.selected);
    }
    expect(new Set(selected).size).toBe(9); expect(calls).toBe(3);
  });
  it('公开检索不会把中文兴趣清单作为必须同时命中的长串查询', async () => {
    const original = '生活 认知 年轻人成长 科技 AI', queries: string[] = [];
    const result = await searchExploration({ provider: 'public', queries: [original] }, async url => {
      if (url.hostname === 'hn.algolia.com') { queries.push(url.searchParams.get('query')!); return JSON.stringify({ hits: [] }); }
      const query = url.searchParams.get('q')!;
      return JSON.stringify({ items: query.includes(original) ? [] : [{ full_name: 'org/project', html_url: 'https://github.com/org/project', description: 'A concrete practical learning project with examples and implementation details.', stargazers_count: 500, pushed_at: now.toISOString(), archived: false, fork: false }] });
    }, now);
    expect(queries).not.toContain(original);
    expect(result.candidates).toHaveLength(1);
    expect(result.warnings.some(w => w.includes('改写'))).toBe(true);
  });
  it('订阅补充只提供近期未读真实正文，排除旧文、已读、元数据及关闭板块', async () => {
    const item = (id: string, overrides: Partial<ReadingItem> = {}) => ({ id, version: 'v1', title: '已同步的具体教程', source: '已订阅作者', url: `https://example.org/${id}`, identity: `https://example.org/${id}`, body: '这里是已经保存到阅读库中的正文，包含具体的使用方法、案例与限制。'.repeat(4), publishedAt: now.toISOString(), capturedAt: now.toISOString(), savedAt: now.toISOString(), path: `09/阅读材料/${id}.md`, kind: 'article', purpose: 'reading', coverage: 'partial', gaps: [], guide: '', guideKind: 'none', topic: 'ai-learning', progress: 'unread', position: '', ...overrides }) as ReadingItem;
    const result = await subscriptionDiscoveryCandidates([item('a'), item('a', { version: 'v2' }), item('old', { publishedAt: '2026-10-01T00:00:00Z' }), item('done', { progress: 'done' }), item('meta', { coverage: 'metadata' }), item('closed', { topic: 'finance' })], ['technology'], now);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.origin).toBe('subscription');
    expect(result.candidates[0]?.evidence[0]).toContain('已经保存');
    expect(result.snapshots[0]?.json).toContain('v2');
    expect((await subscriptionDiscoveryCandidates([item('a'), item('b')], ['technology'], now, new Set([await hash('https://example.org/a')]))).candidates.map(c => c.url)).toEqual(['https://example.org/b']);
  });
});
