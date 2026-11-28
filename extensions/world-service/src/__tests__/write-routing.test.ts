import type { FactInput } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACME, caller, PRIVATE, type ServiceHarness, serviceHarness } from './service-harness';

const ent = (type: string, name: string): FactInput => ({
  kind: 'entity',
  type,
  name,
  sourceRef: 'chat:1',
  author: 'agent',
});

describe('write routing', () => {
  let h: ServiceHarness;
  beforeEach(async () => {
    h = await serviceHarness();
  });
  afterEach(() => h.dispose());

  it('R1 shared-world writes are proposals only', async () => {
    const out = await h.service.writeFacts(caller(), 'acme', [ent('Person', 'Ravi')], 'met him');
    expect(out.applied).toEqual([]);
    expect(out.proposed).toHaveLength(1);
    expect(out.refused).toEqual([]);
    expect(h.provider.asserts.filter((a) => a.world === ACME)).toEqual([]);
    expect(h.store.inbox(ACME)).toHaveLength(1);
    expect(h.store.inbox(ACME)[0]?.proposedBy).toBe('engineer');
  });

  it('R1 a close on a shared world is a proposal too', async () => {
    const e = h.provider.seedEntity(ACME, 'Service', 'billing-svc');
    const p = h.provider.seedEntity(ACME, 'Person', 'Ravi');
    const edge = h.provider.seedEdge(ACME, 'owns', p.id, e.id, { author: 'agent' });
    const out = await h.service.closeFact(caller(), 'acme', edge.id, '2026-11-01', 'chat:2');
    expect(out.proposed).toHaveLength(1);
    expect(h.provider.all(ACME).edges[0]?.validTo).toBeNull();
  });

  it('R2 user facts are never overwritten by the agent', async () => {
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const ravi = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const priyaOwns = h.provider.seedEdge(PRIVATE, 'owns', priya.id, svc.id, { author: 'user' });

    const out = await h.service.writeFacts(
      caller(),
      'private',
      [
        {
          kind: 'edge',
          type: 'owns',
          fromId: ravi.id,
          toId: svc.id,
          sourceRef: 'chat:3',
          author: 'agent',
          confidence: 0.9,
        },
      ],
      'Ravi took over',
    );
    // Not applied; Priya still live; a conflict proposal exists.
    expect(out.applied).toEqual([]);
    expect(out.proposed).toHaveLength(1);
    expect(h.provider.all(PRIVATE).edges.filter((e) => e.type === 'owns')).toHaveLength(1);
    expect(h.provider.all(PRIVATE).edges[0]?.validTo).toBeNull();
    const [row] = h.store.inbox(PRIVATE);
    expect(row?.conflictWith).toBe(priyaOwns.id);

    // Accept: Priya closed on the proposal's date, Ravi open, original author kept.
    const accepted = await h.service.acceptProposal(row?.id ?? '', 'owner');
    expect(accepted.refused).toEqual([]);
    expect(accepted.applied).toHaveLength(1);
    const edges = h.provider.all(PRIVATE).edges;
    expect(edges.find((e) => e.id === priyaOwns.id)?.validTo).toBe(row?.createdAt.slice(0, 10));
    const raviEdge = edges.find((e) => e.fromId === ravi.id);
    expect(raviEdge?.validTo).toBeNull();
    expect(raviEdge?.author).toBe('agent');
    expect(h.store.get(row?.id ?? '')?.decidedBy).toBe('owner');
    expect(h.store.get(row?.id ?? '')?.status).toBe('accepted');
  });

  it('R2 an attribute with a different value than a user fact becomes a conflict proposal', async () => {
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const a = h.provider.seedAttribute(PRIVATE, priya.id, 'title', 'VP', { author: 'user' });
    const out = await h.service.writeFacts(
      caller(),
      'private',
      [
        {
          kind: 'attribute',
          entityId: priya.id,
          key: 'title',
          value: 'Director',
          sourceRef: 'chat:4',
          author: 'agent',
          confidence: 0.9,
        },
      ],
      '',
    );
    expect(out.proposed).toHaveLength(1);
    expect(h.store.inbox(PRIVATE)[0]?.conflictWith).toBe(a.id);
    expect(h.provider.all(PRIVATE).attributes).toHaveLength(1);
  });

  it('an agent cannot claim the user author', async () => {
    await h.service.writeFacts(
      caller(),
      'private',
      [{ ...ent('Skill', 'Go'), author: 'user' }],
      '',
    );
    expect(h.provider.all(PRIVATE).entities[0]?.author).toBe('agent');
  });

  it('agent closing a user fact becomes a conflict proposal', async () => {
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const edge = h.provider.seedEdge(PRIVATE, 'owns', priya.id, svc.id, { author: 'user' });
    const out = await h.service.closeFact(caller(), 'private', edge.id, '2026-11-01', 'chat:5');
    expect(out.proposed).toHaveLength(1);
    expect(out.applied).toEqual([]);
    expect(h.provider.all(PRIVATE).edges[0]?.validTo).toBeNull();
    expect(h.store.inbox(PRIVATE)[0]?.conflictWith).toBe(edge.id);
  });

  it('agent closing its own fact on the private world is applied', async () => {
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const ravi = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const edge = h.provider.seedEdge(PRIVATE, 'owns', ravi.id, svc.id, { author: 'agent' });
    const out = await h.service.closeFact(caller(), 'private', edge.id, '2026-11-01', 'chat:5');
    expect(out.applied).toEqual([edge.id]);
    expect(h.provider.all(PRIVATE).edges[0]?.validTo).toBe('2026-11-01');
  });

  it('agent-on-agent unique collision closes the older one directly', async () => {
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const ravi = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const older = h.provider.seedEdge(PRIVATE, 'owns', priya.id, svc.id, { author: 'agent' });
    const out = await h.service.writeFacts(
      caller(),
      'private',
      [
        {
          kind: 'edge',
          type: 'owns',
          fromId: ravi.id,
          toId: svc.id,
          validFrom: '2026-11-20',
          sourceRef: 'chat:6',
          author: 'agent',
          confidence: 0.9,
        },
      ],
      '',
    );
    expect(out.applied).toHaveLength(1);
    expect(out.proposed).toEqual([]);
    const edges = h.provider.all(PRIVATE).edges;
    expect(edges.find((e) => e.id === older.id)?.validTo).toBe('2026-11-20');
    expect(edges.find((e) => e.fromId === ravi.id)?.validTo).toBeNull();
  });

  it('low confidence on a private world becomes a proposal', async () => {
    const out = await h.service.writeFacts(
      caller(),
      'private',
      [{ ...ent('Skill', 'Rust') }, { ...ent('Skill', 'Zig') }],
      '',
    );
    expect(out.applied).toHaveLength(2);
    const person = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const low = await h.service.writeFacts(
      caller(),
      'private',
      [
        {
          kind: 'attribute',
          entityId: person.id,
          key: 'title',
          value: 'CTO',
          sourceRef: 'chat:7',
          author: 'agent',
          confidence: 0.5,
        },
      ],
      '',
    );
    expect(low.applied).toEqual([]);
    expect(low.proposed).toHaveLength(1);
    expect(h.provider.all(PRIVATE).attributes).toEqual([]);
  });

  it('R9 null world with 2+ visible worlds → WORLD_REQUIRED', async () => {
    const out = await h.service.writeFacts(caller(), null, [ent('Skill', 'Go')], '');
    expect(out.applied).toEqual([]);
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0]?.reason).toContain('WORLD_REQUIRED');
    expect(out.refused[0]?.reason).toContain('acme');
    expect(out.refused[0]?.reason).toContain('private');
  });

  it('a world that is not mounted is refused', async () => {
    const out = await h.service.writeFacts(caller(), 'nowhere', [ent('Skill', 'Go')], '');
    expect(out.refused[0]?.reason).toContain('not_mounted');
  });

  it('a personality with no mount is refused', async () => {
    const ro = await serviceHarness({ mountAcme: true });
    try {
      // engineer is only a proposer; make a reader-only personality.
      const out = await ro.service.writeFacts(
        caller({ personalityId: 'reader' }),
        'acme',
        [ent('Skill', 'Go')],
        '',
      );
      expect(out.refused[0]?.reason).toContain('not_mounted');
    } finally {
      ro.dispose();
    }
  });

  it('a shared turn cannot see the private world', async () => {
    const out = await h.service.writeFacts(
      caller({ audience: 'shared' }),
      'private',
      [ent('Skill', 'Go')],
      '',
    );
    expect(out.refused[0]?.reason).toContain('not_mounted');
  });

  it('a duplicate entity is refused and names the existing id', async () => {
    const e = h.provider.seedEntity(PRIVATE, 'Skill', 'Go');
    const out = await h.service.writeFacts(caller(), 'private', [ent('Skill', 'Go')], '');
    expect(out.refused[0]?.reason).toContain(e.id);
  });

  it('reads tag every result with its world and span only visible worlds', async () => {
    h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    h.provider.seedEntity(ACME, 'Person', 'Ravi');
    const r = await h.service.query(caller(), null, { kind: 'entities', limit: 10 });
    expect(r.entities.map((e) => e.displayTag).sort()).toEqual(['acme:Ravi', 'private:Ravi']);
  });

  it('promoteToUser retires the agent row and asserts a user row with the same content', async () => {
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const ravi = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const edge = h.provider.seedEdge(PRIVATE, 'owns', ravi.id, svc.id, {
      author: 'agent',
      validFrom: '2026-10-01',
    });
    const out = await h.service.promoteToUser(PRIVATE, edge.id, 'owner');
    expect(out.applied).toHaveLength(1);
    const edges = h.provider.all(PRIVATE).edges;
    expect(edges.find((e) => e.id === edge.id)?.retiredAt).not.toBeNull();
    const promoted = edges.find((e) => e.id === out.applied[0]);
    expect(promoted?.author).toBe('user');
    expect(promoted?.validFrom).toBe('2026-10-01');
    expect(promoted?.sourceRef).toBe(`promoted:${edge.id}`);
  });

  it('rejectProposal tombstones, so the same write is not proposed again', async () => {
    const first = await h.service.writeFacts(caller(), 'acme', [ent('Person', 'Ravi')], '');
    const id = first.proposed[0] ?? '';
    await h.service.rejectProposal(id, 'owner', 'no');
    const again = await h.service.writeFacts(caller(), 'acme', [ent('Person', 'Ravi')], '');
    expect(again.proposed).toEqual([]);
    expect(again.refused[0]?.reason).toContain('rejected');
  });

  it('accepting a shared-world proposal applies it with the original author and records decided_by', async () => {
    const first = await h.service.writeFacts(caller(), 'acme', [ent('Person', 'Ravi')], '');
    const out = await h.service.acceptProposal(first.proposed[0] ?? '', 'owner');
    expect(out.applied).toHaveLength(1);
    expect(h.provider.all(ACME).entities[0]?.author).toBe('agent');
    expect(h.store.get(first.proposed[0] ?? '')?.decidedBy).toBe('owner');
  });

  it('ownerWrite applies directly with the import author and may write a sensitive attribute', async () => {
    const p = h.provider.seedEntity(ACME, 'Person', 'Ravi');
    const out = await h.service.ownerWrite(
      ACME,
      [
        {
          kind: 'attribute',
          entityId: p.id,
          key: 'salary',
          value: 100,
          sourceRef: 'csv:1',
          author: 'agent',
          confidence: 1,
        },
      ],
      'owner',
      { author: 'import' },
    );
    expect(out.applied).toHaveLength(1);
    expect(h.provider.all(ACME).attributes[0]?.author).toBe('import');
  });

  it('purge goes to the provider with the reason and who asked', async () => {
    const r = await h.service.purge(PRIVATE, {}, 'gdpr', 'owner');
    expect(r).toEqual({ removed: 0 });
  });
});
