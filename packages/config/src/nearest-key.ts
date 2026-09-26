// Plan ux-feedback-and-config-clarity B2 (§6.1) — the one typo-suggestion
// helper for config keys and CLI command names. `parseConfigYaml`'s unknown-key
// warnings and the CLI's unknown-command hint both go through it, so the two
// surfaces cannot disagree about what counts as "close enough to suggest".

/**
 * Damerau-Levenshtein distance (optimal string alignment): Levenshtein plus
 * adjacent transposition, so `modle` is one edit from `model`.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row: number[] = [];
    for (let j = 0; j <= b.length; j++) {
      if (i === 0 || j === 0) {
        row.push(i + j);
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const prev = rows[i - 1] ?? [];
      let d = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, (rows[i - 2]?.[j - 2] ?? 0) + 1);
      }
      row.push(d);
    }
    rows.push(row);
  }
  return rows[a.length]?.[b.length] ?? 0;
}

/**
 * The candidate closest to `input` within `maxDistance` (default 2) edits, or
 * `undefined` when nothing is close enough to be a typo of it. Ties are broken
 * by the SHORTEST candidate — `personalit` should suggest `personality`, not a
 * longer dotted sibling that happens to be equally close — and then by first
 * appearance, so the result is deterministic for any candidate order.
 */
export function nearestKey(
  input: string,
  candidates: Iterable<string>,
  maxDistance = 2,
): string | undefined {
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    if (candidate === input) continue;
    const d = damerauLevenshtein(input, candidate);
    if (
      d < bestDistance ||
      (d === bestDistance && best !== undefined && candidate.length < best.length)
    ) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}
