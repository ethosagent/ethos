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
      rollupOptions: {
        input: {
          index: 'src/main/preload.ts',
          'quick-chat': 'src/main/preload-quick-chat.ts',
        },
        output: {
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'process.platform': JSON.stringify(process.platform),
      'process.version': JSON.stringify(process.version),
    },
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          index: 'src/renderer/index.html',
          'quick-chat': 'src/renderer/quick-chat.html',
        },
      },
    },
  },
});
