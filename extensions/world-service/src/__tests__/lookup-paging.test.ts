import type { FactInput } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { type CapturedFact, type CaptureJobRef, WorldCaptureRouter } from '../capture';
import { rippleWalk } from '../ripple';
import { caller, PRIVATE, type ServiceHarness, serviceHarness } from './service-harness';
import { SCHEMA_FOR_WATCHLIST } from './watchlist-schema';

// A lookup that the provider truncates must be paged (re-queried with a
// growing limit) before a write is decided; if the ceiling is reached with the
// set still unseen, the write is refused as `lookup_incomplete`.

const PAGE = 200;
const FUTURE = '2099-01-01';

const ownsEdge = (fromId: string, toId: string): FactInput => ({
  kind: 'edge',
  type: 'owns',
  fromId,
  toId,
  sourceRef: 'chat:3',
  author: 'agent',
  confidence: 0.9,
});

const ent = (name: string): FactInput => ({
  kind: 'entity',
  type: 'Person',
  name,
  sourceRef: 'chat:1',
  author: 'agent',
});

describe('truncated lookups are paged before a write is decided', () => {
  let h: ServiceHarness;
  afterEach(() => h.dispose());

  /** 250 scheduled-end owners (returned by the provider, not live) ahead of the one live owner. */
  function seedOwners(svcId: string): { priyaOwns: string; ravi: string } {
    for (let i = 0; i < PAGE + 50; i++) {
      const old = h.provider.seedEntity(PRIVATE, 'Person', `Former ${i}`);
      const e = h.provider.seedEdge(PRIVATE, 'owns', old.id, svcId, { author: 'agent' });
      e.validTo = FUTURE;
    }
    const priya = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const ravi = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const priyaOwns = h.provider.seedEdge(PRIVATE, 'owns', priya.id, svcId, { author: 'user' });
    return { priyaOwns: priyaOwns.id, ravi: ravi.id };
  }

  it('a live unique owner past the first page still turns the second owns into a conflict proposal', async () => {
    h = await serviceHarness();
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const { priyaOwns, ravi } = seedOwners(svc.id);

    const out = await h.service.writeFacts(caller(), 'private', [ownsEdge(ravi, svc.id)], 'swap');

    expect(out.applied).toEqual([]);
    expect(out.refused).toEqual([]);
    expect(out.proposed).toHaveLength(1);
    expect(h.store.inbox(PRIVATE)[0]?.conflictWith).toBe(priyaOwns);
    const liveOwners = h.provider
      .all(PRIVATE)
      .edges.filter((e) => e.type === 'owns' && e.validTo === null && e.retiredAt === null);
    expect(liveOwners.map((e) => e.id)).toEqual([priyaOwns]);
  });

  it('an existing entity past the first page is detected as a duplicate, not stored twice', async () => {
    h = await serviceHarness();
    for (let i = 0; i < PAGE + 50; i++) h.provider.seedEntity(PRIVATE, 'Person', `Priya ${i}`);
    const real = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const before = h.provider.all(PRIVATE).entities.length;

    const out = await h.service.writeFacts(caller(), 'private', [ent('Priya')], 'met her');

    expect(out.applied).toEqual([]);
    expect(out.refused).toEqual([{ index: 0, reason: `duplicate: already stored as ${real.id}` }]);
    expect(h.provider.all(PRIVATE).entities).toHaveLength(before);
  });

  it('refuses lookup_incomplete when the ceiling is hit without seeing the whole unique-edge set', async () => {
    h = await serviceHarness({ lookupCeiling: PAGE });
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const { ravi } = seedOwners(svc.id);

    const out = await h.service.writeFacts(caller(), 'private', [ownsEdge(ravi, svc.id)], 'swap');

    expect(out.applied).toEqual([]);
    expect(out.proposed).toEqual([]);
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0]?.reason).toMatch(/^lookup_incomplete: /);
    expect(h.provider.asserts.filter((a) => a.world === PRIVATE)).toEqual([]);
  });

  it('refuses lookup_incomplete for an entity when the ceiling is hit and no match was seen', async () => {
    h = await serviceHarness({ lookupCeiling: PAGE });
    for (let i = 0; i < PAGE + 50; i++) h.provider.seedEntity(PRIVATE, 'Person', `Priya ${i}`);
    h.provider.seedEntity(PRIVATE, 'Person', 'Priya');

    const out = await h.service.writeFacts(caller(), 'private', [ent('Priya')], 'met her');

    expect(out.applied).toEqual([]);
    expect(out.refused[0]?.reason).toMatch(/^lookup_incomplete: /);
    expect(h.provider.all(PRIVATE).entities.filter((e) => e.name === 'Priya')).toHaveLength(1);
  });

  it('accepting a proposal whose endpoint sits past the first page resolves it, not "accept first"', async () => {
    h = await serviceHarness();
    for (let i = 0; i < PAGE + 50; i++) h.provider.seedEntity(PRIVATE, 'Service', `svc ${i}`);
    const svc = h.provider.seedEntity(PRIVATE, 'Service', 'svc');
    const ravi = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const q = h.store.propose({
      world: PRIVATE,
      kind: 'assert',
      payload: {
        fact: ownsEdge(ravi.id, 'x'),
        closes: [],
        refs: { toId: { type: 'Service', name: 'svc' } },
      },
      summary: 'Ravi owns svc',
      conflictWith: null,
      sourceRef: 'chat:3',
      proposedBy: 'engineer',
      sessionId: 's1',
      confidence: 0.9,
      batchId: 'b-1',
    });
    if ('refused' in q) throw new Error('setup');

    const out = await h.service.acceptProposal(q.id, 'owner');

    expect(out.refused).toEqual([]);
    expect(out.applied).toHaveLength(1);
    expect(h.provider.all(PRIVATE).edges[0]?.toId).toBe(svc.id);
  });
});

describe('capture and ripple page truncated lookups', () => {
  let h: ServiceHarness;
  afterEach(() => h.dispose());

  const JOB: CaptureJobRef = {
    sessionId: 's1',
    personalityId: 'engineer',
    initialPrompt: 'Ravi now owns billing-svc.',
  };
  const OWNS: CapturedFact = {
    text: 'Ravi owns billing-svc.',
    hint: 0.8,
    triple: { subject: 'Ravi', relation: 'owns', object: 'billing-svc' },
  };

  it('capture finds an existing endpoint past its first page and proposes only the edge', async () => {
    h = await serviceHarness();
    for (let i = 0; i < 250; i++) h.provider.seedEntity(PRIVATE, 'Person', `Ravi ${i}`);
    h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    const router = new WorldCaptureRouter({ service: h.service, schema: h.schema });

    expect(await router.route(OWNS, JOB)).toBe('graph');

    const inbox = h.store.inbox(PRIVATE);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.kind).toBe('assert');
  });

  it('ripple walks every watched edge past its first page', async () => {
    h = await serviceHarness({ schemaText: SCHEMA_FOR_WATCHLIST });
    const p = h.provider;
    const e = (type: string, name: string) => p.seedEntity(PRIVATE, type, name).id;
    const list = e('List', 'Core');
    const outage = e('Event', 'fab outage');
    const fabr = e('Stock', 'FABR');
    p.seedEdge(PRIVATE, 'affected_by', fabr, outage);
    for (let i = 0; i < 600; i++) {
      const s = e('Stock', `S${i}`);
      p.seedEdge(PRIVATE, 'watched_in', s, list);
    }
    const target = e('Stock', 'TARGET');
    p.seedEdge(PRIVATE, 'watched_in', target, list);
    p.seedEdge(PRIVATE, 'supplies', fabr, target);

    const out = await rippleWalk(h.service, caller(), {
      world: 'private',
      eventId: outage,
      listName: 'Core',
    });

    expect(out.map((r) => r.stock)).toEqual(['TARGET']);
  });

  it('ripple throws lookup_incomplete rather than walking a truncated edge page', async () => {
    h = await serviceHarness({ schemaText: SCHEMA_FOR_WATCHLIST });
    const p = h.provider;
    const list = p.seedEntity(PRIVATE, 'List', 'Core').id;
    const outage = p.seedEntity(PRIVATE, 'Event', 'fab outage').id;
    for (let i = 0; i < 8100; i++) {
      p.seedEdge(PRIVATE, 'watched_in', list, list);
    }

    await expect(
      rippleWalk(h.service, caller(), { world: 'private', eventId: outage, listName: 'Core' }),
    ).rejects.toThrow(/^lookup_incomplete: /);
  });
});
