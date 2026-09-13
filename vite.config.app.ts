import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build config for the standalone demo app deployed to GitHub Pages (the
// default vite.config.ts builds the library). The base path matches the
// project pages URL: https://o16s.github.io/mcap-sheets/. Override with
// VITE_BASE (e.g. "/" for a user/custom-domain site).
export default defineConfig({
  base: process.env.VITE_BASE ?? '/mcap-sheets/',
  plugins: [react()],
  build: {
    outDir: 'dist-app',
    emptyOutDir: true,
  },
});
