// Builds the extension into dist/: ES-module pages + service worker, and IIFE content scripts.
import { build } from 'vite';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = process.env.XAP_VERSION || pkg.version;

const common = {
  configFile: false,
  logLevel: 'warn',
  define: { __XAP_VERSION__: JSON.stringify(version) },
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  ...common,
  root: src,
  base: '/',
  build: {
    outDir: dist,
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    watch: watch ? {} : null,
    rollupOptions: {
      input: {
        sidepanel: path.join(src, 'sidepanel/sidepanel.html'),
        offscreen: path.join(src, 'offscreen/offscreen.html'),
        background: path.join(src, 'background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});

for (const [name, entry] of [['content', 'content/index.ts'], ['main', 'main/index.ts']]) {
  await build({
    ...common,
    build: {
      outDir: dist,
      emptyOutDir: false,
      target: 'chrome116',
      sourcemap: false,
      watch: watch ? {} : null,
      lib: { entry: path.join(src, entry), formats: ['iife'], name: `xap_${name}`, fileName: () => `${name}.js` },
    },
  });
}

await cp(path.join(root, 'public'), dist, { recursive: true });
const manifestPath = path.join(dist, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.version = version;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`built dist/ (version ${version})`);
