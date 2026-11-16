import { describe, it, expect } from 'vitest';
import { ExplorationLibrary, explorationMessages, parseExplorationEntries, selectExploration, type ExplorationOptions, type ExplorationSearchResult } from '../src/core/exploration';
import { hash, type FileStore } from '../src/core/model';
import { candidateUrl, searchExploration } from '../src/server/exploration-search';
import { settingsDefaults, restoreSettings, parseSettings } from '../src/core/settings';
import { discoveryTopicIds } from '../src/core/discovery-topics';
import { mergeExplorationSearch } from '../src/core/exploration-merge';

class Files implements FileStore {
  data = new Map<string,string>(); fail = '';
  async read(path: string) { return this.data.get(path) ?? null; }
  async write(path: string,contents: string,expected?: string | null) { if (this.fail && path.includes(this.fail)) throw new Error('保存失败'); if (expected !== undefined && await this.read(path) !== expected) throw new Error('文件已修改'); this.data.set(path,contents); }
  async readBinary() { return null; } async writeBinary() { throw new Error('unused'); }
}
const now = new Date('2026-10-11T02:00:00Z');
const options: ExplorationOptions = { provider: 'public', queries: ['AI agent'], goals: '学习AI应用', model: 'test', endpoint: 'https://example.org' };
async function search(): Promise<ExplorationSearchResult> {
  return { candidates: await Promise.all([1,2,3,4].map(async index => ({ id: await hash(`https://example.org/${index}`), title: `材料${index}`, url: `https://example.org/${index}`, source: '测试源', query: 'AI agent', excerpt: '原始检索证据及方法步骤。'.repeat(10), evidence: ['真实证据'], coverage: 'search-excerpt' as const, dateKind: 'unknown' as const }))), snapshots: [{ source: '测试源', query: 'AI agent', json: '{"original":true}' }], warnings: [], credits: 0 };
}
const answer = async (messages: { content: string }[]) => ({ content: JSON.stringify({ items: JSON.parse(messages.at(-1)!.content).candidates.map((candidate: { id: string }) => ({ id: candidate.id, label: 'PASS', score: 80, axes:{substance:8,novelty:8,evidence:8,relevance:8,utility:8},assessment:{basis:'content',substance:8,novelty:8,relevance:8,utility:8,support:'firsthand'},reason: '适合学习方法', uncertainty: '尚未阅读全文', quoteIndex: 0, kind: 'learning', event: '', section: 'technology' })) }), usage: { inputTokens: 100, outputTokens: 80 } });

describe('主动发现与持久化', () => {
  it('按日归档保留超过30项旧推荐，并区分失败、未确认和零入选回执',async()=>{
    const files=new Files();let current=new Date('2026-10-07T04:00:00Z');const library=new ExplorationLibrary(files,'09_信息源',()=>current);
    for(let day=7;day<=13;day++){
      current=new Date(`2026-10-${String(day).padStart(2,'0')}T04:00:00Z`);
      await library.run({...options,maxItems:6},async()=>({...await search(),candidates:await Promise.all(Array.from({length:6},async(_,i)=>({...(await search()).candidates[0]!,id:await hash(`https://example.org/day${day}/${i}`),url:`https://example.org/day${day}/${i}`})))}),answer);
    }
    expect(await library.recommendations()).toHaveLength(42);expect(await library.recommendations('2026-10-07')).toHaveLength(6);
    current=new Date('2026-10-14T04:00:00Z');await library.run(options,async()=>{throw Error('检索失败');},answer);
    current=new Date('2026-10-15T04:00:00Z');await library.run(options,async()=>({...await search(),candidates:[],warnings:['主要渠道未返回内容']}),answer);
    const archive=await library.archive();expect(archive.recommendations).toHaveLength(42);expect(archive.days.find(day=>day.date==='2026-10-14')).toMatchObject({status:'failed',count:0,error:'检索失败'});expect(archive.days.find(day=>day.date==='2026-10-15')).toMatchObject({status:'completed',count:0,warnings:['主要渠道未返回内容']});
  });
  it('始发模型格式包含必填板块；缺失时保存原回答和用量，同日修改提示不重发',async()=>{
    const files=new Files(),library=new ExplorationLibrary(files,'09_信息源',()=>now);let calls=0;
    const run=await library.run({...options,maxItems:6,sections:['technology']},search,async messages=>{
      calls++;const prompt=messages[0]!.content;const example=JSON.parse(prompt.slice(prompt.indexOf('{"items"'),prompt.indexOf(']}。')+2));
      expect(example.items[0].section).toBe('technology');expect(prompt).toContain('包括BLOCK和UNKNOWN，不可省略');
      const response=await answer(messages);const parsed=JSON.parse(response.content);parsed.items.forEach((item:Record<string,unknown>)=>{delete item.section;});return {...response,content:JSON.stringify(parsed)};
    });
    expect(run.status).toBe('failed');expect(run.error).toContain('缺少板块');expect(run.rawModel).toContain('items');expect(run.usage?.outputTokens).toBe(80);
    const restarted=new ExplorationLibrary(files,'09_信息源',()=>now);await restarted.run({...options,maxItems:6,sections:['life']},()=>{throw new Error('不应重搜');},async()=>{calls++;throw new Error('不应重发');});expect(calls).toBe(1);
    expect(explorationMessages(run)[0]!.content).toContain('section');
  });
  it('同事件转述不占用板块名额，选入该板块下一条独立达标内容',async()=>{
    const candidates=(await search()).candidates,entries=parseExplorationEntries((await answer([{content:JSON.stringify({candidates})}])).content,candidates);
    Object.assign(entries[0]!,{score:99,section:'technology',role:'recap',event:'节目A',kind:'news'});
    Object.assign(entries[1]!,{score:97,section:'business',role:'original',event:'节目A',kind:'news'});
    Object.assign(entries[2]!,{score:85,section:'technology',role:'original',event:'节目B',kind:'news'});
    Object.assign(entries[3]!,{score:90,section:'business',role:'original',event:'节目C',kind:'news'});
    expect(selectExploration(entries,candidates,new Set(),undefined,2,[...discoveryTopicIds])).toEqual([entries[1]!.id,entries[2]!.id]);
  });
  it('多板块先保证达标内容的不同主归属，不为填板块降低分数；关闭板块排除',async()=>{
    const candidates=(await search()).candidates;const entries=parseExplorationEntries((await answer([{content:JSON.stringify({candidates})}])).content,candidates,true,true);
    entries[0]!.score=99;entries[0]!.section='technology';entries[1]!.score=98;entries[1]!.section='technology';entries[2]!.score=85;entries[2]!.section='life';entries[3]!.score=80;entries[3]!.section='domestic';
    const selected=selectExploration(entries,candidates,new Set(),undefined,3,[...discoveryTopicIds]);expect(selected).toEqual([entries[0]!.id,entries[2]!.id,entries[3]!.id]);
    entries[2]!.score=59;expect(selectExploration(entries,candidates,new Set(),undefined,6,['technology','life'])).toEqual([entries[0]!.id,entries[1]!.id]);
    entries[0]!.section=undefined;expect(()=>parseExplorationEntries(JSON.stringify({items:entries}),candidates,true,true)).toThrow('缺少板块');
  });
  it('每日自定义上限与板块保存在始发回执，换配置复用原批；历史三项回执仍兼容',async()=>{
    const files=new Files(),library=new ExplorationLibrary(files,'09_信息源',()=>now);
    const run=await library.run({...options,maxItems:6,sections:['technology']},search,answer);expect(run.selected).toHaveLength(4);expect(run.maxItems).toBe(6);expect(run.sections).toEqual(['technology']);
    const repeated=await library.run({...options,maxItems:1,sections:['life']},()=>{throw new Error('不应再检索');},answer);expect(repeated.id).toBe(run.id);expect(repeated.selected).toHaveLength(4);
  });
  it('网页与X候选轮换合并，去重后保留两套实际回执与独立计费字段',async()=>{
    const original=await search();const web={...original,candidates:Array.from({length:24},(_,i)=>({...original.candidates[0]!,id:String(i).padStart(64,'0'),url:`https://example.org/web/${i}`}))};
    const x={...original,candidates:original.candidates.slice(0,2),credits:0,xUsage:{returnedPosts:60,chargedUsd:0.012,month:'2026-10',monthlyLimitUsd:0.5,monthlyAccountedUsd:0.012,reservedUsd:0,paused:false,cached:false}};
    const merged=mergeExplorationSearch(web,x);expect(merged.candidates).toHaveLength(24);expect(merged.candidates[1]!.id).toBe(x.candidates[0]!.id);expect(merged.xUsage?.returnedPosts).toBe(60);expect(merged.snapshots).toHaveLength(2);
  });
  it('AIHOT式材料不足保留UNKNOWN，明确机械缺口先过滤；无正文批次不花筛选调用',async()=>{
    const files=new Files(),library=new ExplorationLibrary(files,'09_信息源',()=>now);const results=await search();results.candidates.forEach(c=>{c.coverage='metadata';});let calls=0;
    const run=await library.run(options,async()=>results,async messages=>{calls++;return answer(messages);});expect(calls).toBe(0);expect(run.status).toBe('completed');expect(run.entries).toHaveLength(4);expect(run.entries.every(entry=>entry.label==='UNKNOWN')).toBe(true);expect(run.search!.candidates).toHaveLength(4);expect(run.rawModel).toBeUndefined();expect(run.selected).toEqual([]);
  });
  it('先预筛再只给有效候选评分，原件和每项判断均保留',async()=>{
    const results=await search();results.candidates[0]!.coverage='metadata';results.candidates[1]!.dateKind='published';results.candidates[1]!.date='2026-09-01';let assessed=0;
    const run=await new ExplorationLibrary(new Files(),'09_信息源',()=>now).run(options,async()=>results,async messages=>{assessed=JSON.parse(messages.at(-1)!.content).candidates.length;return answer(messages);});expect(assessed).toBe(2);expect(run.entries).toHaveLength(4);expect(run.entries.find(e=>e.id===results.candidates[0]!.id)?.label).toBe('UNKNOWN');expect(run.entries.find(e=>e.id===results.candidates[1]!.id)?.label).toBe('BLOCK');expect(run.selected).toHaveLength(2);
  });
  it('按AIHOT五轴思想适配个人兴趣与内容类型，程序计算分数；越界轴被拒绝',async()=>{
    const candidate=(await search()).candidates[0]!;const axes={substance:5,novelty:8,evidence:6,relevance:9,utility:7};const base={id:candidate.id,score:99,axes,label:'PASS',reason:'方法与当前兴趣有关',uncertainty:'仅摘选',quoteIndex:0,event:''};
    expect(parseExplorationEntries(JSON.stringify({items:[{...base,kind:'news'}]}),[candidate])[0]!.score).toBe(72);expect(parseExplorationEntries(JSON.stringify({items:[{...base,kind:'opinion'}]}),[candidate])[0]!.score).toBe(75);expect(()=>parseExplorationEntries(JSON.stringify({items:[{...base,kind:'tool',axes:{...axes,evidence:11}}]}),[candidate])).toThrow();expect(()=>parseExplorationEntries(JSON.stringify({items:[{...base,kind:'news',axes:undefined}]}),[candidate],true)).toThrow('缺少五轴');
  });
  it('模型运行中可读取已有推荐和始发状态，浏览工作台不等待API',async()=>{
    const library=new ExplorationLibrary(new Files(),'09_信息源',()=>now);let entered!:()=>void;let release!:()=>void;
    const starting=new Promise<void>(done=>{entered=done;});const gate=new Promise<void>(done=>{release=done;});
    const running=library.run(options,search,async messages=>{entered();await gate;return answer(messages);});
    await starting;expect((await library.runs())[0]!.status).toBe('started');expect(await library.recommendations()).toEqual([]);release();await running;
  });
  it('同日并发和重启复用一次检索一次AI，最多三项，原响应独立保存无Key', async () => {
    const files = new Files(); const library = new ExplorationLibrary(files,'09_信息源',()=>now); let searches=0,models=0;
    const request = () => library.run(options,async()=>{searches++;return search();},async messages=>{models++;return answer(messages);});
    const runs = await Promise.all([request(),request()]); expect(searches).toBe(1);expect(models).toBe(1);expect(runs[0]!.selected).toHaveLength(3);
    expect(await library.recommendations()).toHaveLength(3);
    await new ExplorationLibrary(files,'09_信息源',()=>now).run(options,()=>{throw new Error('不应检索');},()=>{throw new Error('不应调用');});
    const state = JSON.parse((await files.read('09_信息源/_工作台/探索/state.json'))!);expect(state.runs[0].rawModel).toBeUndefined(); expect(state.runs[0].search.snapshots).toEqual([]);
    expect(await files.read(`09_信息源/_工作台/探索/${runs[0]!.id}.json`)).toContain('original');
  });
  it('调用开始前回执保存失败，不发送任何外部请求',async()=>{const files=new Files();files.fail='state.json';const library=new ExplorationLibrary(files,'09_信息源',()=>now);let calls=0;await expect(library.run(options,async()=>{calls++;return search();},answer)).rejects.toThrow('保存失败');expect(calls).toBe(0);});
  it('笔记写入失败只补保存，首次模型与目标不变；重启从响应日志恢复',async()=>{
    const files=new Files();files.fail='探索推荐/';const library=new ExplorationLibrary(files,'09_信息源',()=>now);let models=0;
    await expect(library.run(options,search,async messages=>{models++;return answer(messages);})).rejects.toThrow('保存失败');expect(library.pendingSave).toBe(true);
    files.fail='';const restarted=new ExplorationLibrary(files,'09_信息源',()=>now);
    const run=await restarted.run({...options,model:'changed',goals:'changed'},()=>{throw new Error('不应重搜');},()=>{throw new Error('不应调用');});
    expect(run.model).toBe('test');expect(models).toBe(1);expect(await restarted.recommendations()).toHaveLength(3);
  });
  it('超时或无效模型输出保留实际用量和原响应，同日不重发',async()=>{
    const files=new Files();const library=new ExplorationLibrary(files,'09_信息源',()=>now);let models=0;
    const run=await library.run(options,search,async()=>{models++;return {content:'{"items":[]}',usage:{inputTokens:5,outputTokens:2}};});
    expect(run.status).toBe('failed');expect(run.rawModel).toContain('items');expect(run.usage?.inputTokens).toBe(5);
    await library.run(options,search,async()=>{models++;throw new Error('超时未知');});expect(models).toBe(1);
    const other=new ExplorationLibrary(new Files(),'09_信息源',()=>now);expect((await other.run(options,search,async()=>{throw new Error('超时未知');})).status).toBe('failed');
    expect((await other.run(options,()=>{throw new Error('不应重搜');},answer)).status).toBe('failed');
  });
  it('排除已收录和拒绝的链接；跨天已推荐的内容30天内不再推',async()=>{
    const files=new Files();let date=now;const library=new ExplorationLibrary(files,'09_信息源',()=>date);
    const run=await library.run(options,search,answer,['https://example.org/1']);expect(run.selected).not.toContain(await hash('https://example.org/1'));
    await library.dismiss(run.selected[0]!);expect(await library.recommendations()).toHaveLength(2);
    date=new Date(now.getTime()+86400_000);const next=await library.run(options,search,answer,['https://example.org/1']);expect(next.selected).toHaveLength(0);
  });
  it('只有同一具体新闻事件合并；教程和观点不会按关键词归并，伪造引用被拒绝',async()=>{
    const candidates=(await search()).candidates;const entries=parseExplorationEntries((await answer([{content:JSON.stringify({candidates})}])).content,candidates);
    entries[0]!.kind='news';entries[0]!.event='same';entries[1]!.kind='news';entries[1]!.event='same';entries[2]!.event='same';entries[3]!.event='same';
    const selected=selectExploration(entries,candidates,new Set());expect(selected).toHaveLength(3);expect(selected.filter(id=>[entries[0]!.id,entries[1]!.id].includes(id))).toHaveLength(1);
    entries[0]!.quoteIndex=3;expect(()=>parseExplorationEntries(JSON.stringify({items:entries}),candidates)).toThrow('证据');
  });
  it('用户修改笔记时保留内容；目标库各自隔离',async()=>{
    const files=new Files();const library=new ExplorationLibrary(files,'09_信息源',()=>now);const run=await library.run(options,search,answer);
    files.data.set(run.path!,'用户批注');await expect(library.run(options,search,answer)).rejects.toThrow('已修改');expect(await files.read(run.path!)).toBe('用户批注');expect(library.pendingSave).toBe(false);
    const another=new ExplorationLibrary(files,'09_另一库',()=>now);const next=await another.run(options,search,answer);expect(next.path).toContain('09_另一库/');expect(await files.read(run.path!)).toBe('用户批注');
  });
  it('首次结果尚未提交时笔记冲突继续保留待保存结果，不重发请求',async()=>{
    const files=new Files();files.fail='探索推荐/';const library=new ExplorationLibrary(files,'09_信息源',()=>now);
    await expect(library.run(options,search,answer)).rejects.toThrow('保存失败');files.fail='';
    const statePath='09_信息源/_工作台/探索/state.json',before=(await files.read(statePath))!,run=JSON.parse(before).runs[0];
    const path=`09_信息源/探索推荐/${run.date}-${run.id}.md`;files.data.set(path,'用户内容');
    await expect(library.run(options,()=>{throw Error('不应重搜');},()=>{throw Error('不应调用');})).rejects.toThrow('已修改');
    expect(library.pendingSave).toBe(true);expect(await files.read(path)).toBe('用户内容');expect(await files.read(statePath)).toBe(before);
  });
  it('已完成索引与首次回执不一致时，笔记冲突不能清除待保存保护',async()=>{
    const files=new Files(),library=new ExplorationLibrary(files,'09_信息源',()=>now),run=await library.run(options,search,answer);
    const statePath='09_信息源/_工作台/探索/state.json',state=JSON.parse((await files.read(statePath))!);state.runs[0].selected=[];files.data.set(statePath,JSON.stringify(state));files.data.set(run.path!,'用户内容');
    await expect(library.run(options,()=>{throw Error('不应重搜');},()=>{throw Error('不应调用');})).rejects.toThrow('已修改');
    expect(library.pendingSave).toBe(true);expect(await files.read(run.path!)).toBe('用户内容');expect(JSON.parse((await files.read(statePath))!).runs[0].selected).toEqual([]);
  });
});
describe('检索接口',()=>{
  it('免费公开检索独立失败可降级，限候选，保留真实日期含义',async()=>{
    const result=await searchExploration({provider:'public',queries:['AI agent']},async url=>{
      if(url.hostname==='hn.algolia.com')throw new Error('暂时失败');
      return JSON.stringify({items:[{full_name:'org/repo',html_url:'https://github.com/org/repo',description:'A practical tutorial for using AI agents with examples and limitations.',stargazers_count:200,pushed_at:now.toISOString(),archived:false,fork:false}]});
    },now);
    expect(result.candidates).toHaveLength(1);expect(result.candidates[0]!.dateKind).toBe('updated');expect(result.warnings).toHaveLength(1);expect(result.credits).toBe(0);
  });
  it('Tavily只basic且禁用自动升级，搜索Key不出现在响应、快照；拒绝私网和伪URL',async()=>{
    let body='';let auth='';const result=await searchExploration({provider:'tavily',queries:['AI工具'],key:'test-secret'},async(_url,input,key)=>{body=input!;auth=key!;return JSON.stringify({results:[{title:'教程',url:'https://example.org/article',content:'真实检索摘要'},{title:'私网',url:'http://127.0.0.1/private',content:'private'}],usage:{credits:1}});});
    expect(JSON.parse(body)).toMatchObject({search_depth:'basic',auto_parameters:false});expect(auth).toBe('test-secret');expect(JSON.stringify(result)).not.toContain('test-secret');expect(result.candidates).toHaveLength(1);
    for(const url of ['javascript:alert(1)','http://10.0.0.1/a','http://[::1]/a','https://localhost/a','https://example.org:1234/a'])expect(candidateUrl(url)).toBeNull();
    await expect(searchExploration({provider:'tavily',queries:['topic']})).rejects.toThrow('Key未配置');
  });
  it('旧配置默认关闭收费探索，关键词校验与渠道配置可持久化',()=>{expect(restoreSettings({guideKey:'keep'}).settings.autoExplore).toBe(false);expect(parseSettings({...settingsDefaults,searchProvider:'tavily',searchKey:' secret '}).searchKey).toBe('secret');expect(()=>parseSettings({...settingsDefaults,searchQueries:'a\nb\nc'})).toThrow('关键词');});
});
