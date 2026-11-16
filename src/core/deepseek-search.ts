import { z } from 'zod';
import { hash, canonicalIdentity, webUrl } from './model';
import { beijingDate } from './daily';
import { searchResultSchema, type ExplorationCandidate, type ExplorationSearchResult } from './exploration';
import { discoveryTopicIds, discoveryTopicsSchema, topicName, type DiscoveryTopic } from './discovery-topics';

export function deepseekSearchRequest(queries: string[], goals: string, model: string, now=new Date(), topics:DiscoveryTopic[]=[...discoveryTopicIds]) {
  const enabled=discoveryTopicsSchema.parse(topics);
  const offset=Math.floor(Date.parse(`${beijingDate(now)}T00:00:00Z`)/86_400_000)%enabled.length;
  const ordered=[...enabled.slice(offset),...enabled.slice(0,offset)];
  const groups=Array.from({length:Math.min(3,enabled.length)},()=>[] as DiscoveryTopic[]);
  ordered.forEach((topic,index)=>groups[index%groups.length]!.push(topic));
  const directions=groups.map((group,index)=>`第${index+1}次重点方向：${group.map(topicName).join('、')}`).join('；');
  return {
    model, max_tokens: 7000, stream: false,
    tools: [{type:'web_search_20250305',name:'web_search',max_uses:3}],
    system: '你是个人信息发现助手。必须使用web_search取得真实网页，不能凭记忆列链接。关注近期具体文章、长视频和播客，优先原作者发布的完整作品；同时寻找讨论该作品的独立线索。按用户兴趣召回而非泛泛的词语定义或工具导航。保留真实URL，用API引用标注搜到的证据。最多三次搜索，搜索不足时如实说明。不要进行投资建议或把流量等同质量。',
    messages: [{role:'user',content:`今天是${beijingDate(now)}。兴趣与起点：${goals}。补充方向：${queries.join('；')}。开启板块：${enabled.map(topicName).join('、')}。请搜索近7天值得关注的具体内容。每条关联任一开启板块即可，不要把这些词串成必须全部命中的检索条件。本日检索安排：${directions}。这些是分组覆盖方向，每组可用OR或宽主题改写成可检索的词，不能将组内各词当必须同时出现；优先较少覆盖的方向。中文优先，兼顾国内文章、B站、YouTube、播客和可公开检索的讨论。你可以改写检索词，不要求用户先指定作者或节目名。给出最多二十四个候选，用检索引用说明内容与相关讨论；找不到原始完整节目则标注，不以剪辑或转载冒充原片。不要只给GitHub项目。`}],
  };
}
const responseSchema=z.object({
  content:z.array(z.object({type:z.string()}).passthrough()).max(200),
  usage:z.object({input_tokens:z.number().int().nonnegative(),output_tokens:z.number().int().nonnegative(),server_tool_use:z.object({web_search_requests:z.number().int().nonnegative()}).optional()}).passthrough().optional(),
  stop_reason:z.string().optional(),
}).passthrough();
function safeUrl(value: string): string | null {
  try{const url=new URL(webUrl.parse(value));if(!/[a-z]/i.test(url.hostname)||!url.hostname.includes('.')||url.hostname.endsWith('.local')||url.hostname.endsWith('.internal')||(url.port&&!['80','443'].includes(url.port)))return null;return canonicalIdentity(url.toString());}catch{return null;}
}
/** Only server tool result URLs become candidates. Plain answer URLs are never
 * accepted as retrieval proof; cited_text remains an explicitly sampled excerpt. */
export async function parseDeepseekSearch(raw: string, queries: string[], maximum=12): Promise<ExplorationSearchResult> {
  z.number().int().min(1).max(24).parse(maximum);
  const response=responseSchema.parse(JSON.parse(raw));const sources=new Map<string,{title:string;query:string;snippets:string[]}>();const toolQueries=new Map<string,string>();
  let toolCalls=0;const warnings:string[]=[];
  for(const block of response.content){if(block.type==='server_tool_use'&&block.name==='web_search'&&typeof block.id==='string'){
    toolCalls++;const input=block.input as {query?:unknown}|undefined;toolQueries.set(block.id,typeof input?.query==='string'?input.query.slice(0,240):queries.join('；').slice(0,240));
  }}
  for(const block of response.content){if(block.type!=='web_search_tool_result')continue;
    if(!Array.isArray(block.content)){warnings.push('一次联网检索未返回可用结果，保留原回执');continue;}
    for(const item of block.content){if(item?.type!=='web_search_result'||typeof item.url!=='string'||typeof item.title!=='string')continue;
      const url=safeUrl(item.url);if(!url)continue;
      const current:{title:string;query:string;snippets:string[]}=sources.get(url)??{title:item.title.slice(0,240),query:toolQueries.get(String(block.tool_use_id))??queries.join('；').slice(0,240),snippets:[]};
      const snippet=[item.snippet,item.description].find(value=>typeof value==='string');if(typeof snippet==='string')current.snippets.push(snippet.slice(0,2400));sources.set(url,current);
    }
  }
  for(const block of response.content){if(block.type!=='text'||!Array.isArray(block.citations))continue;
    for(const citation of block.citations){if(citation?.type!=='web_search_result_location'||typeof citation.url!=='string'||typeof citation.cited_text!=='string')continue;
      const url=safeUrl(citation.url);const source=url&&sources.get(url);if(source&&citation.cited_text.trim()&&!source.snippets.includes(citation.cited_text))source.snippets.push(citation.cited_text.slice(0,2400));
    }
  }
  const candidates:ExplorationCandidate[]=[];
  // An answer link can prioritize a real tool result, but never supply evidence.
  // Some compatible APIs return encrypted results without text citations. Taking
  // only the first search page would lose the useful results from later searches.
  const mentioned=new Set<string>();
  for(const block of response.content)if(block.type==='text'&&typeof block.text==='string')for(const match of block.text.matchAll(/https?:\/\/[^\s)<>"\]]+/g)){const url=safeUrl(match[0]);if(url&&sources.has(url))mentioned.add(url);}
  const prioritized=[...mentioned].map(url=>[url,sources.get(url)!] as const);
  const groups=new Map<string,Array<readonly [string,{title:string;query:string;snippets:string[]}]>>();
  for(const pair of sources){if(mentioned.has(pair[0]))continue;const group=groups.get(pair[1].query)??[];group.push(pair);groups.set(pair[1].query,group);}
  while(prioritized.length<sources.size){let added=false;for(const group of groups.values()){const next=group.shift();if(next){prioritized.push(next);added=true;}}if(!added)break;}
  for(const [url,source]of prioritized.sort((a,b)=>Number(!!b[1].snippets.length)-Number(!!a[1].snippets.length))){
    if(!source.title.trim())continue;const excerpt=source.snippets.join('\n').slice(0,2400);
    candidates.push({id:await hash(url),title:source.title,url,source:new URL(url).hostname,excerpt:excerpt||source.title,evidence:(excerpt||source.title).match(/[\s\S]{1,600}/g)!.slice(0,4),coverage:excerpt?'search-excerpt':'metadata',query:source.query,dateKind:'unknown'});if(candidates.length===maximum)break;
  }
  if(!toolCalls||!sources.size)warnings.push('未取得可校验的联网工具结果，模型文字回答没有作为已搜到内容');
  if(response.stop_reason&&response.stop_reason!=='end_turn')warnings.push(`联网模型停止原因${response.stop_reason.slice(0,50)}，不自动续发请求`);
  if(candidates.some(item=>item.coverage==='metadata'))warnings.push('部分候选只有标题，证据不足时不推荐');
  return searchResultSchema.parse({candidates,warnings:warnings.slice(0,8),snapshots:[{source:'DeepSeek 原生联网回执',query:queries.join('；').slice(0,240),json:raw}],credits:0,...(response.usage?{modelUsage:{inputTokens:response.usage.input_tokens,outputTokens:response.usage.output_tokens,searchRequests:response.usage.server_tool_use?.web_search_requests??toolCalls}}:{})});
}
