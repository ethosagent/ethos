// Mechanical schema-freeze gate for `MemoryProvider`.
//
// Reads the source of `memory.ts`, extracts the body of the
// `MemoryProvider` interface, and asserts the method names are exactly
// the five contract methods: `prefetch`, `read`, `search`, `sync`, `list`.
//
// A PR that adds or renames a method without updating this list fails
// the gate. Mirrors the personality-field-count gate pattern.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = join(import.meta.dirname, '..', 'memory.ts');

/**
 * Extract the body of `interface MemoryProvider { ... }` and return the
 * top-level method names. Brace-depth scan so nested generics / object
 * types in parameter or return positions don't pollute the list.
 */
function extractMemoryProviderMethods(src: string): string[] {
  const startMarker = 'export interface MemoryProvider';
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) throw new Error('MemoryProvider interface not found');
  const openIdx = src.indexOf('{', startIdx);
  if (openIdx < 0) throw new Error('MemoryProvider opening brace not found');

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

  // Strip block + line comments so commented-out methods don't count.
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // Each method declaration is `name(...): Promise<...>;` at depth 0.
  // Walk character-by-character tracking nesting depth across (), <>, {},
  // and []. Method names are identifiers at depth 0 that are immediately
  // followed by `(`.
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
      // Skip whitespace
      let look = end;
      while (look < stripped.length && /\s/.test(stripped[look] ?? '')) look++;
      if (stripped[look] === '(') {
        methods.push(name);
      }
      cursor = end;
      continue;
    }
    cursor++;
  }
  return methods;
}

describe('MemoryProvider method-count gate', () => {
  it('exposes exactly the five contract methods', () => {
    const src = readFileSync(SOURCE, 'utf-8');
    const methods = extractMemoryProviderMethods(src);
    expect(methods).toEqual(['prefetch', 'read', 'search', 'sync', 'list']);
  });
});
