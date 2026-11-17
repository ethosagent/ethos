import { EthosError } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Value scalars — the one reader of a `key: <value>`, and the CLI's writer
// ---------------------------------------------------------------------------

/**
 * The value of a `key: <value>` line, as whichever writer meant it.
 *
 * - `"…"`: the text between the quotes, with exactly two escapes decoded —
 *   `\\` is `\` and `\"` is `"`. Every other backslash is literal, so a
 *   hand-written `"C:\tmp"`, `"C:\Users\me"` or `"C:\ffmpeg\bin"` reads
 *   exactly as it did before quoting was made reversible; no escape can
 *   silently become a tab, form feed or backspace. `quoteConfigScalar` writes
 *   the same two escapes, so both writers' values read back as written — the
 *   old reader stripped the quotes and decoded nothing, so each web save of
 *   `C:\tmp "x"` added a layer of `\`. Values the previous web writer produced
 *   with `JSON.stringify` still decode: without control characters (which no
 *   writer accepts, `assertWritableConfigLines`) JSON uses only these escapes.
 * - Anything else — `'…'` included — is trimmed, and one quote is stripped from
 *   each end: the legacy rule, unchanged for hand-written files.
 *
 * Pinned by `__tests__/config-scalar-roundtrip.test.ts`.
 */
export function parseConfigScalar(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return s.replace(/^["']|["']$/g, '');
}

/** `value` double-quoted with `\` and `"` escaped — the inverse of
 *  `parseConfigScalar` for a quoted value. Both config writers quote with it
 *  (`renderConfigScalar` here, `yamlScalar` in apps/web-api). */
export function quoteConfigScalar(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * The CLI writer's spelling of a value: raw when `parseConfigScalar` reads the
 * raw text back unchanged, quoted (`quoteConfigScalar`) otherwise — surrounding
 * whitespace or a quote at either end. Ordinary values — URLs, cron
 * expressions, model ids, Windows paths — keep the unquoted shape existing
 * files have; a raw backslash is literal.
 *
 * Exported for `__tests__/config-scalar-roundtrip.test.ts`, which pins it as
 * `parseConfigScalar`'s inverse value by value; nothing outside this module
 * calls it (`serializeConfigLines` does, through `renderConfigLine`).
 */
export function renderConfigScalar(value: string): string {
  if (value === '') return value;
  const plain = value === value.trim() && !/^["']/.test(value) && !/["']$/.test(value);
  return plain ? value : quoteConfigScalar(value);
}

/** One serialized `key: value` line with its value run through
 *  `renderConfigScalar`. Keys never contain `': '`, so the first one splits. */
export function renderConfigLine(line: string): string {
  const i = line.indexOf(': ');
  if (i <= 0) return line;
  const value = line.slice(i + 2);
  // `""` is the serializer's explicit empty (`security.trusted_github_orgs`),
  // already in the spelling `parseConfigScalar` reads as ''.
  if (value === '""') return line;
  return `${line.slice(0, i)}: ${renderConfigScalar(value)}`;
}

/**
 * Refuse serialized config lines that carry a control character (newline, CR,
 * tab, …). The format is line-based: such a value cannot be written so it
 * reads back, so the writer refuses it with `INVALID_INPUT` naming the key
 * instead of writing a file that means something else. Credentials are exempt
 * by construction — only their `${secrets:…}` reference reaches a line. Both
 * writers call it on exactly what they are about to write: `writeConfig` here
 * and `ConfigRepository.write` in apps/web-api (setup goes through
 * `writeConfig`). Pinned by `__tests__/config-scalar-roundtrip.test.ts`.
 */
export function assertWritableConfigLines(lines: readonly string[]): void {
  for (const line of lines) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the subject.
    if (!/[\u0000-\u001f\u007f]/.test(line)) continue;
    const i = line.indexOf(':');
    const key = i > 0 ? line.slice(0, i) : line.slice(0, 40);
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `config.yaml cannot store a newline, tab or other control character; '${key}' has one.`,
      action: `Remove the control character from '${key}' and save again.`,
    });
  }
}

/** The `key` of a flat `key: value` config line; `null` for blanks and comments. */
export function configLineKey(line: string): string | null {
  const i = line.indexOf(':');
  if (i <= 0) return null;
  const key = line.slice(0, i);
  if (key.startsWith('#') || /\s/.test(key)) return null;
  return key;
}
