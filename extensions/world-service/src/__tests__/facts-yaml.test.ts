import type { GraphBundle, WorldId, WorldSchema } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { exportFactsYaml, importFactsYaml } from '../codecs/facts-yaml';

const WORLD: WorldId = 'world:acme';
const NOW = '2026-11-28T00:00:00Z';

const schema: WorldSchema = {
  version: 2,
  entities: {
    Person: { attrs: { email: { type: 'string' }, level: { type: 'int', min: 1, max: 5 } } },
    Team: { attrs: {} },
  },
  edges: {
    member_of: {
      from: ['Person'],
      to: ['Team'],
      attrs: { role: { type: 'string' } },
    },
  },
};

const base = {
  world: WORLD,
  recordedAt: '2026-11-01T10:00:00Z',
  retiredAt: null,
  sourceRef: 'chat:1',
  author: 'user' as const,
};

// Deliberately unsorted so the export has to sort.
const bundle: GraphBundle = {
  schema,
  entities: [
    { ...base, id: 'e2', type: 'Team', name: 'Platform', aliases: [], mergedInto: null },
    { ...base, id: 'e3', type: 'Person', name: 'Tom', aliases: [], mergedInto: null },
    { ...base, id: 'e1', type: 'Person', name: 'Ada', aliases: ['A. L.'], mergedInto: null },
  ],
  attributes: [
    {
      ...base,
      id: 'a1',
      entityId: 'e1',
      key: 'level',
      value: 4,
      validFrom: '2026-01-01',
      validTo: null,
      confidence: 1,
    },
    {
      ...base,
      id: 'a2',
      entityId: 'e1',
      key: 'email',
      value: 'ada@acme.test',
      validFrom: null,
      validTo: null,
      confidence: 0.8,
    },
  ],
  edges: [
    {
      ...base,
      id: 'x1',
      type: 'member_of',
      fromId: 'e3',
      toId: 'e2',
      attrs: { role: 'lead' },
      validFrom: '2025-03-01',
      validTo: '2026-06-30',
      confidence: 1,
    },
    {
      ...base,
      id: 'x2',
      type: 'member_of',
      fromId: 'e1',
      toId: 'e2',
      attrs: {},
      validFrom: '2024-01-01',
      validTo: null,
      confidence: 0.9,
    },
  ],
};

function mustImport(text: string) {
  const r = importFactsYaml(text, WORLD, { now: NOW });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
}

describe('facts yaml codec', () => {
  it('export → import → export is byte-identical', () => {
    const first = exportFactsYaml(bundle);
    const imported = mustImport(first);
    expect(imported.report.skipped).toEqual([]);
    expect(imported.report).toMatchObject({ entities: 3, attributes: 2, edges: 2 });
    expect(exportFactsYaml(imported.bundle)).toBe(first);
    // sorted by type, then name: Person/Ada, Person/Tom, Team/Platform
    expect(first.indexOf('name: Ada')).toBeLessThan(first.indexOf('name: Tom'));
    expect(first.indexOf('name: Tom')).toBeLessThan(first.indexOf('name: Platform'));
  });

  it('a bundle without a schema round-trips too', () => {
    const text = exportFactsYaml({ ...bundle, schema: null });
    expect(mustImport(text).bundle.schema).toBeNull();
    expect(exportFactsYaml(mustImport(text).bundle)).toBe(text);
  });

  it('closed edges keep both dates', () => {
    const imported = mustImport(exportFactsYaml(bundle));
    const closed = imported.bundle.edges.find((e) => e.validTo !== null);
    expect(closed).toMatchObject({
      type: 'member_of',
      validFrom: '2025-03-01',
      validTo: '2026-06-30',
      attrs: { role: 'lead' },
    });
    const open = imported.bundle.edges.find((e) => e.validTo === null);
    expect(open?.validFrom).toBe('2024-01-01');
  });

  it('import of facts referencing an unknown type reports the line', () => {
    const text = exportFactsYaml(bundle).replace('    - type: Team\n', '    - type: Robot\n');
    const lines = text.split('\n');
    const robotLine = lines.findIndex((l) => l.includes('type: Robot')) + 1;
    const r = mustImport(text);
    expect(r.report.skipped).toContainEqual({
      line: robotLine,
      reason: "unknown entity type 'Robot'",
    });
    // the edge that pointed at the skipped entity is skipped too, with its own line
    expect(r.report.skipped.some((s) => s.reason.includes("unknown entity 'Team/Platform'"))).toBe(
      true,
    );
    expect(r.bundle.entities.map((e) => e.type)).not.toContain('Robot');
  });

  it('malformed yaml reports errors instead of throwing', () => {
    const r = importFactsYaml('facts: [', WORLD, { now: NOW });
    expect(r.ok).toBe(false);
  });
});
