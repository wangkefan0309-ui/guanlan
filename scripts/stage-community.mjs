import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
const { version } = manifest;
if (!/^\d+\.\d+\.\d+$/.test(version) || version !== packageInfo.version) {
  throw new Error('Release version must match manifest.json and package.json.');
}
const output = `release/community/${version}`;
await mkdir(output, { recursive: true });
const checksums = [];
for (const name of ['main.js', 'manifest.json', 'styles.css']) {
  await copyFile(name, `${output}/${name}`);
  const bytes = await readFile(`${output}/${name}`);
  checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await writeFile(`release/community/${version}-SHA256SUMS.txt`, checksums.join('\n') + '\n');
console.log(`Community release assets: ${output} (tag: ${version})`);
