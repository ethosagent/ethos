/**
 * Strip ANSI escape sequences from untrusted output before rendering.
 * Prevents terminal manipulation via LLM-generated or tool-fetched content.
 *
 * Covers:
 * - CSI sequences: ESC[ ... <letter> (cursor movement, colors, erase)
 * - OSC sequences: ESC] ... BEL (title changes, hyperlinks)
 * - Other escape patterns: ESC followed by a single character
 */

const ESC = '\x1b';
const BEL = '\x07';

// Built dynamically to avoid biome's noControlCharactersInRegex lint on regex literals.
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-9;]*[A-Za-z]|${ESC}\\][^${BEL}]*${BEL}|${ESC}[^[(${BEL}]`,
  'g',
);

export function stripAnsiEscapes(input: string): string {
  return input.replace(ANSI_RE, '');
}
