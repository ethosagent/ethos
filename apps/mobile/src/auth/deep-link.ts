import { normalizeRemoteUrl } from '@ethosagent/sdk';

export type DeepLink =
  | { kind: 'connect'; url: string; key: string }
  | { kind: 'chat'; personalityId: string; sessionId?: string }
  | { kind: 'task'; team: string; taskId: string };

/** Parse any `ethos://` link. Returns null for anything malformed. */
export function parseDeepLink(raw: string): DeepLink | null {
  if (!raw.startsWith('ethos://')) return null;
  const rest = raw.slice(8);
  const qIdx = rest.indexOf('?');
  const path = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const params = new URLSearchParams(qIdx === -1 ? '' : rest.slice(qIdx + 1));
  if (path === 'connect') {
    const url = params.get('url');
    const key = params.get('key');
    if (!url || !key?.startsWith('sk-ethos-')) return null;
    const normalized = normalizeRemoteUrl(url);
    if (!normalized) return null;
    return { kind: 'connect', url: normalized, key };
  }
  const segs = path.split('/');
  try {
    if (segs[0] === 'p' && segs.length === 3 && segs[1] && segs[2] === 'chat') {
      const personalityId = decodeURIComponent(segs[1]);
      const session = params.get('session');
      return session
        ? { kind: 'chat', personalityId, sessionId: session }
        : { kind: 'chat', personalityId };
    }
    if (segs[0] === 't' && segs.length === 4 && segs[1] && segs[2] === 'task' && segs[3]) {
      return {
        kind: 'task',
        team: decodeURIComponent(segs[1]),
        taskId: decodeURIComponent(segs[3]),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The OS URL dispatcher's entry point. Custom schemes are first-come on iOS —
 * any installed app may claim `ethos://` — so a `connect` link (it carries the
 * API key) is refused here; only the in-app QR scanner hands a string to
 * `parseDeepLink` directly.
 */
export function parseOsLink(raw: string): DeepLink | null {
  const link = parseDeepLink(raw);
  return link?.kind === 'connect' ? null : link;
}
