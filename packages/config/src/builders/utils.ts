import { parseConfigScalar } from '../scalar';

/** An integer inside [min, max], or `undefined` — never a clamped near-miss. */
export function parseBoundedInt(v: string, min: number, max: number): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/**
 * A finite number inside [min, max], or `undefined` — the float sibling of
 * `parseBoundedInt`, for the one wake bound (`sensitivity`) that is a fraction
 * rather than a count. Same contract: never a clamped near-miss.
 */
export function parseBoundedFloat(v: string, min: number, max: number): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

export function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function sortedIndexes(kv: Record<number, Record<string, string>>): number[] {
  // Numeric sort — `Object.keys(...)` returns strings even on numeric-keyed
  // records, and the default lexicographic order would put index 10 before 2.
  return Object.keys(kv)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * Narrows an operator-supplied string to one of a platform's modes. `some`
 * rather than `includes` because `readonly T[]`'s `includes` only accepts a
 * `T`, and the value being tested is exactly what has not been checked yet.
 */
export function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return values.some((v) => v === value);
}

/** `'a', 'b' or 'c'` — the shape the existing mode errors already use. */
export function quotedList(values: readonly string[]): string {
  const quoted = values.map((v) => `'${v}'`);
  const last = quoted[quoted.length - 1] ?? '';
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} or ${last}` : last;
}

/**
 * If `line` matches `pattern` (group 1 = field, group 2 = raw value), store the parsed scalar in
 * `kv[field]` and return true; otherwise return false and leave `kv` alone.
 */
export function takeKvLine(line: string, pattern: RegExp, kv: Record<string, string>): boolean {
  const m = line.match(pattern);
  if (!m) return false;
  kv[m[1]] = parseConfigScalar(m[2]);
  return true;
}
