import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      lib: {
        entry: 'src/main/index.ts',
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      lib: {
        entry: 'src/main/preload.ts',
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      outDir: 'dist/renderer',
    },
  },
});
