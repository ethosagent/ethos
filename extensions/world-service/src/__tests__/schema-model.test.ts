import { describe, expect, it } from 'vitest';
import { parseSchemaYaml, serializeSchemaYaml } from '../schema-model';

const COMPANY = `version: 4
entities:
  Company: { attrs: { domain: { type: string } } }
  Team:    { attrs: { mission: { type: string }, size: { type: int, min: 1 } } }
  Person:  { attrs: { email: { type: string, sensitive: true }, location: { type: string } } }
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
changelog:
  - { v: 4, by: agent, at: 2026-11-27, change: add edge mentors, reason: "chat 27 Nov: Mei mentors Tom" }
  - { v: 3, by: you, at: 2026-11-20, change: rename Squad to Team }
`;

describe('schema model', () => {
  it('canonical and short edge forms parse; the spec shorthand with ": " inside braces reports line and column', () => {
    const r = parseSchemaYaml(COMPANY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema.version).toBe(4);
    expect(Object.keys(r.schema.entities)).toEqual([
      'Company',
      'Team',
      'Person',
      'Skill',
      'Service',
    ]);
    // short form
    expect(r.schema.edges.part_of).toEqual({ from: ['Team'], to: ['Company'], attrs: {} });
    // canonical form
    expect(r.schema.edges.expert_in).toEqual({
      from: ['Person'],
      to: ['Skill'],
      attrs: { level: { type: 'int', min: 1, max: 5 } },
    });
    expect(r.schema.edges.owns?.unique).toBe('to');
    expect(r.changelog.map((c) => c.v)).toEqual([4, 3]);
    expect(r.changelog[0]?.reason).toBe('chat 27 Nov: Mei mentors Tom');
    // `sensitive` is a world-service extension kept out of the frozen WorldSchema
    expect(r.sensitive).toEqual(['entity:Person.email']);
    expect(JSON.stringify(r.schema)).not.toContain('sensitive');

    // The spec's shorthand is not valid YAML (": " inside a plain scalar).
    const bad = parseSchemaYaml(
      `version: 1\nentities:\n  Person: { attrs: {} }\n  Skill: { attrs: {} }\nedges:\n  expert_in:  Person -> Skill  { level: 1-5 }\n`,
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors[0]?.line).toBe(6);
    expect(bad.errors[0]?.column).toBe(15);
    expect(bad.errors[0]?.message).toMatch(/structured form/);
  });

  it('a short edge form with attributes is refused with its line', () => {
    const r = parseSchemaYaml(
      `version: 1\nentities:\n  A: { attrs: {} }\nedges:\n  e: "A -> A { x: 1 }"\n`,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.line).toBe(5);
    expect(r.errors[0]?.message).toMatch(/structured form/);
  });

  it('unknown keys, bad attribute types and unknown endpoint types report their line', () => {
    const shape = parseSchemaYaml(
      `version: 1\nentities:\n  A: { attrs: { x: { type: number5 } }, colour: red }\n`,
    );
    expect(shape.ok).toBe(false);
    if (shape.ok) return;
    expect(shape.errors.map((e) => e.line)).toEqual([3, 3]);
    expect(shape.errors.some((e) => /unknown key "colour"/.test(e.message))).toBe(true);

    const ref = parseSchemaYaml(
      `version: 1\nentities:\n  A: { attrs: {} }\nedges:\n  e: { from: [A], to: [Ghost] }\n`,
    );
    expect(ref.ok).toBe(false);
    if (ref.ok) return;
    expect(ref.errors[0]?.line).toBe(5);
    expect(ref.errors[0]?.message).toMatch(/Ghost/);
  });

  it('serialize then parse round-trips, keeping sensitive and the changelog', () => {
    const r = parseSchemaYaml(COMPANY);
    if (!r.ok) throw new Error('fixture must parse');
    const text = serializeSchemaYaml({
      schema: r.schema,
      sensitive: r.sensitive,
      changelog: r.changelog,
    });
    const again = parseSchemaYaml(text);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.schema).toEqual(r.schema);
    expect(again.sensitive).toEqual(r.sensitive);
    expect(again.changelog).toEqual(r.changelog);
    // attr-less single-endpoint edges go back out in the short form
    expect(text).toContain('part_of: Team -> Company');
  });
});
