import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHORITATIVE_AUTHORS } from '../world-graph';

describe('world-graph contract', () => {
  it('AUTHORITATIVE_AUTHORS is user and import', () => {
    expect([...AUTHORITATIVE_AUTHORS]).toEqual(['user', 'import']);
  });

  it('no node:* import in world-graph.ts', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'world-graph.ts'), 'utf-8');
    expect(src).not.toMatch(/from\s+['"]node:/);
    expect(src).not.toMatch(/import\(\s*['"]node:/);
  });
});
