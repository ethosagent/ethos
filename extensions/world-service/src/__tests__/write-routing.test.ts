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

  it('accepting a conflict proposal records the proposal author and source as the closer, not the accepter or the old fact author', async () => {
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const ravi = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const priyaOwns = h.provider.seedEdge(PRIVATE, 'owns', priya.id, svc.id, { author: 'user' });
    await h.service.writeFacts(
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
    const [row] = h.store.inbox(PRIVATE);
    await h.service.acceptProposal(row?.id ?? '', 'owner');

    const closure = h.provider.closures.find((c) => c.factId === priyaOwns.id);
    expect(closure).toMatchObject({ kind: 'closed', author: 'agent', sourceRef: 'chat:3' });
    // The accepting owner lives in decided_by only.
    expect(h.store.get(row?.id ?? '')?.decidedBy).toBe('owner');
    const closed = (await h.provider.changes(PRIVATE, '2000-01-01', 50)).find(
      (c) => c.kind === 'closed' && c.factId === priyaOwns.id,
    );
    expect(closed).toMatchObject({ author: 'agent', sourceRef: 'chat:3' });
  });

  it('accept closes a user fact at its validFrom when the proposal fact starts earlier', async () => {
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const held = h.provider.seedAttribute(PRIVATE, priya.id, 'title', 'VP', {
      author: 'user',
      validFrom: '2026-11-20',
    });
    const out = await h.service.writeFacts(
      caller(),
      'private',
      [
        {
          kind: 'attribute',
          entityId: priya.id,
          key: 'title',
          value: 'Director',
          validFrom: '2026-11-01',
          sourceRef: 'chat:date',
          author: 'agent',
          confidence: 0.9,
        },
      ],
      'title changed',
    );
    expect(out.proposed).toHaveLength(1);
    const [row] = h.store.inbox(PRIVATE);
    const accepted = await h.service.acceptProposal(row?.id ?? '', 'owner');
    expect(accepted.refused).toEqual([]);
    expect(h.store.get(row?.id ?? '')?.status).toBe('accepted');
    const attrs = h.provider.all(PRIVATE).attributes;
    expect(attrs.find((a) => a.id === held.id)?.validTo).toBe('2026-11-20');
    const opened = attrs.find((a) => a.value === 'Director');
    expect(opened?.validTo).toBeNull();
    expect(opened?.author).toBe('agent');
  });

  it('a close that fails after the new fact is asserted leaves the proposal pending', async () => {
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const ravi = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const priyaOwns = h.provider.seedEdge(PRIVATE, 'owns', priya.id, svc.id, { author: 'user' });
    await h.service.writeFacts(
      caller(),
      'private',
      [
        {
          kind: 'edge',
          type: 'owns',
          fromId: ravi.id,
          toId: svc.id,
          sourceRef: 'chat:fail-close',
          author: 'agent',
          confidence: 0.9,
        },
      ],
      'Ravi took over',
    );
    const [row] = h.store.inbox(PRIVATE);
    const assertsBefore = h.provider.asserts.length;
    h.provider.close = async () => ({
      ok: false,
      code: 'invalid',
      reason: 'validTo is before validFrom',
    });
    const accepted = await h.service.acceptProposal(row?.id ?? '', 'owner');
    expect(accepted.applied).toHaveLength(1);
    expect(accepted.refused.map((r) => r.reason).join('\n')).toContain(
      `could not close ${priyaOwns.id}`,
    );
    expect(accepted.refused.map((r) => r.reason).join('\n')).toContain(
      'validTo is before validFrom',
    );
    expect(h.store.get(row?.id ?? '')?.status).toBe('pending');
    expect(h.provider.asserts.length).toBe(assertsBefore + 1);
    expect(h.provider.all(PRIVATE).edges.find((e) => e.id === priyaOwns.id)?.validTo).toBeNull();
    const opened = h.provider.all(PRIVATE).edges.find((e) => e.fromId === ravi.id);
    expect(opened?.validTo).toBeNull();
  });

  it('accept refuses before assert when a close target is already closed', async () => {
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const ravi = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const priyaOwns = h.provider.seedEdge(PRIVATE, 'owns', priya.id, svc.id, { author: 'user' });
    await h.service.writeFacts(
      caller(),
      'private',
      [
        {
          kind: 'edge',
          type: 'owns',
          fromId: ravi.id,
          toId: svc.id,
          sourceRef: 'chat:preflight',
          author: 'agent',
          confidence: 0.9,
        },
      ],
      'Ravi took over',
    );
    const [row] = h.store.inbox(PRIVATE);
    await h.provider.close(PRIVATE, priyaOwns.id, '2026-11-28', 'owner', 'user');
    const assertsBefore = h.provider.asserts.length;
    const edgesBefore = h.provider.all(PRIVATE).edges.length;
    const accepted = await h.service.acceptProposal(row?.id ?? '', 'owner');
    expect(accepted.applied).toEqual([]);
    expect(accepted.refused[0]?.reason).toContain(priyaOwns.id);
    expect(h.store.get(row?.id ?? '')?.status).toBe('pending');
    expect(h.provider.asserts.length).toBe(assertsBefore);
    expect(h.provider.all(PRIVATE).edges).toHaveLength(edgesBefore);
    expect(h.provider.all(PRIVATE).edges.find((e) => e.id === priyaOwns.id)?.validTo).toBe(
      '2026-11-28',
    );
  });

  it('accepting a close proposal from a feed caller records connector as the closer', async () => {
    const e = h.provider.seedEntity(ACME, 'Service', 'billing-svc');
    const p = h.provider.seedEntity(ACME, 'Person', 'Ravi');
    const edge = h.provider.seedEdge(ACME, 'owns', p.id, e.id, { author: 'agent' });
    const out = await h.service.closeFact(
      caller({ surface: 'feed' }),
      'acme',
      edge.id,
      '2026-11-01',
      'feed:hr',
    );
    expect(out.proposed).toHaveLength(1);
    await h.service.acceptProposal(out.proposed[0] ?? '', 'owner');
    expect(h.provider.closures).toEqual([
      expect.objectContaining({
        kind: 'closed',
        factId: edge.id,
        author: 'connector',
        sourceRef: 'feed:hr',
      }),
    ]);
  });

  it('accepting a close proposal from the agent records agent as the closer', async () => {
    const e = h.provider.seedEntity(ACME, 'Service', 'billing-svc');
    const p = h.provider.seedEntity(ACME, 'Person', 'Ravi');
    const edge = h.provider.seedEdge(ACME, 'owns', p.id, e.id, { author: 'agent' });
    const out = await h.service.closeFact(caller(), 'acme', edge.id, '2026-11-01', 'chat:2');
    await h.service.acceptProposal(out.proposed[0] ?? '', 'owner');
    expect(h.provider.closures).toEqual([
      expect.objectContaining({ factId: edge.id, author: 'agent', sourceRef: 'chat:2' }),
    ]);
  });

  it('a user attribute with a future validTo still forces a conflict proposal', async () => {
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const held = h.provider.seedAttribute(PRIVATE, priya.id, 'title', 'VP', { author: 'user' });
    held.validTo = '2026-12-31';
    const out = await h.service.writeFacts(
      caller(),
      'private',
      [
        {
          kind: 'attribute',
          entityId: priya.id,
          key: 'title',
          value: 'Director',
          sourceRef: 'chat:future',
          author: 'agent',
          confidence: 0.9,
        },
      ],
      '',
    );
    expect(out.applied).toEqual([]);
    expect(out.proposed).toHaveLength(1);
    expect(out.refused).toEqual([]);
    const attrs = h.provider.all(PRIVATE).attributes;
    expect(attrs).toHaveLength(1);
    expect(attrs[0]).toMatchObject({ id: held.id, value: 'VP', validTo: '2026-12-31' });
    expect(h.store.inbox(PRIVATE)[0]?.conflictWith).toBe(held.id);
    expect(h.store.get(out.proposed[0] ?? '')?.status).toBe('pending');
  });

  it('a direct write refuses before assert when the occupant already has validTo', async () => {
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const held = h.provider.seedAttribute(PRIVATE, priya.id, 'title', 'VP', { author: 'agent' });
    held.validTo = '2026-12-31';
    const assertsBefore = h.provider.asserts.length;
    const out = await h.service.writeFacts(
      caller(),
      'private',
      [
        {
          kind: 'attribute',
          entityId: priya.id,
          key: 'title',
          value: 'Director',
          sourceRef: 'chat:overlap',
          author: 'agent',
          confidence: 0.9,
        },
      ],
      '',
    );
    expect(out.applied).toEqual([]);
    expect(out.proposed).toEqual([]);
    expect(out.refused[0]?.reason).toContain('overlap');
    expect(out.refused[0]?.reason).toContain(held.id);
    expect(h.provider.asserts.length).toBe(assertsBefore);
    expect(h.errors).toEqual([]);
    expect(h.provider.all(PRIVATE).attributes).toEqual([
      expect.objectContaining({ id: held.id, value: 'VP', validTo: '2026-12-31' }),
    ]);
  });

  it('an attribute whose validTo is already past is not a collision', async () => {
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const held = h.provider.seedAttribute(PRIVATE, priya.id, 'title', 'VP', {
      author: 'user',
      validFrom: '2026-10-01',
    });
    held.validTo = '2026-11-01';
    const out = await h.service.writeFacts(
      caller(),
      'private',
      [
        {
          kind: 'attribute',
          entityId: priya.id,
          key: 'title',
          value: 'Director',
          sourceRef: 'chat:past',
          author: 'agent',
          confidence: 0.9,
        },
      ],
      '',
    );
    expect(out.proposed).toEqual([]);
    expect(out.refused).toEqual([]);
    expect(out.applied).toHaveLength(1);
    const attrs = h.provider.all(PRIVATE).attributes;
    expect(attrs.find((a) => a.id === held.id)).toMatchObject({
      value: 'VP',
      validTo: '2026-11-01',
    });
    expect(attrs.find((a) => a.value === 'Director')?.validTo).toBeNull();
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

  it('closeFact, promoteToUser and ownerClose look a fact up with getFact, never export', async () => {
    h.provider.export = async () => {
      throw new Error('export must not be called to find one fact');
    };
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const ravi = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const toClose = h.provider.seedEdge(PRIVATE, 'owns', ravi.id, svc.id, { author: 'agent' });
    const toPromote = h.provider.seedEdge(PRIVATE, 'owns', ravi.id, svc.id, { author: 'agent' });
    const toOwnerClose = h.provider.seedEdge(PRIVATE, 'owns', ravi.id, svc.id, { author: 'agent' });

    const closed = await h.service.closeFact(
      caller(),
      'private',
      toClose.id,
      '2026-11-01',
      'chat:5',
    );
    expect(closed.applied).toEqual([toClose.id]);
    const promoted = await h.service.promoteToUser(PRIVATE, toPromote.id, 'owner');
    expect(promoted.applied).toHaveLength(1);
    const owner = await h.service.ownerClose(PRIVATE, toOwnerClose.id, '2026-11-02', 'owner');
    expect(owner.applied).toEqual([toOwnerClose.id]);
    // A closed fact is still found, so the refusal says "closed", not "not_found".
    const again = await h.service.ownerClose(PRIVATE, toOwnerClose.id, '2026-11-03', 'owner');
    expect(again.refused[0]?.reason).toContain('closed');
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
