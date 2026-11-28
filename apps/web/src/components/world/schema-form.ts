import type { SchemaState, WorldSchemaParsed } from './types';

// Pure edit operations behind the schema form, and the serialiser that turns the
// edited draft back into schema.yaml text. The text is JSON, which is valid YAML
// 1.2; the server re-parses and validates it (WorldSchemaService.saveYaml), so
// this module only has to produce something the parser reads.

export type AttrType = 'string' | 'int' | 'number' | 'bool' | 'date' | 'url';
export const ATTR_TYPES: readonly AttrType[] = ['string', 'int', 'number', 'bool', 'date', 'url'];

/** Same rule as extensions/world-service/src/schema-model.ts `NAME`. */
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function addEntityType(s: WorldSchemaParsed, type: string): WorldSchemaParsed {
  if (!isValidName(type) || type in s.entities) return s;
  return { ...s, entities: { ...s.entities, [type]: { attrs: {} } } };
}

export function removeEntityType(s: WorldSchemaParsed, type: string): WorldSchemaParsed {
  const entities = Object.fromEntries(Object.entries(s.entities).filter(([t]) => t !== type));
  // An allowed link may not name a type that no longer exists.
  const edges = Object.fromEntries(
    Object.entries(s.edges)
      .map(
        ([t, e]) =>
          [
            t,
            { ...e, from: e.from.filter((x) => x !== type), to: e.to.filter((x) => x !== type) },
          ] as const,
      )
      .filter(([, e]) => e.from.length > 0 && e.to.length > 0),
  );
  return { ...s, entities, edges };
}

export function setEntityAttr(
  s: WorldSchemaParsed,
  type: string,
  attr: string,
  attrType: AttrType,
): WorldSchemaParsed {
  const ent = s.entities[type];
  if (!ent || !isValidName(attr)) return s;
  const prev = ent.attrs[attr];
  return {
    ...s,
    entities: {
      ...s.entities,
      [type]: { attrs: { ...ent.attrs, [attr]: { ...prev, type: attrType } } },
    },
  };
}

export function removeEntityAttr(
  s: WorldSchemaParsed,
  type: string,
  attr: string,
): WorldSchemaParsed {
  const ent = s.entities[type];
  if (!ent) return s;
  const attrs = Object.fromEntries(Object.entries(ent.attrs).filter(([a]) => a !== attr));
  return { ...s, entities: { ...s.entities, [type]: { attrs } } };
}

/** Add or replace an allowed link; `from`/`to` must name existing entity types. */
export function setEdgeType(
  s: WorldSchemaParsed,
  type: string,
  from: string[],
  to: string[],
): WorldSchemaParsed {
  if (!isValidName(type) || from.length === 0 || to.length === 0) return s;
  const known = (x: string) => x in s.entities;
  if (!from.every(known) || !to.every(known)) return s;
  const prev = s.edges[type];
  return { ...s, edges: { ...s.edges, [type]: { attrs: prev?.attrs ?? {}, from, to } } };
}

export function removeEdgeType(s: WorldSchemaParsed, type: string): WorldSchemaParsed {
  return { ...s, edges: Object.fromEntries(Object.entries(s.edges).filter(([t]) => t !== type)) };
}

/** "Person, Team" -> ['Person', 'Team'] (blank entries dropped). */
export function parseNameList(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export interface SchemaYamlInput {
  draft: WorldSchemaParsed;
  sensitive: readonly string[];
  changelog: SchemaState['changelog'];
  /** The version the file is at now; the saved file carries `currentVersion + 1`. */
  currentVersion: number;
  by: string;
  at: string;
  change: string;
  reason?: string;
}

export function schemaToYaml(input: SchemaYamlInput): string {
  const sens = new Set(input.sensitive);
  const attrsOut = (
    on: 'entity' | 'edge',
    type: string,
    attrs: WorldSchemaParsed['entities'][string]['attrs'],
  ) =>
    Object.fromEntries(
      Object.entries(attrs).map(([k, spec]) => [
        k,
        sens.has(`${on}:${type}.${k}`) ? { ...spec, sensitive: true } : spec,
      ]),
    );
  const version = input.currentVersion + 1;
  const doc = {
    version,
    entities: Object.fromEntries(
      Object.entries(input.draft.entities).map(([t, e]) => [
        t,
        { attrs: attrsOut('entity', t, e.attrs) },
      ]),
    ),
    edges: Object.fromEntries(
      Object.entries(input.draft.edges).map(([t, e]) => [
        t,
        {
          from: e.from,
          to: e.to,
          ...(Object.keys(e.attrs).length > 0 ? { attrs: attrsOut('edge', t, e.attrs) } : {}),
          ...(e.unique ? { unique: e.unique } : {}),
        },
      ]),
    ),
    changelog: [
      ...input.changelog,
      {
        v: version,
        by: input.by,
        at: input.at,
        change: input.change,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    ],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** One-line summary of what differs between two drafts, for the changelog row. */
export function describeChange(before: WorldSchemaParsed, after: WorldSchemaParsed): string {
  const diff = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
  const parts: string[] = [];
  const entAdd = diff(Object.keys(before.entities), Object.keys(after.entities));
  const entDel = diff(Object.keys(after.entities), Object.keys(before.entities));
  const edgeAdd = diff(Object.keys(before.edges), Object.keys(after.edges));
  const edgeDel = diff(Object.keys(after.edges), Object.keys(before.edges));
  if (entAdd.length) parts.push(`added types ${entAdd.join(', ')}`);
  if (entDel.length) parts.push(`removed types ${entDel.join(', ')}`);
  if (edgeAdd.length) parts.push(`added links ${edgeAdd.join(', ')}`);
  if (edgeDel.length) parts.push(`removed links ${edgeDel.join(', ')}`);
  return parts.length ? parts.join('; ') : 'edited attributes';
}
