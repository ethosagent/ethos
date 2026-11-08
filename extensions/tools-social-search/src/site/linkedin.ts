import { type SearchHit, toIsoDate } from '@ethosagent/tools-web';
import type { Tool } from '@ethosagent/types';
import { createSiteSearchTool, hitSnippet, type SiteSearchToolOptions } from './factory';
import { LINKEDIN_PROFILE } from './filter';

// ---------------------------------------------------------------------------
// linkedin_search — LinkedIn has no public post-search API at any partner
// tier (plan §1; SNAP is closed to new applicants), so this searches through
// the personality's EXISTING web_search backend, constrained to
// linkedin.com. Same D3a rationale as quora_search: no tools.yaml key of its
// own, shares the web_search binding.
//
// Low-fidelity discovery, documented as such (plan D11): it surfaces public
// /posts/ and /pulse/ URLs a search index happened to keep. It is never a
// live-conversation source and a consuming plugin must not rank it as one.
// See plan/phases/social-search-tools.md §6, §9, D3a, D11.
// ---------------------------------------------------------------------------

export type CreateLinkedInSearchToolOptions = SiteSearchToolOptions;

/** Some search backends title a LinkedIn post hit "<Name> on LinkedIn: <post
 *  text>" — when a hit's title carries that shape, split out the author. No
 *  field is invented when it doesn't (plan D10): a hit with no such title
 *  just renders without an author line. */
const TITLE_AUTHOR_RE = /^(.+?)\s+on LinkedIn:\s*(.+)$/i;

function firstLine(text: string | undefined): string | null {
  const line = text?.split('\n')[0]?.trim();
  return line || null;
}

function formatHit(hit: SearchHit, index: number): string {
  const rawTitle = hit.title?.trim();
  const match = rawTitle?.match(TITLE_AUTHOR_RE);
  const author = match?.[1];
  const heading = match ? match[2] : rawTitle || firstLine(hit.text) || 'Untitled post';
  const snippet = hitSnippet(hit);
  // ` (YYYY-MM-DD)` closes the heading line, or nothing at all when the backend
  // supplied no readable date — `toIsoDate` never invents one (plan D10).
  const iso = toIsoDate(hit.publishedDate);

  const lines = [
    `${index + 1}. **${heading}**${author ? ` — ${author}` : ''}${iso ? ` (${iso})` : ''}`,
    `   ${hit.url}`,
  ];
  if (snippet && snippet !== heading) lines.push(`   ${snippet}`);
  return lines.join('\n');
}

export function createLinkedInSearchTool(opts: CreateLinkedInSearchToolOptions = {}): Tool {
  return createSiteSearchTool(
    {
      name: 'linkedin_search',
      description:
        "Search public LinkedIn posts and articles via the personality's web-search backend, constrained to linkedin.com. Low-fidelity discovery, not a live-conversation source: no engagement counts and no follower counts. A post's publication date is rendered as ISO YYYY-MM-DD when the backend supplied one, and omitted entirely when it did not; a missing date is never guessed. Optionally restrict results to a recency window with max_age, a duration like 30d, 6m or 1y; omit it for no recency filter. Shares the web_search credential binding rather than a key of its own.",
      noun: 'posts',
      headerLabel: 'LinkedIn posts',
      profile: LINKEDIN_PROFILE,
      formatHit,
    },
    opts,
  );
}

export const linkedInSearchTool = createLinkedInSearchTool();
