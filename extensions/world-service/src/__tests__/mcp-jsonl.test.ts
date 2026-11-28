import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttributeFact, Edge, Entity, GraphBundle, WorldId } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { exportMcpJsonl, importMcpJsonl } from '../codecs/mcp-jsonl';

const world = 'world:acme' as WorldId;
const NOW = '2026-01-01T00:00:00.000Z';

function ctx() {
  let n = 0;
  return { world, sourceRef: 'import:mcp', now: NOW, newId: () => `id${++n}` };
}

const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'mcp-memory.jsonl'), 'utf-8');

describe('mcp-jsonl', () => {
  it('fixture imports as entities and edges', () => {
    const { bundle, report } = importMcpJsonl(fixture, ctx());
    expect(bundle.entities.map((e) => [e.name, e.type, e.author])).toEqual([
      ['John_Smith', 'person', 'import'],
      ['Anthropic', 'organization', 'import'],
    ]);
    expect(bundle.attributes.map((a) => [a.key, a.value])).toEqual([
      ['note', 'Speaks fluent Spanish'],
      ['note', 'Graduated in 2019'],
      ['note', 'AI safety company'],
    ]);
    expect(bundle.edges).toHaveLength(1);
    const [john, anthropic] = bundle.entities;
    expect(bundle.edges[0]).toMatchObject({
      type: 'works_at',
      fromId: john?.id,
      toId: anthropic?.id,
      sourceRef: 'import:mcp',
    });
    expect(report).toEqual({ entities: 2, attributes: 3, edges: 1, skipped: [] });
  });

  it('Ethos export → JSONL → import keeps dates and author', () => {
    const base = { world, recordedAt: NOW, retiredAt: null, sourceRef: 'doc:1' };
    const ada: Entity = {
      ...base,
      id: 'e1',
      type: 'person',
      name: 'Ada',
      aliases: ['Countess'],
      author: 'user',
      mergedInto: null,
    };
    const co: Entity = { ...ada, id: 'e2', type: 'org', name: 'Engine Co', aliases: [] };
    const attr: AttributeFact = {
      ...base,
      id: 'a1',
      entityId: 'e1',
      key: 'title',
      value: 'Analyst',
      validFrom: '2020-01-01',
      validTo: '2021-06-30',
      author: 'connector',
      confidence: 0.8,
    };
    const edge: Edge = {
      ...base,
      id: 'r1',
      type: 'works_at',
      fromId: 'e1',
      toId: 'e2',
      attrs: { role: 'lead' },
      validFrom: '2020-02-01',
      validTo: null,
      author: 'agent',
      confidence: 1,
    };
    const bundle: GraphBundle = {
      schema: null,
      entities: [ada, co],
      attributes: [attr],
      edges: [edge],
    };

    const text = exportMcpJsonl(bundle);
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['entity', 'entity', 'relation']);
    expect(lines[2]).toEqual({
      type: 'relation',
      from: 'Ada',
      to: 'Engine Co',
      relationType: 'works_at',
    });

    const back = importMcpJsonl(text, ctx());
    expect(back.report.skipped).toEqual([]);
    const a = back.bundle.entities.find((e) => e.name === 'Ada');
    expect(a).toMatchObject({ author: 'user', sourceRef: 'doc:1', aliases: ['Countess'] });
    expect(back.bundle.attributes).toHaveLength(1);
    expect(back.bundle.attributes[0]).toMatchObject({
      key: 'title',
      value: 'Analyst',
      validFrom: '2020-01-01',
      validTo: '2021-06-30',
      author: 'connector',
      sourceRef: 'doc:1',
      entityId: a?.id,
    });
    expect(back.bundle.edges[0]).toMatchObject({
      type: 'works_at',
      attrs: { role: 'lead' },
      validFrom: '2020-02-01',
      validTo: null,
      author: 'agent',
      sourceRef: 'doc:1',
    });
  });

  it('relation to an unknown entity is skipped with the line', () => {
    const text = [
      '{"type":"entity","name":"A","entityType":"x","observations":[]}',
      '',
      '{"type":"relation","from":"A","to":"Ghost","relationType":"knows"}',
      'not json',
    ].join('\n');
    const { bundle, report } = importMcpJsonl(text, ctx());
    expect(bundle.edges).toEqual([]);
    expect(report.skipped.map((s) => s.line)).toEqual([3, 4]);
    expect(report.skipped[0]?.reason).toContain('Ghost');
    expect(report.entities).toBe(1);
  });
});
