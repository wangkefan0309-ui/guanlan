import {mkdir,readFile,writeFile,rename,unlink,lstat,realpath,open} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute,sep} from 'node:path';
import {byteHash,pluginProgramFiles,type PluginUpdateFiles} from '../core/plugin-update';

/** Fixed own-plugin scope, including Obsidian's actual custom config directory. */
export class LocalPluginUpdateFiles implements PluginUpdateFiles {
 private constructor(private root:string){}
 static async open(vaultBase:string,configDir:string,id:string){
  if(id!=='source-workbench'||!configDir||configDir.includes('\\')||configDir.split('/').some(part=>!part||part==='..'||part==='.')||isAbsolute(configDir))throw Error('插件配置目录无效');
  const base=await realpath(vaultBase),root=resolve(base,configDir,'plugins',id),rel=relative(base,root);if(isAbsolute(rel)||rel.startsWith('..'))throw Error('插件更新目录越过当前仓库');
  let parent=base;for(const part of rel.split(sep)){parent=resolve(parent,part);if((await lstat(parent)).isSymbolicLink())throw Error('符号链接安装需人工维护，未改动插件');}if(await realpath(root)!==root)throw Error('插件真实路径与当前仓库不一致');return new LocalPluginUpdateFiles(root);
 }
 private path(path:string){
  const allowed=pluginProgramFiles.includes(path as typeof pluginProgramFiles[number])||path==='data.json'||path==='_updates/state.json'||/^_updates\/[a-f0-9-]{36}\/(?:receipt\.json|(?:backup|staged)\/(?:main\.js|manifest\.json|styles\.css|AIHOT-MIT\.txt|data\.json))$/.test(path);
  if(!allowed)throw Error('更新仅允许访问本插件程序和更新备份');const target=resolve(this.root,path);if(!target.startsWith(this.root+sep))throw Error('更新路径越界');return target;
 }
 private async check(target:string){if(await realpath(this.root)!==this.root||(await lstat(this.root)).isSymbolicLink())throw Error('插件更新根目录已改变或含符号链接，未写入');let current=this.root;for(const part of relative(this.root,target).split(sep)){current=resolve(current,part);try{if((await lstat(current)).isSymbolicLink())throw Error('更新目标含符号链接，未写入');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}}
 async read(path:string){const target=this.path(path);await this.check(target);try{return await readFile(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
 async write(path:string,bytes:Uint8Array,expected?:string|null){
  if(path==='data.json')throw Error('更新不得替换用户配置');const target=this.path(path);await this.check(target);await mkdir(dirname(target),{recursive:true});const before=await this.read(path);if(expected!==undefined&&(before?byteHash(before):null)!==expected)throw Error('更新目标已改变，未覆盖');const temporary=`${target}.update-${crypto.randomUUID()}`;await writeFile(temporary,bytes,{flag:'wx'});
  try{await this.check(target);const current=await this.read(path);if(expected!==undefined&&(current?byteHash(current):null)!==expected)throw Error('更新目标已改变，未覆盖');for(let n=0;;n++){try{await rename(temporary,target);break;}catch(error){if(n>=7||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))throw error;await new Promise(r=>setTimeout(r,25*(n+1)));}}}finally{await unlink(temporary).catch(()=>{});}
 }
 async remove(path:string,expected:string){if(!pluginProgramFiles.includes(path as typeof pluginProgramFiles[number]))throw Error('只能恢复本插件程序文件');const current=await this.read(path);if(!current||byteHash(current)!==expected)throw Error('待恢复文件已改变');await this.check(this.path(path));await unlink(this.path(path));}
 async recoverLock(allowOwnReady=false){const target=resolve(this.root,'_updates/install.lock');await this.check(target);let contents:string;try{contents=await readFile(target,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}const owner=JSON.parse(contents);if(!Number.isInteger(owner.pid)||owner.pid<=0||typeof owner.token!=='string')throw Error('更新锁身份无法核验，请检查更新记录');let alive=true;try{process.kill(owner.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw error;}if(alive){if(allowOwnReady&&owner.pid===process.pid)return;throw Error('已有更新操作尚未结束');}if(await readFile(target,'utf8')!==contents)throw Error('更新锁已改变');await unlink(target);}
 async lock(){const target=resolve(this.root,'_updates/install.lock');await this.check(target);await mkdir(dirname(target),{recursive:true});const handle=await open(target,'wx').catch(()=>{throw Error('已有更新操作或未恢复更新锁，请重启后检查更新记录');});const owner=JSON.stringify({pid:process.pid,token:crypto.randomUUID()});await handle.writeFile(owner);return async()=>{await handle.close();if(await readFile(target,'utf8')!==owner)throw Error('更新锁身份已改变，未清除');await unlink(target);};}
}
