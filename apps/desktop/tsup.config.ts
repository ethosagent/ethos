import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/main/index.ts',
    preload: 'src/main/preload.ts',
  },
  outDir: 'dist/main',
  format: ['esm'],
  platform: 'node',
  external: ['electron'],
  clean: true,
});
