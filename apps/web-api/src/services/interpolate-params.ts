type ParamType = 'select' | 'options' | 'date-range';

interface ParamDef {
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
    return def.options ? def.options.includes(value) : true;
  }
  if (def.type === 'date-range') {
    return DATE_RE.test(value);
  }
  return true;
}
