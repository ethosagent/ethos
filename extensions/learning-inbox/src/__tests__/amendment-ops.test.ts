// Plan personality-memory-boundary G2 — the pure half of the amendment store:
// canonical ops, opsHash, applyOps and expectedAfterHash.

import { hashDefinitionBytes } from '@ethosagent/personalities';
import { parseToolsetYaml, renderToolsetYaml } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  canonicalizeIdentityOps,
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

// M2 — a name or vibe line may carry no character a reviewer cannot see. The
// emoji op keeps its own validator (`isSingleEmojiGrapheme`).
describe('canonicalizeIdentityOps — invisible characters', () => {
  const INVISIBLE: ReadonlyArray<readonly [string, string]> = [
    ['a Unicode tag character (U+E0041)', String.fromCodePoint(0xe0041)],
    ['the tag cancel character (U+E007F)', String.fromCodePoint(0xe007f)],
    ['the reserved tag block start (U+E0000, unassigned)', String.fromCodePoint(0xe0000)],
    ['a soft hyphen (U+00AD)', '\u00ad'],
    ['a function application (U+2061)', '\u2061'],
    ['an invisible separator (U+2063)', '\u2063'],
    ['an Arabic letter mark (U+061C)', '\u061c'],
    ['a Mongolian vowel separator (U+180E)', '\u180e'],
    ['an interlinear annotation anchor (U+FFF9)', '\ufff9'],
    ['a private-use character (U+E000)', '\ue000'],
    ['a supplementary private-use character (U+F0000)', String.fromCodePoint(0xf0000)],
    ['an unassigned code point (U+0378)', '\u0378'],
    ['a lone high surrogate', '\ud800'],
    ['a lone low surrogate', '\udc00'],
    ['a zero-width space (U+200B)', '\u200b'],
    ['a right-to-left override (U+202E)', '\u202e'],
    ['a variation selector VS1 (U+FE00)', '\ufe00'],
    ['the text-presentation selector VS15 (U+FE0E)', '\ufe0e'],
    ['the emoji-presentation selector VS16 (U+FE0F)', '\ufe0f'],
    ['a supplementary variation selector (U+E0100)', String.fromCodePoint(0xe0100)],
    ['the last supplementary variation selector (U+E01EF)', String.fromCodePoint(0xe01ef)],
    ['a Hangul choseong filler (U+115F)', '\u115f'],
    ['a Hangul jungseong filler (U+1160)', '\u1160'],
    ['a Hangul filler (U+3164)', '\u3164'],
    ['a halfwidth Hangul filler (U+FFA0)', '\uffa0'],
    ['a braille blank (U+2800)', '\u2800'],
    ['a combining long stroke overlay (U+0336) on a letter', 'a\u0336'],
    ['a combining tilde overlay (U+0334) on a letter', 'a\u0334'],
    ['a combining long solidus overlay (U+0338) on a letter', 'a\u0338'],
    ['a combining mark after a space', ' \u0301'],
    ['a combining mark after a digit', '1\u0301'],
    ['a combining mark after punctuation', '-\u0301'],
    ['an enclosing keycap mark after a digit', '1\u20e3'],
    ['a stack of four combining marks on a letter', 'a\u0301\u0302\u0303\u0304'],
  ];

  for (const op of ['set_name', 'set_description'] as const) {
    it.each(INVISIBLE)(`refuses ${op} carrying %s`, (_label, ch) => {
      const result = canonicalizeIdentityOps([{ op, value: `No${ch}va` }]);
      expect(result).toMatchObject({ ok: false, reason: 'invalid_value', op });
    });
  }

  it('still accepts ordinary text, accents, CJK and an emoji in a vibe line', () => {
    expect(
      canonicalizeIdentityOps([
        { op: 'set_name', value: 'Zoë 小龙' },
        { op: 'set_description', value: 'Calm, curious — a little dry 🦉' },
      ]),
    ).toMatchObject({ ok: true });
  });

  it('refuses a combining mark at the very start of the value', () => {
    expect(canonicalizeIdentityOps([{ op: 'set_name', value: '\u0301Nova' }])).toMatchObject({
      ok: false,
      reason: 'invalid_value',
    });
  });

  it.each([
    ['a composed accent', 'Zoë Café'],
    ['a decomposed accent', 'Zoe\u0308 Cafe\u0301'],
    ['two stacked marks on a letter (Vietnamese, decomposed)', 'Vie\u0323\u0302t'],
    ['Hindi with combining vowel signs and virama', 'शिक्षक मित्र'],
    ['Hindi with two marks on one letter', 'कीं'],
    ['CJK', '小龙'],
    ['plain emoji text', 'Chef 🍳 and owl 🦉'],
  ])('accepts %s in a name and a vibe', (_label, value) => {
    expect(
      canonicalizeIdentityOps([
        { op: 'set_name', value },
        { op: 'set_description', value },
      ]),
    ).toMatchObject({ ok: true });
  });

  it('leaves the emoji op to its own validator: a ZWJ family emoji is still one emoji', () => {
    expect(
      canonicalizeIdentityOps([{ op: 'set_display_emoji', value: '👩\u200d👩\u200d👧' }]),
    ).toMatchObject({ ok: true });
  });
});
