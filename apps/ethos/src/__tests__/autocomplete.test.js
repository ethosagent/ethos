import { describe, expect, it } from 'vitest';
import { renderDropdown } from '../lib/autocomplete';
import { buildBaseRegistry, builtInCommands, SlashCommandRegistry } from '../lib/slash-commands';

describe('SlashCommandRegistry', () => {
  it('registers and retrieves built-ins', () => {
    const reg = buildBaseRegistry();
    const all = reg.getAll();
    expect(all.length).toBe(builtInCommands.length);
    for (const cmd of builtInCommands) {
      expect(reg.get(cmd.name)).toMatchObject({ name: cmd.name });
    }
  });
  it('every built-in has name, description, and usage', () => {
    for (const cmd of builtInCommands) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(cmd.usage).toBeTruthy();
    }
  });
  it('filter narrows on prefix', () => {
    const reg = buildBaseRegistry();
    const matches = reg.filter('per');
    const names = matches.map((c) => c.name);
    expect(names).toContain('personality');
    expect(names).not.toContain('help');
  });
  it('filter is case-insensitive', () => {
    const reg = buildBaseRegistry();
    expect(reg.filter('HELP').map((c) => c.name)).toContain('help');
  });
  it('filter returns all commands on empty prefix', () => {
    const reg = buildBaseRegistry();
    expect(reg.filter('')).toHaveLength(builtInCommands.length);
  });
  it('register adds a new command', () => {
    const reg = new SlashCommandRegistry();
    reg.register({ name: 'foo', description: 'Test', usage: '/foo' });
    expect(reg.get('foo')).toMatchObject({ name: 'foo' });
  });
  it('unregister removes a command', () => {
    const reg = buildBaseRegistry();
    reg.unregister('help');
    expect(reg.get('help')).toBeUndefined();
  });
  it('register with prefix stored correctly', () => {
    const reg = new SlashCommandRegistry();
    reg.register({
      name: 'my-skill',
      description: 'A skill',
      usage: '/my-skill',
      prefix: '[skill]',
    });
    const cmd = reg.get('my-skill');
    expect(cmd?.prefix).toBe('[skill]');
  });
});
describe('renderDropdown', () => {
  it('returns empty string for no matches', () => {
    expect(renderDropdown([], 80)).toBe('');
  });
  it('renders a dropdown row per match', () => {
    const reg = buildBaseRegistry();
    const matches = reg.filter('h');
    const output = renderDropdown(matches, 80);
    expect(output).toContain('/help');
    expect(output).toContain('Show all slash commands');
  });
  it('snapshot of the rendered dropdown', () => {
    const commands = [
      {
        name: 'personality',
        description: 'Show or switch personality',
        usage: '/personality [id|list]',
      },
      {
        name: 'personalities',
        description: 'Alias — list all personalities',
        usage: '/personalities',
      },
    ];
    const output = renderDropdown(commands, 80);
    expect(output).toMatchInlineSnapshot(`
      "  /personality                Show or switch personality
        /personalities              Alias — list all personalities
        \x1b[2m↑↓ select · Tab accept · Esc dismiss\x1b[0m"
    `);
  });
  it('truncates lines to column width', () => {
    const commands = [{ name: 'x', description: 'A'.repeat(200), usage: '/x' }];
    const output = renderDropdown(commands, 40);
    for (const line of output.split('\n').slice(0, -1)) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });
  it('caps at MAX_ROWS matches', () => {
    const commands = Array.from({ length: 20 }, (_, i) => ({
      name: `cmd${i}`,
      description: `Desc ${i}`,
      usage: `/cmd${i}`,
    }));
    const output = renderDropdown(commands, 80);
    // 8 data rows + 1 hint row
    expect(output.split('\n')).toHaveLength(9);
  });
});
