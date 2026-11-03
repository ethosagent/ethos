import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as index from '../index';
import { contract } from '../router';

// Pins the public surface of @ethosagent/web-contracts so a file split (or any
// refactor) cannot silently change it: export names, the router key tree in
// declaration order, and a hash of every exported zod schema's JSON Schema, and a hash of every
// procedure's route/meta/input/output definition.
// Regenerate deliberately with UPDATE_SURFACE=1.

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'surface.json');

type KeyTree = { [key: string]: KeyTree | string };

// Fields of an oRPC procedure's `~orpc` definition (observed on the real objects:
// errorMap, route, meta, prefix, tags, inputSchema, outputSchema). Route-relevant
// ones are hashed so swapping two procedures under the same keys changes the tree.
type ProcedureDef = {
  route?: unknown;
  meta?: unknown;
  prefix?: unknown;
  tags?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

const skippedProcedures: string[] = [];

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function schemaJson(path: string, label: string, schema: unknown): unknown {
  if (schema === undefined) return null;
  try {
    return z.toJSONSchema(schema as z.ZodType);
  } catch {
    skippedProcedures.push(`${path}#${label}`);
    return '__toJSONSchema_failed__';
  }
}

function procedureHash(path: string, def: ProcedureDef): string {
  const stable = {
    route: def.route ?? null,
    meta: def.meta ?? null,
    prefix: def.prefix ?? null,
    tags: def.tags ?? null,
    input: schemaJson(path, 'input', def.inputSchema),
    output: schemaJson(path, 'output', def.outputSchema),
  };
  return sha(JSON.stringify(stable));
}

function keyTree(node: unknown, path: string[] = []): KeyTree {
  const tree: KeyTree = {};
  for (const key of Object.keys(node as object)) {
    const child = (node as Record<string, unknown>)[key];
    const childPath = [...path, key];
    if (typeof child === 'object' && child !== null && '~orpc' in child) {
      tree[key] = procedureHash(childPath.join('.'), (child as { '~orpc': ProcedureDef })['~orpc']);
    } else if (typeof child === 'object' && child !== null) {
      tree[key] = keyTree(child, childPath);
    }
  }
  return tree;
}

function snapshot() {
  const exports = Object.keys(index).sort();
  const schemaShapes: Record<string, string> = {};
  const skipped: string[] = [];
  for (const name of exports) {
    const value = (index as Record<string, unknown>)[name];
    if (!(value instanceof z.ZodType)) continue;
    try {
      schemaShapes[name] = sha(JSON.stringify(z.toJSONSchema(value)));
    } catch {
      skipped.push(name);
    }
  }
  skippedProcedures.length = 0;
  const tree = keyTree(contract);
  return {
    exports,
    contract: tree,
    schemaShapes,
    skippedSchemas: skipped,
    skippedProcedures: [...skippedProcedures],
  };
}

describe('web-contracts surface', () => {
  it('public surface is unchanged', () => {
    const actual = snapshot();
    if (process.env.UPDATE_SURFACE === '1') {
      // CI must never regenerate the pin silently.
      expect(process.env.CI, 'UPDATE_SURFACE must not be set in CI').toBeFalsy();
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
      console.warn(`surface fixture regenerated at ${FIXTURE}; assertion skipped`);
      return;
    }
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(actual).toEqual(expected);
    // toEqual ignores key order; the contract tree is order-sensitive.
    expect(JSON.stringify(actual.contract)).toBe(JSON.stringify(expected.contract));
  });
});
