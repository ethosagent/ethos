// UBP-009 / owner decision D4 — plugin code inside the working directory
// (`<cwd>/.ethos/plugins`, `<cwd>/node_modules/ethos-plugin-*`) loads only after
// an explicit trust grant keyed on (directory, content hash), and never shadows
// a same-id plugin the user installed under `~/.ethos/plugins`.

import { mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import { PLUGIN_CONTRACT_MAJOR } from '@ethosagent/plugin-contract';
import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ContextInjector, Logger } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverWorkspacePluginDirs,
  PluginLoader,
  trustWorkspacePlugin,
  untrustWorkspacePlugin,
  workspaceTrustState,
} from '../index';

function makeRegistries(): PluginRegistries {
  const injectors: ContextInjector[] = [];
  return {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors,
    injectorPluginIds: new Map<ContextInjector, string>(),
    personalities: new DefaultPersonalityRegistry(),
    llmProviders: new DefaultLLMProviderRegistry(),
    memoryProviders: new DefaultMemoryProviderRegistry(),
  };
}

function captureLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const noop = () => {};
  const logger = {
    debug: noop,
    info: noop,
    warn: (msg: string) => warnings.push(msg),
    error: noop,
    child: () => logger,
  } as unknown as Logger;
  return { logger, warnings };
}

type Ran = Record<string, number>;
const ran = (): Ran => {
  const g = globalThis as { __ubpWorkspaceRan?: Ran };
  g.__ubpWorkspaceRan ??= {};
  return g.__ubpWorkspaceRan;
};

/** A plugin whose TOP-LEVEL code records that it ran, under `marker`. */
function pluginSource(marker: string, toolName: string): string {
  return `
globalThis.__ubpWorkspaceRan ??= {};
globalThis.__ubpWorkspaceRan[${JSON.stringify(marker)}] = (globalThis.__ubpWorkspaceRan[${JSON.stringify(marker)}] ?? 0) + 1;
export async function activate(api) {
  api.registerTool({
    name: ${JSON.stringify(toolName)},
    description: 'x',
    schema: { type: 'object', properties: {} },
    async execute() { return { ok: true, value: ${JSON.stringify(marker)} }; },
  });
}
`.trim();
}

let root: string;
let home: string;
let dataDir: string;
let cwd: string;
let savedHome: string | undefined;
let tag: string;

beforeEach(async () => {
  tag = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  root = join(tmpdir(), `ethos-ws-trust-${tag}`);
  home = join(root, 'home');
  dataDir = join(home, '.ethos');
  cwd = join(root, 'repo');
  await mkdir(join(dataDir, 'plugins'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  savedHome = process.env.HOME;
  // `loadAll` finds the user plugins dir through `os.homedir()`, which reads HOME.
  process.env.HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

async function writeDirPlugin(base: string, name: string, marker: string, tool: string) {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.ts'), pluginSource(marker, tool));
  return dir;
}

function loader(logger?: Logger) {
  const registries = makeRegistries();
  return {
    registries,
    loader: new PluginLoader(registries, {
      storage: new FsStorage(),
      dataDir,
      cwd,
      ...(logger ? { logger } : {}),
    }),
  };
}

describe('workspace plugin trust', () => {
  it('does not import an untrusted <cwd>/.ethos/plugins plugin, and says how to trust it', async () => {
    const marker = `clean-${tag}`;
    await writeDirPlugin(join(cwd, '.ethos', 'plugins'), 'helper', marker, 'helper_tool');
    const { logger, warnings } = captureLogger();
    const { loader: l, registries } = loader(logger);

    await l.loadAll();

    expect(ran()[marker]).toBeUndefined();
    expect(l.isLoaded('helper')).toBe(false);
    expect(registries.tools.get('helper_tool')).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/not trusted.*ethos plugin trust/s);
  });

  it('loads it after `trust`, and refuses it again once its files change', async () => {
    const marker = `granted-${tag}`;
    const dir = await writeDirPlugin(join(cwd, '.ethos', 'plugins'), 'helper', marker, 'h_tool');
    const storage = new FsStorage();
    const pluginsDir = join(dataDir, 'plugins');

    await trustWorkspacePlugin(storage, pluginsDir, dir);
    expect(await workspaceTrustState(storage, pluginsDir, dir)).toBe('trusted');
    const first = loader();
    await first.loader.loadAll();
    expect(first.loader.isLoaded('helper')).toBe(true);
    expect(ran()[marker]).toBe(1);

    await writeFile(join(dir, 'extra.js'), 'export const x = 1;');
    expect(await workspaceTrustState(storage, pluginsDir, dir)).toBe('changed');
    const { logger, warnings } = captureLogger();
    const second = loader(logger);
    await second.loader.loadAll();
    expect(second.loader.isLoaded('helper')).toBe(false);
    expect(warnings.join('\n')).toMatch(/changed since it was trusted/);

    expect(await untrustWorkspacePlugin(storage, pluginsDir, dir)).toBe(true);
    expect(await workspaceTrustState(storage, pluginsDir, dir)).toBe('untrusted');
  });

  it('does not import an untrusted <cwd>/node_modules/ethos-plugin-* package', async () => {
    const marker = `npm-${tag}`;
    const pkgDir = join(cwd, 'node_modules', 'ethos-plugin-x');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'ethos-plugin-x',
        version: '1.0.0',
        main: 'index.mjs',
        ethos: { type: 'plugin', pluginContractMajor: PLUGIN_CONTRACT_MAJOR },
      }),
    );
    await writeFile(join(pkgDir, 'index.mjs'), pluginSource(marker, 'npm_x_tool'));
    const { loader: l } = loader();

    await l.loadAll();

    expect(ran()[marker]).toBeUndefined();
    expect(l.isLoaded('ethos-plugin-x')).toBe(false);
    expect(await discoverWorkspacePluginDirs(new FsStorage(), cwd)).toEqual([pkgDir]);
  });

  it('a trusted cwd plugin never shadows a same-id user-installed plugin', async () => {
    const userMarker = `user-${tag}`;
    const cwdMarker = `cwd-${tag}`;
    await writeDirPlugin(join(dataDir, 'plugins'), 'helper', userMarker, 'user_tool');
    const cwdDir = await writeDirPlugin(
      join(cwd, '.ethos', 'plugins'),
      'helper',
      cwdMarker,
      'cwd_tool',
    );
    await trustWorkspacePlugin(new FsStorage(), join(dataDir, 'plugins'), cwdDir);
    const { logger, warnings } = captureLogger();
    const { loader: l, registries } = loader(logger);

    await l.loadAll();

    expect(l.isLoaded('helper')).toBe(true);
    expect(registries.tools.get('user_tool')).toBeDefined();
    expect(registries.tools.get('cwd_tool')).toBeUndefined();
    expect(ran()[cwdMarker]).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/already loaded from ~\/\.ethos\/plugins/);
  });
});

// V-CC-1 — the grant covers what actually executes: code and skills outside
// the plugin folder are refused, and a nested node_modules is hashed.
describe('workspace plugin trust covers what executes', () => {
  it('a change inside a nested node_modules voids the grant', async () => {
    const dir = await writeDirPlugin(join(cwd, '.ethos', 'plugins'), 'helper', `nm-${tag}`, 't');
    const dep = join(dir, 'node_modules', 'dep');
    await mkdir(dep, { recursive: true });
    await writeFile(join(dep, 'index.js'), 'export const v = 1;');
    const storage = new FsStorage();
    const pluginsDir = join(dataDir, 'plugins');
    await trustWorkspacePlugin(storage, pluginsDir, dir);
    await writeFile(join(dep, 'index.js'), 'export const v = 2;');
    expect(await workspaceTrustState(storage, pluginsDir, dir)).toBe('changed');
  });

  it('refuses a trusted plugin whose skills_dir resolves outside its folder', async () => {
    const dir = join(cwd, '.ethos', 'plugins', 'skilled');
    await mkdir(dir, { recursive: true });
    await mkdir(join(cwd, 'repo-skills'), { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'skilled', ethos: { skills_dir: '../../../repo-skills' } }),
    );
    await trustWorkspacePlugin(new FsStorage(), join(dataDir, 'plugins'), dir);
    const { logger, warnings } = captureLogger();
    const { loader: l } = loader(logger);
    await l.loadAll();
    expect(l.getPluginSkillSources().map((s) => s.dir)).toEqual([]);
    expect(warnings.join('\n')).toMatch(/skills_dir.*outside the plugin folder/);
  });

  it('refuses a trusted node_modules package whose skills_dir resolves outside its folder', async () => {
    const pkgDir = join(cwd, 'node_modules', 'ethos-plugin-sk');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'ethos-plugin-sk', ethos: { skills_dir: '../../skills' } }),
    );
    await trustWorkspacePlugin(new FsStorage(), join(dataDir, 'plugins'), pkgDir);
    const { logger, warnings } = captureLogger();
    const { loader: l } = loader(logger);
    await l.loadAll();
    expect(l.getPluginSkillSources().map((s) => s.dir)).toEqual([]);
    expect(warnings.join('\n')).toMatch(/skills_dir.*outside the plugin folder/);
  });

  it('keeps a skills_dir inside the folder', async () => {
    const dir = join(cwd, '.ethos', 'plugins', 'skilled');
    await mkdir(join(dir, 'skills'), { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'skilled', ethos: { skills_dir: 'skills' } }),
    );
    await trustWorkspacePlugin(new FsStorage(), join(dataDir, 'plugins'), dir);
    const { loader: l } = loader();
    await l.loadAll();
    expect(l.getPluginSkillSources().map((s) => s.dir)).toEqual([join(dir, 'skills')]);
  });
  // Import containment runs in Node's resolver, which vitest's module runner
  // bypasses — pinned in a real process by workspace-import-guard.test.ts.
});

// V2-RT-2 — pnpm links each dependency as a DIRECTORY symlink
// (`node_modules/dep -> .pnpm/dep@1.0.0/node_modules/dep`). The hash records a
// link as its target text and never reads through it (the target's files are
// hashed where they really live); a link that leaves the folder refuses the
// grant with a message instead of an EISDIR.
describe('workspace plugin trust over symlinks', () => {
  async function pnpmPlugin(): Promise<{ dir: string; real: string }> {
    const dir = await writeDirPlugin(join(cwd, '.ethos', 'plugins'), 'helper', `pn-${tag}`, 't');
    const real = join(dir, 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules', 'dep');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'index.js'), 'export const v = 1;');
    await symlink(
      join('.pnpm', 'dep@1.0.0', 'node_modules', 'dep'),
      join(dir, 'node_modules', 'dep'),
    );
    return { dir, real };
  }

  it('trusts a plugin whose dependencies were installed with pnpm inside its folder', async () => {
    const { dir, real } = await pnpmPlugin();
    const storage = new FsStorage();
    const pluginsDir = join(dataDir, 'plugins');
    await trustWorkspacePlugin(storage, pluginsDir, dir);
    expect(await workspaceTrustState(storage, pluginsDir, dir)).toBe('trusted');

    await writeFile(join(real, 'index.js'), 'export const v = 2;');
    expect(await workspaceTrustState(storage, pluginsDir, dir)).toBe('changed');
  });

  it('a retargeted symlink voids the grant', async () => {
    const { dir } = await pnpmPlugin();
    const other = join(dir, 'node_modules', '.pnpm', 'dep@2.0.0', 'node_modules', 'dep');
    await mkdir(other, { recursive: true });
    const storage = new FsStorage();
    const pluginsDir = join(dataDir, 'plugins');
    await trustWorkspacePlugin(storage, pluginsDir, dir);
    await unlink(join(dir, 'node_modules', 'dep'));
    await symlink(
      join('.pnpm', 'dep@2.0.0', 'node_modules', 'dep'),
      join(dir, 'node_modules', 'dep'),
    );
    expect(await workspaceTrustState(storage, pluginsDir, dir)).toBe('changed');
  });

  it('refuses to trust a plugin with a symlink that leaves its folder', async () => {
    const dir = await writeDirPlugin(join(cwd, '.ethos', 'plugins'), 'helper', `out-${tag}`, 't');
    await mkdir(join(cwd, 'outside'), { recursive: true });
    await symlink(join(cwd, 'outside'), join(dir, 'lib'));
    await expect(
      trustWorkspacePlugin(new FsStorage(), join(dataDir, 'plugins'), dir),
    ).rejects.toThrow(/symlink .*lib.* outside the plugin folder/);
  });

  it('warns, naming the reason, when a trusted plugin can no longer be hashed', async () => {
    const dir = await writeDirPlugin(join(cwd, '.ethos', 'plugins'), 'helper', `w-${tag}`, 't');
    await trustWorkspacePlugin(new FsStorage(), join(dataDir, 'plugins'), dir);
    await symlink(tmpdir(), join(dir, 'escape'));
    const { logger, warnings } = captureLogger();
    const { loader: l } = loader(logger);
    await l.loadAll();
    expect(l.isLoaded('helper')).toBe(false);
    expect(warnings.join('\n')).toMatch(/"helper".*not loaded.*outside the plugin folder/s);
  });
});
