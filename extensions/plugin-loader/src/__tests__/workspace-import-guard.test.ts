// V-CC-1 — a trusted workspace plugin's module graph is contained to its
// folder (`guardWorkspacePluginImports`, ../workspace-import-guard.ts), so the
// trust grant's hash covers everything that executes under it.
//
// The containment hook runs in Node's module resolver. vitest's module runner
// resolves `import()` itself, so the end-to-end cases run `PluginLoader.loadAll`
// in a real `node --import tsx` child process — the same resolver `ethos` uses.

import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  guardWorkspacePluginImports,
  resetWorkspaceImportGuardForTests,
  workspaceImportRefusal,
} from '../workspace-import-guard';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SRC = resolve(import.meta.dirname, '..');

let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `ethos-ws-guard-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  resetWorkspaceImportGuardForTests();
  await rm(root, { recursive: true, force: true });
});

describe('workspaceImportRefusal', () => {
  it('refuses a resolution from a guarded folder to a file outside it', async () => {
    const plugin = join(root, 'plugin');
    await mkdir(plugin, { recursive: true });
    guardWorkspacePluginImports(plugin);
    const { realpathSync } = await import('node:fs');
    const real = realpathSync(plugin);
    const parent = pathToFileURL(join(real, 'index.js')).href;
    const outside = pathToFileURL(join(real, '..', 'lib', 'x.js')).href;
    expect(workspaceImportRefusal('../lib/x.js', parent, outside)).toMatch(
      /outside the plugin folder/,
    );
    expect(
      workspaceImportRefusal(
        'dep',
        parent,
        pathToFileURL(join(real, '..', 'node_modules', 'dep', 'i.js')).href,
      ),
    ).toMatch(/outside the plugin folder/);
  });

  it('allows files inside the folder, builtins, data: URLs, and unguarded parents', async () => {
    const plugin = join(root, 'plugin');
    await mkdir(plugin, { recursive: true });
    guardWorkspacePluginImports(plugin);
    const { realpathSync } = await import('node:fs');
    const real = realpathSync(plugin);
    const parent = pathToFileURL(join(real, 'index.js')).href;
    const inner = pathToFileURL(join(real, 'node_modules', 'dep', 'index.js')).href;
    expect(workspaceImportRefusal('dep', parent, inner)).toBeNull();
    expect(workspaceImportRefusal('node:fs', parent, 'node:fs')).toBeNull();
    expect(workspaceImportRefusal('data:x', parent, 'data:text/javascript,1')).toBeNull();
    // A sibling folder whose name merely starts with the plugin's.
    const sibling = pathToFileURL(`${real}-evil/x.js`).href;
    expect(workspaceImportRefusal('../plugin-evil/x.js', parent, sibling)).toMatch(/outside/);
    // A module outside every guarded folder is not constrained.
    const other = pathToFileURL(join(real, '..', 'other.js')).href;
    expect(workspaceImportRefusal('./x.js', other, pathToFileURL('/tmp/x.js').href)).toBeNull();
  });
});

describe('PluginLoader contains a trusted workspace plugin in a real process', () => {
  it('refuses relative, hoisted-bare and dynamic escapes; loads a self-contained plugin', async () => {
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const plugins = join(cwd, '.ethos', 'plugins');
    await mkdir(join(home, '.ethos', 'plugins'), { recursive: true });
    await mkdir(join(cwd, 'lib'), { recursive: true });
    const mark = (name: string) =>
      `globalThis.__ran ??= {}; globalThis.__ran[${JSON.stringify(name)}] = true;`;
    await writeFile(join(cwd, 'lib', 'x.mjs'), `${mark('outside')} export const x = 1;`);
    // A dependency hoisted to the repo's own node_modules.
    await mkdir(join(cwd, 'node_modules', 'hoisted'), { recursive: true });
    await writeFile(
      join(cwd, 'node_modules', 'hoisted', 'package.json'),
      JSON.stringify({ name: 'hoisted', type: 'module', main: 'index.js' }),
    );
    await writeFile(
      join(cwd, 'node_modules', 'hoisted', 'index.js'),
      `${mark('hoisted')} export const h = 1;`,
    );

    const plugin = async (name: string, files: Record<string, string>) => {
      const dir = join(plugins, name);
      for (const [rel, body] of Object.entries(files)) {
        await mkdir(join(dir, rel, '..'), { recursive: true });
        await writeFile(join(dir, rel), body);
      }
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name, type: 'module', main: 'index.mjs' }),
      );
      return dir;
    };
    const tool = (name: string) =>
      `export async function activate(api) { api.registerTool({ name: ${JSON.stringify(name)}, description: 'x', schema: { type: 'object', properties: {} }, async execute() { return { ok: true, value: 'x' }; } }); }`;
    const dirs = [
      await plugin('relative', {
        'index.mjs': `import { x } from '../../../lib/x.mjs';\n${tool('relative_tool')}`,
      }),
      await plugin('hoisted', {
        'index.mjs': `import { h } from 'hoisted';\n${tool('hoisted_tool')}`,
      }),
      await plugin('dynamic', {
        'index.mjs': `export async function activate() { await import('../../../lib/x.mjs'); }`,
      }),
      await plugin('contained', {
        'index.mjs': `import { v } from './lib/inner.mjs';\nimport { d } from 'dep';\n${mark('contained')}\n${tool('contained_tool')}`,
        'lib/inner.mjs': 'export const v = 1;',
        'node_modules/dep/package.json': JSON.stringify({
          name: 'dep',
          type: 'module',
          main: 'index.js',
        }),
        'node_modules/dep/index.js': 'import "node:path"; export const d = 1;',
      }),
    ];

    const script = join(root, 'run.mts');
    await writeFile(
      script,
      `
import { FsStorage } from ${JSON.stringify(join(REPO_ROOT, 'packages/storage-fs/src/index.ts'))};
import { PluginLoader, trustWorkspacePlugin } from ${JSON.stringify(join(SRC, 'index.ts'))};
import { DefaultHookRegistry, DefaultLLMProviderRegistry, DefaultMemoryProviderRegistry, DefaultPersonalityRegistry, DefaultToolRegistry } from ${JSON.stringify(join(REPO_ROOT, 'packages/core/src/index.ts'))};
const storage = new FsStorage();
for (const dir of ${JSON.stringify(dirs)}) await trustWorkspacePlugin(storage, ${JSON.stringify(join(home, '.ethos', 'plugins'))}, dir);
const warnings: string[] = [];
const logger: any = { debug() {}, info() {}, error() {}, warn: (m: string) => warnings.push(m), child: () => logger };
const tools = new DefaultToolRegistry();
const l = new PluginLoader({ tools, hooks: new DefaultHookRegistry(), injectors: [], injectorPluginIds: new Map(), personalities: new DefaultPersonalityRegistry(), llmProviders: new DefaultLLMProviderRegistry(), memoryProviders: new DefaultMemoryProviderRegistry() } as any, { storage, dataDir: ${JSON.stringify(join(home, '.ethos'))}, cwd: ${JSON.stringify(cwd)}, logger });
await l.loadAll();
process.stdout.write(JSON.stringify({
  ran: (globalThis as any).__ran ?? {},
  tools: ['relative_tool', 'hoisted_tool', 'contained_tool'].filter((t) => tools.get(t)),
  loaded: ['relative', 'hoisted', 'dynamic', 'contained'].filter((p) => l.isLoaded(p)),
  warnings,
}));
`,
    );
    const child = spawnSync(process.execPath, ['--import', 'tsx', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const out = JSON.parse(child.stdout) as {
      ran: Record<string, boolean>;
      tools: string[];
      loaded: string[];
      warnings: string[];
    };
    // Nothing outside a plugin folder ever evaluated.
    expect(out.ran).toEqual({ contained: true });
    expect(out.tools).toEqual(['contained_tool']);
    expect(out.loaded).not.toContain('relative');
    expect(out.loaded).not.toContain('hoisted');
    expect(out.loaded).toContain('contained');
    const refusals = out.warnings.filter((w) => /outside the plugin folder/.test(w)).join('\n');
    expect(refusals).toMatch(/"\.\.\/\.\.\/\.\.\/lib\/x\.mjs"/);
    expect(refusals).toMatch(/"hoisted"/);
  }, 90_000);
});
