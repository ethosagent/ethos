import type { ChatMessage } from './chat-reducer';

// A3 (ux-feedback plan) — what the error banner's Retry can honestly re-send.
//
// A turn error arrives AFTER `chat.send` succeeded, so the original request is
// gone: the user bubble in `state.messages` keeps render-only attachment
// metadata (`MessageAttachment`, no base64 — see `lib/attachments.ts`), never
// the bytes. Re-sending the text alone would silently degrade a question that
// carried attachments, so that case returns `null` and the caller hides Retry
// instead. Pinned by `__tests__/chat-retry.test.ts`.
export function retryTurnText(messages: readonly ChatMessage[]): string | null {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser?.role !== 'user') return null;
  if (lastUser.attachments && lastUser.attachments.length > 0) return null;
  return lastUser.content;
}
