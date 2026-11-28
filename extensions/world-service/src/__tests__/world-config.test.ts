import { describe, expect, it } from 'vitest';
import { parseMountsYaml, parseWorldYaml, WorldConfigError } from '../index';

function issuesOf(fn: () => unknown): WorldConfigError['issues'] {
  try {
    fn();
  } catch (err) {
    if (err instanceof WorldConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected WorldConfigError');
}

describe('world config', () => {
  it('parses a world.yaml with defaults', () => {
    const w = parseWorldYaml('id: acme\ntitle: Acme company\nreaders: [engineer]\n');
    expect(w).toEqual({
      id: 'acme',
      title: 'Acme company',
      audience: 'owner_only',
      backend: 'sqlite',
      readers: ['engineer'],
      proposers: [],
    });
  });

  it('parses worlds.yaml mounts', () => {
    const m = parseMountsYaml(
      'mounts:\n  - { world: acme, mode: read }\n  - { world: watchlist, mode: propose, as: stocks }\n',
    );
    expect(m.mounts).toHaveLength(2);
    expect(m.mounts[1]?.as).toBe('stocks');
  });

  it('unknown key fails', () => {
    const issues = issuesOf(() => parseWorldYaml('id: acme\ntitle: Acme\nowner: me\n'));
    expect(issues).toEqual([{ line: 3, message: 'unknown key "owner"' }]);
    expect(() => parseMountsYaml('mounts:\n  - { world: acme, mode: read, extra: 1 }\n')).toThrow(
      WorldConfigError,
    );
  });

  it('duplicate alias fails with the line', () => {
    const text = [
      'mounts:',
      '  - { world: acme, mode: read, as: x }',
      '  - { world: watchlist, mode: read, as: x }',
      '',
    ].join('\n');
    expect(issuesOf(() => parseMountsYaml(text))).toEqual([
      { line: 3, message: 'duplicate alias "x"' },
    ]);
  });

  it('alias may not equal another mounted world', () => {
    const text =
      'mounts:\n  - { world: acme, mode: read, as: watchlist }\n  - { world: watchlist, mode: read }\n';
    expect(issuesOf(() => parseMountsYaml(text))[0]?.line).toBe(2);
  });

  it('rejects an unsafe slug and a bad mode with lines', () => {
    const issues = issuesOf(() => parseMountsYaml('mounts:\n  - { world: ../x, mode: write }\n'));
    expect(issues.map((i) => i.line)).toEqual([2, 2]);
  });

  it('reports YAML syntax and duplicate-key errors with a line', () => {
    expect(issuesOf(() => parseWorldYaml('id: a\nid: b\ntitle: t\n'))[0]?.line).toBe(2);
  });
});
