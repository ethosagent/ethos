import type { SearchHit } from '@ethosagent/tools-web';

// ---------------------------------------------------------------------------
// SiteProfile — the site-constraint + de-duplication contract shared by
// quora_search and linkedin_search. Each search-derived tool appends its
// profile's `siteOperator` to the query AND filters every returned URL
// against `hosts`/`denyPathPrefixes`/`allowPathPrefixes` — the constraint is
// enforced twice on purpose, because not every backend honours `site:` (Exa
// is a neural index and does not document it as an operator). See
// plan/phases/social-search-tools.md §5.3 and §9.
// ---------------------------------------------------------------------------

export interface SiteProfile {
  /** Appended to the user's query before the backend call. A hint, not the
   *  guarantee — the filter below is the guarantee. */
  siteOperator: string;
  /** Registrable hosts a hit must be on. */
  hosts: readonly string[];
  /** A hit's pathname must not start with any of these. */
  denyPathPrefixes: readonly string[];
  /** When non-empty, a hit's pathname MUST start with one of these. */
  allowPathPrefixes: readonly string[];
  /** Stable identity of the underlying question/post, for de-duplication.
   *  `null` when no identity is derivable — such a hit is kept and deduped
   *  by its raw URL instead of being dropped. */
  dedupKey(url: URL): string | null;
}

const OVER_FETCH_MULTIPLIER = 3;
const OVER_FETCH_CAP = 30;

/** `min(num_results * 3, 30)` (plan §6) — filtering drops hits (wrong host,
 *  denied path, navigational page), so the backend is asked for more than
 *  the caller wants. */
export function overFetchCount(numResults: number): number {
  return Math.min(numResults * OVER_FETCH_MULTIPLIER, OVER_FETCH_CAP);
}

/** Registrable-host equality, never substring matching: `quora.com.evil.test`
 *  must NOT match `hosts: ['quora.com']` the way `.includes('quora.com')`
 *  would. A hostname matches a host either exactly or as one of its
 *  subdomains (`foo.quora.com` matches `quora.com`). */
function hostMatches(hostname: string, hosts: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return hosts.some((host) => h === host || h.endsWith(`.${host}`));
}

function pathAllowed(pathname: string, profile: SiteProfile): boolean {
  if (profile.denyPathPrefixes.some((p) => pathname.startsWith(p))) return false;
  if (profile.allowPathPrefixes.length === 0) return true;
  return profile.allowPathPrefixes.some((p) => pathname.startsWith(p));
}

/**
 * Apply a `SiteProfile`'s host + path filter, then de-duplicate by
 * `dedupKey` (first occurrence wins). Does NOT trim to `num_results` — the
 * caller over-fetches (`overFetchCount`) and slices after this returns.
 */
export function filterAndDedupe(hits: readonly SearchHit[], profile: SiteProfile): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    let url: URL;
    try {
      url = new URL(hit.url);
    } catch {
      continue;
    }
    if (!hostMatches(url.hostname, profile.hosts)) continue;
    if (!pathAllowed(url.pathname, profile)) continue;
    const key = profile.dedupKey(url) ?? `raw:${hit.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quora — question slug is the first path segment. `/unanswered/<slug>` and
// `<slug>/answer/<author>` both collapse onto the plain `<slug>` form, so a
// question and one of its answers de-duplicate to one entry.
// ---------------------------------------------------------------------------

function quoraDedupKey(url: URL): string | null {
  let path = url.pathname.replace(/^\/+/, '');
  if (path.startsWith('unanswered/')) path = path.slice('unanswered/'.length);
  const slug = path.split('/')[0];
  return slug || null;
}

export const QUORA_PROFILE: SiteProfile = {
  siteOperator: 'site:quora.com',
  hosts: ['quora.com', 'www.quora.com'],
  denyPathPrefixes: ['/profile/', '/topic/', '/search'],
  allowPathPrefixes: [],
  dedupKey: quoraDedupKey,
};

// ---------------------------------------------------------------------------
// LinkedIn — `/posts/` de-duplicates by the trailing `activity-<digits>` id
// (the same post reachable through different slug text); `/pulse/` has no
// id, so its last path segment (the article slug) is the key. The deny list
// is kept alongside the allow list even though the allow list already
// excludes those paths — a redundant deny entry is free, and the pair
// documents what was deliberately excluded.
// ---------------------------------------------------------------------------

function linkedInDedupKey(url: URL): string | null {
  const path = url.pathname;
  if (path.startsWith('/posts/')) {
    const match = path.match(/activity-(\d+)/);
    return match ? `activity-${match[1]}` : null;
  }
  if (path.startsWith('/pulse/')) {
    const segments = path.split('/').filter(Boolean);
    const slug = segments[segments.length - 1];
    return slug ? `pulse:${slug}` : null;
  }
  return null;
}

export const LINKEDIN_PROFILE: SiteProfile = {
  siteOperator: 'site:linkedin.com',
  hosts: ['linkedin.com', 'www.linkedin.com'],
  denyPathPrefixes: ['/company/', '/school/', '/jobs/', '/in/', '/learning/', '/showcase/'],
  allowPathPrefixes: ['/posts/', '/pulse/'],
  dedupKey: linkedInDedupKey,
};
