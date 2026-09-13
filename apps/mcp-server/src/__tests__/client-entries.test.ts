// `McpEntry.name` / `McpEntry.env` across all five client adapters (M-T7).
//
// The property under test is the same one in every adapter and it is a safety
// property, not a convenience: `ethos` (the operator console, full trust) and
// `ethos-<id>` (one personality's bounded export) are DIFFERENT servers that
// live in the same config file (M-D14). Installing an export must add an entry
// beside the console's, never on top of it — a user who loses their `ethos`
// entry to an export install loses a surface they configured on purpose, and
// silently.

import { describe, expect, it } from 'vitest';
import { claudeDesktop } from '../clients/claude-desktop';
import { continueClient } from '../clients/continue';
import { cursor } from '../clients/cursor';
import { opencode } from '../clients/opencode';
import type { ClientAdapter, McpEntry } from '../clients/types';
import { DEFAULT_ENTRY_NAME, entryName } from '../clients/types';
import { zed } from '../clients/zed';

const CONSOLE_ENTRY: McpEntry = { command: 'node', args: ['ethos', 'mcp', 'serve'] };
const EXPORT_ENTRY: McpEntry = {
  name: 'ethos-reviewer',
  command: 'node',
  args: ['ethos', 'mcp', 'serve', '--personality', 'reviewer'],
  env: { ETHOS_MCP_KEY: 'sk-ethos-secret01' },
};

/** Every adapter's own container shape, reduced to `name → entry`. */
const READERS: Record<string, (config: Record<string, unknown>) => Record<string, unknown>> = {
  'claude-desktop': (c) => (c.mcpServers ?? {}) as Record<string, unknown>,
  cursor: (c) => (c.mcpServers ?? {}) as Record<string, unknown>,
  opencode: (c) =>
    (((c.mcp ?? {}) as Record<string, unknown>).servers ?? {}) as Record<string, unknown>,
  continue: (c) =>
    Object.fromEntries(
      ((c.mcpServers ?? []) as Array<Record<string, unknown>>).map((s) => [String(s.name), s]),
    ),
  zed: (c) => (c.context_servers ?? {}) as Record<string, unknown>,
};

/** Where each adapter puts a spawned process's environment. */
const ENV_OF: Record<string, (entry: Record<string, unknown>) => unknown> = {
  'claude-desktop': (e) => e.env,
  cursor: (e) => e.env,
  // OpenCode names the block `environment` on a local server.
  opencode: (e) => e.environment,
  continue: (e) => e.env,
  // Zed nests the whole invocation under `command`.
  zed: (e) => (e.command as Record<string, unknown>).env,
};

const ADAPTERS: ClientAdapter[] = [claudeDesktop, cursor, opencode, continueClient, zed];

describe('McpEntry.name defaults', () => {
  it('is the console name when the entry does not ask for one', () => {
    expect(entryName(CONSOLE_ENTRY)).toBe(DEFAULT_ENTRY_NAME);
    expect(entryName(EXPORT_ENTRY)).toBe('ethos-reviewer');
  });
});

describe.each(ADAPTERS)('$name — export entries live beside the console entry', (adapter) => {
  const read = READERS[adapter.name];
  const envOf = ENV_OF[adapter.name];
  if (!read || !envOf) throw new Error(`no reader registered for adapter "${adapter.name}"`);

  it('writes ethos-<id> without clobbering an existing ethos entry', () => {
    const withConsole = adapter.injectEntry({}, CONSOLE_ENTRY);
    const both = adapter.injectEntry(withConsole, EXPORT_ENTRY);
    const entries = read(both);

    expect(Object.keys(entries).sort()).toEqual(['ethos', 'ethos-reviewer']);
    // The console entry is untouched, not merely present.
    expect(entries.ethos).toEqual(read(withConsole).ethos);
  });

  it('does not clobber an export entry when the console is reinstalled after it', () => {
    const withExport = adapter.injectEntry({}, EXPORT_ENTRY);
    const both = adapter.injectEntry(withExport, CONSOLE_ENTRY);
    expect(Object.keys(read(both)).sort()).toEqual(['ethos', 'ethos-reviewer']);
  });

  it('keeps two exports of different personalities apart', () => {
    const first = adapter.injectEntry({}, EXPORT_ENTRY);
    const both = adapter.injectEntry(first, {
      name: 'ethos-planner',
      command: 'node',
      args: ['ethos', 'mcp', 'serve', '--personality', 'planner'],
    });
    expect(Object.keys(read(both)).sort()).toEqual(['ethos-planner', 'ethos-reviewer']);
  });

  it('replaces an entry of the SAME name on reinstall rather than duplicating it', () => {
    const once = adapter.injectEntry({}, EXPORT_ENTRY);
    const twice = adapter.injectEntry(once, EXPORT_ENTRY);
    expect(Object.keys(read(twice))).toEqual(['ethos-reviewer']);
  });

  it('carries the bearer secret in the entry environment', () => {
    const entries = read(adapter.injectEntry({}, EXPORT_ENTRY));
    const entry = entries['ethos-reviewer'] as Record<string, unknown>;
    expect(envOf(entry)).toEqual({ ETHOS_MCP_KEY: 'sk-ethos-secret01' });
  });

  it('writes no environment block at all when there is no secret', () => {
    const entries = read(adapter.injectEntry({}, CONSOLE_ENTRY));
    const entry = entries.ethos as Record<string, unknown>;
    expect(envOf(entry)).toBeUndefined();
  });
});
