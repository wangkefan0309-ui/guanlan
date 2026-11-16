import {describe,it,expect,afterEach} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {LocalPluginUpdateFiles} from '../src/plugin/plugin-update-files';
import {byteHash} from '../src/core/plugin-update';
const roots:string[]=[];
async function setup(config='.custom-config'){const root=await mkdtemp(join(tmpdir(),'source-update-files-'));roots.push(root);const plugin=join(root,config,'plugins/source-workbench');await mkdir(plugin,{recursive:true});await writeFile(join(plugin,'main.js'),'old');await writeFile(join(plugin,'data.json'),'keep');return{root,plugin,files:await LocalPluginUpdateFiles.open(root,config,'source-workbench')};}
afterEach(async()=>{for(const root of roots.splice(0)){const target=resolve(root);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('source-update-files-'))throw Error('Cleanup outside test root');await rm(target,{recursive:true,force:true});}});
describe('实际插件更新目录与文件保护',()=>{
 it('支持真实自定义配置目录；配置文件及越界目标禁止写入',async()=>{
  const {files,plugin}=await setup();await files.write('main.js',Buffer.from('new'),byteHash(Buffer.from('old')));expect(await readFile(join(plugin,'main.js'),'utf8')).toBe('new');await expect(files.write('data.json',Buffer.from('bad'))).rejects.toThrow('用户配置');await expect(files.write('../other.js',Buffer.from('bad'))).rejects.toThrow();await expect(files.write('main.js',Buffer.from('bad'),byteHash(Buffer.from('old')))).rejects.toThrow('改变');expect(await readFile(join(plugin,'data.json'),'utf8')).toBe('keep');
 });
 it('拒绝目标符号链接，保留其所指文件',async()=>{
  const {files,root}=await setup();const other=join(root,'other');await mkdir(other);await symlink(other,join(root,'.custom-config/plugins/source-workbench/_updates'),'junction');await expect(files.write('_updates/state.json',Buffer.from('bad'))).rejects.toThrow('符号链接');
 });
 it('初始化后安装根目录被替换为链接时拒绝写入其他目录',async()=>{const {files,root,plugin}=await setup();const other=join(root,'other');await mkdir(other);await writeFile(join(other,'main.js'),'foreign');await rename(plugin,plugin+'-before');await symlink(other,plugin,'junction');await expect(files.write('main.js',Buffer.from('bad'))).rejects.toThrow('根目录');expect(await readFile(join(other,'main.js'),'utf8')).toBe('foreign');});
 it('更新锁阻止同进程重复安装，正常释放后可继续',async()=>{const {files}=await setup();const release=await files.lock();await expect(files.lock()).rejects.toThrow('已有更新');await expect(files.recoverLock()).rejects.toThrow('尚未结束');await files.recoverLock(true);await release();const again=await files.lock();await again();});
 it('仅清除确认进程不存在的自身更新锁，异常锁保留',async()=>{
  const {files,plugin}=await setup();await mkdir(join(plugin,'_updates'));await writeFile(join(plugin,'_updates/install.lock'),JSON.stringify({pid:2147483646,token:'test'}));await files.recoverLock();const release=await files.lock();await release();await writeFile(join(plugin,'_updates/install.lock'),'invalid');await expect(files.recoverLock()).rejects.toThrow();expect(await readFile(join(plugin,'_updates/install.lock'),'utf8')).toBe('invalid');
 });
});
