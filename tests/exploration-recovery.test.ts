import { describe, expect, it } from 'vitest';
import { ExplorationLibrary } from '../src/core/exploration';
import { hash, type FileStore } from '../src/core/model';

const root = '09_测试', now = new Date('2026-10-19T04:00:00Z'), statePath = `${root}/_工作台/探索/state.json`;
class Files implements FileStore {
  data = new Map<string, string>(); fail = '';
  async read(path: string) { return this.data.get(path) ?? null; }
  async readBinary() { return null; }
  async writeBinary() {}
  async write(path: string, content: string, expected?: string | null) {
    if (this.fail && path.includes(this.fail)) throw Error('模拟保存失败');
    if (expected !== undefined && (this.data.get(path) ?? null) !== expected) throw Error('比较写入失败');
    this.data.set(path, content);
  }
}
async function failedReceipt(files: Files) {
  const candidates = await Promise.all(Array.from({ length: 4 }, async (_, i) => ({ id: await hash(`https://example.org/episode/${i}`), url: `https://example.org/episode/${i}`, title: `具体节目 ${i}`, source: `作者 ${i}`, query: 'AI', excerpt: '节目介绍列出具体议题、方法、案例和适用条件，提供可打开的本期节目页面。'.repeat(3), evidence: ['节目介绍列出具体议题、方法、案例和适用条件。'], coverage: 'page-excerpt', dateKind: 'unknown' })));
  const rawModel = JSON.stringify({ items: candidates.map(c => ({ id: c.id, score: 5, assessment: { basis: 'preview', substance: null, novelty: 8, relevance: 8, utility: 8, support: 'attributed' }, label: 'PASS', kind: 'learning', section: 'technology', reason: '节目介绍涉及具体方法，值得打开', uncertainty: '尚未收听节目', quoteIndex: 0, event: '' })) });
  const original = { id: await hash('original-batch'), date: '2026-10-19', createdAt: now.toISOString(), provider: 'public', queries: ['AI'], goals: '学习具体方法', model: 'original-model', endpoint: 'https://example.org', promptVersion: 'exploration-8', status: 'failed', maxItems: 3, sections: ['technology'], search: { candidates, snapshots: [{ source: '原检索回执', query: 'AI', json: '{}' }], warnings: [], credits: 0 }, entries: [], selected: [], usage: { inputTokens: 100, outputTokens: 40 }, rawModel, error: '探索预览评价缺少实际内容入口' };
  const journalPath = `${root}/_工作台/探索/${original.id}.json`, journal = JSON.stringify(original, null, 2);
  files.data.set(journalPath, journal);
  const indexed = { ...original, rawModel: undefined, search: { ...original.search, snapshots: [] }, journalHash: await hash(journal) };
  files.data.set(statePath, JSON.stringify({ schema: 1, runs: [indexed], dismissed: [] }));
  return { original: JSON.parse(JSON.stringify(indexed)), journal, journalPath, rawModel, candidates };
}
describe('首次模型回答的本地重校验', () => {
  it('保留原失败和原回答，新建派生回执获得3条；重启和再次点击都不发新请求', async () => {
    const files = new Files(), source = await failedReceipt(files), library = new ExplorationLibrary(files, root, () => now);
    const result = await library.recoverFirstEvaluation();
    expect(result.status).toBe('completed'); expect(result.selected).toHaveLength(3); expect(result.recoveredFrom).toBe(source.original.id);
    expect(result.model).toBe('original-model'); expect(result.rawModel).toBe(source.rawModel); expect(result.usage).toEqual(source.original.usage);
    expect(await files.read(source.journalPath)).toBe(source.journal);
    const state = JSON.parse((await files.read(statePath))!); expect(state.runs).toEqual([source.original]); expect(state.recoveries).toHaveLength(1);
    expect((await library.archive()).days).toHaveLength(1); expect((await library.archive()).days[0]?.summary).toContain('无新调用');
    const restarted = new ExplorationLibrary(files, root, () => now);
    expect((await restarted.recoverFirstEvaluation()).id).toBe(result.id);
    const existing = await restarted.run({ provider: 'public', queries: ['AI'], goals: 'changed', model: 'changed', endpoint: 'https://example.org' }, () => { throw Error('不应重新检索'); }, () => { throw Error('不应调用模型'); });
    expect(existing.id).toBe(result.id); expect(await restarted.recommendations()).toHaveLength(3);
    expect((await restarted.excludedIds()).size).toBe(3);
  });
  it('原始回执哈希不符时拒绝重校验，保留首次失败和篡改文件', async () => {
    const files = new Files(), source = await failedReceipt(files), state = await files.read(statePath);
    files.data.set(source.journalPath, source.journal + ' ');
    await expect(new ExplorationLibrary(files, root, () => now).recoverFirstEvaluation()).rejects.toThrow('已修改');
    expect(await files.read(statePath)).toBe(state); expect(await files.read(source.journalPath)).toBe(source.journal + ' ');
  });
  it('笔记保存中断后只补保存首次重校验，原始失败和模型配置不变', async () => {
    const files = new Files(), source = await failedReceipt(files), library = new ExplorationLibrary(files, root, () => now);
    files.fail = '/探索推荐/'; await expect(library.recoverFirstEvaluation()).rejects.toThrow('保存失败'); expect(library.pendingSave).toBe(true);
    files.fail = ''; const restarted = new ExplorationLibrary(files, root, () => now);
    const result = await restarted.run({ provider: 'public', queries: ['AI'], goals: 'changed', model: 'changed', endpoint: 'https://example.org' }, () => { throw Error('不应重新检索'); }, () => { throw Error('不应调用模型'); });
    expect(result.status).toBe('completed'); expect(result.model).toBe('original-model'); expect(await restarted.recommendations()).toHaveLength(3);
    expect(await files.read(source.journalPath)).toBe(source.journal); expect(JSON.parse((await files.read(statePath))!).runs).toEqual([source.original]);
  });
});
