// ---------------------------------------------------------------------------
// parseYouTubeVideoId — extracts the 11-character video id from any of the
// forms an agent is likely to hand `youtube_comments`. Shaped after
// `parseRedditPostId` (extensions/tools-reddit/src/thread.ts): trimmed input,
// ordered regex attempts, `null` on no match. See plan §5.2.
// ---------------------------------------------------------------------------

const BARE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOST = /^(?:www\.|m\.)?youtube\.com$/i;

/**
 * Accepts, in order: a bare 11-character id; `watch?v=<id>` on any
 * youtube.com host (including `m.` and `www.`); `youtu.be/<id>`;
 * `/shorts/<id>`; `/live/<id>`; `/embed/<id>`. Query strings, fragments and
 * trailing path segments after the id are ignored. Returns `null` for
 * anything else — a playlist-only URL, a channel URL, an empty string, or a
 * `watch` URL with no `v`.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (BARE_ID.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && BARE_ID.test(id) ? id : null;
  }

  if (!YOUTUBE_HOST.test(host)) return null;

  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v');
    return id && BARE_ID.test(id) ? id : null;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const [first, second] = segments;
  if ((first === 'shorts' || first === 'live' || first === 'embed') && second) {
    return BARE_ID.test(second) ? second : null;
  }

  return null;
}
