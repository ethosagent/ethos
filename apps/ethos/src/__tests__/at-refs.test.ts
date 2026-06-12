import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAtRefs } from '../lib/at-refs';

const cwd = mkdtempSync(join(tmpdir(), 'ethos-at-refs-'));

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveAtRefs', () => {
  it('passes through text without refs unchanged', async () => {
    expect(await resolveAtRefs('plain text, no refs here', cwd)).toBe('plain text, no refs here');
  });

  it('inlines an existing file with a language fence and path header', async () => {
    writeFileSync(join(cwd, 'snippet.ts'), 'const x = 1;\n');
    const result = await resolveAtRefs('look at @snippet.ts please', cwd);
    expect(result).toBe('look at ```ts\n// snippet.ts\nconst x = 1;\n\n``` please');
  });

  it('leaves a missing file ref as-is', async () => {
    const result = await resolveAtRefs('see @does/not/exist.ts ok', cwd);
    expect(result).toBe('see @does/not/exist.ts ok');
  });

  it('truncates file content over 8000 chars with a [truncated] suffix', async () => {
    writeFileSync(join(cwd, 'big.txt'), 'a'.repeat(9000));
    const result = await resolveAtRefs('@big.txt', cwd);
    expect(result).toContain('a'.repeat(8000));
    expect(result).not.toContain('a'.repeat(8001));
    expect(result).toContain('\n[truncated]\n```');
  });

  it('does not add a [truncated] suffix at exactly 8000 chars', async () => {
    writeFileSync(join(cwd, 'exact.txt'), 'b'.repeat(8000));
    const result = await resolveAtRefs('@exact.txt', cwd);
    expect(result).not.toContain('[truncated]');
  });

  it('fetches and inlines a URL ref with a source line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ text: async () => 'remote body' })),
    );
    const result = await resolveAtRefs('read @https://example.com/page now', cwd);
    expect(result).toBe('read ```\nremote body\n```\n(source: https://example.com/page) now');
  });

  it('truncates URL content over 8000 chars with a [truncated] suffix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ text: async () => 'c'.repeat(9000) })),
    );
    const result = await resolveAtRefs('@https://example.com/big', cwd);
    expect(result).not.toContain('c'.repeat(8001));
    expect(result).toContain('\n[truncated]\n```');
  });

  it('leaves the URL ref as-is when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const result = await resolveAtRefs('try @https://example.com/down ok', cwd);
    expect(result).toBe('try @https://example.com/down ok');
  });

  it('resolves multiple refs in one input', async () => {
    writeFileSync(join(cwd, 'one.md'), 'first');
    writeFileSync(join(cwd, 'two.md'), 'second');
    const result = await resolveAtRefs('@one.md and @two.md', cwd);
    expect(result).toContain('// one.md\nfirst');
    expect(result).toContain('// two.md\nsecond');
  });
});
