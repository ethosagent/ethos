// CSV codec for world graphs: import (header -> schema mapping, preview, drafts)
// and export (entities.csv + links.csv). Pure functions over GraphBundle /
// WorldSchema; no I/O, no dependency beyond @ethosagent/types.
//
// Import output shape: ids do not exist before the world is written, so import
// yields name-referenced drafts (EntityDraft / AttributeDraft / EdgeDraft).
// They mirror FactInput minus the ids: the caller asserts the entity drafts
// first, then resolves each `{type, name}` Ref to the returned id before
// asserting attribute and edge drafts. Every draft carries author 'import'
// (pinned by __tests__/csv.test.ts 'spec CSV becomes people, teams, skills and
// links with author import').
//
// Mapping inference reports an unknown or ambiguous column and refuses to
// import; it never guesses (pinned by 'unknown column is reported' and
// 'ambiguous column is reported, not guessed').

import type { AttrSpec, FactAuthor, GraphBundle, WorldSchema } from '@ethosagent/types';
import type { EntityRef } from '../proposal-payload';

// ---------------------------------------------------------------- parser

export type ParseCsvResult =
  | { ok: true; rows: Array<{ line: number; cells: string[] }> }
  | { ok: false; line: number; reason: string };

/** RFC 4180: quoted fields, "" escapes, CRLF or LF, embedded newlines in quotes. */
export function parseCsv(text: string): ParseCsvResult {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let pending = false; // a record has started (any char consumed since last record end)

  const endRecord = (): void => {
    cells.push(field);
    // A lone empty cell is a blank line.
    if (!(cells.length === 1 && cells[0] === '')) rows.push({ line: recordLine, cells });
    cells = [];
    field = '';
    pending = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (!pending) recordLine = line;
    pending = true;
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === ',') {
      cells.push(field);
      field = '';
    } else if (ch === '\r' && src[i + 1] === '\n') {
      // handled on the \n
    } else if (ch === '\n' || ch === '\r') {
      endRecord();
      line++;
    } else field += ch;
  }
  if (inQuotes) return { ok: false, line: recordLine, reason: 'unterminated quoted field' };
  if (pending) endRecord();
  return { ok: true, rows };
}

function quoteCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

const toCsv = (rows: string[][]): string =>
  rows.map((r) => `${r.map(quoteCell).join(',')}\r\n`).join('');

// ---------------------------------------------------------------- import

export interface EntityDraft extends EntityRef {
  sourceRef: string;
  author: FactAuthor;
}
export interface AttributeDraft {
  entity: EntityRef;
  key: string;
  value: unknown;
  sourceRef: string;
  author: FactAuthor;
  confidence: number;
}
export interface EdgeDraft {
  type: string;
  from: EntityRef;
  to: EntityRef;
  attrs: Record<string, unknown>;
  sourceRef: string;
  author: FactAuthor;
  confidence: number;
}

export interface ColumnField {
  column: string;
  key: string;
}
export interface LinkMapping {
  column: string;
  edgeType: string;
  targetType: string;
  attrs: ColumnField[];
}
/** The inferred header -> schema mapping, shown to the user as the import preview. */
export interface CsvMapping {
  primaryType: string;
  nameColumn: string;
  attributes: ColumnField[];
  links: LinkMapping[];
}
export interface MappingIssue {
  column: string;
  reason: string;
}

export interface CsvImportOptions {
  /** Force the primary entity type instead of inferring it. */
  entityType?: string;
  /** Prefix of every draft's sourceRef (`<sourceName>:<line>`). Default `csv`. */
  sourceName?: string;
}

export type CsvImportResult =
  | {
      ok: true;
      mapping: CsvMapping;
      entities: EntityDraft[];
      attributes: AttributeDraft[];
      edges: EdgeDraft[];
      skipped: Array<{ line: number; reason: string }>;
    }
  | { ok: false; mapping: CsvMapping | null; issues: MappingIssue[] };

const norm = (s: string): string => s.trim().toLowerCase();

function matchesType(header: string, type: string): boolean {
  const h = norm(header);
  const t = type.toLowerCase();
  return h === t || h === `${t}s` || `${h}s` === t;
}

function matchingEdges(schema: WorldSchema, from: string, to: string): string[] {
  return Object.entries(schema.edges)
    .filter(([, e]) => e.from.includes(from) && e.to.includes(to))
    .map(([name]) => name);
}

function inferMapping(
  header: string[],
  schema: WorldSchema,
  opts: CsvImportOptions,
): { mapping: CsvMapping } | { issues: MappingIssue[] } {
  const issues: MappingIssue[] = [];
  const nameColumn = header.find((h) => norm(h) === 'name');
  if (!nameColumn) return { issues: [{ column: 'name', reason: 'no "name" column in header' }] };

  const types = Object.keys(schema.entities);
  const linkCols = new Map<string, string>(); // column -> target type
  for (const col of header) {
    if (col === nameColumn) continue;
    const t = types.filter((ty) => matchesType(col, ty));
    if (t.length === 1) linkCols.set(col, t[0] as string);
  }

  let primary = opts.entityType;
  if (primary === undefined) {
    const targets = [...linkCols.values()];
    const others = header.filter((h) => h !== nameColumn && !linkCols.has(h));
    const resolvable = (t: string): number => {
      const keys = new Set(
        Object.keys(schema.entities[t]?.attrs ?? {}).map((k) => k.toLowerCase()),
      );
      for (const to of targets) {
        for (const e of matchingEdges(schema, t, to)) {
          for (const k of Object.keys(schema.edges[e]?.attrs ?? {})) keys.add(k.toLowerCase());
        }
      }
      return others.filter((h) => keys.has(norm(h))).length;
    };
    const viable = types.filter((t) =>
      targets.every((to) => matchingEdges(schema, t, to).length > 0),
    );
    // Prefer the type that explains the most non-link columns; a tie stays ambiguous.
    const best = Math.max(0, ...viable.map(resolvable));
    const candidates = viable.filter((t) => resolvable(t) === best);
    if (candidates.length !== 1) {
      return {
        issues: [
          {
            column: nameColumn,
            reason: `ambiguous: cannot infer the entity type of "name" (candidates: ${candidates.join(', ') || 'none'}); pass entityType`,
          },
        ],
      };
    }
    primary = candidates[0] as string;
  }
  const primaryDef = schema.entities[primary];
  if (!primaryDef)
    return { issues: [{ column: nameColumn, reason: `unknown entity type ${primary}` }] };

  const links: LinkMapping[] = [];
  for (const [col, target] of linkCols) {
    const edges = matchingEdges(schema, primary, target);
    if (edges.length === 1) {
      links.push({ column: col, edgeType: edges[0] as string, targetType: target, attrs: [] });
    } else if (edges.length === 0) {
      issues.push({ column: col, reason: `no edge from ${primary} to ${target} in the schema` });
    } else {
      issues.push({
        column: col,
        reason: `ambiguous: ${edges.join(', ')} all connect ${primary} to ${target}`,
      });
    }
  }

  const attributes: ColumnField[] = [];
  for (const col of header) {
    if (col === nameColumn || linkCols.has(col)) continue;
    const h = norm(col);
    const entityKey = Object.keys(primaryDef.attrs).find((k) => k.toLowerCase() === h);
    const edgeHits = links.filter((l) =>
      Object.keys(schema.edges[l.edgeType]?.attrs ?? {}).some((k) => k.toLowerCase() === h),
    );
    const total = (entityKey ? 1 : 0) + edgeHits.length;
    if (total === 0) {
      issues.push({
        column: col,
        reason: `unknown column: no ${primary} attribute or linked edge attribute matches`,
      });
    } else if (total > 1) {
      const where = [
        ...(entityKey ? [`${primary}.${entityKey}`] : []),
        ...edgeHits.map((l) => l.edgeType),
      ];
      issues.push({ column: col, reason: `ambiguous: matches ${where.join(', ')}` });
    } else if (entityKey) {
      attributes.push({ column: col, key: entityKey });
    } else {
      const link = edgeHits[0] as LinkMapping;
      const key = Object.keys(schema.edges[link.edgeType]?.attrs ?? {}).find(
        (k) => k.toLowerCase() === h,
      ) as string;
      link.attrs.push({ column: col, key });
    }
  }
  if (issues.length > 0) return { issues };
  return { mapping: { primaryType: primary, nameColumn, attributes, links } };
}

function coerce(
  raw: string,
  key: string,
  spec: AttrSpec | undefined,
): { value: unknown } | { error: string } {
  const type = spec?.type ?? 'string';
  const bad = (): { error: string } => ({ error: `${key}: "${raw}" is not a valid ${type}` });
  let value: unknown = raw;
  if (type === 'int' || type === 'number') {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || (type === 'int' && !Number.isInteger(n)))
      return bad();
    if (spec?.min !== undefined && n < spec.min)
      return { error: `${key}: ${n} is below min ${spec.min}` };
    if (spec?.max !== undefined && n > spec.max)
      return { error: `${key}: ${n} is above max ${spec.max}` };
    value = n;
  } else if (type === 'bool') {
    if (!/^(true|false)$/i.test(raw)) return bad();
    value = raw.toLowerCase() === 'true';
  } else if (type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.+Z-]+)?$/.test(raw) || Number.isNaN(Date.parse(raw)))
      return bad();
  } else if (type === 'url') {
    if (!URL.canParse(raw)) return bad();
  }
  if (spec?.enum && !spec.enum.includes(raw))
    return { error: `${key}: "${raw}" is not one of ${spec.enum.join('|')}` };
  return { value };
}

/**
 * Import CSV text against `schema`. Fails (ok:false) with the issues list when
 * the header cannot be mapped unambiguously; otherwise returns the mapping
 * preview plus drafts. Bad rows are skipped with their line, never fatal.
 */
export function importCsv(
  text: string,
  schema: WorldSchema,
  opts: CsvImportOptions = {},
): CsvImportResult {
  const parsed = parseCsv(text);
  if (!parsed.ok)
    return {
      ok: false,
      mapping: null,
      issues: [{ column: '', reason: `line ${parsed.line}: ${parsed.reason}` }],
    };
  const [head, ...body] = parsed.rows;
  if (!head)
    return {
      ok: false,
      mapping: null,
      issues: [{ column: '', reason: 'empty CSV: no header row' }],
    };
  const header = head.cells.map((h) => h.trim());
  const inferred = inferMapping(header, schema, opts);
  if ('issues' in inferred) return { ok: false, mapping: null, issues: inferred.issues };
  const { mapping } = inferred;

  const col = (name: string): number => header.indexOf(name);
  const src = opts.sourceName ?? 'csv';
  const entities = new Map<string, EntityDraft>();
  const attributes: AttributeDraft[] = [];
  const edges: EdgeDraft[] = [];
  const skipped: Array<{ line: number; reason: string }> = [];
  const primarySpecs = schema.entities[mapping.primaryType]?.attrs ?? {};

  for (const row of body) {
    const skip = (reason: string): void => void skipped.push({ line: row.line, reason });
    if (row.cells.length !== header.length) {
      skip(`expected ${header.length} cells, got ${row.cells.length}`);
      continue;
    }
    const cell = (name: string): string => (row.cells[col(name)] ?? '').trim();
    const name = cell(mapping.nameColumn);
    if (name === '') {
      skip('empty name');
      continue;
    }
    const sourceRef = `${src}:${row.line}`;
    const draftEntities: EntityDraft[] = [];
    const draftAttrs: AttributeDraft[] = [];
    const draftEdges: EdgeDraft[] = [];
    const self: EntityRef = { type: mapping.primaryType, name };
    draftEntities.push({ ...self, sourceRef, author: 'import' });
    let error: string | null = null;

    for (const f of mapping.attributes) {
      const raw = cell(f.column);
      if (raw === '') continue;
      const c = coerce(raw, f.key, primarySpecs[f.key]);
      if ('error' in c) error ??= c.error;
      else
        draftAttrs.push({
          entity: self,
          key: f.key,
          value: c.value,
          sourceRef,
          author: 'import',
          confidence: 1,
        });
    }
    for (const link of mapping.links) {
      const edgeSpecs = schema.edges[link.edgeType]?.attrs ?? {};
      const attrs: Record<string, unknown> = {};
      for (const f of link.attrs) {
        const raw = cell(f.column);
        if (raw === '') continue;
        const c = coerce(raw, f.key, edgeSpecs[f.key]);
        if ('error' in c) error ??= c.error;
        else attrs[f.key] = c.value;
      }
      for (const target of cell(link.column)
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s !== '')) {
        const to: EntityRef = { type: link.targetType, name: target };
        draftEntities.push({ ...to, sourceRef, author: 'import' });
        draftEdges.push({
          type: link.edgeType,
          from: self,
          to,
          attrs: { ...attrs },
          sourceRef,
          author: 'import',
          confidence: 1,
        });
      }
    }
    if (error) {
      skip(error);
      continue;
    }
    for (const e of draftEntities) {
      const k = `${e.type}\u0000${e.name}`;
      if (!entities.has(k)) entities.set(k, e);
    }
    attributes.push(...draftAttrs);
    edges.push(...draftEdges);
  }
  return { ok: true, mapping, entities: [...entities.values()], attributes, edges, skipped };
}

// ---------------------------------------------------------------- export

const cellValue = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ''));

/**
 * entities.csv: `id,type,name,aliases,<attribute keys>` (aliases `;`-joined),
 * one row per live entity, current attribute values only. links.csv:
 * `id,type,from_id,from_name,to_id,to_name,valid_from,valid_to,<edge attr keys>`,
 * one row per non-retired edge (closed edges keep valid_to). CRLF line ends.
 * Attribute keys that collide with a fixed column name are not disambiguated.
 */
export function exportCsv(bundle: GraphBundle): { entitiesCsv: string; linksCsv: string } {
  const entities = bundle.entities.filter((e) => e.retiredAt === null && e.mergedInto === null);
  const nameOf = new Map(bundle.entities.map((e) => [e.id, e.name]));

  const live = bundle.attributes.filter((a) => a.retiredAt === null && a.validTo === null);
  const attrKeys = [...new Set(live.map((a) => a.key))].sort();
  const byEntity = new Map<string, Map<string, unknown>>();
  for (const a of live) {
    const m = byEntity.get(a.entityId) ?? new Map<string, unknown>();
    m.set(a.key, a.value);
    byEntity.set(a.entityId, m);
  }
  const entityRows = [
    ['id', 'type', 'name', 'aliases', ...attrKeys],
    ...entities.map((e) => [
      e.id,
      e.type,
      e.name,
      e.aliases.join(';'),
      ...attrKeys.map((k) =>
        byEntity.get(e.id)?.has(k) ? cellValue(byEntity.get(e.id)?.get(k)) : '',
      ),
    ]),
  ];

  const edges = bundle.edges.filter((e) => e.retiredAt === null);
  const edgeKeys = [...new Set(edges.flatMap((e) => Object.keys(e.attrs)))].sort();
  const linkRows = [
    [
      'id',
      'type',
      'from_id',
      'from_name',
      'to_id',
      'to_name',
      'valid_from',
      'valid_to',
      ...edgeKeys,
    ],
    ...edges.map((e) => [
      e.id,
      e.type,
      e.fromId,
      nameOf.get(e.fromId) ?? '',
      e.toId,
      nameOf.get(e.toId) ?? '',
      e.validFrom ?? '',
      e.validTo ?? '',
      ...edgeKeys.map((k) => (k in e.attrs ? cellValue(e.attrs[k]) : '')),
    ]),
  ];
  return { entitiesCsv: toCsv(entityRows), linksCsv: toCsv(linkRows) };
}
