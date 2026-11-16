import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], exclude: ['research/**','node_modules/**'], maxWorkers: 2, testTimeout: 20_000 } });
