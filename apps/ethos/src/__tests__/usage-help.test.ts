import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_GROUPS,
  COMMAND_TABLE,
  renderGroupedHelp,
  suggestCommand,
} from '../commands/registry-table';

// N1 (plan ux-feedback-and-config-clarity) — the grouped `--help` and the
// nearest-command suggestion. The registered command set is DERIVED from the
// dispatch switch in index.ts (its `case '<name>':` labels), so a command
// added to the dispatcher without a row in COMMAND_TABLE fails here, and a
// row for a command the dispatcher no longer has fails too.

function registeredCommands(): string[] {
  const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/^\s*case '([^']*)':/gm)) {
    const name = m[1] ?? '';
    // Flags (--help, -v), the empty default-to-chat alias, and the internal
    // _supervisor entry are not user-facing commands.
    if (name === '' || name.startsWith('-') || name.startsWith('_')) continue;
    names.add(name);
  }
  return [...names];
}

describe('COMMAND_TABLE coverage', () => {
  it('every dispatched command appears in exactly one group', () => {
    const registered = registeredCommands();
    expect(registered.length).toBeGreaterThan(40);
    const tableNames = COMMAND_TABLE.map((e) => e.name);
    for (const name of registered) {
      expect(tableNames.filter((n) => n === name)).toHaveLength(1);
    }
  });

  it('has no rows for commands the dispatcher does not register', () => {
    const registered = new Set(registeredCommands());
    for (const entry of COMMAND_TABLE) {
      expect(registered.has(entry.name), `stale table row: ${entry.name}`).toBe(true);
    }
  });

  it('every row names a known group and a one-line description', () => {
    for (const entry of COMMAND_TABLE) {
      expect(COMMAND_GROUPS).toContain(entry.group);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description).not.toContain('\n');
    }
  });
});

describe('renderGroupedHelp', () => {
  it('renders every group heading and ends with the per-command pointer', () => {
    const help = renderGroupedHelp();
    for (const group of COMMAND_GROUPS) {
      expect(help).toContain(`${group}:`);
    }
    expect(help.trimEnd().endsWith('ethos <command> --help for details')).toBe(true);
  });

  it('lists every command once with its description', () => {
    const help = renderGroupedHelp();
    for (const entry of COMMAND_TABLE) {
      expect(help).toContain(entry.description);
    }
  });
});

describe('suggestCommand', () => {
  it('suggests the nearest command for a typo', () => {
    expect(suggestCommand('statsu')).toBe('status');
    expect(suggestCommand('docto')).toBe('doctor');
  });

  it('suggests nothing for gibberish', () => {
    expect(suggestCommand('zzzzqqqq')).toBeUndefined();
  });
});
