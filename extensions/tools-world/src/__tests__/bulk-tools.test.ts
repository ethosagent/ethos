import type { ScopedFs, Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorldTools, WORLD_TOOL_NAMES } from '../index';
import { ctxFor, type ToolHarness, textOf, toolHarness } from './harness';

const PRIVATE = 'personality:engineer' as const;
const ACME = 'world:acme' as const;

const JSONL = [
  JSON.stringify({ type: 'entity', name: 'Ravi', entityType: 'Person', observations: [] }),
  JSON.stringify({ type: 'entity', name: 'Go', entityType: 'Skill', observations: [] }),
  JSON.stringify({ type: 'relation', from: 'Ravi', to: 'Go', relationType: 'expert_in' }),
].join('\n');

/** A ScopedFs over a map: anything else throws what ScopedFsImpl throws out of reach. */
function fsOf(files: Record<string, string>, writes: Record<string, string> = {}): ScopedFs {
  const reach = (p: string): Error => new Error(`PATH_NOT_REACHABLE: ${p}`);
  return {
    read: async (p: string) => {
      const t = files[p];
      if (t === undefined) throw reach(p);
      return t;
    },
    write: async (p: string, c: string | Uint8Array) => {
      if (!p.startsWith('/files/')) throw reach(p);
      writes[p] = typeof c === 'string' ? c : new TextDecoder().decode(c);
    },
  } as unknown as ScopedFs;
}

describe('world bulk tools', () => {
  let h: ToolHarness;
  let tools: Map<string, Tool>;
  beforeEach(async () => {
    h = await toolHarness();
    tools = new Map(createWorldTools(h.port).map((t) => [t.name, t as Tool]));
  });
  afterEach(() => h.dispose());

  const run = (
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => (tools.get(name) as Tool).execute(args, ctx);

  it('createWorldTools returns exactly the ten named tools', () => {
    expect([...tools.keys()].sort()).toEqual([...WORLD_TOOL_NAMES].sort());
    for (const t of tools.values()) expect(t.toolset).toBe('world');
  });

  it('import path outside fs reach is refused', async () => {
    const ctx = ctxFor({ scopedFs: fsOf({ '/files/people.jsonl': JSONL }) });
    const r = await run('world_import', { world: 'private', path: '/etc/passwd' }, ctx);
    expect(r.ok).toBe(false);
    expect(textOf(r)).toContain('fs_reach');
    expect(h.provider.all(PRIVATE).entities).toEqual([]);
  });

  it('import reads through the turn fs and writes agent facts on the private world', async () => {
    const ctx = ctxFor({ scopedFs: fsOf({ '/files/people.jsonl': JSONL }) });
    const r = await run('world_import', { world: 'private', path: '/files/people.jsonl' }, ctx);
    expect(r.ok).toBe(true);
    expect(textOf(r)).toContain('applied');
    expect(
      h.provider
        .all(PRIVATE)
        .entities.map((e) => e.name)
        .sort(),
    ).toEqual(['Go', 'Ravi']);
  });

  it('import into a shared world proposes', async () => {
    const ctx = ctxFor({ scopedFs: fsOf({ '/files/people.jsonl': JSONL }) });
    const r = await run('world_import', { world: 'acme', path: '/files/people.jsonl' }, ctx);
    expect(textOf(r)).toMatch(/proposed [1-9]/);
    expect(h.provider.all(ACME).entities).toEqual([]);
  });

  it('import is refused in a shared turn', async () => {
    const ctx = ctxFor({ roomAudience: 'shared', scopedFs: fsOf({ '/files/p.jsonl': JSONL }) });
    const r = await run('world_import', { world: 'acme', path: '/files/p.jsonl' }, ctx);
    expect(r).toMatchObject({ ok: false, code: 'not_available' });
    expect(h.provider.all(ACME).entities).toEqual([]);
  });

  it('import reports parse errors with their line', async () => {
    const ctx = ctxFor({ scopedFs: fsOf({ '/files/bad.yaml': 'entities: [\n' }) });
    const r = await run('world_import', { world: 'private', path: '/files/bad.yaml' }, ctx);
    expect(r.ok).toBe(false);
    expect(textOf(r)).toMatch(/line \d+/);
  });

  it('export respects the audience of the turn', async () => {
    h.provider.seedEntity(PRIVATE, 'Person', 'Secret');
    h.provider.seedEntity(ACME, 'Person', 'Ravi');

    const priv = await run('world_export', { world: 'private', format: 'mermaid' }, ctxFor());
    expect(textOf(priv)).toContain('Secret');

    const shared = ctxFor({ roomAudience: 'shared' });
    const denied = await run('world_export', { world: 'private' }, shared);
    expect(denied.ok).toBe(false);
    expect(textOf(denied)).not.toContain('Secret');

    const open = await run('world_export', { format: 'json' }, shared);
    expect(textOf(open)).toContain('Ravi');
    expect(textOf(open)).not.toContain('Secret');
  });

  it('export supports every format and rejects an unknown one', async () => {
    h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    for (const format of ['facts-yaml', 'json', 'graphml', 'mermaid', 'mcp-jsonl', 'csv']) {
      const r = await run('world_export', { world: 'private', format }, ctxFor());
      expect(r.ok, format).toBe(true);
      expect(textOf(r), format).toContain('Ravi');
    }
    expect((await run('world_export', { world: 'private', format: 'xml' }, ctxFor())).ok).toBe(
      false,
    );
  });

  it('export save_to writes through the turn fs only', async () => {
    h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const writes: Record<string, string> = {};
    const ctx = ctxFor({ scopedFs: fsOf({}, writes) });
    const ok = await run('world_export', { world: 'private', save_to: '/files/w.yaml' }, ctx);
    expect(textOf(ok)).toContain('/files/w.yaml');
    expect(writes['/files/w.yaml']).toContain('Ravi');
    const bad = await run('world_export', { world: 'private', save_to: '/etc/x' }, ctx);
    expect(bad.ok).toBe(false);
    expect(textOf(bad)).toContain('fs_reach');
  });

  it('world_build refused in a shared turn', async () => {
    const r = await run('world_build', { world: 'private' }, ctxFor({ roomAudience: 'shared' }));
    expect(r).toMatchObject({ ok: false, code: 'not_available' });
    expect(textOf(r)).toContain('shared');
  });

  it('world_build says it is not available yet in a private turn', async () => {
    const r = await run('world_build', { world: 'private' }, ctxFor());
    expect(r).toMatchObject({ ok: false, code: 'not_available' });
    expect(textOf(r)).toContain('not available yet');
  });

  it('bulk tools declare fs reach from the personality', () => {
    expect((tools.get('world_import') as Tool).capabilities).toEqual({
      fs_reach: { read: 'from-personality' },
    });
    expect((tools.get('world_export') as Tool).capabilities).toEqual({
      fs_reach: { write: 'from-personality' },
    });
    expect((tools.get('world_build') as Tool).capabilities).toEqual({
      fs_reach: { read: 'from-personality' },
    });
  });
});
