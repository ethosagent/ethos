import type { WorldSchema } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vetFact } from '../vetting';
import { caller, PRIVATE, type ServiceHarness, serviceHarness } from './service-harness';

const schema: WorldSchema = {
  version: 1,
  entities: {
    Person: { attrs: { email: { type: 'string' }, salary: { type: 'int' } } },
    Skill: { attrs: {} },
  },
  edges: { expert_in: { from: ['Person'], to: ['Skill'], attrs: { level: { type: 'int' } } } },
};
const ctx = { schema, sensitive: ['entity:Person.salary'], actor: 'agent' as const };

describe('vetFact', () => {
  it('passes a clean entity', () => {
    expect(
      vetFact({ kind: 'entity', type: 'Skill', name: 'Go', sourceRef: 's', author: 'agent' }, ctx),
    ).toEqual({ ok: true });
  });

  it('refuses an unknown entity type and an unknown edge type', () => {
    const e = vetFact(
      { kind: 'entity', type: 'Ghost', name: 'x', sourceRef: 's', author: 'agent' },
      ctx,
    );
    expect(e.ok).toBe(false);
    const r = vetFact(
      {
        kind: 'edge',
        type: 'haunts',
        fromId: 'a',
        toId: 'b',
        sourceRef: 's',
        author: 'agent',
        confidence: 1,
      },
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it('skips schema fit when the world has no schema yet', () => {
    const r = vetFact(
      { kind: 'entity', type: 'Ghost', name: 'x', sourceRef: 's', author: 'agent' },
      { ...ctx, schema: { version: 0, entities: {}, edges: {} } },
    );
    expect(r).toEqual({ ok: true });
  });

  it('refuses a confidence outside 0..1', () => {
    const r = vetFact(
      {
        kind: 'attribute',
        entityId: 'a',
        key: 'email',
        value: 'x',
        sourceRef: 's',
        author: 'agent',
        confidence: 2,
      },
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it('does not echo the secret in the refusal reason', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const r = vetFact(
      { kind: 'entity', type: 'Skill', name: secret, sourceRef: 's', author: 'agent' },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('the owner may write PII and a sensitive key, but never a secret', () => {
    const owner = { ...ctx, actor: 'owner' as const };
    expect(
      vetFact(
        {
          kind: 'attribute',
          entityId: 'a',
          key: 'salary',
          value: 5,
          sourceRef: 's',
          author: 'user',
          confidence: 1,
        },
        owner,
      ),
    ).toEqual({ ok: true });
    expect(
      vetFact(
        {
          kind: 'attribute',
          entityId: 'a',
          key: 'email',
          value: 'a@b.com',
          sourceRef: 's',
          author: 'user',
          confidence: 1,
        },
        owner,
      ),
    ).toEqual({ ok: true });
    expect(
      vetFact(
        {
          kind: 'entity',
          type: 'Skill',
          name: 'AKIAIOSFODNN7EXAMPLE',
          sourceRef: 's',
          author: 'user',
        },
        owner,
      ).ok,
    ).toBe(false);
  });
});

describe('fact vetting through WorldService', () => {
  let h: ServiceHarness;
  beforeEach(async () => {
    h = await serviceHarness();
  });
  afterEach(() => h.dispose());

  it('R11 a fact carrying a secret is refused', async () => {
    const out = await h.service.writeFacts(
      caller(),
      'private',
      [
        {
          kind: 'entity',
          type: 'Skill',
          name: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
          sourceRef: 'c',
          author: 'agent',
        },
        {
          kind: 'entity',
          type: 'Skill',
          name: 'AKIAIOSFODNN7EXAMPLE',
          sourceRef: 'c',
          author: 'agent',
        },
        { kind: 'entity', type: 'Skill', name: 'ravi@acme.com', sourceRef: 'c', author: 'agent' },
        { kind: 'entity', type: 'Skill', name: 'Go', sourceRef: 'c', author: 'agent' },
      ],
      '',
    );
    expect(out.refused.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(out.applied).toHaveLength(1);
    expect(h.provider.all(PRIVATE).entities.map((e) => e.name)).toEqual(['Go']);
  });

  it('R11 a secret is refused at proposal creation on a shared world too', async () => {
    const out = await h.service.writeFacts(
      caller(),
      'acme',
      [
        {
          kind: 'entity',
          type: 'Skill',
          name: 'AKIAIOSFODNN7EXAMPLE',
          sourceRef: 'c',
          author: 'agent',
        },
      ],
      '',
    );
    expect(out.proposed).toEqual([]);
    expect(out.refused).toHaveLength(1);
    expect(h.store.inbox('world:acme')).toEqual([]);
  });

  it('sensitive attribute refused for the agent, allowed for the owner', async () => {
    const p = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const fact = {
      kind: 'attribute' as const,
      entityId: p.id,
      key: 'salary',
      value: 100,
      sourceRef: 'c',
      author: 'agent' as const,
      confidence: 1,
    };
    const agent = await h.service.writeFacts(caller(), 'private', [fact], '');
    expect(agent.refused[0]?.reason).toContain('sensitive');
    expect(h.provider.all(PRIVATE).attributes).toEqual([]);
    const owner = await h.service.ownerWrite(PRIVATE, [{ ...fact, author: 'user' }], 'owner');
    expect(owner.applied).toHaveLength(1);
  });
});
