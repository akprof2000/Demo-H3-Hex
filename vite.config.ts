import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // 📦 Относительный base: демо одинаково работает и локально, и на GitHub Pages
  // по адресу вида /Demo-H3-Hex/, без правки путей.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      'react-h3-map': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  build: { outDir: 'dist-demo' }, // 🏗️ демо собирается отдельно от dist/ библиотеки
  server: { port: 5180 },
});
