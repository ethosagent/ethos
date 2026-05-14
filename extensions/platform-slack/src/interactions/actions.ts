// Pure interaction handler for the approval card's Allow / Deny buttons.
// The Bolt adapter registers `app.action(...)` listeners that parse the raw
// `block_actions` payload down to `ApprovalActionPayload` and hand it here;
// this module decides whether the click is one we own and, if so, invokes
// the decision callback. Decoupling Bolt from the routing logic keeps it
// unit-testable without standing up a real Slack app — same pattern as
// `commands/index.ts`.

import { APPROVE_ACTION_ID, DENY_ACTION_ID } from '../blocks/approval';

/** The interaction fields the adapter extracts from a Bolt `block_actions`. */
export interface ApprovalActionPayload {
  /** `action_id` of the clicked button. */
  actionId: string;
  /** `value` carried by the button — the pending approval id. */
  approvalId: string;
  /** Slack user id of whoever clicked. */
  userId: string;
  /** Channel the approval card lives in. */
  channelId: string;
  /** `ts` of the approval card message — used for the in-place `chat.update`. */
  messageTs: string;
}

/** The decision the handler forwards once it's parsed a valid click. */
export interface ApprovalDecisionEvent {
  approvalId: string;
  decision: 'allow' | 'deny';
  decidedBy: string;
  channelId: string;
  messageTs: string;
}

export interface ApprovalActionHandlers {
  onDecision: (event: ApprovalDecisionEvent) => Promise<void>;
}

/**
 * Route an approval button click. Returns silently for action ids we don't
 * own, clicks missing an `approvalId` (a malformed or stale payload), or
 * clicks with no identifiable user — authorization fails closed, an
 * anonymous click must never resolve a dangerous tool approval.
 * Callback errors are swallowed: a click on an already-resolved approval is
 * expected (another tab / surface beat this one) and must never crash the
 * adapter's interaction loop.
 */
export async function handleApprovalAction(
  payload: ApprovalActionPayload,
  handlers: ApprovalActionHandlers,
): Promise<void> {
  let decision: 'allow' | 'deny';
  if (payload.actionId === APPROVE_ACTION_ID) decision = 'allow';
  else if (payload.actionId === DENY_ACTION_ID) decision = 'deny';
  else return;

  if (!payload.approvalId) return;
  if (!payload.userId) return;

  try {
    await handlers.onDecision({
      approvalId: payload.approvalId,
      decision,
      decidedBy: payload.userId,
      channelId: payload.channelId,
      messageTs: payload.messageTs,
    });
  } catch {
    // Stale / already-resolved approval — expected, not exceptional.
  }
}
