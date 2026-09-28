// UBP-009 / owner decision D4 — plugin code inside the working directory
// (`<cwd>/.ethos/plugins`, `<cwd>/node_modules/ethos-plugin-*`) loads only after
// an explicit trust grant keyed on (directory, content hash), and never shadows
// a same-id plugin the user installed under `~/.ethos/plugins`.

import { mkdir, rm, writeFile } from 'node:fs/promises';
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
