// `PersonalityConfig.display.emoji` validation (plan
// personality-presence-and-initiative §2). One predicate, pure and
// dependency-free, so every reader of the field asks the same question: the
// personality loader (`buildDisplayConfig` / `FilePersonalityRegistry.update`
// in extensions/personalities), the web-contracts update schema, and the web
// editor's field.

/**
 * Longest value worth segmenting. The longest RGI emoji sequences (a ZWJ
 * family, a subdivision tag flag) are 11–14 UTF-16 code units; 32 leaves room
 * without letting a pasted paragraph through the segmenter.
 */
const MAX_EMOJI_CODE_UNITS = 32;

/**
 * The accepted shapes, as a WHITELIST over every code point — the grapheme
 * segmenter alone folds invisible and decorative code units (TAG characters,
 * combining marks, VS15, ZWNJ, a dangling ZWJ) into the cluster before them,
 * so "one grapheme" is not "one emoji".
 *
 * A pictographic sequence: a pictograph, optionally VS16 (U+FE0F) or one
 * skin-tone modifier (U+1F3FB–1F3FF), and further pictographs of the same
 * shape joined by ZWJ (U+200D). A ZWJ therefore only ever sits BETWEEN two
 * pictographs. Covers plain emoji, ❤ with or without VS16, skin tones and
 * ZWJ families.
 */
const PICTOGRAPHIC_SEQUENCE =
  /^\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*$/u;
/** A subdivision flag: 🏴, then 2–6 TAG characters spelling a lowercase
 *  ISO 3166-2 code (tag digits U+E0030–E0039 and tag letters U+E0061–E007A:
 *  `gbeng`, `gbsct`, `usca`), then CANCEL TAG (U+E007F). The only shape in
 *  which TAG characters are accepted, and narrow on purpose: tag characters
 *  are invisible, so a wider range carries hidden text ("IGNORE ALL!") inside
 *  what renders as a flag. */
const SUBDIVISION_FLAG = /^\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,6}\u{E007F}$/u;
/** A country flag: exactly two regional indicators. */
const REGIONAL_FLAG = /^\p{Regional_Indicator}{2}$/u;
/** A keycap: `0-9`, `#` or `*`, optional VS16, then U+20E3 — the only shape
 *  in which the enclosing keycap mark is accepted. */
const KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/u;

/**
 * True when `value` is exactly ONE emoji grapheme: `Intl.Segmenter` sees one
 * grapheme cluster, and every code point of it fits one of the shapes above —
 * a pictographic sequence, a subdivision flag, a regional-indicator flag or a
 * keycap. No surrounding whitespace, no text, no invisible trailing code
 * units. Pinned by `__tests__/display-emoji.test.ts`.
 */
export function isSingleEmojiGrapheme(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMOJI_CODE_UNITS) return false;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const _segment of segmenter.segment(value)) {
    count += 1;
    if (count > 1) return false;
  }
  return (
    PICTOGRAPHIC_SEQUENCE.test(value) ||
    SUBDIVISION_FLAG.test(value) ||
    REGIONAL_FLAG.test(value) ||
    KEYCAP.test(value)
  );
}
