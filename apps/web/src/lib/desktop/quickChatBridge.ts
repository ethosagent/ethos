// W3 (ux-feedback plan) — the QuickChat window's one main-process call: ask
// Electron to raise an OS notification for a reply that finished while the
// window was hidden. The preload exposes it as `window.ethos.quickChat`
// (apps/desktop/src/main/preload.ts); `EthosDesktopBridge` in web-contracts
// does not carry the key yet, so it is reached through a structural runtime
// check rather than a cast on the bridge type.

export interface QuickChatDoneNotice {
  /** Session to open when the notification is clicked (`navigate:session`). */
  sessionId: string | null;
  title: string;
  body: string;
}

interface QuickChatApi {
  notifyDone: (notice: QuickChatDoneNotice) => void;
}

function quickChatApi(): QuickChatApi | null {
  if (typeof window === 'undefined') return null;
  const holder: unknown = window.ethos;
  if (typeof holder !== 'object' || holder === null || !('quickChat' in holder)) return null;
  const candidate: unknown = (holder as Record<string, unknown>).quickChat;
  if (typeof candidate !== 'object' || candidate === null || !('notifyDone' in candidate)) {
    return null;
  }
  const notifyDone: unknown = (candidate as Record<string, unknown>).notifyDone;
  if (typeof notifyDone !== 'function') return null;
  return { notifyDone: (notice) => notifyDone(notice) };
}

/**
 * Fire-and-forget: true when the desktop bridge took the notice, false in a
 * plain browser (or an older preload) — the caller simply does nothing then.
 */
export function notifyQuickChatDone(notice: QuickChatDoneNotice): boolean {
  const api = quickChatApi();
  if (!api) return false;
  api.notifyDone(notice);
  return true;
}
