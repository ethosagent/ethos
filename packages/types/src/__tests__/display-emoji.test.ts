// plan personality-presence-and-initiative §2 — `display.emoji` is exactly one
// emoji grapheme. The personality loader, the web-contracts update schema and
// the web editor all ask this one predicate.

import { describe, expect, it } from 'vitest';
import { isSingleEmojiGrapheme } from '../display-emoji';

/** 🏴 + `text` spelled in Unicode TAG characters + CANCEL TAG. */
function tagFlag(text: string): string {
  const tags = [...text].map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0)));
  return `\u{1F3F4}${tags.join('')}\u{E007F}`;
}

describe('isSingleEmojiGrapheme', () => {
  it.each([
    ['a plain emoji', '🦉'],
    ['an emoji with a presentation selector', '❤️'],
    ['a skin-tone modifier sequence', '👋🏽'],
    ['a ZWJ family sequence', '👨‍👩‍👧‍👦'],
    ['a regional-indicator flag', '🇯🇵'],
    ['a subdivision tag flag', '🏴󠁧󠁢󠁳󠁣󠁴󠁿'],
    ['the England flag', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'],
    ['a subdivision flag built from gbeng', tagFlag('gbeng')],
    ['a subdivision flag built from usca', tagFlag('usca')],
    ['a subdivision flag with digits (fr75)', tagFlag('fr75')],
    ['a keycap sequence', '#️⃣'],
    ['a digit keycap', '1️⃣'],
    ['a keycap without VS16', '1⃣'],
    ['a text-default heart without VS16', '❤'],
    ['a ZWJ sequence with VS16 on both sides', '🏳️‍⚧️'],
    ['a skin-toned ZWJ sequence', '🧑🏽‍💻'],
  ])('accepts %s', (_label, value) => {
    expect(isSingleEmojiGrapheme(value)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['two emoji', '🦉🦉'],
    ['plain letters', 'ab'],
    ['a single letter', 'a'],
    ['a bare digit', '1'],
    ['an emoji with trailing text', '🦉 owl'],
    ['surrounding whitespace', ' 🦉'],
    ['a lone regional indicator', '🇯'],
    ['a 200-char string', '🦉'.repeat(100)],
    ['a long non-emoji string', 'x'.repeat(200)],
    // Invisible or decorative code units the grapheme segmenter folds into
    // one cluster — each would ride along into every reaction and prefix.
    ['trailing TAG characters outside a subdivision flag', '🦉\u{E0041}\u{E0042}'],
    ['a subdivision flag missing its cancel tag', '🏴\u{E0067}\u{E0062}'],
    ['TAG characters on a non-flag base', '🦉\u{E0067}\u{E0062}\u{E007F}'],
    ['stacked combining marks', '🦉́́'],
    ['a single trailing combining mark', '🦉́'],
    ['the text-presentation selector VS15', '🦉︎'],
    ['a doubled VS16', '❤️️'],
    ['a dangling trailing ZWJ', '🦉‍'],
    ['a trailing ZWNJ', '🦉‌'],
    ['an enclosing keycap on a pictograph', '🦉⃣'],
    ['a black flag carrying a hidden "IGNORE ALL!" tag payload', tagFlag('IGNORE ALL!')],
    ['a black flag carrying lowercase tags too long for a subdivision', tagFlag('ignoreall')],
    ['a black flag carrying a one-letter tag payload', tagFlag('g')],
    ['a black flag carrying a tag space', tagFlag('gb ng')],
    ['a black flag carrying uppercase subdivision tags', tagFlag('GBENG')],
  ])('refuses %s', (_label, value) => {
    expect(isSingleEmojiGrapheme(value)).toBe(false);
  });
});
