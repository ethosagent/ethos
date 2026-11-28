// Mechanical drift gate for `WorldGraphProvider` (world-graph.ts).
//
// Reads the source of `world-graph.ts`, extracts the body of the
// `WorldGraphProvider` interface, and asserts the method names are exactly
// the fourteen contract methods. A PR that adds, removes or renames a method
// without updating this list fails the gate. Mirrors memory-method-count.test.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = join(import.meta.dirname, '..', 'world-graph.ts');

const EXPECTED = [
  'query',
  'neighbours',
  'history',
  'changes',
  'assert',
  'close',
  'retire',
  'getFact',
  'getSchema',
  'applySchema',
  'import',
  'export',
  'purge',
  'capabilities',
];

/** Brace-depth scan of the interface body; returns top-level method names. */
function extractMethods(src: string): string[] {
  const startIdx = src.indexOf('export interface WorldGraphProvider {');
  if (startIdx < 0) throw new Error('WorldGraphProvider interface not found');
  const openIdx = src.indexOf('{', startIdx);

  let depth = 1;
  let i = openIdx + 1;
  let body = '';
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{' || ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === '>' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) break;
    }
    body += ch;
    i++;
  }

  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const methods: string[] = [];
  let d = 0;
  let cursor = 0;
  while (cursor < stripped.length) {
    const ch = stripped[cursor];
    if (ch === '(' || ch === '{' || ch === '<' || ch === '[') {
      d++;
      cursor++;
      continue;
    }
    if (ch === ')' || ch === '}' || ch === '>' || ch === ']') {
      d--;
      cursor++;
      continue;
    }
    if (d === 0 && ch !== undefined && /[A-Za-z_$]/.test(ch)) {
      let end = cursor;
      while (end < stripped.length) {
        const c = stripped[end];
        if (c === undefined || !/[A-Za-z0-9_$]/.test(c)) break;
        end++;
      }
      const name = stripped.slice(cursor, end);
      let look = end;
      while (look < stripped.length && /\s/.test(stripped[look] ?? '')) look++;
      if (stripped[look] === '(') methods.push(name);
      cursor = end;
      continue;
    }
    cursor++;
  }
  return methods;
}

describe('WorldGraphProvider method-count gate', () => {
  it('world-graph method count is 14', () => {
    const methods = extractMethods(readFileSync(SOURCE, 'utf-8'));
    expect(methods).toHaveLength(14);
    expect(methods).toEqual(EXPECTED);
  });
});
