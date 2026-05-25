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
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginLoader } from '../index';

function makeRegistries() {
  const injectors = [];
  return {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors,
    injectorPluginIds: new Map(),
    personalities: new DefaultPersonalityRegistry(),
    llmProviders: new DefaultLLMProviderRegistry(),
    memoryProviders: new DefaultMemoryProviderRegistry(),
  };
}
let testDir;
beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-plugin-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});
afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});
// Writes a minimal plugin to a temp directory and returns the dir path
async function writePlugin(dir, name, code) {
  const pluginDir = join(dir, name);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'index.ts'), code);
  return pluginDir;
}
describe('PluginLoader', () => {
  it('loads a plugin that registers a tool', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries);
    await writePlugin(
      testDir,
      'my-plugin',
      `
import { ok } from '@ethosagent/plugin-sdk/tool-helpers';
export async function activate(api) {
  api.registerTool({
    name: 'my_plugin_tool',
    description: 'Test tool',
    schema: { type: 'object', properties: {} },
    async execute() { return { ok: true, value: 'from plugin' }; },
  });
}
      `.trim(),
    );
    await loader.loadFromDirectory(testDir);
    expect(loader.isLoaded('my-plugin')).toBe(true);
    expect(registries.tools.get('my_plugin_tool')).toBeDefined();
  });
  it('unloads a plugin and removes its tools', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries);
    await writePlugin(
      testDir,
      'unload-test',
      `
export async function activate(api) {
  api.registerTool({
    name: 'removable_tool',
    description: 'Will be removed',
    schema: { type: 'object', properties: {} },
    async execute() { return { ok: true, value: 'x' }; },
  });
}
export async function deactivate() {}
      `.trim(),
    );
    await loader.loadFromDirectory(testDir);
    expect(registries.tools.get('removable_tool')).toBeDefined();
    await loader.unload('unload-test');
    expect(loader.isLoaded('unload-test')).toBe(false);
    expect(registries.tools.get('removable_tool')).toBeUndefined();
  });
  it('skips directories without activate export', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries);
    await writePlugin(testDir, 'broken-plugin', '// no activate export');
    await loader.loadFromDirectory(testDir);
    expect(loader.list()).toHaveLength(0);
  });
  it('does not throw when directory does not exist', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries);
    await expect(loader.loadFromDirectory(join(testDir, 'nonexistent'))).resolves.not.toThrow();
  });
  it('list() returns loaded plugin ids', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries);
    await writePlugin(testDir, 'plugin-a', 'export async function activate(api) {}');
    await writePlugin(testDir, 'plugin-b', 'export async function activate(api) {}');
    await loader.loadFromDirectory(testDir);
    const ids = loader.list();
    expect(ids).toContain('plugin-a');
    expect(ids).toContain('plugin-b');
  });
  it('unloadAll() removes all plugins', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries);
    await writePlugin(testDir, 'p1', 'export async function activate(api) {}');
    await writePlugin(testDir, 'p2', 'export async function activate(api) {}');
    await loader.loadFromDirectory(testDir);
    expect(loader.list()).toHaveLength(2);
    await loader.unloadAll();
    expect(loader.list()).toHaveLength(0);
  });
  it('loadFromNodeModules discovers scoped @ethos-plugins/* packages', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries);
    // Lay out a fake node_modules with both a flat ethos-plugin-* and a scoped one.
    const flatDir = join(testDir, 'ethos-plugin-flat');
    await mkdir(flatDir, { recursive: true });
    await writeFile(
      join(flatDir, 'package.json'),
      JSON.stringify({ name: 'ethos-plugin-flat', main: 'index.ts', ethos: { type: 'plugin' } }),
    );
    await writeFile(
      join(flatDir, 'index.ts'),
      `export async function activate(api) {
        api.registerTool({
          name: 'flat_tool',
          description: '',
          schema: { type: 'object', properties: {} },
          async execute() { return { ok: true, value: 'flat' }; },
        });
      }`,
    );
    const scopedDir = join(testDir, '@ethos-plugins', 'scoped');
    await mkdir(scopedDir, { recursive: true });
    await writeFile(
      join(scopedDir, 'package.json'),
      JSON.stringify({
        name: '@ethos-plugins/scoped',
        main: 'index.ts',
        ethos: { type: 'plugin' },
      }),
    );
    await writeFile(
      join(scopedDir, 'index.ts'),
      `export async function activate(api) {
        api.registerTool({
          name: 'scoped_tool',
          description: '',
          schema: { type: 'object', properties: {} },
          async execute() { return { ok: true, value: 'scoped' }; },
        });
      }`,
    );
    await loader.loadFromNodeModules(testDir);
    expect(registries.tools.get('flat_tool')).toBeDefined();
    expect(registries.tools.get('scoped_tool')).toBeDefined();
  });
  // --- Credential management -------------------------------------------------
  describe('credential methods', () => {
    it('setCredential throws for an unknown plugin id', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const loader = new PluginLoader(registries, {
        credentialStorage: credStorage,
        dataDir: testDir,
      });
      await expect(loader.setCredential('nonexistent', 'API_KEY', 'secret')).rejects.toThrow(
        'Plugin "nonexistent" is not loaded',
      );
    });
    it('setCredential writes credential and meta files via PluginApiImpl', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const loader = new PluginLoader(registries, {
        credentialStorage: credStorage,
        dataDir: '/test-data',
      });
      await writePlugin(testDir, 'cred-test', 'export async function activate(api) {}');
      await loader.loadFromDirectory(testDir);
      expect(loader.isLoaded('cred-test')).toBe(true);
      await loader.setCredential('cred-test', 'API_KEY', 'my-secret-value');
      const credValue = await credStorage.read('/test-data/plugins/cred-test/credentials/API_KEY');
      expect(credValue).toBe('my-secret-value');
      const metaRaw = await credStorage.read(
        '/test-data/plugins/cred-test/credentials/API_KEY.meta',
      );
      expect(metaRaw).not.toBeNull();
      const meta = JSON.parse(metaRaw ?? '');
      expect(meta.updatedAt).toBeDefined();
    });
    it('getCredentialMeta returns null for unset credential', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const loader = new PluginLoader(registries, {
        credentialStorage: credStorage,
        dataDir: '/test-data',
      });
      const meta = await loader.getCredentialMeta('some-plugin', 'MISSING_KEY');
      expect(meta).toBeNull();
    });
    it('getCredentialMeta returns updatedAt after setCredential', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const loader = new PluginLoader(registries, {
        credentialStorage: credStorage,
        dataDir: '/test-data',
      });
      await writePlugin(testDir, 'meta-test', 'export async function activate(api) {}');
      await loader.loadFromDirectory(testDir);
      await loader.setCredential('meta-test', 'TOKEN', 'abc123');
      const meta = await loader.getCredentialMeta('meta-test', 'TOKEN');
      expect(meta).not.toBeNull();
      expect(meta?.updatedAt).toBeDefined();
      expect(Number.isNaN(Date.parse(meta?.updatedAt ?? ''))).toBe(false);
    });
    it('clearCredential removes credential and meta files', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const loader = new PluginLoader(registries, {
        credentialStorage: credStorage,
        dataDir: '/test-data',
      });
      await writePlugin(testDir, 'clear-test', 'export async function activate(api) {}');
      await loader.loadFromDirectory(testDir);
      await loader.setCredential('clear-test', 'SECRET', 'value');
      expect(await credStorage.exists('/test-data/plugins/clear-test/credentials/SECRET')).toBe(
        true,
      );
      expect(
        await credStorage.exists('/test-data/plugins/clear-test/credentials/SECRET.meta'),
      ).toBe(true);
      await loader.clearCredential('clear-test', 'SECRET');
      expect(await credStorage.exists('/test-data/plugins/clear-test/credentials/SECRET')).toBe(
        false,
      );
      expect(
        await credStorage.exists('/test-data/plugins/clear-test/credentials/SECRET.meta'),
      ).toBe(false);
    });
    it('listCredentialKeys merges manifest declarations with storage state', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const loader = new PluginLoader(registries, {
        credentialStorage: credStorage,
        dataDir: '/test-data',
      });
      const pluginDir = join(testDir, 'list-test');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'list-test',
          version: '1.0.0',
          ethos: {
            type: 'plugin',
            credentials: [
              {
                key: 'API_KEY',
                label: 'API Key',
                type: 'secret',
                description: 'Main API key',
                required: true,
              },
              {
                key: 'WORKSPACE',
                label: 'Workspace ID',
                type: 'text',
              },
            ],
          },
        }),
      );
      await writeFile(join(pluginDir, 'index.ts'), 'export async function activate(api) {}');
      await loader.loadFromDirectory(testDir);
      await loader.setCredential('list-test', 'API_KEY', 'secret-value');
      await credStorage.mkdir('/test-data/plugins/list-test/credentials');
      await credStorage.write(
        '/test-data/plugins/list-test/credentials/EXTRA_TOKEN',
        'extra-value',
      );
      await credStorage.write(
        '/test-data/plugins/list-test/credentials/EXTRA_TOKEN.meta',
        JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z' }),
      );
      const keys = await loader.listCredentialKeys('list-test');
      expect(keys).toHaveLength(3);
      const apiKey = keys.find((k) => k.key === 'API_KEY');
      expect(apiKey).toBeDefined();
      expect(apiKey?.isSet).toBe(true);
      expect(apiKey?.label).toBe('API Key');
      expect(apiKey?.type).toBe('secret');
      expect(apiKey?.description).toBe('Main API key');
      expect(apiKey?.required).toBe(true);
      expect(apiKey?.updatedAt).toBeDefined();
      const workspace = keys.find((k) => k.key === 'WORKSPACE');
      expect(workspace).toBeDefined();
      expect(workspace?.isSet).toBe(false);
      expect(workspace?.label).toBe('Workspace ID');
      expect(workspace?.updatedAt).toBeNull();
      const extra = keys.find((k) => k.key === 'EXTRA_TOKEN');
      expect(extra).toBeDefined();
      expect(extra?.isSet).toBe(true);
      expect(extra?.label).toBe('EXTRA_TOKEN');
      expect(extra?.type).toBe('text');
      expect(extra?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });
    it('listCredentialKeys returns empty array for plugin with no credentials', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const loader = new PluginLoader(registries, {
        credentialStorage: credStorage,
        dataDir: '/test-data',
      });
      await writePlugin(testDir, 'no-creds', 'export async function activate(api) {}');
      await loader.loadFromDirectory(testDir);
      const keys = await loader.listCredentialKeys('no-creds');
      expect(keys).toHaveLength(0);
    });
  });
  // --- Phase 30.6 — plugin contract version gate ---------------------------
  describe('Phase 30.6: contract major gate', () => {
    it('rejects a directory plugin declaring an incompatible pluginContractMajor', async () => {
      const registries = makeRegistries();
      const warns = [];
      const logger = {
        debug: () => {},
        info: () => {},
        warn: (msg) => {
          warns.push(msg);
        },
        error: () => {},
        child: () => logger,
      };
      const loader = new PluginLoader(registries, { logger });
      const pluginDir = join(testDir, 'old-major');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'old-major',
          version: '1.0.0',
          ethos: { type: 'plugin', pluginContractMajor: 999 },
        }),
      );
      await writeFile(
        join(pluginDir, 'index.ts'),
        `export async function activate(api) {
          api.registerTool({
            name: 'should_not_register',
            description: '',
            schema: { type: 'object', properties: {} },
            async execute() { return { ok: true, value: 'no' }; },
          });
        }`,
      );
      await loader.loadFromDirectory(testDir);
      expect(loader.isLoaded('old-major')).toBe(false);
      expect(registries.tools.get('should_not_register')).toBeUndefined();
      // Rejection message names plugin, declared major, current major, and links to MIGRATIONS.md
      const msg = warns.find((w) => w.includes('old-major'));
      expect(msg).toBeDefined();
      expect(msg).toMatch(/pluginContractMajor=999/);
      expect(msg).toMatch(/MIGRATIONS\.md/);
    });
    it('rejects an npm-discovered plugin declaring an incompatible major', async () => {
      const registries = makeRegistries();
      const warns = [];
      const logger = {
        debug: () => {},
        info: () => {},
        warn: (msg) => {
          warns.push(msg);
        },
        error: () => {},
        child: () => logger,
      };
      const loader = new PluginLoader(registries, { logger });
      const pluginDir = join(testDir, 'ethos-plugin-bad');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'ethos-plugin-bad',
          main: 'index.ts',
          ethos: { type: 'plugin', pluginContractMajor: 42 },
        }),
      );
      await writeFile(
        join(pluginDir, 'index.ts'),
        `export async function activate(api) {
          api.registerTool({
            name: 'bad_tool',
            description: '',
            schema: { type: 'object', properties: {} },
            async execute() { return { ok: true, value: 'no' }; },
          });
        }`,
      );
      await loader.loadFromNodeModules(testDir);
      expect(registries.tools.get('bad_tool')).toBeUndefined();
      expect(warns.find((w) => /ethos-plugin-bad.*pluginContractMajor=42/.test(w))).toBeDefined();
    });
    it('allows a plugin without pluginContractMajor (backward compat)', async () => {
      const registries = makeRegistries();
      const loader = new PluginLoader(registries);
      const pluginDir = join(testDir, 'no-major');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({ name: 'no-major', version: '1.0.0', ethos: { type: 'plugin' } }),
      );
      await writeFile(
        join(pluginDir, 'index.ts'),
        `export async function activate(api) {
          api.registerTool({
            name: 'compat_tool',
            description: '',
            schema: { type: 'object', properties: {} },
            async execute() { return { ok: true, value: 'ok' }; },
          });
        }`,
      );
      await loader.loadFromDirectory(testDir);
      expect(loader.isLoaded('no-major')).toBe(true);
      expect(registries.tools.get('compat_tool')).toBeDefined();
    });
  });
});
