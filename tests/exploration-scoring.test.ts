import { describe, expect, it } from 'vitest';
import { hash } from '../src/core/model';
import { parseExplorationEntries, prefilterExploration, selectExploration, type ExplorationCandidate } from '../src/core/exploration';
import { enrichExploration } from '../src/server/exploration-evidence';

async function candidate(): Promise<ExplorationCandidate> {
  const url = 'https://x.com/creator/status/123';
  return { id: await hash(url), url, title: '作者展示可打开的新作品', source: 'X · @creator', query: 'AI project',
    excerpt: '作者介绍自己完成的可交互作品，说明制作过程，并提供实际项目入口。'.repeat(3), evidence: ['作者介绍自己完成的可交互作品，并提供实际项目入口。'],
    date: '2026-10-15T01:00:00Z', dateKind: 'published', coverage: 'search-excerpt', media: { kind: 'video', durationSeconds: 63 },
    contentLinks: [{ url: 'https://example.org/project', label: '作品入口', kind: 'article' }] };
}
const assessment = { basis: 'preview', substance: null, novelty: 8, relevance: 8, utility: null, support: 'firsthand' };
const entry = (id: string, overrides = {}) => ({ id, score: 0, assessment, label: 'PASS', kind: 'news', section: 'technology',
  reason: '原帖展示具体作品，值得打开体验', uncertainty: '未观看视频，尚未体验作品', quoteIndex: 0, event: '', ...overrides });
const parse = (c: ExplorationCandidate, value = entry(c.id)) => parseExplorationEntries(JSON.stringify({ items: [value] }), [c], false, true, true);

describe('推荐价值与材料覆盖分开评价', () => {
  it('真实网页或播客的候选URL本身就是预览入口，不要求再附一个外链', async () => {
    const url = 'https://podcasts.apple.com/podcast/episode/id123?i=456';
    const c = { ...await candidate(), id: await hash(url), url, source: '节目页面', media: undefined, contentLinks: undefined, evidenceUrl: undefined, coverage: 'page-excerpt' as const };
    expect(parse(c)[0]!.score).toBe(80);
  });
  it('尚未看视频不对未知份量打低分；按已知增量与兴趣选择作品入口', async () => {
    const c = await candidate(), entries = parse(c);
    expect(entries[0]!.score).toBe(80);
    expect(entries[0]!.assessment!.substance).toBeNull();
    expect(selectExploration(entries, [c], new Set(), '2026-10-15', 6, ['technology'])).toEqual([c.id]);
    // A single attributed source can justify opening a work, without claiming verification.
    const attributed = parse(c, entry(c.id, { assessment: { ...assessment, support: 'attributed' } }));
    expect(attributed[0]!.score).toBe(80);expect(selectExploration(attributed, [c], new Set())).toEqual([c.id]);
  });
  it('具体新闻无需教程用途；课程按明确用途评价，程序忽略模型自报总分', async () => {
    const c = await candidate();
    const news = parse(c, entry(c.id, { score: 99, assessment: { ...assessment, basis: 'content', substance: 6, novelty: 7, relevance: 8, utility: 1 } }));
    expect(news[0]!.score).toBe(74);
    const learning = parse(c, entry(c.id, { kind: 'learning', assessment: { ...assessment, novelty: 4, relevance: 7, utility: 8 } }));
    expect(learning[0]!.score).toBe(71);expect(selectExploration(learning, [c], new Set())).toEqual([c.id]);
  });
  it('高兴趣不能放行明确空泛内容、线索不足、低相关或UNKNOWN', async () => {
    const c = await candidate();
    for (const value of [
      entry(c.id, { assessment: { ...assessment, basis: 'content', substance: 2 } }),
      entry(c.id, { assessment: { ...assessment, support: 'insufficient' } }),
      entry(c.id, { assessment: { ...assessment, relevance: 5, novelty: 10 } }),
      entry(c.id, { label: 'UNKNOWN' }), entry(c.id, { label: 'BLOCK' }),
    ]) expect(selectExploration(parse(c, value), [c], new Set())).toEqual([]);
    expect(selectExploration(parse(c), [c], new Set([c.id]))).toEqual([]);
  });
  it('不允许评价未看视频的份量，也不允许用无入口的预览或缺失新评分字段混过验证', async () => {
    const c = await candidate();
    expect(() => parse(c, entry(c.id, { assessment: { ...assessment, substance: 9 } }))).toThrow('必须留空');
    expect(() => parse(c, entry(c.id, { assessment: { ...assessment, basis: 'content' } }))).toThrow('必须说明实质份量');
    expect(() => parse({ ...c, media: undefined, contentLinks: undefined })).toThrow('缺少实际内容入口');
    expect(() => parse(c, entry(c.id, { assessment: undefined, score: 100 }))).toThrow('缺少推荐价值');
  });
  it('旧五轴回答仍按旧公式解析，不把历史分数改成新推荐价值', async () => {
    const c = await candidate(), old = { ...entry(c.id), assessment: undefined, axes: { substance: 6, novelty: 7, evidence: 5, relevance: 8, utility: 7 } };
    expect(parseExplorationEntries(JSON.stringify({ items: [old] }), [c], true, true)[0]!.score).toBe(67);
  });
  it('相近分数优先不同作者，明显更强的同作者材料仍可入选，不为作者配额放行低分', async () => {
    const base = await candidate();
    const candidates = await Promise.all(['authorA', 'authorA', 'authorB', 'authorC'].map(async (author, i) => {
      const url = `https://x.com/${author}/status/${100+i}`;return { ...base, url, id: await hash(url) };
    }));
    const entries = candidates.map((c, i) => ({ ...parse(c)[0]!, score: [86, 82, 80, 78][i]! }));
    expect(selectExploration(entries, candidates, new Set(), undefined, 3, ['technology'])).toEqual([candidates[0]!.id, candidates[2]!.id, candidates[3]!.id]);
    entries[1]!.score=95;entries[2]!.score=70;entries[3]!.score=59;
    expect(selectExploration(entries, candidates, new Set(), undefined, 3, ['technology'])).toEqual([candidates[1]!.id, candidates[0]!.id, candidates[2]!.id]);
  });
});

describe('X项目及文章外链补读', () => {
  it('短帖补读成功后按实际外链内容评价，不因原帖仅元数据继续机械拦截', async () => {
    const c = { ...await candidate(), excerpt: '这个项目值得看', coverage: 'metadata' as const };
    expect(prefilterExploration(c, '2026-10-15')?.label).toBe('UNKNOWN');
    const result = await enrichExploration({ candidates: [c] }, async () => `<html><body><article><p>${'项目说明列出具体交互场景、操作步骤和实现限制。'.repeat(12)}</p></article></body></html>`);
    const enriched = result.candidates[0]!;
    expect(enriched.coverage).toBe('metadata');expect(prefilterExploration(enriched, '2026-10-15')).toBeNull();
    expect(selectExploration(parse(enriched), [enriched], new Set())).toEqual([c.id]);
  });
  it('保留帖文、作者日期和附件；外链单独保存并具有对应原件', async () => {
    const c = await candidate(), before = structuredClone(c), calls: string[] = [];
    const result = await enrichExploration({ candidates: [c] }, async url => {
      calls.push(url);return `<html><head><meta property="article:published_time" content="2020-01-01"></head><body><article><p>${'项目有三个可探索场景，页面提供具体操作步骤与演示说明。'.repeat(12)}</p></article></body></html>`;
    });
    expect(calls).toEqual(['https://example.org/project']);
    const saved = result.candidates[0]!;
    expect(saved).toMatchObject({ id: before.id, url: before.url, excerpt: before.excerpt, date: before.date, dateKind: before.dateKind, coverage: before.coverage, media: before.media });
    expect(saved.linkedEvidence!.url).toBe('https://example.org/project');
    expect(saved.evidence.at(-1)).toContain('外链摘选 https://example.org/project');
    expect(result.snapshots[0]!.json).toContain('项目有三个可探索场景');expect(c).toEqual(before);
  });
  it('外链失败保留已有文字，视频和X登录页不作为待抓正文；每批最多三条外链', async () => {
    const c = await candidate(), calls: string[] = [];
    const candidates = await Promise.all(Array.from({ length: 7 }, async (_, i) => ({ ...c, id: await hash(`post${i}`), query: `query${i}` })));
    candidates.push({ ...c, id: await hash('video'), contentLinks: [{ url: 'https://www.youtube.com/watch?v=Abcdef12345', kind: 'video', label: '原视频' }] });
    candidates.push({ ...c, id: await hash('login'), contentLinks: [{ url: 'https://x.com/other/status/456', kind: 'article', label: '引用帖' }] });
    const result = await enrichExploration({ candidates }, async url => { calls.push(url);throw Error('无法读取'); });
    expect(calls).toHaveLength(3);expect(calls.every(url => url === 'https://example.org/project')).toBe(true);
    expect(result.candidates).toEqual(candidates);expect(result.warnings).toHaveLength(3);expect(result.snapshots).toEqual([]);
  });
});
