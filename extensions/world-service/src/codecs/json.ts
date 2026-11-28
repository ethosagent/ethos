// JSON export: the GraphBundle with recursively sorted keys, so the same
// bundle always serialises to the same bytes (pinned by
// __tests__/exports.test.ts 'JSON export has stable key order').

import type { GraphBundle } from '@ethosagent/types';

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function toBundleJson(bundle: GraphBundle): string {
  return `${JSON.stringify(sortKeys(bundle), null, 2)}\n`;
}
