import { z } from 'zod';
import { materialSchema } from '../core/model';
import type { Material, FileStore } from '../core/model';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';

const entrySchema=z.object({seq:z.number().int().positive(),version:z.string().min(1).max(200),material:materialSchema}).strict();
type Entry=z.infer<typeof entrySchema>;
const indexSchema=z.object({schema:z.literal(1),instance:z.string().min(1),entries:z.array(z.object({seq:z.number().int().positive(),version:z.string().min(1).max(200),path:z.string().regex(/^ledger-entries\/[1-9]\d*-[a-f0-9]{64}\.json$/)}).strict())}).strict();
type Index=z.infer<typeof indexSchema>;
export type LegacyPart={instance:string}|Entry;

/** Parse the canonical legacy envelope incrementally. Individual entries are
 * bounded; the aggregate document is never turned into one V8 string. */
export async function* legacyLedger(chunks:AsyncIterable<string>):AsyncGenerator<LegacyPart>{
 let prefix='',record='',tail='',depth=0,quoted=false,escaped=false,started=false,ended=false,expectRecord=true,afterComma=false;
 let instance='';
 for await(const chunk of chunks){let recordStart=depth?0:-1;for(let offset=0;offset<chunk.length;offset++){const char=chunk[offset]!;
  if(!started){prefix+=char;if(prefix.length>16384)throw new Error('旧账本头部无效');if(char==='['&&!quoted){const header=JSON.parse(prefix.slice(0,-1)+'[]}');if(typeof header.instance!=='string'||!header.instance||!Array.isArray(header.entries)||Object.keys(header).some(k=>!['instance','entries'].includes(k)))throw new Error('旧账本头部无效');instance=header.instance;started=true;yield {instance};}else if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}else if(char==='"')quoted=true;continue;}
  if(ended){tail+=char;if(tail.length>16384)throw new Error('旧账本尾部无效');continue;}
  if(!depth){if(/\s/.test(char))continue;if(char===']'){if(afterComma)throw new Error('旧账本尾逗号无效');ended=true;continue;}if(!expectRecord&&char===','){expectRecord=true;afterComma=true;continue;}if(!expectRecord||char!=='{')throw new Error('旧账本条目无效');depth=1;recordStart=offset;quoted=false;escaped=false;continue;}
  if(record.length+offset-recordStart>60_000_000)throw new Error('单份材料超出账本上限');
  if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}
  else if(char==='"')quoted=true;else if(char==='{'||char==='[')depth++;else if(char==='}'||char===']')depth--;
  if(!depth){record+=chunk.slice(recordStart,offset+1);yield entrySchema.parse(JSON.parse(record));record='';recordStart=-1;expectRecord=false;afterComma=false;}
 }if(depth)record+=chunk.slice(recordStart);}
 if(!prefix)return;
 if(!started||!ended||depth||tail.trim()!=='}')throw new Error('旧账本不完整；迁移未提交');
}
export async function* legacyFile(directory:string):AsyncGenerator<string>{
 const decoder=new StringDecoder('utf8');
 try{for await(const chunk of createReadStream(resolve(directory,'ledger.json'),{highWaterMark:64*1024}))yield decoder.write(chunk as Buffer);yield decoder.end();}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
/** Durable index commits only after an immutable entry has been saved. An
 * interrupted migration leaves the legacy file authoritative and recoverable. */
export class MaterialLedger{
 private state:Index|null=null;
  private loading?:Promise<Index>;
  private queue:Promise<unknown>=Promise.resolve();
 constructor(private files:FileStore,private legacy:()=>AsyncIterable<string>){}
 async load():Promise<Index>{
  if(this.state)return this.state;
    this.loading??=this.loadOne().finally(()=>{this.loading=undefined;});return this.loading;
  }
  private async loadOne():Promise<Index>{
  const saved=await this.files.read('ledger-index.json');
  if(saved){const candidate=indexSchema.parse(JSON.parse(saved));this.validate(candidate);this.state=candidate;return candidate;}
  const candidate:Index={schema:1,instance:crypto.randomUUID(),entries:[]};
  for await(const part of legacyLedger(this.legacy())){if('instance'in part){candidate.instance=part.instance;continue;}if(part.seq<=(candidate.entries.at(-1)?.seq??0)||candidate.entries.some(e=>e.version===part.version))throw new Error('旧账本序号或版本重复');candidate.entries.push(await this.persist(part));}
  // No legacy file is a fresh installation; malformed nonempty input throws.
  this.validate(candidate);await this.files.write('ledger-index.json',JSON.stringify(candidate));this.state=candidate;return candidate;
 }
 private validate(index:Index){let seq=0;const versions=new Set<string>();for(const entry of index.entries){if(entry.seq<=seq||versions.has(entry.version))throw new Error('材料账本索引重复或失序');seq=entry.seq;versions.add(entry.version);}}
 private async persist(entry:Entry){
  const data=JSON.stringify(entry),bytes=new TextEncoder().encode(data),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  const path=`ledger-entries/${entry.seq}-${digest}.json`,existing=await this.files.read(path);
  if(existing!==null&&existing!==data)throw new Error('账本材料已改变，保留原内容');
  if(existing===null)await this.files.write(path,data,null);
  return{seq:entry.seq,version:entry.version,path};
 }
 append(material:Material,version:string):Promise<boolean>{
  const result=this.queue.then(()=>this.appendOne(material,version));this.queue=result.catch(()=>{});return result;
 }
 private async appendOne(material:Material,version:string){
  const state=await this.load();if(state.entries.some(e=>e.version===version))return false;
  const saved=await this.persist(entrySchema.parse({seq:(state.entries.at(-1)?.seq??0)+1,version,material}));
  const next={...state,entries:[...state.entries,saved]};
  await this.files.write('ledger-index.json',JSON.stringify(next));this.state=next;return true;
 }
 async entry(ref:Index['entries'][number]):Promise<Entry>{
  const text=await this.files.read(ref.path);if(text===null)throw new Error('账本材料缺失，保留游标等待恢复');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('');
  if(!ref.path.endsWith(`-${digest}.json`))throw new Error('账本材料校验失败');
  const entry=entrySchema.parse(JSON.parse(text));if(entry.seq!==ref.seq||entry.version!==ref.version)throw new Error('账本材料与索引不一致');return entry;
 }
}
