import { describe, expect, it } from 'vitest';
import {
  getSlashCommand,
  parseSlashCommand,
  resolveSlashCommand,
  SLASH_COMMANDS,
  slashCommandsForSurface,
} from '../slash-commands';

describe('SLASH_COMMANDS registry', () => {
  it('has unique names and non-empty metadata', () => {
    const names = new Set<string>();
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(cmd.usage).toBeTruthy();
      expect(cmd.surfaces.length).toBeGreaterThan(0);
      expect(names.has(cmd.name)).toBe(false);
      names.add(cmd.name);
    }
  });

  it('every aliasOf points at a real command', () => {
    for (const cmd of SLASH_COMMANDS) {
      if (cmd.aliasOf) {
        expect(getSlashCommand(cmd.aliasOf)).toBeDefined();
      }
    }
  });

  it('reproduces the CLI built-in list in order', () => {
    // The CLI-advertised subset is the legacy `builtInCommands`, in order.
    const cli = slashCommandsForSurface('cli').map((c) => c.name);
    expect(cli).toEqual([
      'help',
      'new',
      'reset',
      'fork',
      'branches',
      'branch',
      'personality',
      'model',
      'tier',
      'memory',
      'usage',
      'compact',
      'budget',
      'verbose',
      'busy',
      'steer',
      'allow',
      'deny',
      'communications',
      'commands',
      'learn',
      'undo',
      'title',
      'attach',
      'dry-run',
      'exit',
      'quit',
      'background',
      'goal',
      'goals',
    ]);
  });

  it('exposes gateway-only commands', () => {
    const gateway = slashCommandsForSurface('gateway').map((c) => c.name);
    for (const name of ['stop', 'start', 'queue', 'background', 'voice']) {
      expect(gateway).toContain(name);
    }
  });
});

describe('TUI surface tag (C5)', () => {
  // The TUI's /help body and its CompletionPanel both DERIVE from this
  // filtered list now (apps/tui/src/help.ts, apps/tui/src/components/
  // CompletionPanel.tsx — pinned by apps/tui/src/__tests__/help.test.ts), so
  // the previous source-scrape of those files is obsolete. This pin is the
  // deliberate edit point when a command joins or leaves the TUI surface.
  it('reproduces the TUI built-in list in order', () => {
    const tui = slashCommandsForSurface('tui').map((c) => c.name);
    expect(tui).toEqual([
      'help',
      'new',
      'fork',
      'branches',
      'branch',
      'personality',
      'model',
      'memory',
      'usage',
      'compact',
      'budget',
      'verbose',
      'learn',
      'exit',
      'sessions',
      'readonly',
      'details',
      'skin',
      'tools',
      'skills',
      'goal',
      'goals',
    ]);
  });

  it('tui entries keep name, usage and description for help generation', () => {
    for (const cmd of slashCommandsForSurface('tui')) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.usage).toContain(`/${cmd.name}`);
      expect(cmd.description).toBeTruthy();
    }
  });
});

describe('parseSlashCommand', () => {
  it('parses name and argument string', () => {
    expect(parseSlashCommand('/personality list')).toEqual({
      name: 'personality',
      args: ['list'],
      arg: 'list',
    });
  });

  it('lowercases the name and joins multi-token args', () => {
    expect(parseSlashCommand('/DENY telegram 123 456')).toEqual({
      name: 'deny',
      args: ['telegram', '123', '456'],
      arg: 'telegram 123 456',
    });
  });

  it('handles a bare command with no args', () => {
    expect(parseSlashCommand('/new')).toEqual({ name: 'new', args: [], arg: '' });
  });

  it('tolerates a lone slash', () => {
    expect(parseSlashCommand('/')).toEqual({ name: '', args: [], arg: '' });
  });

  it('accepts input without a leading slash', () => {
    expect(parseSlashCommand('help')).toEqual({ name: 'help', args: [], arg: '' });
  });
});

describe('resolveSlashCommand', () => {
  it('follows an alias to its canonical command', () => {
    expect(resolveSlashCommand('reset')?.name).toBe('new');
    expect(resolveSlashCommand('quit')?.name).toBe('exit');
  });

  it('returns the command itself when not an alias', () => {
    expect(resolveSlashCommand('help')?.name).toBe('help');
  });

  it('returns undefined for unknown names', () => {
    expect(resolveSlashCommand('nope')).toBeUndefined();
  });
});

describe('branch commands', () => {
  it('/fork, /branches, /branch are advertised on the CLI and gateway and parse their argument', () => {
    for (const name of ['fork', 'branches', 'branch']) {
      expect(getSlashCommand(name)?.surfaces).toEqual(['cli', 'gateway', 'tui']);
    }
    expect(parseSlashCommand('/branch 2')).toEqual({ name: 'branch', args: ['2'], arg: '2' });
    expect(parseSlashCommand('/FORK')).toEqual({ name: 'fork', args: [], arg: '' });
  });
});
