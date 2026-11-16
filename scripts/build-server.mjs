import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist/server', { recursive: true });
await build({ entryPoints: ['src/server/main.ts'], bundle: true, packages: 'external', outfile: 'dist/server/main.mjs', format: 'esm', platform: 'node', target: 'node22', logLevel: 'info', sourcemap: false });
await build({ entryPoints: ['src/server/local-supervisor.ts'], bundle: true, outfile: 'dist/server/local-supervisor.mjs', format: 'esm', platform: 'node', target: 'node22', logLevel: 'info', sourcemap: false });
