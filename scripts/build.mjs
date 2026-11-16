import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/plugin', { recursive: true });
await build({ entryPoints: ['src/plugin/main.ts'], bundle: true, outfile: 'dist/plugin/main.js', format: 'cjs', platform: 'node', target: 'es2022', external: ['obsidian','electron'], logLevel: 'info', sourcemap: false });
for (const name of ['manifest.json','styles.css']) await copyFile(name, `dist/plugin/${name}`);
await copyFile('THIRD_PARTY_NOTICES/AIHOT-MIT.txt', 'dist/plugin/AIHOT-MIT.txt');
console.log('Obsidian 插件产物已生成：dist/plugin');
