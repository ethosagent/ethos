// Initiative digest / brief button taps. The adapter parses the raw `block_actions` payload with
// `parseInitiativeAction` and hands the result to the host's initiative wiring, which owns the
// owner check and the decision. The adapter enforces nothing: a tap with no handler is a no-op.

import { type InitiativeActionVerb, parseInitiativeAction } from '@ethosagent/types';

export interface InitiativeActionEvent {
  verb: InitiativeActionVerb;
  /** A ledger id parsed from the button's action id. */
  target: string;
  /** Slack user id of whoever clicked. The wiring compares it to `channel_filter.slack.ownerUserId`. */
  userId: string;
  channelId: string;
  messageTs: string;
  /** A message only the tapping user sees (the result, the brief as Markdown, the chat hand-off). */
  /** Resolves true when the message was posted, false when it was not. */
  reply: (text: string) => Promise<boolean>;
}

/** The raw fields the adapter pulls from a Bolt `block_actions`. */
export interface InitiativeActionPayload {
  actionId: string;
  userId: string;
  channelId: string;
  messageTs: string;
}

/** Null for a payload that is not a well-formed initiative action or has no identifiable user. */
export function toInitiativeAction(
  p: InitiativeActionPayload,
  reply: (text: string) => Promise<boolean>,
): InitiativeActionEvent | null {
  const parsed = parseInitiativeAction(p.actionId);
  if (!parsed || !p.userId) return null;
  return {
    verb: parsed.verb,
    target: parsed.target,
    userId: p.userId,
    channelId: p.channelId,
    messageTs: p.messageTs,
    reply,
  };
}
