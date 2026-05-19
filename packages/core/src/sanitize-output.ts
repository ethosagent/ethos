/**
 * Strip ANSI escape sequences from untrusted output before rendering.
 * Prevents terminal manipulation via LLM-generated or tool-fetched content.
 *
 * Covers:
 * - CSI sequences (including private modes like ?25l, ?2004h): ESC[ ... <final>
 * - OSC sequences terminated with BEL (\x07) or ST (ESC\): ESC] ... BEL|ST
 * - Character set selection (G0/G1): ESC( <charset>
 * - Other single-character escape sequences: ESC + one char
 */

const ESC = '\x1b';
const BEL = '\x07';

// Built dynamically to avoid biome's noControlCharactersInRegex lint on regex literals.
// Pattern breakdown:
//   1. CSI sequences with optional private-mode markers (?, !, >) and tilde-terminated:
//      ESC[ [?!>]? [0-9;]* [A-Za-z~]
//   2. OSC sequences terminated by BEL or ST (ESC\):
//      ESC] <any non-BEL, non-ESC>* (BEL | ESC\)
//   3. Character set selection (G0/G1):
//      ESC( [A-B0-2]
//   4. Other common single-char escape sequences:
//      ESC [DME78HNO=>cfn]
const ANSI_RE = new RegExp(
  `${ESC}\\[[?!>]?[0-9;]*[A-Za-z~]` +
    `|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)` +
    `|${ESC}\\([A-B0-2]` +
    `|${ESC}[DME78HNO=>cfn]`,
  'g',
);

const MAX_STRIP_ITERATIONS = 10;

export function stripAnsiEscapes(input: string): string {
  let result = input;
  for (let i = 0; i < MAX_STRIP_ITERATIONS; i++) {
    const next = result.replace(ANSI_RE, '');
    if (next === result) return next;
    result = next;
  }
  return result;
}
