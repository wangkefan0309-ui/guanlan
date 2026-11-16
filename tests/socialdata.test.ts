import { describe, expect, it } from 'vitest';
import { SocialDataDiscovery, type SocialDataTransport } from '../src/server/socialdata';
import { discoveryTopicIds, socialDataQueries } from '../src/core/discovery-topics';
import type { FileStore } from '../src/core/model';

class Files implements FileStore {
  data = new Map<string,string>(); fail = '';
  async read(path: string) { return this.data.get(path) ?? null; }
  async write(path: string,contents: string,expected?: string | null) { if(this.fail&&path.includes(this.fail))throw new Error('保存失败'); if(expected!==undefined&&await this.read(path)!==expected)throw new Error('文件已修改');this.data.set(path,contents); }
  async readBinary() { return null; } async writeBinary() { throw new Error('unused'); }
}
const start = new Date('2026-10-11T02:00:00Z');
const input = { key: 'test-key-do-not-archive', topics: [...discoveryTopicIds] };
const tweets = (count:number,offset=0) => JSON.stringify({ tweets: Array.from({length:count},(_,i)=>({id_str:String(10000+offset+i),full_text:'这一条是实际帖子正文的模拟内容，用于验证原始文字、热门观测数据与可核对计费数量。',tweet_created_at:start.toISOString(),user:{screen_name:'example_author'},favorite_count:20+i,retweet_count:2,reply_count:1,views_count:1000})) });
describe('X费用、回执和恢复',()=>{
  it('缺失或null互动数据不编造为零，实际正文和返回计费仍保留',async()=>{
    const tweet=JSON.parse(tweets(1)).tweets[0];delete tweet.favorite_count;tweet.reply_count=null;tweet.views_count=null;tweet.tweet_created_at=null;
    const result=await new SocialDataDiscovery(new Files(),async()=>({status:200,text:JSON.stringify({tweets:[tweet]})}),()=>start).search(input);
    expect(result.candidates).toHaveLength(1);expect(result.candidates[0]!.engagement).toBeUndefined();expect(result.candidates[0]!.dateKind).toBe('unknown');expect(result.xUsage?.returnedPosts).toBe(3);expect(result.xUsage?.chargedUsd).toBe(0.0006);
  });
  it('覆盖八板块的OR检索只生成三页，缺Key时零请求',async()=>{
    const queries=socialDataQueries([...discoveryTopicIds],start);expect(queries).toHaveLength(3);expect(queries.every(q=>q.length<=512&&q.includes(' OR ')&&q.includes('since_time:'))).toBe(true);expect(queries.join(' ')).toMatch(/lifestyle/);expect(queries.join(' ')).toMatch(/business/);
    let calls=0;const api=new SocialDataDiscovery(new Files(),async()=>{calls++;return {status:200,text:tweets(1)};},()=>start);
    await expect(api.search({...input,key:''})).rejects.toThrow();expect(calls).toBe(0);
  });
  it('返回数量先全额计费，候选限额和重复帖不会减去账单；同日并发、换Key和重启复用',async()=>{
    const files=new Files();let calls=0;const transport:SocialDataTransport=async(query,key)=>{expect(query).not.toContain('cursor');expect(key).toBe(input.key);calls++;return {status:200,text:tweets(20)};};
    const api=new SocialDataDiscovery(files,transport,()=>start);
    const [first,second]=await Promise.all([api.search(input),api.search({...input,key:'another-key',topics:['life']})]);
    expect(calls).toBe(3);expect(first.candidates).toHaveLength(9);expect(first.xUsage).toMatchObject({returnedPosts:60,chargedUsd:0.012,cached:false});expect(second.xUsage?.cached).toBe(true);expect(first.candidates[0]!.engagement).toMatchObject({likes:39,reposts:2,observedAt:start.toISOString()});
    const reboot=new SocialDataDiscovery(files,()=>{throw new Error('禁止重新请求');},()=>start);expect((await reboot.search(input)).xUsage?.cached).toBe(true);
    expect(JSON.stringify([...files.data.values()])).not.toContain(input.key);expect(JSON.stringify(first)).not.toContain(input.key);expect(first.snapshots).toHaveLength(3);
  });
  it('含不合格条目与重复条目仍按所有返回条目计费，不伪造可读内容',async()=>{
    const result=await new SocialDataDiscovery(new Files(),async()=>({status:200,text:JSON.stringify({tweets:[JSON.parse(tweets(1)).tweets[0],JSON.parse(tweets(1)).tweets[0],{bad:true}]})}),()=>start).search(input);
    expect(result.candidates).toHaveLength(1);expect(result.xUsage?.returnedPosts).toBe(9);expect(result.xUsage?.chargedUsd).toBe(0.0018);
  });
  it('跨天用量共用月预算，余量不足以预留则不请求，跨月恢复额度',async()=>{
    let now=start,calls=0;const files=new Files();const api=new SocialDataDiscovery(files,async()=>{calls++;return {status:200,text:tweets(200)};},()=>now);
    for(let i=0;i<4;i++){now=new Date(start.getTime()+i*86400_000);await api.search(input);}
    expect(calls).toBe(11);expect(await api.status()).toMatchObject({spentUsd:0.44,paused:true});
    now=new Date('2026-11-01T02:00:00Z');await api.search(input);expect(calls).toBe(14);expect((await api.status()).spentUsd).toBe(0.12);
  });
  it('请求未知保留预留，重启及后续日期都不自动付费重试',async()=>{
    const files=new Files();let calls=0,now=start;const transport:SocialDataTransport=async()=>{calls++;throw new Error('请求可能已成功但响应丢失');};
    await new SocialDataDiscovery(files,transport,()=>now).search(input);expect(calls).toBe(1);
    const reboot=new SocialDataDiscovery(files,transport,()=>now);expect(await reboot.status()).toMatchObject({spentUsd:0,reservedUsd:0.1,paused:true});
    now=new Date(start.getTime()+86400_000);await reboot.search(input);expect(calls).toBe(1);expect((await reboot.status()).requestsToday).toBe(0);
  });
  it('HTTP拒绝不记成功收费，不保存提供方错误体，仍不在同日重发',async()=>{
    const files=new Files();let calls=0;const api=new SocialDataDiscovery(files,async()=>{calls++;return {status:402,text:`secret ${input.key}`};},()=>start);
    const result=await api.search(input);await api.search(input);expect(calls).toBe(1);expect(result.warnings.join(' ')).toContain('402');expect((await api.status()).spentUsd).toBe(0);expect((await api.status()).reservedUsd).toBe(0);expect(JSON.stringify([...files.data.values()])).not.toContain(input.key);
  });
  it('成功HTTP但坏JSON或缺返回数组视为未知并暂停；提供方回显Key不入档',async()=>{
    for(const text of ['not-json','{}',JSON.stringify({tweets:[],echo:input.key})]){const files=new Files();let calls=0;const api=new SocialDataDiscovery(files,async()=>{calls++;return {status:200,text};},()=>start);await api.search(input);expect(await api.status()).toMatchObject({reservedUsd:0.1,paused:true});await api.search(input);expect(calls).toBe(1);expect(JSON.stringify([...files.data.values()])).not.toContain(input.key);}
  });
  it('始发回执保存失败不调用；收到结果后原件保存失败只补保存，不发下一页',async()=>{
    const firstFiles=new Files();firstFiles.fail='state.json';let calls=0;const transport:SocialDataTransport=async()=>{calls++;return {status:200,text:tweets(20)};};
    await expect(new SocialDataDiscovery(firstFiles,transport,()=>start).search(input)).rejects.toThrow('保存失败');expect(calls).toBe(0);
    const files=new Files();files.fail='receipts/';const api=new SocialDataDiscovery(files,transport,()=>start);
    await expect(api.search(input)).rejects.toThrow('保存失败');expect(calls).toBe(1);
    expect(await new SocialDataDiscovery(files,transport,()=>start).status()).toMatchObject({reservedUsd:0.1,paused:true});
    files.fail='';const restored=await api.search({...input,key:'changed-key'});expect(calls).toBe(1);expect(restored.candidates).toHaveLength(9);expect(restored.xUsage?.returnedPosts).toBe(20);expect((await api.status()).spentUsd).toBe(0.004);
  });
  it('原件被改动或删除停止复用，不覆盖且不再发请求',async()=>{
    const files=new Files();let calls=0;const api=new SocialDataDiscovery(files,async()=>{calls++;return {status:200,text:tweets(2)};},()=>start);await api.search(input);
    const path=[...files.data.keys()].find(path=>path.includes('receipts/'))!;files.data.set(path,'用户改动');await expect(api.search(input)).rejects.toThrow('校验失败');expect(calls).toBe(3);expect(files.data.get(path)).toBe('用户改动');
  });
  it('意外超量记录实际返回数并暂停，不能把裁剪后的候选数量当账单',async()=>{
    let calls=0;const api=new SocialDataDiscovery(new Files(),async()=>{calls++;return {status:200,text:tweets(600)};},()=>start);const result=await api.search(input);expect(calls).toBe(1);expect(result.xUsage?.returnedPosts).toBe(600);expect(result.xUsage?.chargedUsd).toBe(0.12);expect((await api.status()).paused).toBe(true);expect(result.candidates).toHaveLength(9);
  });
});
