import type { Session, StoredMessage } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { WorldBuildError, WorldBuildService } from '../build/build';
import type { CompleteFn, CompleteRequest } from '../build/extract';
import { caller, PRIVATE, type ServiceHarness, serviceHarness } from './service-harness';

const session = (id: string, updatedAt = '2026-11-10T00:00:00Z'): Session => ({
  id,
  key: `cli:${id}`,
  platform: 'cli',
  model: 'm',
  provider: 'p',
  personalityId: 'engineer',
  usage: {} as Session['usage'],
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date(updatedAt),
});
const msg = (id: string, content: string): StoredMessage =>
  ({ id: `${id}-m`, sessionId: id, role: 'user', content }) as StoredMessage;

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

const harnesses: ServiceHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.dispose();
});

interface Rig {
  h: ServiceHarness;
  build: WorldBuildService;
  calls: CompleteRequest[];
}

/** `replies` are returned one per call, in order; the last repeats. */
async function rig(opts: {
  memory?: string;
  sessions?: Array<{ s: Session; text: string }>;
  replies: unknown[];
  tokens?: number;
  price?: (i: number, o: number) => number;
}): Promise<Rig> {
  const h = await serviceHarness();
  harnesses.push(h);
  const calls: CompleteRequest[] = [];
  let n = 0;
  const complete: CompleteFn = async (req) => {
    calls.push(req);
    const r = opts.replies[Math.min(n++, opts.replies.length - 1)];
    return {
      text: typeof r === 'string' ? r : JSON.stringify(r),
      inputTokens: opts.tokens ?? 100,
      outputTokens: 50,
    };
  };
  const build = new WorldBuildService({
    service: h.service,
    store: h.store,
    schema: h.schema,
    sources: {
      memory: async () => ({ memory: opts.memory ?? '', user: '' }),
      sessions: () =>
        from((opts.sessions ?? []).map((x) => ({ session: x.s, messages: [msg(x.s.id, x.text)] }))),
      isShared: () => false,
    },
    complete,
    wrap: (text, source) => `<untrusted source="${source}">${text}</untrusted>`,
    price: opts.price ?? ((i, o) => (i + o) * 1e-6),
  });
  return { h, build, calls };
}

const io = { readFolder: () => from([]) };
const est = (r: Rig, c = caller()) =>
  r.build.handle(c, 'private', { action: 'estimate', folders: [] }, io);

describe('staged first build', () => {
  it('stub LLM: 3 people, 2 teams, 4 links staged, nothing live', async () => {
    const reply = {
      entities: [
        ...['Mei', 'Ravi', 'Ana'].map((name) => ({ type: 'Person', name })),
        ...['billing', 'search'].map((name) => ({ type: 'Service', name })),
        { type: 'Skill', name: 'Kafka' },
      ],
      links: [
        {
          type: 'owns',
          from: { type: 'Person', name: 'Ravi' },
          to: { type: 'Service', name: 'billing' },
        },
        {
          type: 'owns',
          from: { type: 'Person', name: 'Mei' },
          to: { type: 'Service', name: 'search' },
        },
        {
          type: 'expert_in',
          from: { type: 'Person', name: 'Ana' },
          to: { type: 'Skill', name: 'Kafka' },
        },
        {
          type: 'expert_in',
          from: { type: 'Person', name: 'Mei' },
          to: { type: 'Skill', name: 'Kafka' },
        },
      ],
    };
    const r = await rig({ memory: 'Ravi owns billing. Mei owns search.', replies: [reply] });
    const e = await est(r);
    const run = await r.build.handle(caller(), null, { action: 'run', buildId: e.buildId }, io);
    if (run.action !== 'run') throw new Error('expected run');
    expect(run.entities).toEqual({ Person: 3, Service: 2, Skill: 1 });
    expect(run.links).toBe(4);
    expect(r.h.store.getBuild(e.buildId)?.status).toBe('staged');
    const bundle = await r.h.provider.export(PRIVATE);
    expect(bundle.entities).toHaveLength(0);
    expect(bundle.edges).toHaveLength(0);
  });

  it('Priya and priya@acme.example merge; Pria is flagged unsure', async () => {
    const reply = {
      entities: [
        { type: 'Person', name: 'Priya' },
        { type: 'Person', name: 'priya@acme.example' },
        { type: 'Person', name: 'Pria' },
      ],
    };
    const r = await rig({ memory: 'notes', replies: [reply] });
    const e = await est(r);
    const run = await r.build.handle(caller(), null, { action: 'run', buildId: e.buildId }, io);
    if (run.action !== 'run') throw new Error('expected run');
    expect(run.entities.Person).toBe(2);
    expect(run.duplicates).toBe(1);
    const items = r.h.store.listBuildItems(e.buildId);
    const people = items.filter(
      (i) => i.kind === 'fact' && JSON.stringify(i.payload).includes('"entity"'),
    );
    const sureOf = (name: string) =>
      people.find((i) => (i.payload as { name?: string }).name === name)?.sure;
    expect(sureOf('Priya')).toBe(true);
    expect(sureOf('Pria')).toBe(false);
    expect(JSON.stringify(items)).not.toContain('@');
    expect(items.some((i) => i.kind === 'duplicate')).toBe(true);
  });

  it('a contradiction of a user fact is a conflict item', async () => {
    const r = await rig({
      memory: 'Ana is VP.',
      replies: [
        {
          entities: [{ type: 'Person', name: 'Ana' }],
          attributes: [{ entity: { type: 'Person', name: 'Ana' }, key: 'title', value: 'VP' }],
        },
      ],
    });
    const made = await r.h.service.ownerWrite(
      PRIVATE,
      [{ kind: 'entity', type: 'Person', name: 'Ana', sourceRef: 'user', author: 'user' }],
      'owner',
    );
    const anaId = made.applied[0] ?? '';
    await r.h.service.ownerWrite(
      PRIVATE,
      [
        {
          kind: 'attribute',
          entityId: anaId,
          key: 'title',
          value: 'CTO',
          sourceRef: 'user',
          author: 'user',
          confidence: 1,
        },
      ],
      'owner',
    );
    const e = await est(r);
    const run = await r.build.handle(caller(), null, { action: 'run', buildId: e.buildId }, io);
    if (run.action !== 'run') throw new Error('expected run');
    expect(run.conflicts).toBe(1);
    const items = r.h.store.listBuildItems(e.buildId);
    expect(items.filter((i) => i.kind === 'conflict')).toHaveLength(1);
    expect(
      items.some((i) => i.kind === 'fact' && JSON.stringify(i.payload).includes('"attribute"')),
    ).toBe(false);
  });

  it('chunk text is redacted before the LLM sees it', async () => {
    const r = await rig({
      memory: 'Reach Ravi at ravi@acme.example, key AKIAIOSFODNN7EXAMPLE. Ravi owns billing.',
      replies: [{ entities: [] }],
    });
    const e = await est(r);
    await r.build.handle(caller(), null, { action: 'run', buildId: e.buildId }, io);
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0];
    expect(call?.user).not.toContain('ravi@acme.example');
    expect(call?.user).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(call?.user).toContain('<untrusted source="memory:MEMORY.md">');
    expect(call?.user).toContain('Ravi owns billing');
  });

  it('budget: build stops at the estimate × 1.2 and stages what it has as failed-partial', async () => {
    const sessions = ['s1', 's2', 's3'].map((id) => ({ s: session(id), text: `chat ${id}` }));
    const replies = ['Mei', 'Ravi', 'Ana'].map((name) => ({
      entities: [{ type: 'Person', name }],
    }));
    const r = await rig({ sessions, replies, tokens: 1_000_000 });
    const e = await est(r);
    const run = await r.build.handle(caller(), null, { action: 'run', buildId: e.buildId }, io);
    if (run.action !== 'run') throw new Error('expected run');
    expect(run.partial).toBe(true);
    expect(r.calls).toHaveLength(1);
    const row = r.h.store.getBuild(e.buildId);
    expect(row?.status).toBe('failed');
    expect(row?.spentUsd ?? 0).toBeGreaterThan((row?.estimateUsd ?? 0) * 1.2);
    expect(r.h.store.listBuildItems(e.buildId).length).toBeGreaterThan(0);
  });

  it('a build of another personality is refused', async () => {
    const r = await rig({ memory: 'x', replies: [{ entities: [] }] });
    const e = await est(r);
    await expect(
      r.build.handle(
        caller({ personalityId: 'coach' }),
        null,
        { action: 'run', buildId: e.buildId },
        io,
      ),
    ).rejects.toBeInstanceOf(WorldBuildError);
    await expect(
      r.build.handle(
        caller({ audience: 'shared' }),
        'private',
        { action: 'estimate', folders: [] },
        io,
      ),
    ).rejects.toBeInstanceOf(WorldBuildError);
  });
});
