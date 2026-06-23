import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import { PluginApiImpl } from '@ethosagent/plugin-sdk';
import type { WiringSlashRegistry } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { buildChatHelpText } from '../commands/chat';
import { buildBaseRegistry, SlashCommandRegistry } from '../lib/slash-commands';

// G3 — plugin slash commands in the CLI. Covers the two seams this fix
// connected: (1) the apps' SlashCommandRegistry structurally satisfies the
// wiring layer's WiringSlashRegistry (so chat.ts can pass it through
// resolveActiveLoop → createAgentLoop → loadPlugins), and (2) a plugin's
// registerSlashCommand lands in that registry for autocomplete; (3) /help
// merges plugin commands with a [plugin] suffix.

describe('SlashCommandRegistry ↔ wiring threading (G3)', () => {
  it('SlashCommandRegistry satisfies the WiringSlashRegistry contract', () => {
    // Compile-time guard: if either shape drifts, this assignment fails to
    // typecheck and the plugin-command pipeline silently dies again.
    const registry: WiringSlashRegistry = new SlashCommandRegistry();
    expect(typeof registry.register).toBe('function');
    expect(typeof registry.get).toBe('function');
  });

  it('plugin registerSlashCommand lands in the apps registry with a plugin prefix', () => {
    const registry = buildBaseRegistry();
    const api = new PluginApiImpl('my-plugin', {
      slashRegistry: registry,
    } as unknown as PluginRegistries);

    api.registerSlashCommand({
      name: 'MyCmd',
      description: 'Does plugin things',
      usage: '/mycmd <arg>',
      handler: async () => 'ok',
    });

    const cmd = registry.get('my-plugin:mycmd');
    expect(cmd).toBeDefined();
    expect(cmd?.description).toBe('Does plugin things');
    expect(cmd?.prefix).toBe('[plugin:my-plugin]');
    // Visible to autocomplete's prefix filter (namespaced).
    expect(registry.filter('my-plugin:myc').map((c) => c.name)).toContain('my-plugin:mycmd');
  });
});

describe('buildChatHelpText (G3 /help merge)', () => {
  it('lists only built-ins when no plugin commands exist', () => {
    const text = buildChatHelpText([]);
    expect(text).toContain('/new');
    expect(text).not.toContain('[plugin]');
  });

  it('appends plugin commands with a [plugin] suffix', () => {
    const text = buildChatHelpText([
      { name: 'mycmd', description: 'Does plugin things' },
      { name: 'other', description: 'Another one' },
    ]);
    expect(text).toContain('/mycmd');
    expect(text).toContain('Does plugin things [plugin]');
    expect(text).toContain('Another one [plugin]');
  });
});
