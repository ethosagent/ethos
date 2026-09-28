// Plan personality-memory-boundary G2 — the pure half of the amendment store:
// canonical ops, opsHash, applyOps and expectedAfterHash.

import { hashDefinitionBytes } from '@ethosagent/personalities';
import { parseToolsetYaml, renderToolsetYaml } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  canonicalizeOps,
  expectedAfterHash,
  MAX_AMENDMENT_OPS,
  opsHash,
} from '../amendment-ops';
import { sha256Hex } from '../store';

describe('canonicalizeOps', () => {
  it('dedupes exact repeats and sorts by tool, then add before remove', () => {
    const result = canonicalizeOps([
      { op: 'remove_tool', tool: 'web_search' },
      { op: 'add_tool', tool: 'web_fetch' },
      { op: 'add_tool', tool: 'web_fetch' },
      { op: 'add_tool', tool: 'browse' },
    ]);
    expect(result).toEqual({
      ok: true,
      ops: [
        { op: 'add_tool', tool: 'browse' },
        { op: 'add_tool', tool: 'web_fetch' },
        { op: 'remove_tool', tool: 'web_search' },
      ],
    });
  });

  it('refuses adding and removing the same tool', () => {
    expect(
      canonicalizeOps([
        { op: 'add_tool', tool: 'terminal' },
        { op: 'remove_tool', tool: 'terminal' },
      ]),
    ).toEqual({ ok: false, reason: 'conflict', tool: 'terminal' });
  });

  it('refuses an empty list and more than the op bound', () => {
    expect(canonicalizeOps([])).toEqual({ ok: false, reason: 'empty' });
    const many = Array.from({ length: MAX_AMENDMENT_OPS + 1 }, (_, i) => ({
      op: 'add_tool' as const,
      tool: `tool_${i}`,
    }));
    expect(canonicalizeOps(many)).toEqual({
      ok: false,
      reason: 'too_many',
      count: MAX_AMENDMENT_OPS + 1,
    });
  });

  it('refuses a tool name that could inject a line into toolset.yaml, and an unknown op', () => {
    for (const tool of ['web_fetch\n- terminal', 'a b', '# x', '', '-x']) {
      expect(canonicalizeOps([{ op: 'add_tool', tool }])).toMatchObject({
        ok: false,
        reason: 'invalid_op',
      });
    }
    expect(canonicalizeOps([{ op: 'grant' as 'add_tool', tool: 'web_fetch' }])).toMatchObject({
      ok: false,
      reason: 'invalid_op',
    });
  });
});

describe('opsHash', () => {
  it('is the same for any order or repetition of the same ops', () => {
    const a = canonicalizeOps([
      { op: 'add_tool', tool: 'a' },
      { op: 'remove_tool', tool: 'b' },
    ]);
    const b = canonicalizeOps([
      { op: 'remove_tool', tool: 'b' },
      { op: 'add_tool', tool: 'a' },
      { op: 'add_tool', tool: 'a' },
    ]);
    if (!a.ok || !b.ok) throw new Error('expected canonical ops');
    expect(opsHash(a.ops)).toBe(opsHash(b.ops));
    expect(opsHash(a.ops)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when an op differs', () => {
    expect(opsHash([{ op: 'add_tool', tool: 'a' }])).not.toBe(
      opsHash([{ op: 'remove_tool', tool: 'a' }]),
    );
  });
});

describe('applyOps', () => {
  const live = '- read_file\n- web_search\n';

  it('removes, then appends adds in canonical order, rendered by the loader format owner', () => {
    const result = applyOps(live, [
      { op: 'add_tool', tool: 'web_fetch' },
      { op: 'add_tool', tool: 'browse' },
      { op: 'remove_tool', tool: 'web_search' },
    ]);
    expect(result).toEqual({
      ok: true,
      ops: [
        { op: 'add_tool', tool: 'browse' },
        { op: 'add_tool', tool: 'web_fetch' },
        { op: 'remove_tool', tool: 'web_search' },
      ],
      after: ['read_file', 'browse', 'web_fetch'],
      afterBytes: '- read_file\n- browse\n- web_fetch\n',
    });
    if (result.ok) {
      expect(result.afterBytes).toBe(renderToolsetYaml(result.after));
      expect(parseToolsetYaml(result.afterBytes)).toEqual(result.after);
    }
  });

  it('drops a hand-written comment (the review diff shows it)', () => {
    const result = applyOps('# keep this small\n- read_file\n', [
      { op: 'add_tool', tool: 'web_fetch' },
    ]);
    expect(result).toMatchObject({ ok: true, afterBytes: '- read_file\n- web_fetch\n' });
  });

  it('removing the last tool leaves a DECLARED empty toolset, not an empty file', () => {
    const result = applyOps('- read_file\n', [{ op: 'remove_tool', tool: 'read_file' }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.afterBytes).not.toBe('');
      expect(parseToolsetYaml(result.afterBytes)).toEqual([]);
    }
  });

  it('refuses an undeclared toolset — a missing or empty file', () => {
    const ops = [{ op: 'add_tool' as const, tool: 'web_fetch' }];
    expect(applyOps(null, ops)).toEqual({ ok: false, reason: 'undeclared_toolset' });
    expect(applyOps('', ops)).toEqual({ ok: false, reason: 'undeclared_toolset' });
  });

  it('refuses a no-op: adding a listed tool, or removing an unlisted one', () => {
    expect(applyOps(live, [{ op: 'add_tool', tool: 'read_file' }])).toEqual({
      ok: false,
      reason: 'no_op',
      tool: 'read_file',
    });
    expect(applyOps(live, [{ op: 'remove_tool', tool: 'terminal' }])).toEqual({
      ok: false,
      reason: 'no_op',
      tool: 'terminal',
    });
  });

  it('refuses ops that do not canonicalise before looking at the file', () => {
    expect(
      applyOps(null, [
        { op: 'add_tool', tool: 'x' },
        { op: 'remove_tool', tool: 'x' },
      ]),
    ).toEqual({ ok: false, reason: 'conflict', tool: 'x' });
  });
});

describe('hashes', () => {
  it('sha256Hex is the hash writeDefinitionBytes compares a baseHash against', () => {
    for (const bytes of ['', '- read_file\n', 'ünïcode\n']) {
      expect(sha256Hex(bytes)).toBe(hashDefinitionBytes(bytes));
    }
  });

  it('expectedAfterHash binds the base, the ops and the after-bytes', () => {
    const base = sha256Hex('- read_file\n');
    const ops = opsHash([{ op: 'add_tool', tool: 'web_fetch' }]);
    const after = '- read_file\n- web_fetch\n';
    const h = expectedAfterHash(base, ops, after);
    expect(h).toBe(sha256Hex(`${base}${ops}${after}`));
    expect(expectedAfterHash(sha256Hex('other'), ops, after)).not.toBe(h);
    expect(expectedAfterHash(base, opsHash([{ op: 'add_tool', tool: 'x' }]), after)).not.toBe(h);
    expect(expectedAfterHash(base, ops, `${after}- terminal\n`)).not.toBe(h);
  });
});
