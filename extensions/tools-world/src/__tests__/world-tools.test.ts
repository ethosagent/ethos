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
