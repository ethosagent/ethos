import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      lib: {
        entry: 'src/main/index.ts',
      },
      rollupOptions: {
        // Workspace packages (@ethosagent/*) ship .ts source — they must be
        // bundled into the main process bundle, not loaded from node_modules at
        // runtime (where Electron's Node.js would reject the .ts extension).
        // Exceptions: llm-codex (dynamic import, stays external) and
        // better-sqlite3 (native .node file, can't be bundled by Rollup).
        external: (id: string) => {
          if (id === 'better-sqlite3' || id === '@ethosagent/llm-codex') return true;
          if (id.startsWith('@ethosagent/')) return false;
          if (id.startsWith('node:') || id === 'electron') return true;
          return !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0');
        },
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
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    optimizeDeps: {
      exclude: ['@ethosagent/ui-components'],
    },
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
