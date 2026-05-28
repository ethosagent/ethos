// Pure interaction parser for Discord clarify components. The adapter
// extracts the typed payload from `interactionCreate` and hands it here;
// this module decides whether the click/submission is one we own and routes
// it. Mirrors the Slack `interactions/clarify.ts`.
import {
  CLARIFY_ANSWER_KIND,
  CLARIFY_BUTTON_PREFIX,
  CLARIFY_CANCEL_KIND,
  CLARIFY_CHOICE_KIND,
  CLARIFY_MODAL_INPUT_ID,
  CLARIFY_MODAL_KIND,
} from './clarify-blocks';
/** Route a button click to a typed event. Returns silently for non-clarify
 *  custom_ids, anonymous clicks, malformed payloads, or out-of-range indices. */
export async function handleClarifyButton(payload, handlers) {
  if (!payload.userId) return;
  const parts = payload.customId.split(':');
  if (parts.length < 3) return;
  if (parts[0] !== CLARIFY_BUTTON_PREFIX) return;
  const kind = parts[1];
  const requestId = parts[2];
  if (!requestId) return;
  if (kind === CLARIFY_CHOICE_KIND) {
    if (parts.length !== 4) return;
    const idxStr = parts[3];
    if (idxStr === undefined) return;
    const idx = Number(idxStr);
    if (!Number.isInteger(idx) || idx < 0) return;
    try {
      await handlers.onEvent({
        kind: 'choice',
        requestId,
        choiceIndex: idx,
        userId: payload.userId,
        channelId: payload.channelId,
        messageId: payload.messageId,
      });
    } catch {
      // stale / already-resolved
    }
    return;
  }
  if (kind === CLARIFY_CANCEL_KIND) {
    try {
      await handlers.onEvent({
        kind: 'cancel',
        requestId,
        userId: payload.userId,
        channelId: payload.channelId,
        messageId: payload.messageId,
      });
    } catch {
      // stale / already-resolved
    }
    return;
  }
  if (kind === CLARIFY_ANSWER_KIND) {
    try {
      await handlers.onEvent({
        kind: 'open-modal',
        requestId,
        userId: payload.userId,
        channelId: payload.channelId,
        messageId: payload.messageId,
      });
    } catch {
      // best-effort modal open
    }
  }
}
/** Route a modal submission. Drops payloads we don't own and empty answers. */
export async function handleClarifyModal(payload, handlers) {
  if (!payload.userId) return;
  const parts = payload.customId.split(':');
  if (parts.length !== 3) return;
  if (parts[0] !== CLARIFY_BUTTON_PREFIX || parts[1] !== CLARIFY_MODAL_KIND) return;
  const requestId = parts[2];
  if (!requestId) return;
  if (payload.answer.length === 0) return;
  try {
    await handlers.onEvent({
      kind: 'modal-submit',
      requestId,
      answer: payload.answer,
      userId: payload.userId,
      channelId: payload.channelId,
    });
  } catch {
    // stale / already-resolved
  }
}
/** Convenience constants re-exported for the adapter so it doesn't need to
 *  import from clarify-blocks just for the modal input id. */
export { CLARIFY_MODAL_INPUT_ID };
