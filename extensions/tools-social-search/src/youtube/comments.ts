import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import {
  API_BASE,
  API_HOST,
  COMMENT_THREADS_LIST_COST,
  type CreateYouTubeToolOptions,
  DAILY_QUOTA,
  describeYouTubeApiError,
  NO_KEY_MESSAGE,
  selectYouTubeSecretRef,
} from './constants';
import { parseYouTubeVideoId } from './ids';

// ---------------------------------------------------------------------------
// youtube_comments — YouTube Data API v3 `commentThreads.list` (1 unit per
// page). See plan/phases/social-search-tools.md §6.
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const COMMENT_MAX_CHARS = 600;

export type YouTubeCommentsOrder = 'relevance' | 'time';

export interface YouTubeCommentsArgs {
  video: string;
  limit?: number;
  order?: YouTubeCommentsOrder;
  include_replies?: boolean;
}

interface YouTubeCommentSnippet {
  authorDisplayName?: string;
  likeCount?: number;
  publishedAt?: string;
  textOriginal?: string;
}

interface YouTubeComment {
  snippet?: YouTubeCommentSnippet;
}

interface YouTubeCommentThread {
  snippet?: {
    topLevelComment?: YouTubeComment;
    totalReplyCount?: number;
  };
  replies?: {
    comments?: YouTubeComment[];
  };
}

interface YouTubeCommentThreadsResponse {
  items?: YouTubeCommentThread[];
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} [truncated]` : text;
}

function formatComment(comment: YouTubeComment | undefined, level: number): string | null {
  const snippet = comment?.snippet;
  if (!snippet) return null;
  const author = snippet.authorDisplayName ?? 'unknown';
  const likes = snippet.likeCount ?? 0;
  const date = formatDate(snippet.publishedAt);
  const body = truncate((snippet.textOriginal ?? '').trim(), COMMENT_MAX_CHARS);
  const indent = '  '.repeat(level);
  return `${indent}- ${author} (${likes} likes) ${date}: ${body}`;
}

function formatThread(thread: YouTubeCommentThread, includeReplies: boolean): string[] {
  const out: string[] = [];
  const top = formatComment(thread.snippet?.topLevelComment, 0);
  if (top) out.push(top);
  if (includeReplies) {
    for (const reply of thread.replies?.comments ?? []) {
      const rendered = formatComment(reply, 1);
      if (rendered) out.push(rendered);
    }
  }
  return out;
}

export function createYouTubeCommentsTool(opts: CreateYouTubeToolOptions = {}): Tool {
  return {
    name: 'youtube_comments',
    description: `Fetch top-level comments (and optionally replies) for a YouTube video via the Data API v3. Accepts a video id or any YouTube URL form (watch, youtu.be, /shorts/, /live/, /embed/). Costs ${COMMENT_THREADS_LIST_COST} quota unit per page of a shared ${DAILY_QUOTA.toLocaleString()}/day budget. Requires a Google (YouTube Data API) key.`,
    toolset: 'web',
    maxResultChars: 15_000,
    capabilities: {
      network: { allowedHosts: [API_HOST] },
      secrets: ['providers/google/*'],
    },
    outputIsUntrusted: true,
    // Same shared `youtube` credential as `youtube_search` — see that tool.
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
    isAvailable() {
      return true;
    },
    schema: {
      type: 'object',
      properties: {
        video: {
          type: 'string',
          description:
            'The video to fetch comments for: a video id or a YouTube URL (watch, youtu.be, /shorts/, /live/, /embed/)',
        },
        limit: {
          type: 'number',
          description: `Number of top-level comment threads to fetch (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
        },
        order: {
          type: 'string',
          enum: ['relevance', 'time'],
          description: "Sort order (default 'relevance')",
        },
        include_replies: {
          type: 'boolean',
          description: 'Include up to 5 replies per thread, indented under it (default false)',
        },
      },
      required: ['video'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const { video, limit, order, include_replies } = args as YouTubeCommentsArgs;

      if (!video) return { ok: false, error: 'video is required', code: 'input_invalid' };
      const videoId = parseYouTubeVideoId(video);
      if (!videoId) {
        return {
          ok: false,
          error: `Could not find a YouTube video id in "${video}" — pass a video id or a YouTube URL`,
          code: 'input_invalid',
        };
      }

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

        const includeReplies = include_replies === true;
        const params = new URLSearchParams({
          part: includeReplies ? 'snippet,replies' : 'snippet',
          videoId,
          maxResults: String(clampInt(limit, DEFAULT_LIMIT, MAX_LIMIT)),
          order: order ?? 'relevance',
          key: apiKey,
        });

        const response = await net.fetch(`${API_BASE}/commentThreads?${params.toString()}`, {
          method: 'GET',
          signal: ctx.abortSignal,
        });

        if (!response.ok) return describeYouTubeApiError(response);

        const data = (await response.json()) as YouTubeCommentThreadsResponse;
        const threads = data.items ?? [];

        if (threads.length === 0) {
          return { ok: true, value: `No comments found for video: ${videoId}` };
        }

        const rendered = threads.flatMap((thread) => formatThread(thread, includeReplies));
        const footer = `\n\n(${COMMENT_THREADS_LIST_COST} units (1 page) of ${DAILY_QUOTA.toLocaleString()}/day)`;
        return {
          ok: true,
          value: `Comments for video ${videoId} (${threads.length} threads shown):\n\n${rendered.join('\n')}${footer}`,
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

export const youtubeCommentsTool = createYouTubeCommentsTool();
