import { shortPatternCheck } from '@ethosagent/safety-injection';
import { describe, expect, it } from 'vitest';
import { isHiddenCodePoint, revealHiddenChars } from '../hidden-chars';

describe('revealHiddenChars', () => {
  it('reveals bidi, zero-width, C0/C1 and tag characters and counts them', () => {
    const r = revealHiddenChars('rm‮ -rf​ /\u0007\u{E0041}');
    expect(r.text).toBe('rm⟨U+202E⟩ -rf⟨U+200B⟩ /⟨U+0007⟩⟨U+E0041⟩');
    expect(r.hidden).toBe(4);
  });
  it('leaves tab, newline and ordinary text untouched', () => {
    expect(revealHiddenChars('a\tb\nc é 中')).toEqual({ text: 'a\tb\nc é 中', hidden: 0 });
  });
  it('reveals CR so a carriage-return overwrite cannot hide text', () => {
    expect(revealHiddenChars('safe\rrm -rf /').text).toBe('safe⟨U+000D⟩rm -rf /');
  });
  it('covers every code point safety-injection flags as bidi-override or zero-width', () => {
    // drift pin against packages/safety/injection/src/pattern-check.ts:44-48
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const hit = shortPatternCheck(String.fromCodePoint(cp)).hits.some(
        (h) => h.rule === 'bidi-override' || h.rule === 'zero-width',
      );
      if (hit) expect(isHiddenCodePoint(cp), cp.toString(16)).toBe(true);
    }
  });
});
