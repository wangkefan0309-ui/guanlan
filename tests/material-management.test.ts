import { describe, expect, it } from 'vitest';
import { ReadingLibrary } from '../src/core/library';
import type { FileStore, Material } from '../src/core/model';

class Files implements FileStore {
  data = new Map<string, Uint8Array>(); fail = false;
  async read(path: string) { const value = this.data.get(path); return value ? new TextDecoder().decode(value) : null; }
  async readBinary(path: string) { return this.data.get(path) ?? null; }
  async write(path: string, content: string) { if (this.fail && path.endsWith('/state.json')) throw Error('模拟索引保存失败'); this.data.set(path, new TextEncoder().encode(content)); }
  async writeBinary(path: string, content: Uint8Array) { this.data.set(path, content); }
}
const material = (identity: string, body = '原始正文和具体方法。'): Material => ({ identity, url: identity, title: '材料 ' + identity, body, source: '测试作者', kind: 'article', topic: 'ai-learning', purpose: 'reading', capturedAt: '2026-10-19T01:00:00Z', coverage: 'partial', gaps: [], guide: '', guideKind: 'none', original: { extension: 'html', base64: Buffer.from('<article>来源原件</article>').toString('base64') } });

describe('材料回收站与批量管理', () => {
  it('删除全部版本、重启和再次同步后不复活；恢复保留原件、批注及各版进度', async () => {
    const files = new Files(), library = new ReadingLibrary(files, '09_测试');
    const first = await library.import(material('https://example.org/a'));
    await library.updateProgress(first.id, first.version, 'reading', '第 2 段');
    const second = await library.import(material('https://example.org/a', '新版本正文'));
    await files.write(first.path, '用户批注，必须原样保留');
    const before = new Map([...files.data].filter(([path]) => !path.endsWith('/state.json')));
    expect(await library.trashItems([first.id, first.id])).toBe(1);
    const restarted = new ReadingLibrary(files, '09_测试');
    await restarted.sync({ instance: 'server', cursor: 3, items: [material('https://example.org/a', '新抓取的第三个版本'), material('https://example.org/b')] });
    expect((await restarted.list()).map(i => i.identity)).toEqual(['https://example.org/b']);
    expect((await restarted.checkpoint()).cursor).toBe(3);
    expect(await restarted.listTrash()).toHaveLength(2);
    expect(await restarted.restoreItems([first.id])).toBe(1);
    const restored = (await restarted.list()).filter(i => i.id === first.id);
    expect(restored.map(i => i.version)).toEqual([first.version, second.version]);
    expect(restored[0]?.position).toBe('第 2 段'); expect(restored[0]?.progress).toBe('reading');
    for (const [path, bytes] of before) expect(files.data.get(path)).toEqual(bytes);
    expect(await restarted.listTrash()).toHaveLength(0);
  });
  it('索引写入失败时删除及恢复均不改变当前列表或文件', async () => {
    const files = new Files(), library = new ReadingLibrary(files, '09_测试');
    const item = await library.import(material('https://example.org/a'));
    files.fail = true; await expect(library.trashItems([item.id])).rejects.toThrow('保存失败');
    expect(await library.list()).toHaveLength(1); expect(await library.listTrash()).toHaveLength(0);
    files.fail = false; await library.trashItems([item.id]); files.fail = true;
    await expect(library.restoreItems([item.id])).rejects.toThrow('保存失败');
    expect(await library.list()).toHaveLength(0); expect(await library.listTrash()).toHaveLength(1);
    expect(await files.read(item.path)).toContain('原始正文');
  });
  it('并发批量进度与删除串行提交；手动导入已删除文章明确要求先恢复', async () => {
    const files = new Files(), library = new ReadingLibrary(files, '09_测试');
    const a = await library.import(material('https://example.org/a')), b = await library.import(material('https://example.org/b'));
    await library.updateProgress(a.id, a.version, 'reading', '保留位置');
    await Promise.all([library.updateManyProgress([a.id, b.id], 'done'), library.trashItems([a.id])]);
    expect((await library.list())[0]?.progress).toBe('done');
    expect((await library.listTrash())[0]?.item.position).toBe('保留位置');
    await expect(library.import(material('https://example.org/a'))).rejects.toThrow('回收站');
    expect(await library.trashItems([a.id])).toBe(0);
  });
  it('回收站中的越界路径也拒绝加载', async () => {
    const files = new Files(), library = new ReadingLibrary(files, '09_测试');
    const item = await library.import(material('https://example.org/a')); await library.trashItems([item.id]);
    const path = '09_测试/_工作台/state.json', state = JSON.parse((await files.read(path))!);
    state.trash[0].item.path = 'other/private.md'; await files.write(path, JSON.stringify(state));
    await expect(new ReadingLibrary(files, '09_测试').list()).rejects.toThrow('越过');
  });
});
