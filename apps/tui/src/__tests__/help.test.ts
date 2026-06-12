import { describe, expect, it } from 'vitest';
import { buildHelpText } from '../help';

const state = { readonlyMode: false, verbose: false };

describe('buildHelpText', () => {
  it('lists every TUI built-in with no external commands', () => {
    const text = buildHelpText(state);
    for (const name of [
      '/new',
      '/personality',
      '/model',
      '/sessions',
      '/memory',
      '/usage',
      '/budget',
      '/readonly',
      '/verbose',
      '/details',
      '/skin',
      '/tools',
      '/skills',
      '/exit',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain('[plugin]');
  });

  it('reflects readonly and verbose state', () => {
    const text = buildHelpText({ readonlyMode: true, verbose: false });
    expect(text).toContain('readonly mode (now: on)');
    expect(text).toContain('toggle timing (now: off)');
  });

  it('appends external commands after the built-ins with a [plugin] tag', () => {
    const text = buildHelpText(state, [
      { name: 'standup', description: 'Daily standup', usage: '/standup' },
    ]);
    const lines = text.split('\n');
    const last = lines[lines.length - 1] ?? '';
    expect(last.startsWith('/standup')).toBe(true);
    expect(last).toContain('Daily standup [plugin]');
    expect(lines.indexOf(last)).toBeGreaterThan(lines.findIndex((l) => l.startsWith('/exit')));
  });

  it('keeps built-ins intact when external commands are added', () => {
    const withPlugins = buildHelpText(state, [
      { name: 'p1', description: 'one', usage: '/p1' },
      { name: 'p2', description: 'two', usage: '/p2' },
    ]);
    expect(withPlugins.startsWith(buildHelpText(state))).toBe(true);
    expect(withPlugins).toContain('/p1');
    expect(withPlugins).toContain('/p2');
  });
});
