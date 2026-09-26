/**
 * C5 (ux-feedback plan) — the TUI's /help body and its completion panel both
 * derive from surface-kit's SLASH_COMMANDS filtered to surface 'tui'. No
 * hand-maintained TUI command list is left: these tests compare the generated
 * artifacts against the table itself.
 */

import { slashCommandsForSurface } from '@ethosagent/surface-kit';
import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS } from '../components/CompletionPanel';
import { buildHelpText } from '../help';

const state = { readonlyMode: false, verbose: false };

const tuiCommands = slashCommandsForSurface('tui').filter((cmd) => !cmd.aliasOf);

describe('buildHelpText', () => {
  it('renders exactly the table filtered by tui, in table order', () => {
    const lines = buildHelpText(state).split('\n');
    expect(lines).toHaveLength(tuiCommands.length);
    tuiCommands.forEach((cmd, i) => {
      const line = lines[i] ?? '';
      const usage = cmd.usageBySurface?.tui ?? cmd.usage;
      expect(line.startsWith(usage), `line ${i} should start with ${usage}`).toBe(true);
      expect(line).toContain(cmd.description);
    });
  });

  it('/verbose advertises the TUI toggle, not the CLI level arguments it ignores', () => {
    // The TUI handler is a boolean toggle (App.tsx case 'verbose'); the shared
    // usage advertises levels only the CLI honors, so the tui surface carries
    // its own usage string in the table.
    const lines = buildHelpText(state).split('\n');
    const verboseLine = lines.find((l) => l.startsWith('/verbose')) ?? '';
    expect(verboseLine).not.toContain('quiet|default|verbose|debug');
    expect(verboseLine).toContain('/verbose');
  });

  it('lists every TUI built-in with no external commands', () => {
    const text = buildHelpText(state);
    for (const cmd of tuiCommands) {
      expect(text).toContain(`/${cmd.name}`);
    }
    expect(text).not.toContain('[plugin]');
  });

  it('reflects readonly and verbose state', () => {
    const lines = buildHelpText({ readonlyMode: true, verbose: false }).split('\n');
    const readonlyLine = lines.find((l) => l.startsWith('/readonly')) ?? '';
    expect(readonlyLine).toContain('(now: on)');
    const verboseLine = lines.find((l) => l.startsWith('/verbose')) ?? '';
    expect(verboseLine).toContain('(now: off)');
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

describe('CompletionPanel SLASH_COMMANDS', () => {
  it('derives from the same table filtered by tui', () => {
    expect(SLASH_COMMANDS).toEqual(
      tuiCommands.map((cmd) => ({ name: cmd.name, desc: cmd.description })),
    );
  });
});
