// Bundles the agent bridge (bridge/ + core + ws) into a single Node ESM file: dist-bridge/xap.mjs.
import { build } from 'vite';
import { chmod, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'dist-bridge');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = process.env.XAP_VERSION || pkg.version;

await build({
  configFile: false,
  logLevel: 'warn',
  publicDir: false,
  define: { __XAP_VERSION__: JSON.stringify(version) },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: path.join(root, 'bridge/xap.mjs'),
    outDir,
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      // Optional native accelerators of ws; it falls back to JS when they are missing.
      external: ['bufferutil', 'utf-8-validate'],
      output: { format: 'es', entryFileNames: 'xap.mjs', codeSplitting: false },
    },
  },
});

const out = path.join(outDir, 'xap.mjs');
const code = await readFile(out, 'utf8');
if (!code.startsWith('#!')) throw new Error('dist-bridge/xap.mjs lost its shebang');
await chmod(out, 0o755);
console.log(`built dist-bridge/xap.mjs (version ${version})`);
