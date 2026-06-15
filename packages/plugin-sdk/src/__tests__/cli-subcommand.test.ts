import {
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
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
    const handler = async (_argv: string[]) => {};

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
      handler: async () => {},
    });
    api.registerCliSubcommand({
      name: 'cmd-b',
      description: 'Command B',
      handler: async () => {},
    });

    const cmds = api.getAllCliSubcommands();
    expect(cmds).toHaveLength(2);
    expect(cmds.map((c) => c.name)).toContain('cmd-a');
    expect(cmds.map((c) => c.name)).toContain('cmd-b');
  });

  it('normalizes command names to lowercase', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);
    const handler = async () => {};

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
      handler: async () => {},
    });

    expect(api.getCliSubcommandHandler('temp-cmd')).toBeDefined();
    api.cleanup();
    expect(api.getCliSubcommandHandler('temp-cmd')).toBeUndefined();
  });
});
