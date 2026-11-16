import { describe, expect, it } from 'vitest';
import { ReadingLibrary, selectDaily } from '../src/core/library';
import { hash, materialSchema, materialVersion } from '../src/core/model';
import type { FileStore, Material } from '../src/core/model';
import { extractHtml } from '../src/server/extract';

class Files implements FileStore {
  data = new Map<string, Uint8Array>(); failStateOnce = false;
  async read(path:string){const bytes=this.data.get(path);return bytes?new TextDecoder().decode(bytes):null;}
  async readBinary(path:string){return this.data.get(path)??null;}
  async write(path:string,text:string,expected?:string|null){if(expected!==undefined&&await this.read(path)!==expected) throw new Error('文件已被修改');return this.writeBinary(path,new TextEncoder().encode(text));}
  async writeBinary(path:string,bytes:Uint8Array){if(path.endsWith('/state.json')&&this.failStateOnce){this.failStateOnce=false;throw new Error('模拟状态提交失败');}this.data.set(path,Uint8Array.from(bytes));}
  async remove(path:string){this.data.delete(path);}
}
const article = (overrides:Partial<Material>={}) => materialSchema.parse({title:'审查材料',source:'审查来源',url:'https://example.org/a',identity:'https://example.org/a',topic:'law',kind:'article',capturedAt:'2026-10-09T06:00:00.000Z',body:'这是一份真实的正文，包含明确概念与使用条件。',coverage:'partial',gaps:['仅提取文本'],guideKind:'none',original:{extension:'html',base64:Buffer.from('<article>原件</article>').toString('base64')},...overrides});
describe('对抗式保存与提取',()=>{
  it('状态提交失败后再次抓取仍能恢复已保存文件，不误认为用户修改',async()=>{
    const files=new Files();files.failStateOnce=true;const first=new ReadingLibrary(files,'09_信息源');
    await expect(first.import(article())).rejects.toThrow('模拟状态提交失败');
    const restart=new ReadingLibrary(files,'09_信息源');
    await expect(restart.import(article({capturedAt:'2026-10-09T06:01:00.000Z',original:{extension:'html',base64:Buffer.from('<article>原件<script>changedTracking()</script></article>').toString('base64')}}))).resolves.toMatchObject({title:'审查材料'});
    expect(await restart.list()).toHaveLength(1);
  });
  it('已登记原件被改动时重新导入会发现哈希不符',async()=>{
    const files=new Files();const library=new ReadingLibrary(files,'09_信息源');const item=await library.import(article());
    await files.write(item.originalPath!,'被改动的原件');await expect(library.import(article())).rejects.toThrow('原件已被修改');
  });
  it('路径校验失败不能让第二次读取绕过校验',async()=>{
    const files=new Files();const library=new ReadingLibrary(files,'09_信息源');await library.import(article());
    const state=JSON.parse((await files.read('09_信息源/_工作台/state.json'))!);state.items[0].path='其他目录/私有.md';await files.write('09_信息源/_工作台/state.json',JSON.stringify(state));
    const restart=new ReadingLibrary(files,'09_信息源');await expect(restart.list()).rejects.toThrow('越过');await expect(restart.list()).rejects.toThrow('越过');
  });
  it('发布时间被更正后不得静默复用旧版本',async()=>{
    expect(await materialVersion(article({publishedAt:'2026-10-08'}))).not.toBe(await materialVersion(article({publishedAt:'2026-10-09'})));
  });
  it('同步会保留手动批注，并继续接收同批次的下一篇材料',async()=>{
    const files=new Files();const library=new ReadingLibrary(files,'09_信息源');const item=await library.import(article());await files.write(item.path,'我的批注');
    await expect(library.sync({instance:'audit-server',cursor:2,items:[article(),article({identity:'https://example.org/b',url:'https://example.org/b',title:'第二篇'})]})).resolves.toBe(2);
    expect(await files.read(item.path)).toBe('我的批注');expect(await library.list()).toHaveLength(2);expect((await library.checkpoint()).cursor).toBe(2);
  });
  it('短内容中的转义引号和 Unicode 转义不会截断正文',()=>{
    const html=String.raw`<html><script>const record={nick_name:'作者',content_noencode:'这是一段足够长的短内容。It\'s valid.\x0a\x0a\u7b2c二段还有完整内容。'};</script></html>`;
    const item=extractHtml(html,{url:'https://mp.weixin.qq.com/s/short'});expect(item.body).toContain("It's valid.");expect(item.body).toContain('第二段还有完整内容。');
  });
  it('没有正文的页面不会把未知采集状态伪装为读完一篇正文',()=>{
    const item=extractHtml('<html><head><title>验证页面</title></head><body>完成验证后继续</body></html>',{url:'https://mp.weixin.qq.com/s/a'});expect(item.coverage).toBe('metadata');expect(item.body).toBe('');
  });
  it('今日清单写入成功而状态提交失败后可以恢复，不误报用户修改',async()=>{
    const files=new Files();const library=new ReadingLibrary(files,'09_信息源');await library.import(article());files.failStateOnce=true;
    await expect(library.saveDaily()).rejects.toThrow('模拟状态提交失败');
    const restart=new ReadingLibrary(files,'09_信息源');await expect(restart.saveDaily()).resolves.toBe('09_信息源/今日阅读.md');
    await files.write('09_信息源/今日阅读.md','我的手动清单');await expect(restart.saveDaily()).rejects.toThrow('已被修改');expect(await files.read('09_信息源/今日阅读.md')).toBe('我的手动清单');
  });
  it('恢复记录不允许覆盖用户在失败之后添加的批注',async()=>{
    const files=new Files();files.failStateOnce=true;const library=new ReadingLibrary(files,'09_信息源');await expect(library.import(article())).rejects.toThrow();
    const path=[...files.data.keys()].find(path=>path.includes('/阅读材料/'))!;await files.write(path,'失败后添加的批注');
    const restart=new ReadingLibrary(files,'09_信息源');await expect(restart.import(article({capturedAt:'2026-10-09T06:01:00.000Z'}))).rejects.toThrow('已被修改');expect(await files.read(path)).toBe('失败后添加的批注');
  });
  it('同步保留批注的同时仍拒绝已篡改的原件，不推进游标',async()=>{
    const files=new Files();const library=new ReadingLibrary(files,'09_信息源');const item=await library.import(article());await files.write(item.path,'批注');await files.write(item.originalPath!,'篡改');
    await expect(library.sync({instance:'s',cursor:1,items:[article()]})).rejects.toThrow('原件已被修改');expect((await library.checkpoint()).cursor).toBe(0);
  });
  it('旧版索引升级保留文件与进度，重复导入不会反复新增版本',async()=>{
    const files=new Files();const material=article({publishedAt:'2026-10-08'});const library=new ReadingLibrary(files,'09_信息源');const item=await library.import(material);await library.updateProgress(item.id,item.version,'reading','第一段');
    const state=JSON.parse((await files.read('09_信息源/_工作台/state.json'))!);state.items[0].version=await materialVersion(material,undefined,true);delete state.items[0].originalHash;delete state.conflicts;await files.write('09_信息源/_工作台/state.json',JSON.stringify(state));
    const restart=new ReadingLibrary(files,'09_信息源');for(let i=0;i<2;i++){const reused=await restart.import(material);expect(reused.path).toBe(item.path);expect(reused.position).toBe('第一段');}expect(await restart.list()).toHaveLength(1);
  });
  it('RAW 准备检查实际原件，缺失时不得声称交接准备完成',async()=>{
    const files=new Files();const library=new ReadingLibrary(files,'09_信息源');const item=await library.import(article());files.data.delete(item.originalPath!);
    await expect(library.prepareRaw(item)).rejects.toThrow('来源原件缺失');expect([...files.data.keys()].some(path=>path.includes('/交接材料/'))).toBe(false);
  });
  it('原件尚未写入就失败时，重新抓取有不同脚本仍恢复首份原件',async()=>{
    const files=new Files();const write=files.writeBinary.bind(files);let fail=true;files.writeBinary=async(path,bytes)=>{if(path.includes('/原件/')&&fail){fail=false;throw new Error('原件写入失败');}await write(path,bytes);};
    await expect(new ReadingLibrary(files,'09_信息源').import(article())).rejects.toThrow('原件写入失败');
    const recovered=await new ReadingLibrary(files,'09_信息源').import(article({original:{extension:'html',base64:Buffer.from('重新抓取时脚本变了').toString('base64')}}));
    expect(await files.read(recovered.originalPath!)).toBe('<article>原件</article>');expect([...files.data.keys()].some(path=>path.includes('/待提交/')&&path.endsWith('.json'))).toBe(false);
  });
  it('今日清单提交失败后材料发生改变，仍能恢复并生成新清单',async()=>{
    const files=new Files();const library=new ReadingLibrary(files,'09_信息源');await library.import(article());files.failStateOnce=true;await expect(library.saveDaily()).rejects.toThrow();
    const restarted=new ReadingLibrary(files,'09_信息源');await restarted.import(article({identity:'second',title:'新增材料'}));await expect(restarted.saveDaily()).resolves.toBe('09_信息源/今日阅读.md');expect(await files.read('09_信息源/今日阅读.md')).toContain('新增材料');
  });
  it('同名 Markdown 的整组旧版本迁移后只推荐最新正文，并保留旧路径与位置',async()=>{
    const files=new Files();const library=new ReadingLibrary(files,'09_信息源');
    for(const body of ['第一版','第二版']) await library.import(article({kind:'markdown',body,identity:`markdown:审查材料:${await hash(body)}`,original:{extension:'md',base64:Buffer.from(body).toString('base64')}}));
    const old=await library.list();await library.updateProgress(old[0]!.id,old[0]!.version,'reading','旧阅读位置');
    const latest=await library.import(article({kind:'markdown',body:'第三版',identity:'local:markdown:审查材料',original:{extension:'md',base64:Buffer.from('第三版').toString('base64')}}));
    const saved=await library.list();expect(saved).toHaveLength(3);expect(new Set(saved.map(item=>item.id)).size).toBe(1);expect(saved[0]!.path).toBe(old[0]!.path);expect(saved[0]!.position).toBe('旧阅读位置');expect(selectDaily(saved).map(item=>item.version)).toEqual([latest.version]);
  });
  it('旧手动 HTML 与文件名不同于提取标题的新版导入仍复用路径',async()=>{
    const files=new Files();const library=new ReadingLibrary(files,'09_信息源');const old=await library.import(article({url:undefined,identity:'html:审查材料:审查来源'}));
    const next=await new ReadingLibrary(files,'09_信息源').import(article({url:undefined,identity:'local:html:保存时的文件名'}));expect(next.path).toBe(old.path);expect(selectDaily(await library.list())).toHaveLength(1);
  });
  it('旧版 PDF 哈希索引能发现迁移前篡改，不能采信修改后的磁盘原件',async()=>{
    const files=new Files();const material=article({kind:'pdf',original:{extension:'pdf',base64:Buffer.from('PDF bytes').toString('base64')}});const library=new ReadingLibrary(files,'09_信息源');const item=await library.import(material);
    const state=JSON.parse((await files.read('09_信息源/_工作台/state.json'))!);delete state.items[0].originalHash;await files.write('09_信息源/_工作台/state.json',JSON.stringify(state));await files.write(item.originalPath!,'篡改后的 PDF');
    await expect(new ReadingLibrary(files,'09_信息源').import(material)).rejects.toThrow('原件已被修改');
  });
});
