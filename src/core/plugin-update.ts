import {createHash,verify} from 'node:crypto';
import {z} from 'zod';
import {pluginUpdatePublicKey} from './plugin-update-trust';

export const pluginProgramFiles=['main.js','manifest.json','styles.css','AIHOT-MIT.txt'] as const;
const version=z.string().regex(/^\d+\.\d+\.\d+$/),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const updateReleaseSchema=z.object({schema:z.literal(1),id:z.literal('source-workbench'),version,publishedAt:z.string().datetime(),minServiceVersion:version,notes:z.string().max(4000),files:z.array(z.object({name:z.enum(pluginProgramFiles),sha256:digest,size:z.number().int().positive().max(8_000_000)}).strict()).length(4)}).strict();
export const signedUpdateSchema=z.object({release:updateReleaseSchema,signature:z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(256)}).strict();
export const updateBundleSchema=z.object({header:signedUpdateSchema,files:z.array(z.object({name:z.enum(pluginProgramFiles),base64:z.string().max(12_000_000)}).strict()).length(4)}).strict();
export type SignedUpdate=z.infer<typeof signedUpdateSchema>;
export type UpdateBundle=z.infer<typeof updateBundleSchema>;
export const byteHash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export function compareVersions(a:string,b:string){version.parse(a);version.parse(b);const left=a.split('.').map(Number),right=b.split('.').map(Number);for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]!>right[i]!?1:-1;return 0;}
export function updateMessage(release:z.infer<typeof updateReleaseSchema>){const normalized=updateReleaseSchema.parse(release);return JSON.stringify({...normalized,files:[...normalized.files].sort((a,b)=>a.name.localeCompare(b.name))});}
export function verifyUpdateHeader(input:unknown,publicKey=pluginUpdatePublicKey):SignedUpdate{
 const header=signedUpdateSchema.parse(input);
 if(new Set(header.release.files.map(file=>file.name)).size!==4||!verify(null,Buffer.from(updateMessage(header.release)),publicKey,Buffer.from(header.signature,'base64')))throw Error('更新包签名无效，请等待维护者重新准备新版');
 return header;
}
export function verifyUpdateBundle(input:unknown,publicKey=pluginUpdatePublicKey){
 const bundle=updateBundleSchema.parse(input),header=verifyUpdateHeader(bundle.header,publicKey),files=new Map<string,Uint8Array>();
 for(const file of bundle.files){if(files.has(file.name)||!/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)||file.base64.length%4)throw Error('更新包文件重复或编码无效');const bytes=Buffer.from(file.base64,'base64'),expected=header.release.files.find(f=>f.name===file.name);if(!expected||bytes.length!==expected.size||byteHash(bytes)!==expected.sha256)throw Error('更新包文件校验失败，原插件保持不变');files.set(file.name,bytes);}
 const manifest=JSON.parse(Buffer.from(files.get('manifest.json')!).toString('utf8'));if(manifest.id!==header.release.id||manifest.version!==header.release.version||manifest.isDesktopOnly!==true)throw Error('更新包插件身份或版本不匹配');
 return{header,files};
}
export interface PluginUpdateFiles {
 read(path:string):Promise<Uint8Array|null>;
 write(path:string,bytes:Uint8Array,expected?:string|null):Promise<void>;
 remove(path:string,expected:string):Promise<void>;
}
const stateSchema=z.object({schema:z.literal(1),transaction:z.string().uuid(),phase:z.enum(['prepared','installing','ready','completed','rolled-back','recovery-needed']),from:version,to:version,header:signedUpdateSchema,previous:z.record(z.enum(pluginProgramFiles),digest.nullable()),configHash:digest.nullable(),issue:z.string().optional()}).strict();
export type PluginUpdateState=z.infer<typeof stateSchema>;
/** Only program files participate in replacement. Vault materials and data.json
 * are outside the write set; a durable journal makes interrupted swaps recoverable. */
export class PluginUpdater {
 constructor(private files:PluginUpdateFiles,private publicKey=pluginUpdatePublicKey){}
 private async save(state:PluginUpdateState){await this.files.write('_updates/state.json',Buffer.from(JSON.stringify(state)));await this.files.write(`_updates/${state.transaction}/receipt.json`,Buffer.from(JSON.stringify(state)));}
 async state():Promise<PluginUpdateState|null>{const bytes=await this.files.read('_updates/state.json');return bytes?stateSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8'))):null;}
 async prepare(input:unknown,current:string,serviceVersion:string){
  const {header,files}=verifyUpdateBundle(input,this.publicKey);
  if(compareVersions(header.release.version,current)<=0)throw Error('当前已是此更新源的最新版本');
  if(compareVersions(serviceVersion,header.release.minServiceVersion)<0)throw Error('本机后台版本过旧，请维护者先更新后台');
  const existing=await this.state();if(existing&&!['completed','rolled-back'].includes(existing.phase))throw Error('上次更新尚未恢复，请先检查更新记录');
  const manifest=await this.files.read('manifest.json'),installed=manifest&&JSON.parse(Buffer.from(manifest).toString('utf8'));if(!installed||installed.id!==header.release.id||installed.version!==current)throw Error('当前插件文件与已加载版本不一致，请先重载插件');
  const transaction=crypto.randomUUID(),previous={} as PluginUpdateState['previous'];
  for(const name of pluginProgramFiles){const before=await this.files.read(name);previous[name]=before?byteHash(before):null;if(before)await this.files.write(`_updates/${transaction}/backup/${name}`,before,null);await this.files.write(`_updates/${transaction}/staged/${name}`,files.get(name)!,null);}
  const config=await this.files.read('data.json');if(config)await this.files.write(`_updates/${transaction}/backup/data.json`,config,null);
  const state:PluginUpdateState={schema:1,transaction,phase:'prepared',from:current,to:header.release.version,header,previous,configHash:config?byteHash(config):null};await this.save(state);return state;
 }
 async install(state:PluginUpdateState,assertIdle:()=>void){
  assertIdle();verifyUpdateHeader(state.header,this.publicKey);
  const config=await this.files.read('data.json');if((config?byteHash(config):null)!==state.configHash)throw Error('配置在准备更新期间发生变化，请重新检查更新');
  for(const name of pluginProgramFiles){const current=await this.files.read(name);if((current?byteHash(current):null)!==state.previous[name])throw Error('插件文件已被其他操作修改，未覆盖');}
  state.phase='installing';await this.save(state);
  try{for(const name of ['styles.css','AIHOT-MIT.txt','main.js','manifest.json'] as const){assertIdle();const bytes=await this.files.read(`_updates/${state.transaction}/staged/${name}`),expected=state.header.release.files.find(f=>f.name===name)!;if(!bytes||byteHash(bytes)!==expected.sha256)throw Error('暂存更新包损坏');await this.files.write(name,bytes,state.previous[name]);}state.phase='ready';await this.save(state);return state;}
  catch(error){await this.rollback(state);throw error;}
 }
 async complete(){const state=await this.state();if(state?.phase==='ready'){for(const file of state.header.release.files){const bytes=await this.files.read(file.name);if(!bytes||byteHash(bytes)!==file.sha256)throw Error('已安装程序文件不完整');}state.phase='completed';await this.save(state);}}
 async rollback(state:PluginUpdateState){
  try{for(const name of pluginProgramFiles){const current=await this.files.read(name),actual=current?byteHash(current):null,old=state.previous[name],next=state.header.release.files.find(f=>f.name===name)!.sha256;if(actual===old)continue;if(actual!==next)throw Error('插件文件存在更新之外的修改，请从更新备份人工核对');if(old===null){await this.files.remove(name,next);continue;}const backup=await this.files.read(`_updates/${state.transaction}/backup/${name}`);if(!backup||byteHash(backup)!==old)throw Error('更新备份缺失或损坏');await this.files.write(name,backup,next);}state.phase='rolled-back';await this.save(state);}
  catch(error){state.phase='recovery-needed';state.issue=error instanceof Error?error.message:'更新恢复失败';await this.save(state);throw error;}
 }
 async recover(){const state=await this.state();if(state&&['prepared','installing','recovery-needed'].includes(state.phase)){await this.rollback(state);return true;}return false;}
}
