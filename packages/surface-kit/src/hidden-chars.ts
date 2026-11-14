// Hidden-character reveal for approval surfaces. A bidi override, zero-width
// or tag character in a gated call's args lets what the user reads differ from
// what runs; this swaps each such code point for a visible `⟨U+XXXX⟩` marker.
// Pinned by `__tests__/hidden-chars.test.ts`, including a drift check against
// the `bidi-override` / `zero-width` rules in
// `packages/safety/injection/src/pattern-check.ts`.

/** Inclusive `[lo, hi]` code-point ranges that render as nothing or reorder text. */
export const HIDDEN_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0d, 0x0d],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe007f],
];

/** True when `cp` is a hidden or text-reordering code point. */
export function isHiddenCodePoint(cp: number): boolean {
  for (const [lo, hi] of HIDDEN_CODE_POINT_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

export interface RevealResult {
  text: string;
  /** How many code points were replaced with a marker. */
  hidden: number;
}

/**
 * Replace every hidden code point with `⟨U+XXXX⟩`. `keep` (default tab and
 * newline) lists code points left as-is.
 */
export function revealHiddenChars(
  text: string,
  opts: { keep?: ReadonlyArray<number> } = {},
): RevealResult {
  const keep = opts.keep ?? [0x09, 0x0a];
  let out = '';
  let hidden = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (isHiddenCodePoint(cp) && !keep.includes(cp)) {
      out += `⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩`;
      hidden++;
    } else {
      out += ch;
    }
  }
  return { text: out, hidden };
}
