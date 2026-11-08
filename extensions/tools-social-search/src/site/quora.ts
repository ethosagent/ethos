import { type SearchHit, toIsoDate } from '@ethosagent/tools-web';
import type { Tool } from '@ethosagent/types';
import { createSiteSearchTool, hitSnippet, type SiteSearchToolOptions } from './factory';
import { QUORA_PROFILE } from './filter';

// ---------------------------------------------------------------------------
// quora_search — Quora has no API at any tier (plan §1), so this searches
// through the personality's EXISTING web_search backend (Exa/Tavily/Brave,
// or SearXNG) constrained to quora.com. No tools.yaml key of its own (plan
// D3a): a personality that already binds web_search gets Quora search for
// free, and the shared binding is a disclosure — an operator sees
// quora_search draw on the web_search credential and learns, from the
// configuration itself, that these hits carry search fidelity (no answer
// counts, no vote counts, and a publication date only when the search index
// happened to record one), not the structured fidelity of a first-class
// platform API. See plan/phases/social-search-tools.md §6, §9, D3a.
// ---------------------------------------------------------------------------

export type CreateQuoraSearchToolOptions = SiteSearchToolOptions;

function formatHit(hit: SearchHit, index: number): string {
  const title = hit.title?.trim() || 'Untitled question';
  const snippet = hitSnippet(hit);
  // ` (YYYY-MM-DD)` closes the heading line, or nothing at all when the backend
  // supplied no readable date — `toIsoDate` never invents one (plan D10).
  const iso = toIsoDate(hit.publishedDate);
  const lines = [`${index + 1}. **${title}**${iso ? ` (${iso})` : ''}`, `   ${hit.url}`];
  if (snippet) lines.push(`   ${snippet}`);
  return lines.join('\n');
}

export function createQuoraSearchTool(opts: CreateQuoraSearchToolOptions = {}): Tool {
  return createSiteSearchTool(
    {
      name: 'quora_search',
      description:
        "Search Quora questions via the personality's web-search backend, constrained to quora.com. Search fidelity only — no answer counts and no vote counts. A question's publication date is rendered as ISO YYYY-MM-DD when the backend supplied one, and omitted entirely when it did not; a missing date is never guessed. Optionally restrict results to a recency window with max_age, a duration like 30d, 6m or 1y; omit it for no recency filter. Shares the web_search credential binding rather than a key of its own.",
      noun: 'questions',
      headerLabel: 'Quora questions',
      profile: QUORA_PROFILE,
      formatHit,
    },
    opts,
  );
}

export const quoraSearchTool = createQuoraSearchTool();
