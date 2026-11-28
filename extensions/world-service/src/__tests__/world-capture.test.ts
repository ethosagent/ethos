import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CapturedFact, type CaptureJobRef, WorldCaptureRouter } from '../capture';
import { ACME, caller, PRIVATE, type ServiceHarness, serviceHarness } from './service-harness';

const JOB: CaptureJobRef = {
  sessionId: 's1',
  personalityId: 'engineer',
  initialPrompt: 'Ravi now owns billing-svc, please remember that for the on-call rota.',
};
const OWNS: CapturedFact = {
  text: 'Ravi owns billing-svc.',
  hint: 0.8,
  triple: { subject: 'Ravi', relation: 'owns', object: 'billing-svc' },
};

function router(h: ServiceHarness): WorldCaptureRouter {
  return new WorldCaptureRouter({
    service: h.service,
    schema: h.schema,
    onError: (e) => h.errors.push(e),
  });
}

describe('WorldCaptureRouter', () => {
  let h: ServiceHarness;
  beforeEach(async () => {
    h = await serviceHarness();
  });
  afterEach(() => h.dispose());

  it('graph fact is proposed, never applied, even on the private world', async () => {
    expect(await router(h).route(OWNS, JOB)).toBe('graph');
    // Nothing reached the backend; the private inbox holds the batch (two entities + the edge).
    expect(h.provider.all(PRIVATE).entities).toEqual([]);
    expect(h.provider.all(PRIVATE).edges).toEqual([]);
    const inbox = h.store.inbox(PRIVATE);
    expect(inbox.map((r) => r.summary).join('\n')).toMatch(/Ravi/);
    expect(inbox).toHaveLength(3);
    expect(new Set(inbox.map((r) => r.batchId)).size).toBe(1);
    expect(inbox.every((r) => r.proposedBy === 'engineer')).toBe(true);
    expect(inbox.every((r) => r.sourceRef.startsWith('session:s1 '))).toBe(true);
    expect(h.store.inbox(ACME)).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('reuses entities that already exist and proposes only the edge', async () => {
    h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    h.provider.seedEntity(PRIVATE, 'Service', 'billing-svc');
    expect(await router(h).route(OWNS, JOB)).toBe('graph');
    const inbox = h.store.inbox(PRIVATE);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.kind).toBe('assert');
    expect(h.provider.all(PRIVATE).edges).toEqual([]);
  });

  it('fact for a read-only mount is kept in memory, not dropped', async () => {
    // Only acme has a schema; the personality may only read it.
    await h.dispose();
    h = await serviceHarness({ mountAcme: false, schemaFor: [ACME] });
    await h.config.writeWorld(
      { id: 'acme', title: 'Acme', audience: 'shareable', readers: ['engineer'], proposers: [] },
      { by: 'test' },
    );
    await h.config.writeMounts(
      'engineer',
      { mounts: [{ world: 'acme', mode: 'read' }] },
      { by: 'test' },
    );
    expect(await router(h).route(OWNS, JOB)).toBe('memory');
    expect(h.store.inbox(ACME)).toEqual([]);
    expect(h.store.inbox(PRIVATE)).toEqual([]);
  });

  it('a propose mount takes the fact when the private world cannot hold it', async () => {
    await h.dispose();
    h = await serviceHarness({ schemaFor: [ACME] });
    expect(await router(h).route(OWNS, JOB)).toBe('graph');
    expect(h.store.inbox(ACME)).toHaveLength(3);
    expect(h.store.inbox(PRIVATE)).toEqual([]);
  });

  it('an unknown relation, a missing triple or an ambiguous type stays in memory', async () => {
    const r = router(h);
    const rel = { ...OWNS, triple: { subject: 'Ravi', relation: 'likes', object: 'tea' } };
    expect(await r.route(rel, JOB)).toBe('memory');
    expect(await r.route({ text: 'Prefers tea.', hint: 0.5 }, JOB)).toBe('memory');
    expect(h.store.inbox(PRIVATE)).toEqual([]);
  });

  it('a fact the vetting refuses stays in memory', async () => {
    const secret = {
      ...OWNS,
      triple: { subject: 'Ravi', relation: 'owns', object: 'AKIAIOSFODNN7EXAMPLE' },
    };
    expect(await router(h).route(secret, JOB)).toBe('memory');
    expect(h.store.inbox(PRIVATE).filter((r) => r.kind === 'assert')).toHaveLength(1);
  });

  it('R10 a shared audience sees no owner_only world, so nothing can be proposed for it', async () => {
    const shared = caller({ audience: 'shared', surface: 'extraction' });
    expect((await h.service.visible(shared)).map((w) => w.tag)).toEqual(['acme']);
    const out = await h.service.proposeFacts(
      shared,
      'private',
      [{ kind: 'entity', type: 'Person', name: 'Ravi', sourceRef: 'chat:1', author: 'agent' }],
      'extraction',
    );
    expect(out.proposed).toEqual([]);
    expect(out.refused).toHaveLength(1);
    expect(h.store.inbox(PRIVATE)).toEqual([]);
  });
});
