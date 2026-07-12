import { EthosError } from '@ethosagent/types';
import { z } from 'zod';

type ParamType = 'select' | 'options' | 'date-range';

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  options?: string[];
  default: string;
}

export function interpolateParams(
  template: string,
  ephemeral: Record<string, string>,
  persistent: Record<string, string>,
  panelDefaults: Record<string, string>,
): string {
  const resolve = (key: string, match: string) =>
    ephemeral[key] ?? persistent[key] ?? panelDefaults[key] ?? match;
  // Double-brace first to avoid partial matches on {{key}}
  const pass1 = template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => resolve(k, m));
  return pass1.replace(/\{(\w+)\}/g, (m, k: string) => resolve(k, m));
}

export function extractParamRefs(template: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const m of template.matchAll(/\{\{(\w+)\}\}/g)) {
    const key = m[1];
    if (key && !seen.has(key)) {
      seen.add(key);
      refs.push(key);
    }
  }
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const key = m[1];
    if (key && !seen.has(key)) {
      seen.add(key);
      refs.push(key);
    }
  }
  return refs;
}

export function expandDateRangeParams(
  schema: ParamDef[],
  current: Record<string, string>,
): Record<string, string> {
  const result = { ...current };
  for (const def of schema) {
    if (def.type !== 'date-range') continue;
    const fromKey = `${def.key}_from`;
    const toKey = `${def.key}_to`;
    if (result[fromKey] === undefined && result[toKey] === undefined) {
      const parts = def.default.split(',');
      if (parts.length === 2) {
        const [from, to] = parts;
        if (from) result[fromKey] = from;
        if (to) result[toKey] = to;
      }
    }
  }
  return result;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateParamValue(def: ParamDef, _key: string, value: string): boolean {
  if (def.type === 'select' || def.type === 'options') {
    // Fail closed: a select/options def with no (or empty) options offers no
    // permitted value, so it must accept nothing. Accepting anything here would
    // turn the allowlist into a wildcard and defeat the SQL-injection defense.
    return def.options && def.options.length > 0 ? def.options.includes(value) : false;
  }
  if (def.type === 'date-range') {
    return DATE_RE.test(value);
  }
  return true;
}

/**
 * Resolve the ParamDef that governs a persisted param key. Date-range defs are
 * stored under two derived keys (`<key>_from`, `<key>_to`), so a suffix strip
 * is needed to find the governing def.
 */
function resolveParamDef(schema: ParamDef[], key: string): ParamDef | undefined {
  const direct = schema.find((d) => d.key === key);
  if (direct) return direct;
  return schema.find(
    (d) => d.type === 'date-range' && (key === `${d.key}_from` || key === `${d.key}_to`),
  );
}

/**
 * Validate a bag of param values against a dashboard's schema before it is
 * persisted and later interpolated into a SQL/prompt template. Returns the keys
 * that fail — either unknown (no governing def) or a value outside the def's
 * allowlist / format. An empty array means every value is safe to persist.
 *
 * This is the allowlist that neutralizes SQL injection via the interpolation
 * path: template positions cannot be `?`-bound, so only vetted values may
 * reach `interpolateParams`.
 */
export function findInvalidParamKeys(schema: ParamDef[], values: Record<string, string>): string[] {
  const invalid: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const def = resolveParamDef(schema, key);
    if (!def || !validateParamValue(def, key, value)) {
      invalid.push(key);
    }
  }
  return invalid;
}

const SQL_GUARD_ACTION = 'Provide a single read-only SELECT statement.';

const PARAM_ALLOWLIST_ACTION =
  'Submit only values allowed by each parameter definition (a listed option, or a YYYY-MM-DD date).';

/**
 * Guard a panel SQL query: it must be a single read-only SELECT. This is the
 * one definition of the guard that `DashboardsService.addPanel`/`updatePanel`
 * and the import path all share, so every panel-SQL sink enforces the same
 * rule. Throws `INVALID_INPUT` (surfaces as a typed error, never a 500).
 */
export function assertSelectOnlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!/^select\b/i.test(trimmed)) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: 'SQL query must start with SELECT',
      action: SQL_GUARD_ACTION,
    });
  }
  const withoutTrailing = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
  if (withoutTrailing.includes(';')) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: 'SQL query must not contain multiple statements',
      action: SQL_GUARD_ACTION,
    });
  }
}

const ParamDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['select', 'options', 'date-range']),
  options: z.array(z.string()).optional(),
  default: z.string(),
});

const EmitRuleSchema = z.object({
  on: z.enum(['rowClick']),
  param: z.string(),
  column: z.string(),
  default: z.string(),
});

const ImportPanelSchema = z.object({
  title: z.string().nullable().optional(),
  queryType: z.string().optional(),
  blockType: z.string().optional(),
  content: z.string().optional(),
  prompt: z.string().nullable().optional(),
  sqlQuery: z.string().nullable().optional(),
  pluginId: z.string().nullable().optional(),
  dataSourceId: z.string().nullable().optional(),
  cronSchedule: z.string().nullable().optional(),
  htmlTemplate: z.string().nullable().optional(),
  emitConfig: z.array(EmitRuleSchema).nullable().optional(),
  dependsOnIndices: z.array(z.number()).optional(),
  paramDefaults: z.record(z.string(), z.string()).optional(),
  col: z.number().optional(),
  row: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
});

export const DashboardImportPayloadSchema = z.object({
  version: z.number().optional(),
  title: z.string().optional(),
  personalityId: z.string().optional(),
  dependencies: z.array(z.unknown()).optional(),
  paramsSchema: z.array(ParamDefSchema).optional(),
  paramsCurrent: z.record(z.string(), z.string()).optional(),
  cronSchedule: z.string().nullable().optional(),
  panels: z.array(ImportPanelSchema).optional(),
});

export type DashboardImportPayload = z.infer<typeof DashboardImportPayloadSchema>;

/**
 * Validate an untrusted dashboard-import payload before any of its values reach
 * a SQL sink. Structural validation is a Zod `safeParse` (malformed input →
 * typed `INVALID_INPUT`, never a 500); then every panel SQL query is
 * SELECT-only guarded, and every param sink — the dashboard's `paramsCurrent`
 * plus each panel's `paramDefaults` — is checked against the imported
 * `paramsSchema` allowlist. Both param sinks feed `interpolateParams`, so both
 * must be vetted here.
 */
export function parseImportPayload(raw: unknown): DashboardImportPayload {
  const parsed = DashboardImportPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: 'Dashboard import payload is malformed',
      action: 'Provide the exact JSON produced by dashboard export.',
      details: parsed.error.issues,
    });
  }
  const data = parsed.data;
  const schema = data.paramsSchema ?? [];
  const panels = data.panels ?? [];

  for (const panel of panels) {
    if (panel.sqlQuery) assertSelectOnlySql(panel.sqlQuery);
  }

  const invalidCurrent = findInvalidParamKeys(schema, data.paramsCurrent ?? {});
  if (invalidCurrent.length > 0) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `Imported dashboard param value(s) not permitted by the parameter schema: ${invalidCurrent.join(', ')}`,
      action: PARAM_ALLOWLIST_ACTION,
    });
  }

  for (const panel of panels) {
    if (!panel.paramDefaults) continue;
    const invalidDefaults = findInvalidParamKeys(schema, panel.paramDefaults);
    if (invalidDefaults.length > 0) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Imported panel param default(s) not permitted by the parameter schema: ${invalidDefaults.join(', ')}`,
        action: PARAM_ALLOWLIST_ACTION,
      });
    }
  }

  return data;
}
