import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __XAP_VERSION__: JSON.stringify('test') },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'bridge/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 30000,
  },
});
