#!/usr/bin/env node
// Entry for `node bridge/xap.mjs` (dev) and dist-bridge/xap.mjs (bundled release asset).
import module from 'node:module';

// Dev only: the core sources are TypeScript with extensionless relative imports.
// Node strips types itself; this hook adds the missing ".ts". No-op in the bundle.
module.registerHooks?.({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts')) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});

const { main } = await import('./cli.mjs');
const code = await main();
if (code) process.exitCode = code;
