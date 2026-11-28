import type { Edge, Entity, GraphBundle } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { toGraphML } from '../codecs/graphml';
import { toBundleJson } from '../codecs/json';
import { toMermaid } from '../codecs/mermaid';
import { sliceBundle } from '../codecs/slice';

const W = 'world:acme' as const;

function ent(id: string, name: string, over: Partial<Entity> = {}): Entity {
  return {
    id,
    world: W,
    type: 'person',
    name,
    aliases: [],
    recordedAt: '2025-01-01T00:00:00.000Z',
    retiredAt: null,
    sourceRef: 'test',
    author: 'user',
    mergedInto: null,
    ...over,
  };
}

function edge(id: string, fromId: string, toId: string, over: Partial<Edge> = {}): Edge {
  return {
    id,
    world: W,
    type: 'owns',
    fromId,
    toId,
    attrs: {},
    validFrom: '2025-01-01T00:00:00.000Z',
    validTo: null,
    recordedAt: '2025-01-01T00:00:00.000Z',
    retiredAt: null,
    sourceRef: 'test',
    author: 'user',
    confidence: 1,
    ...over,
  };
}

function bundle(entities: Entity[], edges: Edge[]): GraphBundle {
  return { schema: null, entities, attributes: [], edges };
}

describe('exports', () => {
  it('GraphML is well-formed XML with escaped names', () => {
    const b = bundle(
      [ent('e1', 'A & B <"co"> \'x\''), ent('e2', 'plain\u0001ctl')],
      [edge('d1', 'e1', 'e2')],
    );
    const xml = toGraphML(b);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('A &amp; B &lt;&quot;co&quot;&gt; &apos;x&apos;');
    expect(xml).not.toContain('\u0001');
    // Minimal well-formedness check (no XML parser dependency): strip the
    // declaration, then verify the tags nest and close in order and that no
    // bare `&` or `<` survives in text.
    const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
    const stack: string[] = [];
    const re =
      /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:.-]+="[^"<&]*(?:&(?:amp|lt|gt|quot|apos);[^"<&]*)*")*)\s*(\/?)>/g;
    let last = 0;
    for (const m of body.matchAll(re)) {
      const text = body.slice(last, m.index);
      expect(text).not.toMatch(/<|&(?!(?:amp|lt|gt|quot|apos);)/);
      last = (m.index ?? 0) + m[0].length;
      const [, closing, name, , selfClose] = m;
      if (closing) expect(stack.pop()).toBe(name);
      else if (!selfClose) stack.push(name as string);
    }
    expect(body.slice(last).trim()).toBe('');
    expect(stack).toEqual([]);
    expect(xml).toContain('<node id="e1">');
    expect(xml).toContain('<edge id="d1" source="e1" target="e2">');
  });

  it('Mermaid escapes quotes and brackets', () => {
    const b = bundle(
      [ent('e-1', 'He said "hi" [x] (y) {z}'), ent('e 2', 'B#2')],
      [edge('d1', 'e-1', 'e 2', { type: 'owns "it"' })],
    );
    const out = toMermaid(b);
    expect(out.startsWith('graph LR\n')).toBe(true);
    expect(out).toContain('He said #quot;hi#quot; #91;x#93; #40;y#41; #123;z#125;');
    expect(out).toContain('B#35;2');
    // ids are sanitised to [A-Za-z0-9_]
    for (const m of out.matchAll(/^\s+(\S+?)\["/gm)) expect(m[1]).toMatch(/^[A-Za-z0-9_]+$/);
    // each label line carries exactly the two delimiter quotes
    for (const line of out.split('\n').filter((l) => l.includes('["'))) {
      expect(line.match(/"/g)?.length).toBe(2);
    }
  });

  it('Mermaid caps at 200 nodes with a truncated note', () => {
    const es = Array.from({ length: 205 }, (_, i) =>
      ent(`e${String(i).padStart(3, '0')}`, `n${i}`),
    );
    const out = toMermaid(bundle(es, []));
    expect(out.split('\n').filter((l) => l.includes('["')).length).toBe(200);
    expect(out).toContain('%% truncated');
  });

  it('JSON export has stable key order', () => {
    const a = ent('e1', 'x');
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as Entity;
    expect(toBundleJson(bundle([a], []))).toBe(toBundleJson(bundle([reordered], [])));
  });

  it('as-of slice excludes closed edges', () => {
    const e1 = ent('e1', 'Priya');
    const e2 = ent('e2', 'Billing');
    const e3 = ent('e3', 'Ravi');
    const b = bundle(
      [e1, e2, e3],
      [
        edge('old', 'e1', 'e2', { validTo: '2025-11-20T00:00:00.000Z' }),
        edge('new', 'e3', 'e2', { validFrom: '2025-11-20T00:00:00.000Z' }),
      ],
    );
    const before = sliceBundle(b, { asOf: '2025-11-19T00:00:00.000Z' });
    expect(before.edges.map((e) => e.id)).toEqual(['old']);
    const after = sliceBundle(b, { asOf: '2025-11-21T00:00:00.000Z' });
    expect(after.edges.map((e) => e.id)).toEqual(['new']);
    expect(toMermaid(after)).not.toContain('Priya"] -->');
    // Ethos clock: a fact retired before knownAt is gone, one recorded after is not yet known.
    const c = bundle([e1, e2], [edge('r', 'e1', 'e2', { retiredAt: '2025-06-01T00:00:00.000Z' })]);
    expect(
      sliceBundle(c, { asOf: '2025-07-01T00:00:00.000Z', knownAt: '2025-07-01T00:00:00.000Z' })
        .edges,
    ).toEqual([]);
    expect(
      sliceBundle(c, { asOf: '2025-07-01T00:00:00.000Z', knownAt: '2025-05-01T00:00:00.000Z' })
        .edges.length,
    ).toBe(1);
  });
});
