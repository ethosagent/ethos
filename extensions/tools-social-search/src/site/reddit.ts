import { type SearchHit, toIsoDate } from '@ethosagent/tools-web';
import type { Tool } from '@ethosagent/types';
import { createSiteSearchTool, hitSnippet, type SiteSearchToolOptions } from './factory';
import { REDDIT_PROFILE } from './filter';

// ---------------------------------------------------------------------------
// reddit_web_search — the credential-free rung under `reddit_search`
// (extensions/tools-reddit/). That tool speaks Reddit's official OAuth API
// and needs a client_id/client_secret pair Reddit now grants by manual
// review; its own no-credentials message already names the workaround ("in
// the meantime, web_search with a site:reddit.com query works with no
// setup"). This tool IS that workaround, made narrow: a personality can hold
// reddit_web_search without holding web_search, and its reach stays one
// platform. That narrowing is the whole reason it is a tool rather than a
// prompt instruction — same argument as quora_search / linkedin_search
// (plan/completed/social-search-tools.md D2).
//
// Same D3a rationale as those two: no tools.yaml key of its own, it reads the
// personality's EXISTING web_search binding, and that shared binding is a
// disclosure — an operator sees reddit_web_search drawing on the web_search
// credential and learns from the configuration itself that these hits carry
// SEARCH fidelity (no scores, no comment counts, no subreddit metadata, and a
// publication date only when the search index happened to record one), not the
// structured fidelity reddit_search returns.
// ---------------------------------------------------------------------------

export type CreateRedditWebSearchToolOptions = SiteSearchToolOptions;

/** The subreddit a hit's URL is on, read off the URL itself — structural, not
 *  invented (plan D10). `null` for the bare `/comments/<id>` form, which
 *  names no subreddit. */
function subredditOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).pathname.match(/^\/r\/([^/]+)\//)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Search backends commonly title a Reddit hit "<post title> : r/<sub>" or
 *  "<post title> - Reddit". The subreddit is rendered from the URL, so strip
 *  the decoration rather than print it twice. */
const TITLE_DECORATION_RE = /\s*[-:|]\s*(?:r\/[A-Za-z0-9_]+|Reddit)\s*$/i;

function formatHit(hit: SearchHit, index: number): string {
  const title = hit.title?.replace(TITLE_DECORATION_RE, '').trim() || 'Untitled post';
  const sub = subredditOf(hit.url);
  const snippet = hitSnippet(hit);
  // ` (YYYY-MM-DD)` closes the heading line, or nothing at all when the backend
  // supplied no readable date — `toIsoDate` never invents one (plan D10).
  const iso = toIsoDate(hit.publishedDate);
  const lines = [
    `${index + 1}. **${title}**${sub ? ` — r/${sub}` : ''}${iso ? ` (${iso})` : ''}`,
    `   ${hit.url}`,
  ];
  if (snippet) lines.push(`   ${snippet}`);
  return lines.join('\n');
}

export function createRedditWebSearchTool(opts: CreateRedditWebSearchToolOptions = {}): Tool {
  return createSiteSearchTool(
    {
      name: 'reddit_web_search',
      description:
        "Search Reddit posts via the personality's web-search backend, constrained to reddit.com. Needs no Reddit credentials, unlike reddit_search. Search fidelity only — no scores and no comment counts. A post's publication date is rendered as ISO YYYY-MM-DD when the backend supplied one, and omitted entirely when it did not; a missing date is never guessed. Optionally restrict results to a recency window with max_age, a duration like 30d, 6m or 1y; omit it for no recency filter. Shares the web_search credential binding rather than a key of its own.",
      noun: 'posts',
      headerLabel: 'Reddit posts',
      profile: REDDIT_PROFILE,
      formatHit,
    },
    opts,
  );
}

export const redditWebSearchTool = createRedditWebSearchTool();
