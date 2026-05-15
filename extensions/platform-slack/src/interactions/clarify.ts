// Pure interaction handlers for the clarify card's button clicks and modal
// submission. Mirrors `interactions/actions.ts` (the approval handler): the
// Bolt adapter parses the raw `block_actions` / `view_submission` payload
// into the typed shapes here and hands them off; this module decides
// whether the click is one we own and, if so, invokes the response callback.
// Decoupling Bolt from routing keeps the logic unit-testable.

import {
  CLARIFY_ANSWER_ACTION_ID,
  CLARIFY_CANCEL_ACTION_ID,
  CLARIFY_CHOICE_ACTION_ID,
  CLARIFY_MODAL_CALLBACK_ID,
  CLARIFY_MODAL_INPUT_ACTION_ID,
  CLARIFY_MODAL_INPUT_BLOCK_ID,
} from '../blocks/clarify';

/** Fields the adapter extracts from a Bolt `block_actions` payload. */
export interface ClarifyActionPayload {
  /** `action_id` of the clicked button. */
  actionId: string;
  /** `value` carried by the button — `<requestId>` or `<requestId>:<idx>`. */
  value: string;
  /** Slack user id of whoever clicked. */
  userId: string;
  /** Channel the clarify card lives in. Empty for App Home clicks
   *  (Home payloads don't carry channel/message — the click happened on a
   *  view, not a channel message). */
  channelId: string;
  /** `ts` of the card message — used for the in-place `chat.update`. Empty
   *  for App Home clicks for the same reason. */
  messageTs: string;
  /** Slack `trigger_id` — required for `views.open` (modal). */
  triggerId: string;
  /** True iff this click came from the App Home tab (Slack delivers a
   *  block_actions payload with no `body.channel` and a `body.view` of type
   *  `home`). The surface uses this to relax the channel/messageTs cross-
   *  tenant gate — Home clicks are intrinsically scoped to the user's view,
   *  so the gate's value (preventing cross-message replay) doesn't apply. */
  fromHome: boolean;
}

/** The decision the handler forwards once it's parsed a valid click. */
export type ClarifyActionEvent =
  | {
      kind: 'choice';
      requestId: string;
      choiceIndex: number;
      userId: string;
      channelId: string;
      messageTs: string;
      /** True iff the click originated in the App Home tab. */
      fromHome: boolean;
    }
  | {
      kind: 'cancel';
      requestId: string;
      userId: string;
      channelId: string;
      messageTs: string;
      fromHome: boolean;
    }
  | {
      kind: 'open-modal';
      requestId: string;
      userId: string;
      channelId: string;
      messageTs: string;
      triggerId: string;
      fromHome: boolean;
    };

export interface ClarifyActionHandlers {
  onAction: (event: ClarifyActionEvent) => Promise<void>;
}

/**
 * Route a clarify button click. Silently ignores `action_id`s we don't own,
 * payloads with no userId (anonymous click can't resolve a clarify), and
 * malformed `value` strings. Callback errors are swallowed so a stale row
 * doesn't crash Bolt's event loop.
 */
export async function handleClarifyAction(
  payload: ClarifyActionPayload,
  handlers: ClarifyActionHandlers,
): Promise<void> {
  if (!payload.userId) return;

  if (payload.actionId === CLARIFY_CHOICE_ACTION_ID) {
    const parts = payload.value.split(':');
    if (parts.length !== 2) return;
    const requestId = parts[0];
    const idxStr = parts[1];
    if (!requestId || idxStr === undefined) return;
    const idx = Number(idxStr);
    if (!Number.isInteger(idx) || idx < 0) return;
    try {
      await handlers.onAction({
        kind: 'choice',
        requestId,
        choiceIndex: idx,
        userId: payload.userId,
        channelId: payload.channelId,
        messageTs: payload.messageTs,
        fromHome: payload.fromHome,
      });
    } catch {
      // stale / already-resolved
    }
    return;
  }

  if (payload.actionId === CLARIFY_CANCEL_ACTION_ID) {
    if (!payload.value) return;
    try {
      await handlers.onAction({
        kind: 'cancel',
        requestId: payload.value,
        userId: payload.userId,
        channelId: payload.channelId,
        messageTs: payload.messageTs,
        fromHome: payload.fromHome,
      });
    } catch {
      // stale / already-resolved
    }
    return;
  }

  if (payload.actionId === CLARIFY_ANSWER_ACTION_ID) {
    if (!payload.value || !payload.triggerId) return;
    try {
      await handlers.onAction({
        kind: 'open-modal',
        requestId: payload.value,
        userId: payload.userId,
        channelId: payload.channelId,
        messageTs: payload.messageTs,
        triggerId: payload.triggerId,
        fromHome: payload.fromHome,
      });
    } catch {
      // best-effort — opening the modal can fail for many reasons
    }
  }
}

// ---------------------------------------------------------------------------
// view_submission (free-form modal)
// ---------------------------------------------------------------------------

/** Fields the adapter extracts from a Bolt `view_submission` payload. */
export interface ClarifyModalSubmissionPayload {
  callbackId: string;
  /** Modal `private_metadata` — JSON `{requestId}` set by `clarifyModalView`. */
  privateMetadata: string;
  /** Slack user id of whoever submitted. */
  userId: string;
  /** The full `view.state.values` object. We only read the one input we own. */
  values: Record<string, Record<string, { value?: string }>>;
}

export interface ClarifyModalSubmissionEvent {
  requestId: string;
  answer: string;
  userId: string;
}

export interface ClarifyModalSubmissionHandlers {
  onSubmit: (event: ClarifyModalSubmissionEvent) => Promise<void>;
}

/** Route a modal submission. Returns silently for callback ids we don't own,
 *  malformed metadata, missing input, or an empty answer. */
export async function handleClarifyModalSubmission(
  payload: ClarifyModalSubmissionPayload,
  handlers: ClarifyModalSubmissionHandlers,
): Promise<void> {
  if (payload.callbackId !== CLARIFY_MODAL_CALLBACK_ID) return;
  if (!payload.userId) return;
  let requestId: string;
  try {
    const parsed = JSON.parse(payload.privateMetadata) as { requestId?: unknown };
    if (typeof parsed.requestId !== 'string' || parsed.requestId.length === 0) return;
    requestId = parsed.requestId;
  } catch {
    return;
  }
  const answer =
    payload.values[CLARIFY_MODAL_INPUT_BLOCK_ID]?.[CLARIFY_MODAL_INPUT_ACTION_ID]?.value;
  if (typeof answer !== 'string' || answer.trim().length === 0) return;
  try {
    await handlers.onSubmit({ requestId, answer: answer.trim(), userId: payload.userId });
  } catch {
    // stale / already-resolved
  }
}
