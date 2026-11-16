import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {verifyUpdateBundle} from '../core/plugin-update';

export async function readPluginUpdate(directory:string){
 let text:string;try{text=await readFile(join(directory,'plugin-updates/latest.json'),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 const bundle=JSON.parse(text);verifyUpdateBundle(bundle);return bundle;
}
