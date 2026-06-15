import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const ROOT = resolve(import.meta.dirname, '../..');

// Read workspace path aliases from the root tsconfig so that all @ethosagent/*
// imports are resolved as source files directly — bypassing package `exports`
// resolution entirely (which would fail because exports point to .ts files).
// This handles both direct and transitive @ethosagent/* imports.
const tsconfig = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf-8')) as {
  compilerOptions?: { paths?: Record<string, string[]> };
};
const paths = tsconfig.compilerOptions?.paths ?? {};

// Tsconfig paths point to directories (e.g. ./packages/core/src) OR bare files
// (e.g. ./extensions/memory-markdown/src/compose for compose.ts). Probe both.
const resolveWorkspaceSrc = (dirPath: string): string => {
  const asIndex = resolve(ROOT, dirPath, 'index.ts');
  if (existsSync(asIndex)) return asIndex;
  const asFile = resolve(ROOT, `${dirPath}.ts`);
  if (existsSync(asFile)) return asFile;
  return asIndex; // fallback — build will surface the missing file clearly
};

const ethosSourceMap = new Map(
  Object.entries(paths)
    .filter(([key]) => key.startsWith('@ethosagent/'))
    .map(([key, [dirPath]]) => [key, resolveWorkspaceSrc(dirPath)]),
);

// electron-vite v5 auto-applies externalizeDepsPlugin (enforce: 'pre') which
// wins over any user plugin. Setting build.externalizeDeps: false disables it
// entirely, letting us own all externalization decisions in one plugin.
const bundleWorkspacePackages = {
  name: 'bundle-workspace-packages',
  enforce: 'pre' as const,
  resolveId(id: string) {
    // Bundle @ethosagent/* workspace packages: resolve to their TS source file
    const src = ethosSourceMap.get(id);
    if (src !== undefined) return { id: src, external: false };

    // Keep native modules external — their CJS wrappers use __dirname to locate
    // the .node binary, which breaks when bundled into ESM. Both are symlinked
    // in apps/desktop/node_modules so Electron can resolve them at runtime.
    if (id === 'better-sqlite3' || id === 'argon2') return false;

    // Keep node built-ins and electron external
    if (id.startsWith('node:') || id === 'electron') return false;

    // Everything else (npm packages, relative/absolute paths): let Vite bundle them.
    // Workspace packages pull in transitive npm deps (gray-matter, yaml, zod, etc.)
    // that pnpm doesn't hoist to root node_modules, so they must be bundled rather
    // than left as runtime externals that Electron can't find.
    return null;
  },
};

export default defineConfig({
  main: {
    plugins: [bundleWorkspacePackages],
    define: {
      // __dirname is unavailable in ESM bundles. import.meta.dirname is the
      // ESM equivalent (Node 21.2+). Applied to both app source and bundled
      // CJS packages that reference __dirname at module scope.
      __dirname: 'import.meta.dirname',
      __filename: 'import.meta.filename',
    },
    build: {
      externalizeDeps: false,
      outDir: 'dist/main',
      lib: {
        entry: 'src/main/index.ts',
      },
      rollupOptions: {
        external: ['better-sqlite3', 'argon2'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: 'src/main/preload.ts',
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
});
