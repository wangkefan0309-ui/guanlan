import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { FileStore } from '../core/model';
import { setTimeout as delay } from 'node:timers/promises';

export class DirectoryStore implements FileStore {
  private base: string;
  constructor(base: string) { this.base = resolve(base); }
  private path(relative: string): string {
    const path = resolve(this.base, relative);
    if (!path.startsWith(this.base + sep) || relative.includes('\\') || relative.split('/').includes('..')) throw new Error('写入路径越过指定目录');
    return path;
  }
  async read(path: string): Promise<string | null> { const bytes = await this.readBinary(path); return bytes ? new TextDecoder().decode(bytes) : null; }
  async readBinary(path: string): Promise<Uint8Array | null> {
    try { return await readFile(this.path(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async write(path: string, contents: string): Promise<void> { await this.writeBinary(path, new TextEncoder().encode(contents)); }
  async writeBinary(path: string, contents: Uint8Array): Promise<void> {
    const target = this.path(path); await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.tmp-${crypto.randomUUID()}`; await writeFile(temp, contents);
    for(let attempt=0;;attempt++){
      try{await rename(temp,target);return;}catch(error){
        if(!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')||attempt>=7)throw error;
        // Windows readers/scanners can briefly deny replacement. Retry the
        // same staged file; never unlink the last committed version.
        await delay(25*(attempt+1));
      }
    }
  }
}
