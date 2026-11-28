import type { Edge, Entity, GraphBundle } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { exportCsv, importCsv, parseCsv } from '../codecs/csv';
import { parseSchemaYaml } from '../schema-model';

const COMPANY = `version: 4
entities:
  Company: { attrs: { domain: { type: string } } }
  Team:    { attrs: { mission: { type: string }, size: { type: int, min: 1 } } }
  Person:  { attrs: { email: { type: string }, location: { type: string } } }
  Skill:   { attrs: {} }
  Service: { attrs: { repo: { type: url }, tier: { type: string } } }
edges:
  part_of:    "Team -> Company"
  member_of:  { from: [Person], to: [Team], attrs: { role: { type: string }, since: { type: date } } }
  reports_to: { from: [Person], to: [Person], unique: from }
  expert_in:  { from: [Person], to: [Skill], attrs: { level: { type: int, min: 1, max: 5 } } }
  owns:       { from: [Team, Person], to: [Service], unique: to }
  depends_on: "Team -> Team"
  mentors:    "Person -> Person"
`;

function schema() {
  const r = parseSchemaYaml(COMPANY);
  if (!r.ok) throw new Error('fixture must parse');
  return r.schema;
}

describe('csv codec', () => {
  it('spec CSV becomes people, teams, skills and links with author import', () => {
    const csv = 'name,team,role,skills\nMei,Platform,lead,go;sql\nTom,Platform,engineer,go\n';
    const r = importCsv(csv, schema());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mapping).toEqual({
      primaryType: 'Person',
      nameColumn: 'name',
      attributes: [],
      links: [
        {
          column: 'team',
          edgeType: 'member_of',
          targetType: 'Team',
          attrs: [{ column: 'role', key: 'role' }],
        },
        { column: 'skills', edgeType: 'expert_in', targetType: 'Skill', attrs: [] },
      ],
    });
    const names = r.entities.map((e) => `${e.type}:${e.name}`).sort();
    expect(names).toEqual(['Person:Mei', 'Person:Tom', 'Skill:go', 'Skill:sql', 'Team:Platform']);
    expect(r.edges).toHaveLength(5);
    expect(r.edges[0]).toMatchObject({
      type: 'member_of',
      from: { type: 'Person', name: 'Mei' },
      to: { type: 'Team', name: 'Platform' },
      attrs: { role: 'lead' },
      author: 'import',
    });
    expect(r.edges.filter((e) => e.type === 'expert_in').map((e) => e.to.name)).toEqual([
      'go',
      'sql',
      'go',
    ]);
    expect([...r.entities, ...r.edges, ...r.attributes].every((f) => f.author === 'import')).toBe(
      true,
    );
    expect(r.skipped).toEqual([]);
  });

  it('quoted comma and escaped quote', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z')).toEqual({
      ok: true,
      rows: [
        { line: 1, cells: ['a', 'b'] },
        { line: 2, cells: ['x, y', 'say "hi"'] },
        { line: 3, cells: ['multi\nline', 'z'] },
      ],
    });
    expect(parseCsv('a,"open')).toMatchObject({ ok: false, line: 1 });
    const r = importCsv('name,team,role\n"Doe, Jane","The ""A"" Team",lead\n', schema());
    expect(r.ok && r.entities.map((e) => e.name)).toEqual(['Doe, Jane', 'The "A" Team']);
  });

  it('unknown column is reported', () => {
    const r = importCsv('name,team,role,shoe_size\nMei,Platform,lead,9\n', schema());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toEqual([
      { column: 'shoe_size', reason: expect.stringContaining('unknown column') },
    ]);
  });

  it('ambiguous column is reported, not guessed', () => {
    // Person -> Person has two edges (reports_to, mentors).
    const r = importCsv('name,person\nMei,Tom\n', schema());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]?.reason).toContain('ambiguous');
  });

  it('skips bad rows with their line and coerces attribute types', () => {
    const r = importCsv('name,level,skills\nMei,3,go\n,1,go\n', schema());
    // level is an expert_in attr; with skills present it maps.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edges[0]?.attrs).toEqual({ level: 3 });
    expect(r.skipped).toEqual([{ line: 3, reason: 'empty name' }]);
    const bad = importCsv('name,level,skills\nMei,high,go\n', schema());
    expect(bad.ok && bad.skipped[0]).toEqual({
      line: 2,
      reason: 'level: "high" is not a valid int',
    });
  });

  it('exports entities.csv and links.csv', () => {
    const base = { world: 'world:acme' as const, recordedAt: 't', retiredAt: null, sourceRef: 's' };
    const mei: Entity = {
      ...base,
      id: 'e1',
      type: 'Person',
      name: 'Doe, Mei',
      aliases: ['M'],
      mergedInto: null,
      author: 'user',
    };
    const plat: Entity = {
      ...base,
      id: 'e2',
      type: 'Team',
      name: 'Platform',
      aliases: [],
      mergedInto: null,
      author: 'user',
    };
    const edge: Edge = {
      ...base,
      id: 'x1',
      type: 'member_of',
      fromId: 'e1',
      toId: 'e2',
      attrs: { role: 'lead' },
      validFrom: '2026-01-01',
      validTo: null,
      author: 'user',
      confidence: 1,
    };
    const bundle: GraphBundle = {
      schema: null,
      entities: [mei, plat],
      attributes: [
        {
          ...base,
          id: 'a1',
          entityId: 'e1',
          key: 'email',
          value: 'm@x.io',
          validFrom: null,
          validTo: null,
          author: 'user',
          confidence: 1,
        },
      ],
      edges: [edge],
    };
    const out = exportCsv(bundle);
    expect(out.entitiesCsv).toBe(
      'id,type,name,aliases,email\r\ne1,Person,"Doe, Mei",M,m@x.io\r\ne2,Team,Platform,,\r\n',
    );
    expect(out.linksCsv).toBe(
      'id,type,from_id,from_name,to_id,to_name,valid_from,valid_to,role\r\nx1,member_of,e1,"Doe, Mei",e2,Platform,2026-01-01,,lead\r\n',
    );
    const back = parseCsv(out.entitiesCsv);
    expect(back.ok && back.rows[1]?.cells[2]).toBe('Doe, Mei');
  });

  describe('spreadsheet formula neutralising', () => {
    const base = { world: 'world:acme' as const, recordedAt: 't', retiredAt: null, sourceRef: 's' };
    const TRIGGERS = ["=cmd|' /C calc'!A0", '+1+1', '-2+3', '@SUM(A1)', '\tTabbed', '\rReturned'];
    // Values that genuinely start with a quote: only the ones where the next char is a
    // trigger or a quote are escaped on export (see the scheme comment in csv.ts).
    const QUOTED = ["'=real", "''double", "'plain", "'"];

    function bundleOf(names: string[], score: number): GraphBundle {
      return {
        schema: null,
        entities: names.map((name, i) => ({
          ...base,
          id: `e${i}`,
          type: 'Person',
          name,
          aliases: [],
          mergedInto: null,
          author: 'user' as const,
        })),
        attributes: names.flatMap((name, i) => [
          {
            ...base,
            id: `n${i}`,
            entityId: `e${i}`,
            key: 'note',
            value: name,
            validFrom: null,
            validTo: null,
            author: 'user' as const,
            confidence: 1,
          },
          {
            ...base,
            id: `s${i}`,
            entityId: `e${i}`,
            key: 'score',
            value: score,
            validFrom: null,
            validTo: null,
            author: 'user' as const,
            confidence: 1,
          },
        ]),
        edges: [],
      };
    }

    it('export writes a formula-leading cell as a quoted single-quote-prefixed cell', () => {
      const { entitiesCsv } = exportCsv(bundleOf(TRIGGERS, 1));
      for (const name of TRIGGERS) {
        const cell = `"'${name.replaceAll('"', '""')}"`;
        expect(entitiesCsv).toContain(`,${cell},`);
      }
      const parsed = parseCsv(entitiesCsv);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.rows.slice(1).map((r) => r.cells[2])).toEqual(TRIGGERS.map((n) => `'${n}`));
    });

    it('export leaves a plain name and a plain quote-leading value unprefixed', () => {
      const { entitiesCsv } = exportCsv(bundleOf(["'plain", 'Mei'], 1));
      const parsed = parseCsv(entitiesCsv);
      expect(parsed.ok && parsed.rows.slice(1).map((r) => r.cells[2])).toEqual(["'plain", 'Mei']);
    });

    it('round trip returns formula-leading, quote-leading and negative values unchanged', () => {
      const names = [...TRIGGERS, ...QUOTED, 'Mei'];
      const { entitiesCsv } = exportCsv(bundleOf(names, -5));
      const parsed = parseCsv(entitiesCsv);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      // entities.csv is `id,type,name,aliases,note,score`; keep name,note,score cell text as written.
      const q = (c: string): string => `"${c.replaceAll('"', '""')}"`;
      const text = `name,note,score\r\n${parsed.rows
        .slice(1)
        .map((r) => [r.cells[2], r.cells[4], r.cells[5]].map((c) => q(c ?? '')).join(','))
        .join('\r\n')}\r\n`;
      const r = importCsv(text, schemaWithScore());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.skipped).toEqual([]);
      expect(r.entities.map((e) => e.name)).toEqual(names);
      const notes = r.attributes.filter((a) => a.key === 'note').map((a) => a.value);
      expect(notes).toEqual(names);
      const scores = r.attributes.filter((a) => a.key === 'score').map((a) => a.value);
      expect(scores).toEqual(names.map(() => -5));
    });
  });
});

function schemaWithScore() {
  const r = parseSchemaYaml(
    'version: 4\nentities:\n  Person: { attrs: { note: { type: string }, score: { type: number } } }\nedges: {}\n',
  );
  if (!r.ok) throw new Error('fixture must parse');
  return r.schema;
}
