import { build } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';

// The Community directory downloads only the standard plugin files.
const notices = await Promise.all(['LICENSE', 'THIRD_PARTY_NOTICES/AIHOT-MIT.txt', 'node_modules/zod/LICENSE'].map(path => readFile(path, 'utf8')));
const licenseBanner = notices.map(notice => '/*!\n' + notice.trim().split(/\r?\n/).map(line => ` * ${line.replaceAll('*/', '* /')}`).join('\n') + '\n */').join('\n');
await build({ entryPoints: ['src/plugin/main.ts'], bundle: true, outfile: 'main.js', format: 'cjs', platform: 'node', target: 'es2022', external: ['obsidian'], logLevel: 'info', sourcemap: false, banner: { js: licenseBanner } });
await mkdir('dist/plugin', { recursive: true });
for (const name of ['main.js','manifest.json','styles.css']) await copyFile(name, `dist/plugin/${name}`);
await copyFile('THIRD_PARTY_NOTICES/AIHOT-MIT.txt', 'dist/plugin/AIHOT-MIT.txt');
console.log('Obsidian 插件产物已生成：dist/plugin');
