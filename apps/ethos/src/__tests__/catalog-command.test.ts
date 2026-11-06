import { CATALOG_ENTRIES } from '@ethosagent/catalog';
import type { CatalogEntry } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { execCatalog, nearestIds, runCatalog } from '../commands/catalog';

describe('ethos catalog list', () => {
  it('prints one "id  kind  tier  description" line per entry', () => {
    const r = execCatalog(['list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toHaveLength(CATALOG_ENTRIES.length);
    const linear = r.stdout.find((l) => l.startsWith('linear  '));
    expect(linear).toBe(
      'linear  mcp  verified  Read and update Linear issues, projects, and cycles',
    );
  });

  it('--kind filters; a kind with no entries prints nothing', () => {
    expect(execCatalog(['list', '--kind', 'mcp']).stdout).toHaveLength(CATALOG_ENTRIES.length);
    expect(execCatalog(['list', '--kind', 'plugin']).stdout).toEqual([]);
  });

  it('rejects an unknown --kind with exit 1', () => {
    const r = execCatalog(['list', '--kind', 'bogus']);
    expect(r.code).toBe(1);
    expect(r.stderr[0]).toMatch(/--kind must be one of/);
  });

  it('--json returns the entry array, position-independent', () => {
    const r = execCatalog(['--json', 'list']);
    expect(Array.isArray(r.json)).toBe(true);
    expect((r.json as CatalogEntry[]).map((e) => e.id)).toEqual(CATALOG_ENTRIES.map((e) => e.id));
    expect(r.stdout).toEqual([]);
  });
});

describe('ethos catalog search', () => {
  it('matches case-insensitively over id, name, description and publisher', () => {
    const r = execCatalog(['search', 'LINEAR']);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout.some((l) => l.startsWith('linear  '))).toBe(true);
  });

  it('--json returns the matching entries', () => {
    const r = execCatalog(['search', 'linear', '--json']);
    const ids = (r.json as CatalogEntry[]).map((e) => e.id);
    expect(ids).toContain('linear');
    expect(ids.length).toBeLessThan(CATALOG_ENTRIES.length);
  });

  it('requires a query', () => {
    const r = execCatalog(['search']);
    expect(r.code).toBe(1);
    expect(r.stderr[0]).toMatch(/^Usage: ethos catalog search/);
  });
});

describe('ethos catalog show', () => {
  it('a local entry prints pin, capabilities, the preset add command and the grant', () => {
    const r = execCatalog(['show', 'filesystem']);
    expect(r.code).toBe(0);
    const text = r.stdout.join('\n');
    expect(text).toContain('@modelcontextprotocol/server-filesystem@2.2.0');
    expect(text).toContain('sha512-');
    expect(text).toContain('filesystem: user-path');
    expect(text).toContain(
      'ethos mcp add filesystem --preset filesystem --arg ALLOWED_PATH=<allowed_path>',
    );
    expect(text).toContain('ethos personality mcp <personality-id> --attach filesystem');
  });

  it('prints the catalog install command, with the local entry flags, ahead of the by-hand commands', () => {
    const local = execCatalog(['show', 'filesystem']).stdout.join('\n');
    expect(local).toContain(
      'Install it:\n  ethos catalog install filesystem --arg ALLOWED_PATH=<allowed_path>',
    );
    expect(local.indexOf('ethos catalog install filesystem')).toBeLessThan(
      local.indexOf('Or by hand:'),
    );
    expect(execCatalog(['show', 'linear']).stdout.join('\n')).toContain(
      'Install it:\n  ethos catalog install linear\n',
    );
  });

  it('a remote entry prints the --url add command', () => {
    const text = execCatalog(['show', 'linear']).stdout.join('\n');
    expect(text).toContain('ethos mcp add linear --url https://mcp.linear.app/mcp');
    expect(text).toContain('auth:       oauth');
  });

  it('--json returns the full entry', () => {
    const r = execCatalog(['show', 'filesystem', '--json']);
    expect(r.json).toEqual(CATALOG_ENTRIES.find((e) => e.id === 'filesystem'));
  });

  it('an unknown id: stderr message, exit 1, nearest ids', () => {
    const r = execCatalog(['show', 'nope']);
    expect(r.code).toBe(1);
    expect(r.stdout).toEqual([]);
    expect(r.stderr[0]).toBe('Unknown catalog entry: nope');
  });

  it('suggests close ids, with a prefix fallback when search finds nothing', () => {
    const r = execCatalog(['show', 'linea']);
    expect(r.stderr[0]).toBe('Unknown catalog entry: linea');
    expect(r.stderr[1]).toContain('linear');
    expect(nearestIds('filesyst')).toContain('filesystem');
    expect(nearestIds('zzzz-nothing')).toEqual([]);
    expect(nearestIds('nope')).toEqual([]);
    expect(nearestIds('l', CATALOG_ENTRIES).length).toBeLessThanOrEqual(3);
  });
});

describe('ethos catalog --json failures', () => {
  it('an unknown id carries a NOT_FOUND error doc and exit 1; text mode carries none', () => {
    const j = execCatalog(['show', 'nope', '--json']);
    expect(j.code).toBe(1);
    expect(j.jsonError).toEqual({ code: 'NOT_FOUND', message: 'Unknown catalog entry: nope' });
    expect(execCatalog(['show', 'nope']).jsonError).toBeUndefined();
  });

  it('runCatalog writes the error doc to stdout and sets exit 1', async () => {
    const out: string[] = [];
    const w = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    const e = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const x = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let exitArgs: unknown[][] = [];
    try {
      await runCatalog(['show', 'nope', '--json']);
      exitArgs = [...x.mock.calls];
    } finally {
      w.mockRestore();
      e.mockRestore();
      x.mockRestore();
    }
    expect(JSON.parse(out.join(''))).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Unknown catalog entry: nope' },
    });
    expect(exitArgs).toEqual([[1]]);
    process.exitCode = 0;
  });
});

describe('ethos catalog usage', () => {
  it('no subcommand prints usage with exit 0; an unknown one exits 1', () => {
    expect(execCatalog([]).code).toBe(0);
    expect(execCatalog(['frobnicate']).code).toBe(1);
  });
});
