// §9.8 — Command SDK acceptance test.
// Proves both authoring paths (file-drop, plugin) work end-to-end:
//   - file-drop markdown → slash command (zero code)
//   - plugin registerCommand(prompt) → slash only
//   - plugin registerCommand(run) → slash + CLI
//   - collision protection (built-in shadowing)
//   - tool-grant intersection
//   - validateCommandDefinition conformance

import {
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import { intersectToolGrants, PluginApiImpl } from '@ethosagent/plugin-sdk';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { validateCommandDefinition } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { CliSubcommandRegistry } from '../lib/cli-subcommand-registry';
import type { CommandMeta } from '../lib/command-loader';
import { scanCommandsIntoRegistry } from '../lib/command-loader';
import { buildBaseRegistry, SlashCommandRegistry } from '../lib/slash-commands';

function makeRegistries(overrides?: Partial<PluginRegistries>): PluginRegistries {
  const injectors: import('@ethosagent/types').ContextInjector[] = [];
  return {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors,
    injectorPluginIds: new Map<import('@ethosagent/types').ContextInjector, string>(),
    personalities: new DefaultPersonalityRegistry(),
    llmProviders: new DefaultLLMProviderRegistry(),
    memoryProviders: new DefaultMemoryProviderRegistry(),
    ...overrides,
  };
}

describe('Command SDK acceptance (§9.8)', () => {
  // ---- Test 1: File-drop command (zero code) ----------------------------

  it('file-drop: a markdown file becomes a registered slash command', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/commands');
    await storage.write(
      '/commands/hello.md',
      [
        '---',
        'description: Say hello',
        'argument-hint: <name>',
        'allowed-tools: [read_file]',
        '---',
        '',
        'Hello $ARGUMENTS! Welcome to ethos.',
      ].join('\n'),
    );

    const registry = new SlashCommandRegistry();
    const cache = new Map<string, CommandMeta>();
    await scanCommandsIntoRegistry(
      storage,
      [{ path: '/commands', scope: 'global' }],
      registry,
      cache,
    );

    // Registered in slash registry
    const cmd = registry.get('hello');
    expect(cmd).toBeDefined();
    expect(cmd?.description).toBe('Say hello');
    expect(cmd?.prefix).toBe('[command]');

    // Command definition has the right metadata
    const meta = cache.get('hello');
    expect(meta).toBeDefined();
    expect(meta?.definition.prompt).toContain('Hello $ARGUMENTS');
    expect(meta?.definition.allowedTools).toEqual(['read_file']);
    expect(meta?.definition.scope).toBe('global');
  });

  // ---- Test 2: Plugin command with run handler → slash + CLI ------------

  it('plugin: registerCommand with run handler reaches both slash and CLI', () => {
    const cliRegistry = new CliSubcommandRegistry();
    const slashRegistry = new SlashCommandRegistry();
    const registries = makeRegistries({
      slashRegistry,
      cliSubcommandRegistry: cliRegistry,
    });

    const api = new PluginApiImpl('demo-plugin', registries);

    api.registerCommand({
      name: 'greet',
      description: 'Greet someone',
      run: async (ctx) => ({
        exitCode: 0,
        output: `Hello ${ctx.args.positional.join(' ')}!`,
      }),
    });

    // Verify slash command registration (namespaced)
    const slashCmd = slashRegistry.get('demo-plugin:greet');
    expect(slashCmd).toBeDefined();
    expect(slashCmd?.description).toBe('Greet someone');

    // Verify CLI subcommand registration (namespaced)
    const cliCmd = cliRegistry.get('demo-plugin:greet');
    expect(cliCmd).toBeDefined();
    expect(cliCmd?.pluginId).toBe('demo-plugin');
    expect(cliCmd?.handler).toBeDefined();

    // Verify the handler can be invoked via PluginApiImpl
    expect(api.getSlashHandler('greet')).toBeDefined();
    expect(api.getCliSubcommandHandler('greet')).toBeDefined();
  });

  // ---- Test 3: Plugin prompt-mediated command → slash only --------------

  it('plugin: registerCommand with prompt reaches slash only (not CLI)', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('demo-plugin', registries);

    api.registerCommand({
      name: 'analyze',
      description: 'Analyze code',
      prompt: 'Analyze the following code: $ARGUMENTS',
      allowedTools: ['read_file', 'bash'],
    });

    // Slash yes
    expect(api.getSlashHandler('analyze')).toBeDefined();
    // CLI no (prompt-only commands don't get CLI subcommands)
    expect(api.getCliSubcommandHandler('analyze')).toBeUndefined();
  });

  // ---- Test 4: Collision protection (built-in shadowing) ----------------

  it('file-drop cannot shadow built-in slash commands', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/commands');
    await storage.write('/commands/help.md', '---\ndescription: Evil help\n---\nEvil');

    const registry = buildBaseRegistry(); // includes built-in /help
    const cache = new Map<string, CommandMeta>();
    await scanCommandsIntoRegistry(
      storage,
      [{ path: '/commands', scope: 'global' }],
      registry,
      cache,
    );

    // Built-in /help should NOT be shadowed
    expect(registry.get('help')?.description).toBe('Show all slash commands');
  });

  // ---- Test 5: Tool-grant intersection validation -----------------------

  it('command allowedTools are intersected with personality toolset', () => {
    const commandTools = ['read_file', 'bash', 'web_search'];
    const personalityToolset = ['read_file', 'write_file', 'bash'];
    const result = intersectToolGrants(commandTools, personalityToolset);
    expect(result).toEqual(['read_file', 'bash']);
  });

  // ---- Test 6: validateCommandDefinition conformance --------------------

  it('validateCommandDefinition rejects invalid commands', () => {
    // Both prompt and run
    expect(
      validateCommandDefinition({
        name: 'bad',
        description: 'bad',
        prompt: 'hi',
        run: async () => ({ exitCode: 0 }),
      }),
    ).toContain('exactly one');

    // Neither
    expect(
      validateCommandDefinition({
        name: 'bad',
        description: 'bad',
      }),
    ).toContain('exactly one');

    // Valid
    expect(
      validateCommandDefinition({
        name: 'good',
        description: 'good',
        prompt: 'do stuff',
      }),
    ).toBeNull();
  });
});
