import type { WorldId } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedWorld } from '../access';
import { classifySchemaChange, type SchemaChange } from '../schema-diff';
import { type Harness, harness } from './schema-harness';

const PRIVATE: WorldId = 'personality:eng';
const SHARED: WorldId = 'world:acme';

function resolved(id: WorldId): ResolvedWorld {
  return id === PRIVATE
    ? { id, tag: 'private', alias: null, mode: 'write', audience: 'owner_only', shared: false }
    : { id, tag: 'acme', alias: null, mode: 'propose', audience: 'shareable', shared: true };
}

const ADDITIVE: SchemaChange[] = [
  { op: 'add_entity_type', type: 'Vendor' },
  { op: 'add_edge_type', type: 'supplies', from: ['Vendor'], to: ['Team'] },
  { op: 'add_attribute', on: { entity: 'Team' }, key: 'slack', spec: { type: 'string' } },
  { op: 'add_allowed_pair', edge: 'depends_on', from: 'Person' },
];
const REWRITE: SchemaChange[] = [
  { op: 'rename_type', kind: 'entity', from: 'Skill', to: 'Capability' },
  { op: 'rename_attribute', on: { entity: 'Team' }, from: 'mission', to: 'purpose' },
  { op: 'merge_types', kind: 'entity', from: 'Skill', into: 'Team' },
  { op: 'remove_type', kind: 'entity', type: 'Skill' },
];

describe('schema change rules', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
    await h.seed(PRIVATE);
    await h.seed(SHARED);
  });
  afterEach(() => h.dispose());

  it('classifies add_* as additive and rename/merge/remove as rewrite', () => {
    for (const c of ADDITIVE) expect(classifySchemaChange(c)).toBe('additive');
    for (const c of REWRITE) expect(classifySchemaChange(c)).toBe('rewrite');
  });

  it('R12 change rules table', async () => {
    // Private world, agent: additive applies now with a changelog entry.
    for (const c of ADDITIVE) {
      const r = await h.service.requestChange(resolved(PRIVATE), c, 'eng', 'because');
      expect(r, JSON.stringify(c)).toHaveProperty('applied');
    }
    const loaded = await h.service.load(PRIVATE);
    expect(loaded.errors).toEqual([]);
    expect(loaded.changelog.map((e) => e.by)).toEqual(['agent', 'agent', 'agent', 'agent']);
    expect(loaded.changelog[0]?.reason).toBe('because');

    // Private world, agent: rename / merge / remove become proposals, nothing applied.
    const before = (await h.service.load(PRIVATE)).version;
    for (const c of [
      REWRITE[0] as SchemaChange,
      REWRITE[1] as SchemaChange,
      REWRITE[2] as SchemaChange,
      { op: 'remove_type', kind: 'edge', type: 'supplies' } as SchemaChange,
    ]) {
      const r = await h.service.requestChange(resolved(PRIVATE), c, 'eng', 'why');
      expect(r, JSON.stringify(c)).toHaveProperty('proposalId');
    }
    expect((await h.service.load(PRIVATE)).version).toBe(before);

    // Shared world, agent: every change, additive included, is a proposal.
    const sharedBefore = (await h.service.load(SHARED)).version;
    for (const c of [...ADDITIVE, ...REWRITE.slice(0, 3)]) {
      const r = await h.service.requestChange(resolved(SHARED), c, 'eng', 'why');
      expect(r, JSON.stringify(c)).toHaveProperty('proposalId');
    }
    expect((await h.service.load(SHARED)).version).toBe(sharedBefore);
    expect(h.store.countProposals(SHARED)).toBe(7);

    // User: applied, every row.
    for (const c of ADDITIVE) {
      expect(await h.service.apply(SHARED, c, { kind: 'user', id: 'me' }, 'r')).toMatchObject({
        ok: true,
      });
    }
    expect(
      await h.service.apply(
        SHARED,
        REWRITE[1] as SchemaChange,
        { kind: 'user', id: 'me' },
        'rename attr',
      ),
    ).toMatchObject({ ok: true });
    expect(
      await h.service.apply(
        SHARED,
        { op: 'remove_type', kind: 'edge', type: 'supplies' },
        { kind: 'user', id: 'me' },
        'drop edge',
      ),
    ).toMatchObject({ ok: true });
    expect(
      await h.service.apply(
        SHARED,
        { op: 'remove_type', kind: 'entity', type: 'Vendor' },
        { kind: 'user', id: 'me' },
        'drop',
      ),
    ).toMatchObject({ ok: true });
  });

  it('remove of a used type is refused with the count', async () => {
    const a = h.provider.seedEntity(SHARED, 'Skill', 'Go');
    h.provider.seedEntity(SHARED, 'Skill', 'Rust');
    expect(a.type).toBe('Skill');
    const change: SchemaChange = { op: 'remove_type', kind: 'entity', type: 'Skill' };

    const user = await h.service.apply(SHARED, change, { kind: 'user', id: 'me' }, 'drop');
    expect(user).toEqual({ ok: false, error: expect.stringContaining('2 live') });

    const agent = await h.service.requestChange(resolved(SHARED), change, 'eng', 'drop');
    expect(agent).toEqual({ refused: expect.stringContaining('2 live') });
    expect(h.store.countProposals(SHARED)).toBe(0);
  });

  it('a change the schema cannot take is refused, not applied', async () => {
    const r = await h.service.apply(
      SHARED,
      { op: 'add_entity_type', type: 'Team' },
      { kind: 'user', id: 'me' },
      'dup',
    );
    expect(r).toEqual({ ok: false, error: expect.stringContaining('already exists') });
  });
});
