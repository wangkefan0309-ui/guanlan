import { it, expect } from 'vitest';
import { xContent } from '../src/server/x-content';
import { tweetCandidates } from '../src/server/socialdata';

it('附件只归属于本条原件，不串用引用帖；时长和外链只接受接口实际字段与安全URL', () => {
  const raw = { data: [
    { rest_id:'1', legacy:{ entities:{ urls:[{expanded_url:'http://127.0.0.1/private'},{expanded_url:'javascript:alert(1)'},{expanded_url:'https://youtube.com/watch?v=real'}] }, extended_entities:{ media:[{type:'video',video_info:{duration_millis:-1}},{type:'video',video_info:{duration_millis:Infinity}}] } } },
    { rest_id:'2', legacy:{ extended_entities:{ media:[{type:'video',video_info:{duration_millis:15749336}}] } } },
  ] };
  const result = xContent(raw,'1',{});
  expect(result.media).toEqual({kind:'video',durationSeconds:undefined}); expect(result.links).toEqual([{url:'https://youtube.com/watch?v=real',label:'帖子中的视频链接',kind:'video'}]);
  expect(xContent(raw,'999',{}).media).toBeUndefined(); expect(xContent(raw,'2',{}).media?.durationSeconds).toBe(15749);
});

it('原始长文链接与附件证据可补足短视频正文，不以时长代替原文或编造文字稿', async () => {
  const raw={rest_id:'10000',legacy:{extended_entities:{media:[{type:'video',video_info:{duration_millis:120000}}]}},note_tweet:{note_tweet_results:{result:{entity_set:{urls:[{expanded_url:'https://example.org/original'}]}}}}};
  const candidates=await tweetCandidates(JSON.stringify({tweets:[{id_str:'10000',full_text:'对话：年轻人成长与人工智能应用。',user:{screen_name:'author'}}],raw}),'AI','2026-10-12T02:00:00Z');
  expect(candidates[0]?.coverage).toBe('search-excerpt'); expect(candidates[0]?.excerpt).toContain('尚未观看或取得视频文字稿'); expect(candidates[0]?.evidence).toHaveLength(2);
  expect(candidates[0]?.contentLinks?.[0]?.url).toBe('https://example.org/original'); expect(candidates[0]?.engagement).toBeUndefined();
});

it('大数组原件有界遍历，不因展开参数溢出而中断已保存批次', () => {
  const raw={unused:Array(150000).fill(false),real:{rest_id:'1',legacy:{extended_entities:{media:[{type:'video',video_info:{duration_millis:60000}}]}}}};
  expect(xContent(raw,'1',{}).media?.durationSeconds).toBe(60);
});
