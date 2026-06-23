import {
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import type { CliSubcommandContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { PluginRegistries } from '../index';
import { PluginApiImpl } from '../index';

function makeRegistries(): PluginRegistries {
  const injectors: import('@ethosagent/types').ContextInjector[] = [];
  return {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors,
    injectorPluginIds: new Map<import('@ethosagent/types').ContextInjector, string>(),
    personalities: new DefaultPersonalityRegistry(),
    llmProviders: new DefaultLLMProviderRegistry(),
    memoryProviders: new DefaultMemoryProviderRegistry(),
  };
}

describe('PluginApiImpl.registerCliSubcommand', () => {
  it('registers a CLI subcommand and retrieves its handler', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);
    const handler = async (_ctx: CliSubcommandContext) => 0;

    api.registerCliSubcommand({
      name: 'my-cmd',
      description: 'A custom command',
      handler,
    });

    expect(api.getCliSubcommandHandler('my-cmd')).toBe(handler);
  });

  it('returns undefined for unregistered subcommand', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    expect(api.getCliSubcommandHandler('nonexistent')).toBeUndefined();
  });

  it('getAllCliSubcommands returns all registered commands', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    api.registerCliSubcommand({
      name: 'cmd-a',
      description: 'Command A',
      handler: async () => 0,
    });
    api.registerCliSubcommand({
      name: 'cmd-b',
      description: 'Command B',
      handler: async () => 0,
    });

    const cmds = api.getAllCliSubcommands();
    expect(cmds).toHaveLength(2);
    expect(cmds.map((c) => c.name)).toContain('cmd-a');
    expect(cmds.map((c) => c.name)).toContain('cmd-b');
  });

  it('normalizes command names to lowercase', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);
    const handler = async () => 0;

    api.registerCliSubcommand({
      name: 'MyCmd',
      description: 'Mixed case',
      handler,
    });

    expect(api.getCliSubcommandHandler('mycmd')).toBe(handler);
    expect(api.getCliSubcommandHandler('MyCmd')).toBe(handler);
  });

  it('cleanup clears CLI subcommand handlers', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    api.registerCliSubcommand({
      name: 'temp-cmd',
      description: 'Temporary',
      handler: async () => 0,
    });

    expect(api.getCliSubcommandHandler('temp-cmd')).toBeDefined();
    api.cleanup();
    expect(api.getCliSubcommandHandler('temp-cmd')).toBeUndefined();
  });

  it('passes handler to cliSubcommandRegistry when present', () => {
    const registered: {
      name: string;
      description: string;
      handler?: (ctx: CliSubcommandContext) => Promise<number>;
      pluginId?: string;
    }[] = [];
    const registries = makeRegistries();
    registries.cliSubcommandRegistry = {
      register(cmd: {
        name: string;
        description: string;
        handler?: (ctx: CliSubcommandContext) => Promise<number>;
        pluginId?: string;
      }) {
        registered.push(cmd);
      },
      get(_name: string) {
        return undefined;
      },
      getAll() {
        return [];
      },
    };
    const api = new PluginApiImpl('test-plugin', registries);
    const handler = async (_ctx: CliSubcommandContext) => 0;

    api.registerCliSubcommand({
      name: 'my-cmd',
      description: 'A custom command',
      handler,
    });

    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe('test-plugin:my-cmd');
    expect(registered[0]?.pluginId).toBe('test-plugin');
    expect(registered[0]?.handler).toBe(handler);
  });
});

describe('PluginApiImpl.registerCommand', () => {
  it('registers a prompt command as a slash command only', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    api.registerCommand({
      name: 'greet',
      description: 'Greet the user',
      prompt: 'Hello $ARGUMENTS!',
    });

    expect(api.getSlashHandler('greet')).toBeDefined();
    expect(api.getCliSubcommandHandler('greet')).toBeUndefined();
  });

  it('registers a run command as both slash and CLI', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    api.registerCommand({
      name: 'ping',
      description: 'Ping pong',
      run: async () => ({ exitCode: 0, output: 'pong' }),
    });

    expect(api.getSlashHandler('ping')).toBeDefined();
    expect(api.getCliSubcommandHandler('ping')).toBeDefined();
  });

  it('rejects a command with both prompt and run', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    expect(() =>
      api.registerCommand({
        name: 'bad',
        description: 'bad command',
        prompt: 'hi',
        run: async () => ({ exitCode: 0 }),
      }),
    ).toThrow('exactly one of prompt or run');
  });

  it('rejects a command with neither prompt nor run', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    expect(() =>
      api.registerCommand({
        name: 'empty',
        description: 'empty command',
      }),
    ).toThrow('exactly one of prompt or run');
  });

  it('stores command definitions', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    api.registerCommand({
      name: 'test-cmd',
      description: 'A test',
      prompt: 'Do the thing',
    });

    const defs = api.getCommandDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('test-cmd');
  });
});

describe('namespacing', () => {
  it('registerSlashCommand uses namespaced key in registry', () => {
    const registered: { name: string; description: string; usage: string; prefix?: string }[] = [];
    const registries = makeRegistries();
    registries.slashRegistry = {
      register(cmd: { name: string; description: string; usage: string; prefix?: string }) {
        registered.push(cmd);
      },
      get(_name: string) {
        return undefined;
      },
    };
    const api = new PluginApiImpl('acme', registries);

    api.registerSlashCommand({
      name: 'Deploy',
      description: 'Deploy things',
      usage: '/deploy',
      handler: async () => 'ok',
    });

    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe('acme:deploy');
  });

  it('registerCliSubcommand uses namespaced key in registry', () => {
    const registered: {
      name: string;
      description: string;
      handler?: (ctx: CliSubcommandContext) => Promise<number>;
      pluginId?: string;
    }[] = [];
    const registries = makeRegistries();
    registries.cliSubcommandRegistry = {
      register(cmd: {
        name: string;
        description: string;
        handler?: (ctx: CliSubcommandContext) => Promise<number>;
        pluginId?: string;
      }) {
        registered.push(cmd);
      },
      get(_name: string) {
        return undefined;
      },
      getAll() {
        return [];
      },
    };
    const api = new PluginApiImpl('acme', registries);

    api.registerCliSubcommand({
      name: 'Deploy',
      description: 'Deploy things',
      handler: async () => 0,
    });

    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe('acme:deploy');
  });

  it('getSlashHandler resolves namespaced name to bare handler', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('acme', registries);
    const handler = async () => 'ok';

    api.registerSlashCommand({
      name: 'deploy',
      description: 'Deploy',
      usage: '/deploy',
      handler,
    });

    expect(api.getSlashHandler('acme:deploy')).toBe(handler);
    expect(api.getSlashHandler('deploy')).toBe(handler);
  });

  it('getCliSubcommandHandler resolves namespaced name to bare handler', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('acme', registries);
    const handler = async () => 0;

    api.registerCliSubcommand({
      name: 'deploy',
      description: 'Deploy',
      handler,
    });

    expect(api.getCliSubcommandHandler('acme:deploy')).toBe(handler);
    expect(api.getCliSubcommandHandler('deploy')).toBe(handler);
  });
});
