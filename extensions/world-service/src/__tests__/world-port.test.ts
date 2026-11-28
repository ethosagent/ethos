import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorldToolPort } from '../port';
import { caller, type ServiceHarness, serviceHarness } from './service-harness';

describe('world tool port', () => {
  let h: ServiceHarness;
  beforeEach(async () => {
    h = await serviceHarness();
  });
  afterEach(() => h.dispose());

  it('R13 tool port is narrow', () => {
    const port = createWorldToolPort(h.service);
    const keys = Object.keys(port).sort();
    expect(keys).toEqual(
      [
        'build',
        'closeFact',
        'exportBundle',
        'history',
        'importBundle',
        'neighbours',
        'proposeFacts',
        'query',
        'requestSchemaChange',
        'visible',
        'writeFacts',
      ].sort(),
    );
    for (const banned of [
      'acceptProposal',
      'rejectProposal',
      'purge',
      'ownerWrite',
      'promoteToUser',
    ]) {
      expect(keys).not.toContain(banned);
    }
    for (const k of keys) {
      expect(typeof (port as unknown as Record<string, unknown>)[k]).toBe('function');
    }
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.values(port).some((v) => typeof v !== 'function')).toBe(false);
  });

  it('the port writes through the service rules', async () => {
    const port = createWorldToolPort(h.service);
    const out = await port.writeFacts(
      caller(),
      'acme',
      [{ kind: 'entity', type: 'Person', name: 'Ravi', sourceRef: 'c', author: 'agent' }],
      '',
    );
    expect(out.proposed).toHaveLength(1);
  });

  it('proposeFacts proposes even on the private world', async () => {
    const port = createWorldToolPort(h.service);
    const out = await port.proposeFacts(
      caller(),
      'private',
      [{ kind: 'entity', type: 'Skill', name: 'Go', sourceRef: 'c', author: 'agent' }],
      'check with me',
    );
    expect(out.proposed).toHaveLength(1);
    expect(h.provider.all('personality:engineer').entities).toEqual([]);
  });

  it('requestSchemaChange follows the R12 table (additive on private applies)', async () => {
    const port = createWorldToolPort(h.service);
    const r = await port.requestSchemaChange(
      caller(),
      'private',
      { op: 'add_entity_type', type: 'Team' },
      'need teams',
    );
    expect(r).toEqual({ applied: 2 });
    const shared = await port.requestSchemaChange(
      caller(),
      'acme',
      { op: 'add_entity_type', type: 'Team' },
      'need teams',
    );
    expect('proposalId' in shared).toBe(true);
  });

  it('build is a stub until P5', async () => {
    const port = createWorldToolPort(h.service);
    expect(await port.build(caller(), 'private', {})).toEqual({ refused: 'not_implemented' });
  });

  it('importBundle as an agent proposes on shared worlds and writes agent facts on the private one', async () => {
    const port = createWorldToolPort(h.service);
    const bundle = {
      schema: null,
      entities: [
        {
          id: 'x1',
          world: 'personality:engineer' as const,
          type: 'Person',
          name: 'Ravi',
          aliases: [],
          recordedAt: '',
          retiredAt: null,
          sourceRef: 'csv',
          author: 'import' as const,
          mergedInto: null,
        },
        {
          id: 'x2',
          world: 'personality:engineer' as const,
          type: 'Skill',
          name: 'Go',
          aliases: [],
          recordedAt: '',
          retiredAt: null,
          sourceRef: 'csv',
          author: 'import' as const,
          mergedInto: null,
        },
      ],
      attributes: [],
      edges: [
        {
          id: 'y1',
          world: 'personality:engineer' as const,
          type: 'expert_in',
          fromId: 'x1',
          toId: 'x2',
          attrs: {},
          validFrom: null,
          validTo: null,
          recordedAt: '',
          retiredAt: null,
          sourceRef: 'csv',
          author: 'import' as const,
          confidence: 1,
        },
      ],
    };
    const priv = await port.importBundle(caller(), 'private', bundle);
    expect(priv.report).toMatchObject({ entities: 2, edges: 1, skipped: [] });
    const all = h.provider.all('personality:engineer');
    expect(all.entities.every((e) => e.author === 'agent')).toBe(true);
    expect(all.edges).toHaveLength(1);
    expect(all.edges[0]?.fromId).toBe(all.entities.find((e) => e.name === 'Ravi')?.id);

    const shared = await port.importBundle(caller(), 'acme', bundle);
    expect(shared.proposed).toBe(3);
    expect(h.provider.all('world:acme').entities).toEqual([]);
  });

  it('exportBundle applies mounts: an unmounted world is refused', async () => {
    const port = createWorldToolPort(h.service);
    await expect(port.exportBundle(caller(), 'nowhere')).rejects.toThrow(/not_mounted/);
  });
});
