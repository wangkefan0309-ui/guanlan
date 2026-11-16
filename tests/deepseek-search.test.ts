import { describe,it,expect } from 'vitest';
import { deepseekSearchRequest,parseDeepseekSearch } from '../src/core/deepseek-search';
import { enrichExploration } from '../src/server/exploration-evidence';
import { selectExploration,type ExplorationEntry } from '../src/core/exploration';
const response=(content:unknown[])=>JSON.stringify({content,stop_reason:'end_turn',usage:{input_tokens:120,output_tokens:30,server_tool_use:{web_search_requests:2}}});
const tool=(id:string,urls:string[])=>[{type:'server_tool_use',id,name:'web_search',input:{query:id}},{type:'web_search_tool_result',tool_use_id:id,content:urls.map((url,index)=>({type:'web_search_result',url,title:`节目${index}`,encrypted_content:'opaque',page_age:'2026-10-11'}))}];
describe('原生联网召回与证据',()=>{
  it('只安排开启的板块；跨天轮换分组，仍限制三次联网工具',()=>{
    const now=new Date('2026-10-11T10:00:00Z');const request=deepseekSearchRequest(['个人偏好'],'学习起点','model',now,['life','international']);
    expect(request.messages[0]!.content).toContain('开启板块：生活、国际热点');expect(request.messages[0]!.content).not.toContain('科技与AI');expect(request.tools[0]!.max_uses).toBe(3);
    const tomorrow=deepseekSearchRequest(['个人偏好'],'学习起点','model',new Date(now.getTime()+86400_000),['life','international']);expect(tomorrow.messages[0]!.content.split('第1次重点方向：')[1]!.split('；')[0]).not.toBe(request.messages[0]!.content.split('第1次重点方向：')[1]!.split('；')[0]);
  });
  it('网页证据限额跨实际查询轮换，第一组的九条不会占满六个名额',async()=>{
    const searched=await parseDeepseekSearch(response([...tool('finance',Array.from({length:9},(_,i)=>`https://example.org/finance/${i}`)),...tool('life',Array.from({length:9},(_,i)=>`https://example.org/life/${i}`)),...tool('technology',Array.from({length:6},(_,i)=>`https://example.org/technology/${i}`))]),['公开兴趣'],24);
    searched.candidates.sort((a,b)=>a.query.localeCompare(b.query));const requested:string[]=[];
    const result=await enrichExploration({candidates:searched.candidates},async url=>{requested.push(url);return `<html><body><article><p>${'可供评价的实际文字证据。'.repeat(50)}</p></article></body></html>`;});
    expect(requested).toHaveLength(6);for(const query of ['finance','life','technology'])expect(requested.filter(url=>url.includes(`/${query}/`))).toHaveLength(2);expect(result.snapshots).toHaveLength(6);expect(result.candidates.filter(item=>item.coverage==='page-excerpt')).toHaveLength(6);
  });
  it('只接受真实工具结果，回答链接不能造候选；已检索的回答链接可优先且不冒充正文',async()=>{
    const raw=response([...tool('first',Array.from({length:15},(_,i)=>`https://example.org/${i}`)),...tool('later',['https://example.net/episode']),{type:'text',text:'[内容](https://example.net/episode) [伪造](https://fake.example/evil)'}]);
    const result=await parseDeepseekSearch(raw,['投资 AI']);expect(result.candidates).toHaveLength(12);expect(result.candidates[0]!.url).toBe('https://example.net/episode');expect(result.candidates.every(c=>c.coverage==='metadata')).toBe(true);expect(JSON.stringify(result.candidates)).not.toContain('fake.example');expect(result.modelUsage?.searchRequests).toBe(2);expect(result.candidates[0]!.dateKind).toBe('unknown');
  });
  it('引用摘选必须属于工具结果；私网、URL凭证与伪引用不能成为证据',async()=>{
    const raw=response([...tool('q',['https://example.org/good','http://127.0.0.1/a','https://user:password@example.org/b']),{type:'text',citations:[{type:'web_search_result_location',url:'https://example.org/good',cited_text:'真实页面检索引用。'.repeat(10)},{type:'web_search_result_location',url:'https://fake.example/a',cited_text:'伪造'}]}]);
    const result=await parseDeepseekSearch(raw,['AI']);expect(result.candidates).toHaveLength(1);expect(result.candidates[0]!.coverage).toBe('search-excerpt');expect(result.candidates[0]!.excerpt).toContain('真实页面');
  });
  it('没有检索工具或结果未知不把模型口述当联网成功，请求限定三次搜索',async()=>{
    const result=await parseDeepseekSearch(response([{type:'text',text:'https://example.org/a'}]),['AI']);expect(result.candidates).toEqual([]);expect(result.warnings[0]).toContain('未取得');
    const request=deepseekSearchRequest(['投资 年轻人成长 AI'], '近期完整节目', 'model');expect(request.tools[0]!.max_uses).toBe(3);expect(request.messages[0]!.content).not.toMatch(/孙宇晨|邵艾伦/);
  });
  it('多个检索查询轮流召回，前一查询不占满候选',async()=>{const result=await parseDeepseekSearch(response([...tool('one',Array.from({length:20},(_,i)=>`https://example.org/${i}`)),...tool('two',['https://example.net/a'])]),['AI']);expect(result.candidates.some(c=>c.query==='two')).toBe(true);});
  it('原页包含的完整节目链接可跟随；预告、脚本伪造链接和伪域名不作为原片',async()=>{
    const searched=await parseDeepseekSearch(response(tool('q',['https://example.org/article'])),['成长 AI']);
    const result=await enrichExploration({candidates:searched.candidates},async()=>`<html><head><title>节目介绍</title><meta property="article:published_time" content="2026-10-10T12:00:00Z"></head><body><article><p>${'讨论AI时代的年轻人成长与投资学习。'.repeat(50)}</p><a href="https://www.youtube.com/watch?v=Abcdef12345">对话：年轻人成长完整播客</a><a href="https://www.bilibili.com/video/BV176pp69Eom">预告片</a><a href="https://youtube.com.evil.example/watch?v=Abcdef12345">完整节目</a><script>https://www.youtube.com/watch?v=Invented123</script></article></body></html>`);
    expect(result.candidates).toHaveLength(2);const original=result.candidates[0]!;expect(original.url).toBe('https://www.youtube.com/watch?v=Abcdef12345');expect(original.evidenceUrl).toBe('https://example.org/article');expect(original.excerpt).toContain('未取得原节目文字稿');expect(original.dateKind).toBe('unknown');expect(result.candidates[1]!.dateKind).toBe('published');expect(result.snapshots[0]!.json).toContain('完整播客');
  });
  it('页面失败或超出原件上限保留原覆盖，不伪造正文；成功证据均有原件',async()=>{
    const searched=await parseDeepseekSearch(response(tool('q',['https://example.org/huge','https://example.org/fail','https://example.org/ok'])),['AI']);
    const result=await enrichExploration({candidates:searched.candidates},async url=>{if(url.endsWith('/fail'))throw new Error('失败');if(url.endsWith('/huge'))return 'x'.repeat(1_800_001);return `<html><body><article><p>${'AI与成长的具体文章证据'.repeat(50)}</p></article></body></html>`;});
    expect(result.candidates.map(c=>c.coverage)).toEqual(['metadata','metadata','page-excerpt']);expect(result.warnings).toHaveLength(2);expect(result.snapshots).toHaveLength(1);
  });
  it('不合格或已收录的原片不会压掉合格的讨论；原片合格才优先',async()=>{
    const searched=await parseDeepseekSearch(response(tool('q',['https://example.org/original','https://example.org/recap'])),['AI']);const [original,recap]=searched.candidates;recap!.coverage='page-excerpt';recap!.excerpt='具体内容及依据。'.repeat(10);
    const entries:ExplorationEntry[]=searched.candidates.map((c,i)=>({id:c.id,score:i?90:75,label:'PASS',kind:'opinion',role:i?'recap':'original',reason:'相关',uncertainty:'介绍摘选',quoteIndex:0,event:'同一期播客'}));
    expect(selectExploration(entries,searched.candidates,new Set())).toEqual([recap!.id]);original!.coverage='page-excerpt';original!.excerpt=recap!.excerpt;
    expect(selectExploration(entries,searched.candidates,new Set())).toEqual([original!.id]);expect(selectExploration(entries,searched.candidates,new Set([original!.id]))).toEqual([recap!.id]);
  });
  it('已知一个月前内容和未来日期不当近期推荐；播客统计导航只作线索，未知日期不伪造',async()=>{
    const searched=await parseDeepseekSearch(response(tool('q',['https://example.org/old','https://example.org/future','https://podscan.fm/podcast/a','https://example.org/unknown'])),['AI']);for(const c of searched.candidates){c.coverage='page-excerpt';c.excerpt='原文内容及实际介绍证据。'.repeat(10);}searched.candidates[0]!.dateKind='published';searched.candidates[0]!.date='2026-09-09T10:00:00Z';searched.candidates[1]!.dateKind='published';searched.candidates[1]!.date='2026-10-12T10:00:00Z';
    const entries:ExplorationEntry[]=searched.candidates.map(c=>({id:c.id,score:80,label:'PASS',kind:'learning',reason:'相关',uncertainty:'摘选',quoteIndex:0,event:''}));expect(selectExploration(entries,searched.candidates,new Set(),'2026-10-11')).toEqual([searched.candidates[3]!.id]);
  });
});
