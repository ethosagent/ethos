// Pure interaction handler for the approval card's Allow / Deny buttons.
// The Bolt adapter registers `app.action(...)` listeners that parse the raw
// `block_actions` payload down to `ApprovalActionPayload` and hand it here;
// this module decides whether the click is one we own and, if so, invokes
// the decision callback. Decoupling Bolt from the routing logic keeps it
// unit-testable without standing up a real Slack app — same pattern as
// `commands/index.ts`.

import type { ApprovalDecisionEvent } from '@ethosagent/types';
import {
  APPROVAL_NOTE_BLOCK_ID,
  APPROVAL_NOTE_CALLBACK_ID,
  APPROVAL_NOTE_INPUT_ID,
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
} from '../blocks/approval';

export type { ApprovalDecisionEvent } from '@ethosagent/types';

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

export interface ApprovalNoteSubmissionPayload {
  callbackId: string;
  /** JSON `{ approvalId, channelId, messageTs }` set by `approvalNoteModal`. */
  privateMetadata: string;
  userId: string;
  values: Record<string, Record<string, { value?: string }>>;
}

function parseNoteMetadata(
  raw: string,
): { approvalId: string; channelId: string; messageTs: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // tampered or missing metadata: ignore the submission
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { approvalId, channelId, messageTs } = parsed as Record<string, unknown>;
  if (typeof approvalId !== 'string' || !approvalId) return null;
  if (typeof channelId !== 'string' || typeof messageTs !== 'string') return null;
  return { approvalId, channelId, messageTs };
}

/**
 * Route a note-modal submission as a deny carrying the note. Authorization is
 * NOT decided here: the coordinator drops a decision from anyone but the bound
 * approver (`ApprovalCoordinator.settle`, pinned by the gateway test
 * "a bystander's deny-with-note neither settles nor leaks its note"). A stale
 * approval (settled or timed out while the modal was open) makes the handler
 * throw or no-op; that is swallowed.
 */
export async function handleApprovalNoteSubmission(
  payload: ApprovalNoteSubmissionPayload,
  handlers: ApprovalActionHandlers,
): Promise<void> {
  if (payload.callbackId !== APPROVAL_NOTE_CALLBACK_ID) return;
  if (!payload.userId) return;
  const meta = parseNoteMetadata(payload.privateMetadata);
  if (!meta) return;
  const note = payload.values[APPROVAL_NOTE_BLOCK_ID]?.[APPROVAL_NOTE_INPUT_ID]?.value ?? '';
  try {
    await handlers.onDecision({
      approvalId: meta.approvalId,
      decision: 'deny',
      decidedBy: payload.userId,
      channelId: meta.channelId,
      messageTs: meta.messageTs,
      note,
    });
  } catch {
    // Stale / already-resolved approval — expected, not exceptional.
  }
}
