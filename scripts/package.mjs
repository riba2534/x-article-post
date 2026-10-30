// Zips dist/ into release/markdown-to-x-article-v<version>.zip.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(path.join(root, 'dist/manifest.json'), 'utf8'));
await mkdir(path.join(root, 'release'), { recursive: true });
const out = path.join(root, 'release', `markdown-to-x-article-v${manifest.version}.zip`);
execFileSync('zip', ['-qr', out, '.'], { cwd: path.join(root, 'dist'), stdio: 'inherit' });
console.log(out);
