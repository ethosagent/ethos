import type { ToolContext, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Shared constants for youtube_search / youtube_comments — one module so the
// quota figures used in a tool's description, its result footer, and its
// quotaExceeded error message can never disagree (plan §6/§8).
//
// Quota costs (search.list 100, videos.list 1, commentThreads.list 1, daily
// cap 10,000) read from Google's published YouTube Data API v3 quota-cost
// table on 2026-09-07. Re-verify if Google changes these.
// ---------------------------------------------------------------------------

export const API_HOST = 'www.googleapis.com';
export const API_BASE = `https://${API_HOST}/youtube/v3`;

/** Default secretRef — what `execute()` resolves when no personality binding
 *  names a secret. A binding resolves `providers/google/<name>` instead,
 *  following the same 4-rung resolution `x_search` uses for xAI. */
export const DEFAULT_SECRET_REF = 'providers/google/apiKey';
export const SECRET_PREFIX = 'providers/google/';

export const NO_KEY_MESSAGE =
  "No Google API key configured — add a Google key in Settings → Security → Named Secrets (provider Google, YouTube Data API), then bind it to youtube in the personality's tool settings, or set YOUTUBE_API_KEY.";

export const SEARCH_LIST_COST = 100;
export const VIDEOS_LIST_COST = 1;
export const COMMENT_THREADS_LIST_COST = 1;
export const DAILY_QUOTA = 10_000;

export const QUOTA_EXCEEDED_MESSAGE =
  `YouTube Data API quota exceeded — the shared key has spent its ${DAILY_QUOTA.toLocaleString()}-unit daily limit. ` +
  'More quota requires a manual audit form (Google Cloud Console → APIs & Services → YouTube Data API v3 → Quotas → Request higher quota), not a purchase.';

export const SNIPPET_MAX_CHARS = 400;

/**
 * A resolved per-personality `youtube` binding. `secret` is a NAME only
 * (e.g. `yt-main`) — never a value — that resolves to
 * `providers/google/<name>` in the vault. Absent → `providers/google/apiKey`.
 * Shared by both `youtube_search` and `youtube_comments` (plan §8): same
 * API, same project, same daily quota pool.
 */
export interface YouTubeToolSetting {
  secret?: string;
}

export interface CreateYouTubeToolOptions {
  /** Personality-owned binding (source of truth), resolved by personalityId. */
  resolvePersonalitySetting?: (personalityId: string) => YouTubeToolSetting | undefined;
  /** Global FALLBACK map keyed by personalityId or `_default`. */
  toolSettings?: Record<string, { youtube?: YouTubeToolSetting } | undefined>;
}

/** Same resolution order as `x_search`'s `selectSecretRef`: personality
 *  tools.yaml → global toolSettings[pid] → global toolSettings._default →
 *  the default-named key. */
export function selectYouTubeSecretRef(ctx: ToolContext, opts: CreateYouTubeToolOptions): string {
  const pid = ctx.personalityId;
  const setting =
    (pid ? opts.resolvePersonalitySetting?.(pid) : undefined) ??
    (pid ? opts.toolSettings?.[pid]?.youtube : undefined) ??
    opts.toolSettings?._default?.youtube;
  const name = setting?.secret?.trim();
  return name ? `${SECRET_PREFIX}${name}` : DEFAULT_SECRET_REF;
}

async function readErrorReason(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { errors?: Array<{ reason?: string }> } };
    return body.error?.errors?.[0]?.reason;
  } catch {
    return undefined;
  }
}

/**
 * Shared non-ok mapping for both YouTube tools (plan §6 execute-order rule).
 * YouTube reports `keyInvalid`, `quotaExceeded` and `accessNotConfigured`
 * all as HTTP 403 — only `quotaExceeded` reads as "the key works, quota is
 * spent"; everything else (401, or a 403 with any other/no reason) reads as
 * "this key does not work".
 */
export async function describeYouTubeApiError(response: Response): Promise<ToolResult> {
  if (response.status === 401) {
    return { ok: false, error: NO_KEY_MESSAGE, code: 'not_available' };
  }
  if (response.status === 403) {
    const reason = await readErrorReason(response);
    if (reason === 'quotaExceeded') {
      return { ok: false, error: QUOTA_EXCEEDED_MESSAGE, code: 'execution_failed' };
    }
    return { ok: false, error: NO_KEY_MESSAGE, code: 'not_available' };
  }
  const body = await response.text().catch(() => '');
  return {
    ok: false,
    error: `YouTube API error ${response.status}: ${body}`,
    code: 'execution_failed',
  };
}
