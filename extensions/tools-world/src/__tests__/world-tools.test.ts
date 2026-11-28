import type { Tool, ToolResult } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorldTools } from '../index';
import { addWorld, ctxFor, type ToolHarness, textOf, toolHarness } from './harness';

const PRIVATE = 'personality:engineer' as const;
const ACME = 'world:acme' as const;

describe('world read tools', () => {
  let h: ToolHarness;
  let tools: Map<string, Tool>;
  beforeEach(async () => {
    h = await toolHarness();
    tools = new Map(createWorldTools(h.port).map((t) => [t.name, t as Tool]));
  });
  afterEach(() => h.dispose());

  const run = (name: string, args: Record<string, unknown>, ctx = ctxFor()): Promise<ToolResult> =>
    (tools.get(name) as Tool).execute(args, ctx);

  it('R8 unscoped queries are tagged and span only mounted worlds', async () => {
    await addWorld(h, 'beta', { mount: false });
    h.provider.seedEntity(ACME, 'Person', 'Ravi');
    h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    h.provider.seedEntity('world:beta', 'Person', 'Ravi');

    const r = await run('world_query', { text: 'Ravi' });
    const text = textOf(r);
    expect(r.ok).toBe(true);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.startsWith('acme:Ravi (Person)'))).toBe(true);
    expect(lines.some((l) => l.startsWith('private:Ravi (Person)'))).toBe(true);
    expect(text).not.toContain('beta');
  });

  it('same name in two worlds is two entities', async () => {
    const a = h.provider.seedEntity(ACME, 'Person', 'Ravi');
    const p = h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');
    const text = textOf(await run('world_query', { text: 'Ravi' }));
    expect(a.id).not.toBe(p.id);
    expect(text).toContain(`#${a.id}`);
    expect(text).toContain(`#${p.id}`);
    expect(text.match(/Ravi \(Person\)/g)).toHaveLength(2);
  });

  it('shared turn drops owner_only worlds from results', async () => {
    await addWorld(h, 'ops', { audience: 'owner_only' });
    h.provider.seedEntity(ACME, 'Person', 'Ravi');
    h.provider.seedEntity('world:ops', 'Person', 'Ravi');
    h.provider.seedEntity(PRIVATE, 'Person', 'Ravi');

    const priv = textOf(await run('world_query', { text: 'Ravi' }));
    expect(priv).toContain('ops:Ravi');
    expect(priv).toContain('private:Ravi');

    const shared = textOf(
      await run('world_query', { text: 'Ravi' }, ctxFor({ roomAudience: 'shared' })),
    );
    expect(shared).toContain('acme:Ravi');
    expect(shared).not.toContain('ops:Ravi');
    expect(shared).not.toContain('private:Ravi');

    const named = await run(
      'world_query',
      { text: 'Ravi', world: 'ops' },
      ctxFor({ roomAudience: 'shared' }),
    );
    expect(named.ok).toBe(false);
    expect(textOf(named)).toContain('not_mounted');
  });

  it('as_of returns the earlier owner', async () => {
    const ravi = h.provider.seedEntity(ACME, 'Person', 'Ravi');
    const priya = h.provider.seedEntity(ACME, 'Person', 'Priya');
    const svc = h.provider.seedEntity(ACME, 'Service', 'billing-svc');
    const edge = (id: string, from: string, validFrom: string) => ({
      id,
      world: ACME,
      type: 'owns',
      fromId: from,
      toId: svc.id,
      attrs: {},
      validFrom,
      validTo: null,
      recordedAt: '',
      retiredAt: null,
      sourceRef: 'chat:s-41',
      author: 'user' as const,
      confidence: 1,
    });
    const asOfs: Array<string | undefined> = [];
    const port = {
      ...h.port,
      neighbours: async (...a: Parameters<typeof h.port.neighbours>) => {
        const asOf = a[4]?.asOf;
        asOfs.push(asOf);
        const facts = await h.port.neighbours(...a);
        const early = asOf !== undefined && asOf < '2026-11-01';
        return {
          ...facts,
          entities: [
            { ...ravi, tag: 'acme', displayTag: 'acme:Ravi' },
            { ...priya, tag: 'acme', displayTag: 'acme:Priya' },
            { ...svc, tag: 'acme', displayTag: 'acme:billing-svc' },
          ],
          edges: [
            {
              ...(early ? edge('r1', ravi.id, '2026-01-01') : edge('r2', priya.id, '2026-11-01')),
              tag: 'acme',
            },
          ],
        };
      },
    };
    const t = new Map(createWorldTools(port).map((x) => [x.name, x as Tool]));
    const call = (args: Record<string, unknown>) =>
      (t.get('world_neighbours') as Tool).execute(
        { world: 'acme', entity: svc.id, ...args },
        ctxFor(),
      );

    const earlier = textOf(await call({ as_of: '2026-03-01' }));
    expect(earlier).toContain('acme:Ravi (Person) owns billing-svc (Service) since 2026-01-01');
    expect(asOfs).toEqual(['2026-03-01']);
    const now = textOf(await call({}));
    expect(now).toContain('acme:Priya (Person) owns billing-svc (Service) since 2026-11-01');
    expect((await call({ as_of: 'last spring' })).ok).toBe(false);
  });

  it('an empty result names the worlds searched', async () => {
    const text = textOf(await run('world_query', { text: 'nobody' }));
    expect(text).toBe('No matching facts in worlds: private, acme.');
  });

  it('world_history lists closed values and needs a world when several are visible', async () => {
    const e = h.provider.seedEntity(ACME, 'Person', 'Ravi');
    const a = h.provider.seedAttribute(ACME, e.id, 'title', 'Engineer');
    await h.provider.close(ACME, a.id, '2026-06-01');

    const needs = await run('world_history', { entity: e.id });
    expect(needs.ok).toBe(false);
    expect(textOf(needs)).toContain('WORLD_REQUIRED');

    const text = textOf(await run('world_history', { world: 'acme', entity: e.id }));
    expect(text).toContain('.title = "Engineer"');
    expect(text).toContain('until 2026-06-01');
  });

  it('every read tool is service-mediated with a result cap', () => {
    for (const n of ['world_query', 'world_neighbours', 'world_history']) {
      const t = tools.get(n) as Tool;
      expect(t.toolset).toBe('world');
      expect(t.capabilities).toEqual({});
      expect(t.maxResultChars).toBe(8000);
    }
  });
});

describe('world write tools', () => {
  let h: ToolHarness;
  let tools: Map<string, Tool>;
  beforeEach(async () => {
    h = await toolHarness();
    tools = new Map(createWorldTools(h.port).map((t) => [t.name, t as Tool]));
  });
  afterEach(() => h.dispose());

  const run = (name: string, args: Record<string, unknown>, ctx = ctxFor()): Promise<ToolResult> =>
    (tools.get(name) as Tool).execute(args, ctx);
  const ravi = { kind: 'entity', type: 'Person', name: 'Ravi' };

  it('R9 write without world refused when 2+ mounted', async () => {
    const r = await run('world_assert', { facts: [ravi] });
    expect(r.ok).toBe(false);
    const text = textOf(r);
    expect(text).toContain('WORLD_REQUIRED');
    expect(text).toContain('private');
    expect(text).toContain('acme');
    expect(h.provider.all(PRIVATE).entities).toEqual([]);
    expect(h.provider.all(ACME).entities).toEqual([]);
  });

  it('assert on acme becomes a proposal; on private applies', async () => {
    const shared = await run('world_assert', { world: 'acme', facts: [ravi], why: 'met in chat' });
    expect(textOf(shared)).toContain('applied 0 · proposed 1 · refused 0');
    expect(h.provider.all(ACME).entities).toEqual([]);

    const priv = await run('world_assert', { world: 'private', facts: [ravi] });
    expect(textOf(priv)).toContain('applied 1 · proposed 0 · refused 0');
    expect(h.provider.all(PRIVATE).entities.map((e) => e.name)).toEqual(['Ravi']);
    expect(h.provider.all(PRIVATE).entities[0]?.author).toBe('agent');
  });

  it('read mount cannot propose', async () => {
    await addWorld(h, 'ro', { mode: 'read' });
    const r = await run('world_propose', { world: 'ro', facts: [ravi], why: 'x' });
    expect(r.ok).toBe(false);
    expect(textOf(r)).toContain('read_only');
  });

  it('world_propose proposes even on the private world', async () => {
    const r = await run('world_propose', { world: 'private', facts: [ravi], why: 'check with me' });
    expect(textOf(r)).toContain('applied 0 · proposed 1 · refused 0');
    expect(h.provider.all(PRIVATE).entities).toEqual([]);
  });

  it('a conflict with your fact is named in the reply', async () => {
    const e = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    h.provider.seedAttribute(PRIVATE, e.id, 'title', 'Staff Engineer', { author: 'user' });
    const r = await run('world_assert', {
      world: 'private',
      facts: [{ kind: 'attribute', entity_id: e.id, key: 'title', value: 'Intern' }],
    });
    expect(textOf(r)).toMatch(
      /applied 0 · proposed 1 \(conflicts with your fact: .*title.*\) · refused 0/,
    );
    expect(h.provider.all(PRIVATE).attributes.find((a) => a.key === 'title')?.value).toBe(
      'Staff Engineer',
    );
  });

  it('refusals are listed with their reason', async () => {
    const r = await run('world_assert', {
      world: 'private',
      facts: [{ kind: 'entity', type: 'Nope', name: 'X' }],
    });
    expect(r.ok).toBe(false);
    expect(textOf(r)).toContain('refused 1');
    expect(textOf(r)).toContain('#0');
  });

  it('malformed facts are input_invalid', async () => {
    const r = await run('world_assert', { world: 'private', facts: [{ kind: 'planet' }] });
    expect(r).toMatchObject({ ok: false, code: 'input_invalid' });
    expect((await run('world_assert', { world: 'private', facts: [] })).ok).toBe(false);
  });

  it('world_close closes an agent fact and proposes closing a user fact', async () => {
    const e = h.provider.seedEntity(PRIVATE, 'Person', 'Priya');
    const mine = h.provider.seedAttribute(PRIVATE, e.id, 'title', 'Eng', { author: 'agent' });
    const theirs = h.provider.seedAttribute(PRIVATE, e.id, 'email', 'p@x.io', { author: 'user' });

    const a = await run('world_close', {
      world: 'private',
      fact_id: mine.id,
      valid_to: '2026-11-01',
    });
    expect(textOf(a)).toContain('applied 1 · proposed 0 · refused 0');
    expect(h.provider.all(PRIVATE).attributes.find((x) => x.id === mine.id)?.validTo).toBe(
      '2026-11-01',
    );

    const b = await run('world_close', {
      world: 'private',
      fact_id: theirs.id,
      valid_to: '2026-11-01',
    });
    expect(textOf(b)).toContain('applied 0 · proposed 1 (conflicts with your fact');
    expect(h.provider.all(PRIVATE).attributes.find((x) => x.id === theirs.id)?.validTo).toBeNull();

    expect(
      (await run('world_close', { world: 'private', fact_id: mine.id, valid_to: 'soon' })).ok,
    ).toBe(false);
  });

  it('schema change on private adds mentors and reports the version', async () => {
    const r = await run('world_schema_change', {
      world: 'private',
      change: { op: 'add_entity_type', type: 'Mentor' },
      reason: 'track mentors',
    });
    expect(r.ok).toBe(true);
    expect(textOf(r)).toMatch(/schema updated: now version \d+/);
    expect(h.provider.appliedSchemas.at(-1)?.schema.entities.Mentor).toBeDefined();
  });

  it('schema change on a shared world is a proposal', async () => {
    const r = await run('world_schema_change', {
      world: 'acme',
      change: { op: 'add_entity_type', type: 'Mentor' },
      reason: 'x',
    });
    expect(textOf(r)).toContain('proposed');
    expect(
      (await run('world_schema_change', { world: 'acme', change: { op: 'explode' }, reason: '' }))
        .ok,
    ).toBe(false);
  });

  it('write tools are service-mediated', () => {
    for (const n of ['world_assert', 'world_close', 'world_propose', 'world_schema_change']) {
      const t = tools.get(n) as Tool;
      expect(t.toolset).toBe('world');
      expect(t.capabilities).toEqual({});
    }
  });
});
