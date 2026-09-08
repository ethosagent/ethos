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
  /** Optional extra shape test, applied after the prefix lists. Reddit needs
   *  it: a post lives at `/r/<subreddit>/comments/<id>/<slug>`, and the
   *  required `/comments/` segment sits AFTER a segment that varies, which a
   *  prefix list cannot express. Must be flagless (no `g`/`y`) — `test()` on
   *  a stateful regex would alternate hit-by-hit. */
  allowPathPattern?: RegExp;
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
  if (profile.allowPathPattern && !profile.allowPathPattern.test(pathname)) return false;
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

// ---------------------------------------------------------------------------
// Reddit — a post is `/r/<subreddit>/comments/<id>/<slug>`, and the base-36
// `<id>` is the post's identity: it is the same across slug text, across
// `www.`/`old.`/`np.`/`sh.` hosts, and across a comment permalink
// (`/comments/<id>/<slug>/<commentId>/`), so all of those collapse to one
// entry. The bare `/comments/<id>` form (no subreddit segment) is a real
// canonical Reddit URL and carries the same id, so it is admitted and
// collapses with the rest.
//
// Hosts: `reddit.com` alone already admits every `*.reddit.com` subdomain
// through `hostMatches`'s subdomain rule, so `www.`/`old.`/`np.` are listed
// for the record, not for reach — `sh.reddit.com` and anything else Reddit
// invents is admitted too, and dedupes onto the same post id. `redd.it`
// shortlinks are a DIFFERENT registrable domain and are dropped: they carry
// an id but no post shape, and resolving one would need a network fetch this
// tool does not make. Media hosts (`i.redd.it`, `preview.redd.it`) are
// dropped for the same reason — a picture is not a conversation.
//
// Paths: a subreddit listing page (`/r/askscience/`, `/r/askscience/top/`)
// is a directory of conversations, not one, so `/comments/` is REQUIRED. A
// prefix list cannot say that — the required segment sits after `<subreddit>`,
// which varies — hence `allowPathPattern`. The deny list is kept alongside it
// even though the pattern already excludes every entry: a redundant deny is
// free and documents what was deliberately excluded. Note `/r/<sub>/wiki/…`
// is NOT caught by the `/wiki/` deny (that prefix matches the site-level wiki
// only); the pattern is what drops it.
// ---------------------------------------------------------------------------

function redditDedupKey(url: URL): string | null {
  const id = url.pathname.match(/\/comments\/([A-Za-z0-9]+)/)?.[1];
  // Reddit ids are base-36 and case-insensitive in a URL; lowercase so two
  // spellings of the same post do not read as two posts.
  return id ? `post:${id.toLowerCase()}` : null;
}

export const REDDIT_PROFILE: SiteProfile = {
  siteOperator: 'site:reddit.com',
  hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'np.reddit.com'],
  denyPathPrefixes: [
    '/user/',
    '/u/',
    '/search',
    '/wiki/',
    '/settings',
    '/subreddits',
    '/submit',
    '/login',
    '/message/',
  ],
  allowPathPrefixes: ['/r/', '/comments/'],
  allowPathPattern: /^\/(?:r\/[^/]+\/)?comments\/[A-Za-z0-9]+/,
  dedupKey: redditDedupKey,
};
