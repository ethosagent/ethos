// P6 — the oRPC contract: for every procedure path, the JSON schema (zod 4
// `z.toJSONSchema`) of its input and output, plus its route and meta. Catches contract
// drift when `router.ts` / `schemas.ts` are split.

import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
// Relative: wiring does not depend on web-contracts, so it has no workspace link.
import { contract } from '../../../../web-contracts/src/router';
import { assertParity, GOLDEN_DIR, updating } from './harness';

interface ProcedureDef {
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  route?: unknown;
  meta?: unknown;
}

const isProcedure = (node: unknown): node is { '~orpc': ProcedureDef } =>
  typeof node === 'object' && node !== null && '~orpc' in node;

function schemaOf(schema: z.ZodType | undefined, io: 'input' | 'output'): unknown {
  if (!schema) return null;
  return z.toJSONSchema(schema, { unrepresentable: 'any', io });
}

function collect(node: unknown, path: string[], out: Record<string, unknown>): void {
  if (isProcedure(node)) {
    const def = node['~orpc'];
    out[path.join('.')] = {
      input: schemaOf(def.inputSchema, 'input'),
      output: schemaOf(def.outputSchema, 'output'),
      route: def.route ?? null,
      meta: def.meta ?? null,
    };
    return;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(node)) collect(child, [...path, key], out);
  }
}

describe('P6 oRPC contract parity', () => {
  // One fixture per top-level namespace: the whole contract is over 1 MiB, which Biome
  // refuses to process as one file. `p6-contract-index` pins the namespace and
  // procedure names, so a removed namespace cannot hide behind a leftover fixture.
  it('matches the per-namespace contract fixtures', () => {
    const procedures: Record<string, unknown> = {};
    collect(contract, [], procedures);
    const byNamespace: Record<string, Record<string, unknown>> = {};
    for (const [path, def] of Object.entries(procedures)) {
      const ns = path.split('.')[0] ?? path;
      byNamespace[ns] = { ...byNamespace[ns], [path]: def };
    }
    const index = Object.fromEntries(
      Object.entries(byNamespace).map(([ns, defs]) => [ns, Object.keys(defs).sort()]),
    );
    assertParity('p6-contract-index', index);
    for (const [ns, defs] of Object.entries(byNamespace)) assertParity(`p6-contract-${ns}`, defs);
    if (!updating()) {
      const onDisk = readdirSync(GOLDEN_DIR)
        .filter((f) => f.startsWith('p6-contract-') && f !== 'p6-contract-index.json')
        .sort();
      expect(onDisk).toEqual(
        Object.keys(byNamespace)
          .map((ns) => `p6-contract-${ns}.json`)
          .sort(),
      );
    }
  });
});
