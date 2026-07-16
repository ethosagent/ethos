import { createHash } from 'node:crypto';

/**
 * Normalize a fact for dedup: lowercase, collapse whitespace, trim. Two facts
 * that differ only in casing/spacing hash identically, so a restated fact is
 * caught even after the nightly pass rewords it (§3.2).
 */
export function normalizeFact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Content hash of a normalized fact. Hex sha256, no prefix. */
export function hashFact(text: string): string {
  return createHash('sha256').update(normalizeFact(text), 'utf8').digest('hex');
}
