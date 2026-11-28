/**
 * What a paid read tool is charged per call, in USD, before it runs. A paid tool's provider bill
 * never reaches a `ToolResult`, so the window cannot meter it afterwards; instead the L4 gate
 * (tool-gate.ts) charges this fixed estimate to the window guard (budget.ts `chargeToolCall`)
 * and refuses the call when the charge would cross the day, window or exploration cap.
 *
 * Every value is a conservative per-call estimate, not a measured bill. The repo carries no
 * price for any of these providers (extensions/tools-web, tools-answer-engines, tools-x-search
 * hold no cost hints), so the figures come from each vendor's public list price as the author
 * understood it, rounded UP. Re-check them against the vendor pages when a plan changes.
 *
 * Census: tool-prices.test.ts pins that every `INITIATIVE_READ_TOOLS` entry is here or on
 * `INITIATIVE_FREE_READ_TOOLS`, so a new paid tool cannot slip in at $0.
 */
export const INITIATIVE_TOOL_CALL_USD: Readonly<Record<string, number>> = Object.freeze({
  // Exa search ~$0.005, Tavily basic search ~$0.008 (one credit), Brave ~$0.005 per query:
  // vendor list prices, rounded up to the dearest. SearXNG is self-hosted and cheaper.
  web_search: 0.01,
  // Exa contents ~$0.001 per page; the fetch itself is free. Estimate, rounded up.
  web_extract: 0.002,
  // linkedin_search, reddit_web_search and quora_search run the web_search backend with a
  // site constraint (extensions/tools-social-search/src/site/*.ts), so they cost a web_search.
  linkedin_search: 0.01,
  reddit_web_search: 0.01,
  quora_search: 0.01,
  // An answer engine bills model tokens plus a search fee (Perplexity Sonar, OpenAI and Gemini
  // search tools, roughly $0.005 to $0.05 a call). Estimate.
  engine_ask: 0.1,
  // X API pay-per-use bills per post read (about $0.005 each); a search returns up to a page of
  // posts. Estimate for a 20-post page.
  x_search: 0.1,
});

/** Read tools that cost nothing per call: local state, local files, or a provider with a free tier. */
export const INITIATIVE_FREE_READ_TOOLS = Object.freeze([
  // YouTube Data API is quota-limited, not billed. Not a dollar cost.
  'youtube_search',
  'youtube_comments',
  // Reddit's API is free within its rate limit.
  'reddit_search',
  'reddit_thread',
  'session_search',
  'session_list_by_date',
  'memory_read',
  'team_memory_read',
  'team_memory_search',
  'kanban_list',
  'kanban_show',
  'goal_status',
  'read_file',
  'search_files',
] as const);

/** USD charged for one call to `toolName`; 0 for a free, ledger or unknown tool. */
export function toolCallUsd(toolName: string): number {
  return INITIATIVE_TOOL_CALL_USD[toolName] ?? 0;
}
