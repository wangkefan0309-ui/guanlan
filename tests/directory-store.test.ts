import {describe,it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {DirectoryStore} from '../src/server/store';
const injected=vi.hoisted(()=>({failures:0,code:'EPERM',calls:0}));
vi.mock('node:fs/promises',async importOriginal=>{
 const real=await importOriginal<typeof import('node:fs/promises')>();
 return{...real,rename:async(from:string,to:string)=>{injected.calls++;if(injected.failures-->0)throw Object.assign(Error('Temporary Windows file lock'),{code:injected.code});return real.rename(from,to);}};
});
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>{const target=resolve(root);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('source-store-'))throw Error('Cleanup outside test directory');return rm(target,{recursive:true,force:true});}));injected.failures=0;injected.calls=0;injected.code='EPERM';});
describe('材料后台原子文件保存',()=>{
 it('Windows 临时拒绝替换时仍完成保存，原文件在成功替换前可读',async()=>{
  const root=await mkdtemp(join(tmpdir(),'source-store-'));roots.push(root);await writeFile(join(root,'subscriptions.json'),'old');
  const store=new DirectoryStore(root);injected.failures=2;
  const saving=store.write('subscriptions.json','new');void saving.catch(()=>{});await new Promise(r=>setTimeout(r,5));expect(await readFile(join(root,'subscriptions.json'),'utf8')).toBe('old');await saving;
  expect(await store.read('subscriptions.json')).toBe('new');expect((await readdir(root)).filter(p=>p.includes('.tmp-'))).toEqual([]);
 });
 it('持续拒绝替换时返回失败并保留旧内容和完整临时原件',async()=>{
  const root=await mkdtemp(join(tmpdir(),'source-store-'));roots.push(root);await writeFile(join(root,'subscriptions.json'),'old');injected.failures=100;
  const store=new DirectoryStore(root);await expect(store.write('subscriptions.json','new')).rejects.toThrow('Temporary Windows file lock');expect(await store.read('subscriptions.json')).toBe('old');
  const temp=(await readdir(root)).find(p=>p.includes('.tmp-'))!;expect(await readFile(join(root,temp),'utf8')).toBe('new');expect(injected.calls).toBeLessThan(15);
 });
});
