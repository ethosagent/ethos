import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import {
  API_BASE,
  API_HOST,
  type CreateYouTubeToolOptions,
  DAILY_QUOTA,
  describeYouTubeApiError,
  NO_KEY_MESSAGE,
  SEARCH_LIST_COST,
  SNIPPET_MAX_CHARS,
  selectYouTubeSecretRef,
  VIDEOS_LIST_COST,
} from './constants';

// ---------------------------------------------------------------------------
// youtube_search — YouTube Data API v3 `search.list` (100 units) followed by
// one `videos.list` (1 unit) over the returned ids for view/like/comment
// counts. See plan/phases/social-search-tools.md §6.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 10;
const MAX_MAX_RESULTS = 25;
const TOTAL_COST = SEARCH_LIST_COST + VIDEOS_LIST_COST;

export type YouTubeSearchOrder = 'relevance' | 'date' | 'viewCount' | 'rating';

export interface YouTubeSearchArgs {
  query: string;
  max_results?: number;
  order?: YouTubeSearchOrder;
  published_after?: string;
  region_code?: string;
}

interface YouTubeSearchListItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    publishedAt?: string;
  };
}

interface YouTubeSearchListResponse {
  items?: YouTubeSearchListItem[];
}

interface YouTubeVideoStatistics {
  viewCount?: string;
  likeCount?: string;
  commentCount?: string;
}

interface YouTubeVideosListItem {
  id?: string;
  statistics?: YouTubeVideoStatistics;
}

interface YouTubeVideosListResponse {
  items?: YouTubeVideosListItem[];
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function formatDate(publishedAt: string | undefined): string {
  if (!publishedAt) return 'unknown date';
  const d = new Date(publishedAt);
  return Number.isNaN(d.getTime()) ? 'unknown date' : d.toISOString().slice(0, 10);
}

function formatCount(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  return `${value} ${label}`;
}

function formatResult(
  item: YouTubeSearchListItem,
  index: number,
  stats: Map<string, YouTubeVideoStatistics> | null,
): string {
  const id = item.id?.videoId ?? '';
  const title = item.snippet?.title ?? 'Untitled';
  const channel = item.snippet?.channelTitle ?? 'unknown channel';
  const date = formatDate(item.snippet?.publishedAt);
  const url = `https://www.youtube.com/watch?v=${id}`;
  const description = (item.snippet?.description ?? '').trim().slice(0, SNIPPET_MAX_CHARS);

  const lines = [`${index + 1}. **${title}**`, `   ${channel} | ${date}`];

  const stat = stats?.get(id);
  if (stat) {
    const counts = [
      formatCount(stat.viewCount, 'views'),
      formatCount(stat.likeCount, 'likes'),
      formatCount(stat.commentCount, 'comments'),
    ].filter((c): c is string => c !== null);
    if (counts.length > 0) lines.push(`   ${counts.join(', ')}`);
  }

  lines.push(`   ${url}`);
  if (description) lines.push(`   ${description}`);
  return lines.join('\n');
}

export function createYouTubeSearchTool(opts: CreateYouTubeToolOptions = {}): Tool {
  return {
    name: 'youtube_search',
    description: `Search YouTube videos via the Data API v3. Returns title, channel, publish date, view/like/comment counts, and URL. Costs ${TOTAL_COST} quota units per call (${SEARCH_LIST_COST} search + ${VIDEOS_LIST_COST} statistics) of a shared ${DAILY_QUOTA.toLocaleString()}/day budget. Requires a Google (YouTube Data API) key.`,
    toolset: 'web',
    maxResultChars: 15_000,
    capabilities: {
      network: { allowedHosts: [API_HOST] },
      // Prefix grant over the google namespace: any personality binding is
      // `providers/google/<name>`, so it always falls inside this static
      // allowlist.
      secrets: ['providers/google/*'],
    },
    outputIsUntrusted: true,
    // One credential, two tools: the settings UI groups by this key and renders
    // a single form covering `youtube_search` and `youtube_comments`, and the
    // binding is stored under `youtube` in both stores.
    settingsKey: 'youtube',
    settingsSchema: {
      fields: [
        {
          kind: 'secret-binding',
          key: 'secret',
          label: 'Google API key (YouTube)',
          secretKind: 'youtube-api-key',
          providerLabel: 'Google (YouTube Data API)',
          getKeyUrl: 'https://console.cloud.google.com/apis/credentials',
        },
      ],
    },
    // Always registered — a key can arrive from the named-secrets vault,
    // which isAvailable() cannot see (no ToolContext at filter time).
    // execute() surfaces a clear "no key configured" error. Same reasoning
    // as web_search / x_search.
    isAvailable() {
      return true;
    },
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: {
          type: 'number',
          description: `Number of videos to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_MAX_RESULTS})`,
        },
        order: {
          type: 'string',
          enum: ['relevance', 'date', 'viewCount', 'rating'],
          description: "Sort order (default 'relevance')",
        },
        published_after: {
          type: 'string',
          description: 'Only include videos published after this ISO-8601 timestamp',
        },
        region_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code to bias results to',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const { query, max_results, order, published_after, region_code } = args as YouTubeSearchArgs;

      if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };

      const secrets = ctx.secretsResolver;
      const net = ctx.scopedFetch;
      if (!secrets || !net) {
        return {
          ok: false,
          error: 'Capability backends not configured',
          code: 'not_available' as const,
        };
      }

      try {
        const apiKey = await secrets.get(selectYouTubeSecretRef(ctx, opts));
        if (!apiKey) {
          return { ok: false, error: NO_KEY_MESSAGE, code: 'not_available' as const };
        }

        const searchParams = new URLSearchParams({
          part: 'snippet',
          type: 'video',
          q: query,
          maxResults: String(clampInt(max_results, DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS)),
          order: order ?? 'relevance',
          key: apiKey,
        });
        if (published_after) searchParams.set('publishedAfter', published_after);
        if (region_code) searchParams.set('regionCode', region_code);

        const searchResponse = await net.fetch(`${API_BASE}/search?${searchParams.toString()}`, {
          method: 'GET',
          signal: ctx.abortSignal,
        });

        if (!searchResponse.ok) return describeYouTubeApiError(searchResponse);

        const searchData = (await searchResponse.json()) as YouTubeSearchListResponse;
        const items = (searchData.items ?? []).filter(
          (item): item is YouTubeSearchListItem & { id: { videoId: string } } =>
            Boolean(item.id?.videoId),
        );

        if (items.length === 0) {
          return { ok: true, value: `No results found for: ${query}` };
        }

        const ids = items.map((item) => item.id.videoId);
        let stats: Map<string, YouTubeVideoStatistics> | null = null;
        let statsNote = '';

        const videosParams = new URLSearchParams({
          part: 'statistics',
          id: ids.join(','),
          key: apiKey,
        });
        const videosResponse = await net.fetch(`${API_BASE}/videos?${videosParams.toString()}`, {
          method: 'GET',
          signal: ctx.abortSignal,
        });

        if (videosResponse.ok) {
          const videosData = (await videosResponse.json()) as YouTubeVideosListResponse;
          stats = new Map(
            (videosData.items ?? [])
              .filter((v): v is YouTubeVideosListItem & { id: string } => Boolean(v.id))
              .map((v) => [v.id, v.statistics ?? {}]),
          );
        } else {
          statsNote = '\n\n(Engagement counts unavailable — the statistics call failed.)';
        }

        const formatted = items.map((item, i) => formatResult(item, i, stats)).join('\n\n');
        const footer = `\n\n(${TOTAL_COST} units (${SEARCH_LIST_COST} search + ${VIDEOS_LIST_COST} statistics) of ${DAILY_QUOTA.toLocaleString()}/day)`;
        return {
          ok: true,
          value: `YouTube search results for "${query}":\n\n${formatted}${statsNote}${footer}`,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

export const youtubeSearchTool = createYouTubeSearchTool();
