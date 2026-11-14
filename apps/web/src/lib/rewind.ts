import type { ChatMessage } from './chat-reducer';

/** A local id is the `user-<ms>` minted in `useChat.sendMessage`; the server has never seen it. */
export function isLocalUserMessageId(id: string): boolean {
  return /^user-\d+$/.test(id);
}

/** The bubbles the server counts as prompts: user turns that are neither steers nor failed sends. */
function isPrompt(m: ChatMessage): boolean {
  return m.role === 'user' && !m.isSteer && m.status !== 'failed';
}

/**
 * Exact id when persisted; else prompts back from the latest over non-steer,
 * non-failed user bubbles. null if the bubble is not a rewindable prompt.
 */
export function rewindTargetFor(
  messages: readonly ChatMessage[],
  messageId: string,
): { messageId: string } | { turnsBack: number } | null {
  const at = messages.findIndex((m) => m.id === messageId);
  const found = messages[at];
  if (!found || !isPrompt(found)) return null;
  if (!isLocalUserMessageId(messageId)) return { messageId };
  let turnsBack = 0;
  for (let i = messages.length - 1; i >= at; i--) {
    const m = messages[i];
    if (m && isPrompt(m)) turnsBack += 1;
  }
  return { turnsBack };
}
