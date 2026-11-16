import {describe,it,expect} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {PluginUpdater,pluginProgramFiles,byteHash,updateMessage,verifyUpdateBundle,type UpdateBundle,type PluginUpdateFiles} from '../src/core/plugin-update';
const keys=generateKeyPairSync('ed25519'),pub=keys.publicKey.export({type:'spki',format:'pem'}).toString();
function bundle(version='1.1.0'):UpdateBundle{
 const files=pluginProgramFiles.map(name=>({name,base64:Buffer.from(name==='manifest.json'?JSON.stringify({id:'source-workbench',version,isDesktopOnly:true}):`new ${name}`).toString('base64')}));
 const release={schema:1 as const,id:'source-workbench' as const,version,publishedAt:'2026-10-14T04:00:00Z',minServiceVersion:'1.0.0',notes:'test',files:files.map(f=>({name:f.name,sha256:byteHash(Buffer.from(f.base64,'base64')),size:Buffer.from(f.base64,'base64').length}))};return{header:{release,signature:sign(null,Buffer.from(updateMessage(release)),keys.privateKey).toString('base64')},files};
}
class Files implements PluginUpdateFiles {
 data=new Map<string,Uint8Array>();fail='';
 constructor(){for(const name of pluginProgramFiles)this.data.set(name,Buffer.from(name==='manifest.json'?JSON.stringify({id:'source-workbench',version:'1.0.0',isDesktopOnly:true}):`old ${name}`));this.data.set('data.json',Buffer.from('{"custom":"保留密钥与目录"}'));this.data.set('user-file.txt',Buffer.from('user'));}
 async read(path:string){return this.data.get(path)??null;}
 async write(path:string,bytes:Uint8Array,expected?:string|null){if(path===this.fail)throw Error('模拟写入失败');const old=await this.read(path);if(expected!==undefined&&(old?byteHash(old):null)!==expected)throw Error('文件已经改变');this.data.set(path,Uint8Array.from(bytes));}
 async remove(path:string,expected:string){if(byteHash(this.data.get(path)!)!==expected)throw Error('文件已经改变');this.data.delete(path);}
}
describe('插件签名更新与数据保留',()=>{
 it('只替换四个程序文件，配置和额外用户文件逐字节保留，并记录完成',async()=>{
  const files=new Files(),config=files.data.get('data.json'),updater=new PluginUpdater(files,pub),b=bundle(),state=await updater.prepare(b,'1.0.0','1.0.0');await updater.install(state,()=>{});await updater.complete();expect((await updater.state())?.phase).toBe('completed');expect(files.data.get('data.json')).toEqual(config);expect(Buffer.from(files.data.get('user-file.txt')!).toString()).toBe('user');for(const f of b.files)expect(Buffer.from(files.data.get(f.name)!)).toEqual(Buffer.from(f.base64,'base64'));
 });
 it('签名、内容、插件身份或额外data.json无效时不碰现有程序',async()=>{
  for(const mutate of [(b:UpdateBundle)=>{b.header.release.notes='changed';},(b:UpdateBundle)=>{b.files[0]!.base64=Buffer.from('bad').toString('base64');},(b:UpdateBundle)=>{(b.files[0] as any).name='data.json';}]){const f=new Files(),before=new Map(f.data),b=bundle();mutate(b);await expect(new PluginUpdater(f,pub).prepare(b,'1.0.0','1.0.0')).rejects.toThrow();expect(f.data).toEqual(before);}
 });
 it('文件替换到一半失败会恢复旧程序，保留完整更新备份与配置',async()=>{
  const f=new Files(),before=new Map(f.data),u=new PluginUpdater(f,pub),state=await u.prepare(bundle(),'1.0.0','1.0.0');f.fail='main.js';await expect(u.install(state,()=>{})).rejects.toThrow('模拟写入失败');for(const [name,bytes] of before)expect(Buffer.from(f.data.get(name)!)).toEqual(Buffer.from(bytes));expect((await u.state())?.phase).toBe('rolled-back');
 });
 it('启动时可恢复中断的文件替换，程序仍可按旧版加载',async()=>{
  const f=new Files(),u=new PluginUpdater(f,pub),before=f.data.get('styles.css'),state=await u.prepare(bundle(),'1.0.0','1.0.0');state.phase='installing';await f.write('_updates/state.json',Buffer.from(JSON.stringify(state)));await f.write('styles.css',f.data.get(`_updates/${state.transaction}/staged/styles.css`)!);expect(await new PluginUpdater(f,pub).recover()).toBe(true);expect(Buffer.from(f.data.get('styles.css')!)).toEqual(Buffer.from(before!));
 });
 it('更新准备后的配置修改或不兼容/降级版本被拦住，保留用户新配置',async()=>{
  const f=new Files(),u=new PluginUpdater(f,pub),state=await u.prepare(bundle(),'1.0.0','1.0.0');await f.write('data.json',Buffer.from('changed'));await expect(u.install(state,()=>{})).rejects.toThrow('配置');expect(Buffer.from(f.data.get('data.json')!).toString()).toBe('changed');await expect(new PluginUpdater(new Files(),pub).prepare(bundle('1.0.0'),'1.0.0','1.0.0')).rejects.toThrow('最新');await expect(new PluginUpdater(new Files(),pub).prepare(bundle(),'1.0.0','0.9.0')).rejects.toThrow('后台');
 });
 it('更新中插入未保存修改时回退程序，不覆盖额外修改的程序文件',async()=>{
  const f=new Files(),u=new PluginUpdater(f,pub),state=await u.prepare(bundle(),'1.0.0','1.0.0');let checks=0;await expect(u.install(state,()=>{if(++checks===3)throw Error('草稿未保存');})).rejects.toThrow('草稿');expect(Buffer.from(f.data.get('styles.css')!).toString()).toBe('old styles.css');
  const f2=new Files(),u2=new PluginUpdater(f2,pub),s2=await u2.prepare(bundle(),'1.0.0','1.0.0');await u2.install(s2,()=>{});await f2.write('main.js',Buffer.from('foreign edit'));await expect(u2.rollback(s2)).rejects.toThrow('更新之外');expect(Buffer.from(f2.data.get('main.js')!).toString()).toBe('foreign edit');
 });
 it('发布元数据的对象键顺序不改变签名判断',()=>{const b=bundle();const header=JSON.parse(JSON.stringify(b.header));header.release.files=header.release.files.map((f:any)=>({size:f.size,name:f.name,sha256:f.sha256}));expect(verifyUpdateBundle({...b,header},pub).header.release.version).toBe('1.1.0');});
});
