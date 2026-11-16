import { z } from 'zod';
import { parseHTML } from 'linkedom';
import { hash } from '../core/model';
import { candidateSchema, searchResultSchema, type ExplorationCandidate, type ExplorationSearchResult } from '../core/exploration';
import { candidateUrl } from './exploration-search';
import { fetchPublicHtml } from './public-fetch';
import { extractHtml } from './extract';

export const evidenceRequestSchema=z.object({candidates:z.array(candidateSchema).max(24)}).strict();
const videoUrl=(value:string)=>{const safe=candidateUrl(value);if(!safe)return null;const url=new URL(safe);if((['www.youtube.com','youtube.com','m.youtube.com'].includes(url.hostname)&&url.pathname==='/watch'&&/^[\w-]{11}$/.test(url.searchParams.get('v')??''))||(url.hostname==='youtu.be'&&/^\/[\w-]{11}$/.test(url.pathname))||(['www.bilibili.com','bilibili.com'].includes(url.hostname)&&/^\/video\/BV[\w]{10}\/?$/.test(url.pathname)))return safe;return null;};
const isX=(url:string)=>['x.com','www.x.com','twitter.com','www.twitter.com'].includes(new URL(url).hostname);
/** Read public evidence only. No model credentials, paid search or material writes. */
export async function enrichExploration(input:unknown,readPage=(url:string)=>fetchPublicHtml(url,0,AbortSignal.timeout(12_000),false,true)):Promise<ExplorationSearchResult>{
  const request=evidenceRequestSchema.parse(input);const candidates=structuredClone(request.candidates);
  const warnings:string[]=[],snapshots:ExplorationSearchResult['snapshots']=[],originals:ExplorationCandidate[]=[];
  // Balance the limited page reads across actual search queries; answer order
  // alone must not use all evidence slots for the first topic.
  const groups=new Map<string,ExplorationCandidate[]>();
  const targets=new Map<string,string>();
  for(const item of candidates){
    if(isX(item.url)){
      // Read one actual article/project link per post, never an X login page or
      // a video URL masquerading as its transcript. Keep the original post.
      const link=item.contentLinks?.find(link=>link.kind==='article'&&candidateUrl(link.url)&&!isX(link.url)&&!videoUrl(link.url));
      if(!link||item.linkedEvidence)continue;targets.set(item.id,link.url);
    }else targets.set(item.id,item.url);
    const group=groups.get(item.query)??[];group.push(item);groups.set(item.query,group);
  }
  const chosen:ExplorationCandidate[]=[];
  let linkedCount=0;
  while(chosen.length<6&&[...groups.values()].some(group=>group.length)){
    for(const group of groups.values()){const next=group.shift();if(next&&(!isX(next.url)||linkedCount<3)){chosen.push(next);if(isX(next.url))linkedCount++;}if(chosen.length===6)break;}
  }
  const pages=await Promise.all(chosen.map(async item=>{
    try{
      const target=targets.get(item.id)!;
      if(!candidateUrl(target))throw new Error('非公网网址');const html=await readPage(target);if(html.length>1_800_000)throw new Error('超过证据保存上限');
      const material=extractHtml(html,{url:target});if(material.coverage==='metadata'||material.body.length<40)throw new Error('未取得有效正文');
      const json=JSON.stringify({url:target,html});if(json.length>2_000_000)throw new Error('超过证据保存上限');
      if(isX(item.url)){
        item.linkedEvidence={url:target,excerpt:material.body.slice(0,1600)};
        item.evidence=[...item.evidence.slice(0,3),`外链摘选 ${target}\n${material.body.slice(0,Math.max(40,780-target.length))}`.slice(0,800)];
        snapshots.push({source:`X外链证据：${target}`.slice(0,160),query:item.query,json});
        return null;
      }
      const {document}=parseHTML(html);
      const date=document.querySelector('meta[property="article:published_time"],meta[name="date"],meta[itemprop="datePublished"]')?.getAttribute('content')??material.publishedAt;
      const excerpt=material.body.slice(0,2400);item.excerpt=excerpt;item.evidence=excerpt.match(/[\s\S]{1,600}/g)!.slice(0,4);item.coverage='page-excerpt';
      if(date&&Number.isFinite(Date.parse(date))){item.date=new Date(date).toISOString();item.dateKind='published';}
      return {item,body:material.body,document,json};
    }catch{warnings.push(`${item.title.slice(0,60)}：未取得${isX(item.url)?'外链':'原页'}证据，保留已有文字，不评价未读内容`);return null;}
  }));
  for(const page of pages)if(page)snapshots.push({source:`网页证据：${page.item.url}`.slice(0,160),query:page.item.query,json:page.json});
  for(const page of pages){if(!page)continue;
    // Only links physically present in the fetched article can become originals.
    // An embedded/link description is introduction evidence, never a transcript.
    for(const anchor of page.document.querySelectorAll('a[href]')){
      let url:string|null=null;try{url=videoUrl(new URL(anchor.getAttribute('href')!,page.item.url).toString());}catch{}
      if(!url||candidates.some(item=>item.url===url)||originals.some(item=>item.url===url))continue;
      const label=anchor.textContent?.trim()??'';if(!/原|完整|对话|播客|interview|full|original/i.test(label))continue;
      const title=label.replace(/^https?:\/\/\S+$/,'').trim();if(title.length<6)continue;
      const excerpt=`原节目链接在此页面中出现：${page.item.url}\n链接说明：${title}\n下文是该网页的节目介绍或讨论摘选，未取得原节目文字稿，未验证作者身份。\n${page.body.slice(0,1900)}`.slice(0,2400);
      originals.push({...page.item,id:await hash(url),url,title:title.slice(0,240),source:new URL(url).hostname,excerpt,evidence:excerpt.match(/[\s\S]{1,600}/g)!.slice(0,4),evidenceUrl:page.item.url,coverage:'page-excerpt',date:undefined,dateKind:'unknown'});
      if(originals.length===3)break;
    }if(originals.length===3)break;
  }
  return searchResultSchema.parse({candidates:[...originals,...candidates].slice(0,24),snapshots,warnings:warnings.slice(0,8),credits:0});
}
