import { parseOsLink } from '../src/auth/deep-link';

// Links the OS hands the app (a notification tap, another app). `connect`
// carries the API key and is NEVER taken from here — `parseOsLink` refuses it
// (D3); only the in-app scanner parses it. Teams are Phase 2, so a task link
// lands on Activity for now.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (!path.startsWith('ethos://')) return path;
  const link = parseOsLink(path);
  if (link?.kind === 'chat') {
    return link.sessionId
      ? `/chat/${encodeURIComponent(link.sessionId)}`
      : `/chat/new?personalityId=${encodeURIComponent(link.personalityId)}`;
  }
  if (link?.kind === 'task') return '/activity';
  return '/';
}
