import { describe, expect, it } from 'vitest';
import { ReadingLibrary, selectDaily } from '../src/core/library';
import { readingRoot } from '../src/core/model';
import type { FileStore, Material } from '../src/core/model';

class MemoryFiles implements FileStore {
  data = new Map<string, Uint8Array>(); failOn = '';
  async read(path: string) { const bytes = this.data.get(path); return bytes ? new TextDecoder().decode(bytes) : null; }
  async readBinary(path: string) { return this.data.get(path) ?? null; }
  async write(path: string, contents: string) { return this.writeBinary(path,new TextEncoder().encode(contents)); }
  async writeBinary(path: string, contents: Uint8Array) { if (path.includes(this.failOn) && this.failOn) throw new Error('模拟磁盘失败'); this.data.set(path,contents); }
}
function material(overrides: Partial<Material> = {}): Material { return { title: '基础材料', source: '样例来源', identity:'https://example.org/a',url:'https://example.org/a',topic:'ai-learning',kind:'article',purpose:'reading',capturedAt:'2026-10-09T04:00:00.000Z', body:'第一段介绍了概念。\n\n第二段说明使用条件。',coverage:'partial',gaps:['未理解图像'],guide:'第一段介绍了概念。',guideKind:'excerpt',original:{extension:'html',base64:Buffer.from('<article>原件</article>').toString('base64')},...overrides }; }
describe('ReadingLibrary 的保存与恢复', () => {
  it('重复导入同一正文复用材料和首份原件，追踪脚本变化不会制造新版本', async () => {
    const files=new MemoryFiles(); const library=new ReadingLibrary(files,'09_信息源');
    const first=await library.import(material()); const second=await library.import(material({ original:{extension:'html',base64:Buffer.from('<article>原件<script>tracking</script></article>').toString('base64')} }));
    expect(second.path).toBe(first.path); expect(await library.list()).toHaveLength(1);
    expect(new TextDecoder().decode((await files.readBinary(first.originalPath!))!)).toBe('<article>原件</article>');
  });
  it('正文修改生成新版本，旧正文与阅读位置保留；重启后恢复进度', async () => {
    const files=new MemoryFiles(); const library=new ReadingLibrary(files,'09_信息源'); const first=await library.import(material());
    await library.updateProgress(first.id,first.version,'reading','第二段');
    const second=await library.import(material({body:'新正文。'})); expect(second.path).not.toBe(first.path);
    const restarted=new ReadingLibrary(files,'09_信息源'); const saved=await restarted.list();
    expect(saved[0]?.position).toBe('第二段'); expect(saved[0]?.progress).toBe('reading'); expect(await files.read(first.path)).toContain('第二段说明使用条件。');
  });
  it('用户编辑过的正文不会被覆盖，返回可理解的冲突提示', async () => {
    const files=new MemoryFiles(); const library=new ReadingLibrary(files,'09_信息源'); const item=await library.import(material());
    await files.write(item.path,'我的批注'); await expect(library.import(material())).rejects.toThrow('文件已被修改'); expect(await files.read(item.path)).toBe('我的批注');
  });
  it('部分保存失败不推进游标，重试复用已保存材料，服务重置后可恢复全量', async () => {
    const files=new MemoryFiles(); const library=new ReadingLibrary(files,'09_信息源'); const batch={instance:'server-1',cursor:2,items:[material(),material({identity:'https://example.org/b',body:'第二份正文'})]};
    let saves=0; const original=files.writeBinary.bind(files); files.writeBinary=async (path,bytes) => { if (path.includes('/阅读材料/') && ++saves===2) throw new Error('磁盘失败'); await original(path,bytes); };
    await expect(library.sync(batch)).rejects.toThrow('磁盘失败'); expect((await library.checkpoint()).cursor).toBe(0); expect(await library.list()).toHaveLength(1);
    await library.sync(batch); expect((await library.checkpoint()).cursor).toBe(2); expect(await library.list()).toHaveLength(2);
    await library.sync({instance:'server-2',cursor:1,items:[material()]}); expect(await library.checkpoint()).toEqual({instance:'server-2',cursor:1}); expect(await library.list()).toHaveLength(2);
  });
  it('整个批次先校验，不因后半批次无效而写入前半批次', async () => {
    const files=new MemoryFiles(); const library=new ReadingLibrary(files,'09_信息源');
    await expect(library.sync({instance:'server',cursor:2,items:[material(),{...material(),url:'file:///private'}]})).rejects.toThrow(); expect(files.data.size).toBe(0);
  });
  it('并发导入和状态更新按顺序保存，不丢失条目', async () => {
    const files=new MemoryFiles(); const library=new ReadingLibrary(files,'09_信息源');
    await Promise.all([library.import(material()),library.import(material()),library.import(material({identity:'https://example.org/b'}))]); expect(await library.list()).toHaveLength(2);
  });
  it('今日阅读按预算选择，不重复推荐旧版本，不强行补齐缺失板块', async () => {
    const library=new ReadingLibrary(new MemoryFiles(),'09_信息源'); await library.import(material()); await library.import(material({body:'最新版正文'}));
    await library.import(material({identity:'long',body:'长'.repeat(30_000)})); await library.import(material({identity:'second',body:'短正文'}));
    const selected=selectDaily(await library.list()); expect(selected).toHaveLength(2); expect(selected.map(item=>item.body)).toContain('最新版正文'); expect(selected.map(item=>item.body)).not.toContain(material().body);
  });
  it('目录越界和私人区域配置被拒绝', () => {
    for(const path of ['../elsewhere','C:/private','.obsidian','08_LLM Wiki/RAW','01_帆OS/Rocker · 摇杆','09_信息源/../x']) expect(()=>readingRoot(path)).toThrow();
    expect(readingRoot('09_信息源')).toBe('09_信息源');
  });
  it('RAW 交接准备留在阅读目录，状态不冒充正式登记', async () => {
    const files=new MemoryFiles(); const library=new ReadingLibrary(files,'09_信息源'); const item=await library.import(material());
    const path=await library.prepareRaw(item); expect(path).toContain('09_信息源/交接材料/'); expect(await files.read(path)).toContain('尚未登记 RAW'); expect([...files.data.keys()].every(key=>key.startsWith('09_信息源/'))).toBe(true);
  });
  it('移除伴读后仍保留旧问答索引与文件，新材料和今日清单不覆盖它们', async () => {
    const files = new MemoryFiles(); const library = new ReadingLibrary(files, '09_信息源'); const item = await library.import(material());
    const records = [{ role: 'user', content: '这个概念是什么意思？' }, { role: 'assistant', content: '原文第一段解释了适用条件。' }];
    const path = '09_信息源/陪读记录/旧记录.md'; const contents = '旧版讨论和用户批注';
    await files.write(path, contents);
    const state = JSON.parse((await files.read('09_信息源/_工作台/state.json'))!);
    state.dialogues = [{ id: item.id, version: item.version, model: 'legacy-model', records, path }];
    await files.write('09_信息源/_工作台/state.json', JSON.stringify(state));
    const upgraded = new ReadingLibrary(files, '09_信息源');
    expect((await upgraded.dialogue(item))?.records).toEqual(records);
    await upgraded.import(material({ identity: 'new-after-removal' })); await upgraded.saveDaily();
    const restarted = new ReadingLibrary(files, '09_信息源');
    expect((await restarted.dialogue(item))?.path).toBe(path); expect(await files.read(path)).toBe(contents);
    expect(await files.read(item.path)).not.toContain('这个概念是什么意思？');
  });
});
