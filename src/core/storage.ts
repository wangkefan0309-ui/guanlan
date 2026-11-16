import {readingRoot} from './model';
export const readingFolders=['阅读材料','原件','AI导读','探索推荐','知识接续','交接材料','_工作台','_工作台/待提交','_工作台/模型回执','_工作台/知识接续','_工作台/探索'];
const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
export function storageRoot(value:string,configDir:string,knownRoots:string[]=[]):string{
 const root=readingRoot(value),config=configDir.replace(/\\/g,'/').replace(/^\/|\/$/g,'').normalize('NFC');
 if(config&&overlaps(root.toLowerCase(),config.toLowerCase()))throw new Error('阅读目录不能位于 Obsidian 配置目录内或包含配置目录');
 if(knownRoots.some(other=>other.toLowerCase()!==root.toLowerCase()&&overlaps(root.toLowerCase(),other.toLowerCase())))throw new Error('阅读目录不能与已使用的阅读库互为父子目录；请选独立目录');
 return root;
}
/** Inspect the complete parent chain and fixed outputs before any create. */
export async function preflightStorage(value:string,configDir:string,knownRoots:string[],kind:(path:string)=>Promise<'file'|'folder'|null>){
 const root=storageRoot(value,configDir,knownRoots),parents=root.split('/').map((_,i,all)=>all.slice(0,i+1).join('/'));
 for(const path of [...parents,...readingFolders.map(p=>`${root}/${p}`)])if(await kind(path)==='file')throw new Error(`目录位置被同名文件占用，未更改配置：${path}`);
 for(const path of [`${root}/_工作台/state.json`,`${root}/_工作台/探索/state.json`,`${root}/今日阅读.md`])if(await kind(path)==='folder')throw new Error(`文件位置被同名文件夹占用，未更改配置：${path}`);
 return root;
}
