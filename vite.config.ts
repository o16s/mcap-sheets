import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

// Externalize React and every runtime dependency so the published library
// resolves them from the consumer's node_modules instead of bundling copies.
const externalNames = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

const isExternal = (id: string): boolean =>
  externalNames.some((name) => id === name || id.startsWith(`${name}/`));

export default defineConfig({
  plugins: [react()],
  build: {
    copyPublicDir: false,
    lib: {
      entry: 'src/index.ts',
      name: 'MCAPSheets',
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
    },
    rollupOptions: {
      external: isExternal,
    },
  },
});
