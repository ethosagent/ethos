import type { Citation } from './types';
import { domainOf } from './url';

// ---------------------------------------------------------------------------
// The citation rule the grok, gemini and microsoft adapters share (plan
// engine-ask-grok-gemini-microsoft §3/§4.4) — the same rule `chatgpt.ts` and
// `perplexity.ts` implement inline: order by where the citation sits in the
// answer, de-duplicate by EXACT URL string, cap at `maxCitations`, renumber
// `position` 1..n.
// ---------------------------------------------------------------------------

export interface RawCitation {
  url: string;
  /** Set only when the vendor gave a real page title (plan D8). */
  title?: string;
  /**
   * Compared lexicographically, lowest first; ties keep annotation array
   * order because `Array.prototype.sort` is stable. A missing key component
   * is `Number.POSITIVE_INFINITY`, so an annotation without an offset sorts
   * after every annotation with one.
   */
  keys: readonly number[];
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? Number.POSITIVE_INFINITY;
    const y = b[i] ?? Number.POSITIVE_INFINITY;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * URL IDENTITY IS EXACT STRING EQUALITY — no trailing slash, fragment, case or
 * query-string normalisation: `?page=2`, `#section-3` and a trailing slash can
 * each name a different resource, so two citations that MIGHT be two
 * documents stay two. `domain` is normalised for grouping only.
 */
export function orderCitations(raw: readonly RawCitation[], maxCitations: number): Citation[] {
  const sorted = [...raw].sort((a, b) => compareKeys(a.keys, b.keys));
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const c of sorted) {
    if (citations.length >= maxCitations) break;
    if (seen.has(c.url)) continue;
    const domain = domainOf(c.url);
    if (!domain) continue;
    seen.add(c.url);
    citations.push({
      url: c.url,
      ...(c.title !== undefined ? { title: c.title } : {}),
      domain,
      position: citations.length + 1,
    });
  }
  return citations;
}

/**
 * URLs from a documented `{ url }` array; plain URL strings are accepted too,
 * the same defensive posture as `urlsOf` in `chatgpt.ts`.
 */
export function urlsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (typeof item === 'object' && item !== null && 'url' in item) {
      const url = (item as { url?: unknown }).url;
      if (typeof url === 'string') out.push(url);
    }
  }
  return out;
}

/** Narrowing guard shared by the parsers: every field is optional and `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Non-2xx bodies are cut to this many characters before they reach an error. */
export const MAX_ERROR_BODY_CHARS = 500;
