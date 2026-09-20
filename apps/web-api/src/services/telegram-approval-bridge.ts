import type {
  ApprovalCapableAdapter,
  ApprovalDecisionEvent,
  DeliveryResult,
} from '@ethosagent/types';
import type { ApprovalsService } from './approvals.service';

// Telegram approval bridge (plan mobile-app S10). An approval raised on a
// web-api loop is also posted to the operator's bound Telegram chat with
// Approve/Deny buttons; a tap there decides it through the same
// `ApprovalsService` the web panel uses, and a decision made anywhere else
// (web, phone, timeout, shutdown) edits the Telegram message to its outcome.
// First decision wins: `ApprovalsService.take()` refuses a second decision on
// an id, and a refused tap is caught here.
//
// IN-PROCESS ONLY. The bridge needs a live Telegram adapter in the same
// process as the web API, which is `ethos boot` (apps/ethos/src/commands/boot.ts).
// Under `ethos serve` + `ethos gateway` the gateway process owns the bot's
// update polling, so a tap could never reach this service; that pairing gets
// no Telegram copy (the `cross-process-approval-bus` follow-up).

/** The slice of `ApprovalsService` the bridge drives. */
export type BridgedApprovals = Pick<
  ApprovalsService,
  'onPending' | 'onResolved' | 'approve' | 'deny'
>;

/** The Telegram adapter's approval card post plus its plain-text edit, which
 *  lets the resolved message read as its outcome rather than "Approved by @x". */
export type TelegramApprovalSurface = Pick<ApprovalCapableAdapter, 'postApprovalCard'> & {
  editToPlainText(chatId: string, messageId: string, text: string): Promise<DeliveryResult>;
};

export function isTelegramApprovalSurface(adapter: unknown): adapter is TelegramApprovalSurface {
  const a = adapter as Partial<TelegramApprovalSurface> | null;
  return typeof a?.postApprovalCard === 'function' && typeof a.editToPlainText === 'function';
}

export interface TelegramApprovalBridgeOptions {
  approvals: BridgedApprovals;
  /** The operator's bound chat — `channel_filter.telegram.ownerUserId` (a
   *  Telegram DM's chat id is the user's id). Undefined → nothing is posted. */
  ownerChatId: () => string | undefined;
  /** A live Telegram adapter in this process, if any. */
  adapter: () => TelegramApprovalSurface | undefined;
}

/** Mirrors `SYSTEM_DECIDER` in approvals.service.ts (timeout and shutdown). */
const SYSTEM_DECIDER = '__ethos_system__';

interface PostedCard {
  adapter: TelegramApprovalSurface;
  chatId: string;
  messageId: string;
  toolName: string;
}

export function createTelegramApprovalBridge(opts: TelegramApprovalBridgeOptions): {
  /** Handle an Approve/Deny tap. Ids this bridge did not post are ignored, so
   *  the adapter's one decision slot can forward every tap here. */
  decide: (event: ApprovalDecisionEvent) => void;
} {
  const posted = new Map<string, PostedCard>();
  // A decision that lands while the card is still being posted — applied the
  // moment the post returns, so no card is left with live buttons.
  const posting = new Map<string, { outcome?: string }>();

  const edit = (card: PostedCard, outcome: string): void => {
    void card.adapter
      .editToPlainText(card.chatId, card.messageId, `Tool approval: ${card.toolName}\n${outcome}`)
      .catch(() => {});
  };

  opts.approvals.onPending((_sessionId, request) => {
    const chatId = opts.ownerChatId();
    const adapter = opts.adapter();
    if (!chatId || !adapter) return;
    const slot: { outcome?: string } = {};
    posting.set(request.approvalId, slot);
    void adapter
      .postApprovalCard({
        chatId,
        approvalId: request.approvalId,
        toolName: request.toolName,
        reason: request.reason,
        args: request.args,
      })
      .then((result) => {
        // A failed post costs a Telegram convenience only: the web panel still
        // holds the approval and the service's timeout is the backstop.
        if ('error' in result) return;
        const card = { adapter, chatId, messageId: result.messageTs, toolName: request.toolName };
        if (slot.outcome) edit(card, slot.outcome);
        else posted.set(request.approvalId, card);
      })
      .catch(() => {})
      .finally(() => posting.delete(request.approvalId));
  });

  opts.approvals.onResolved((_sessionId, approvalId, decision, decidedBy) => {
    const outcome =
      decision === 'allow'
        ? '✓ allowed'
        : decidedBy === SYSTEM_DECIDER
          ? '✗ auto-denied'
          : '✗ denied';
    const card = posted.get(approvalId);
    if (card) {
      posted.delete(approvalId);
      edit(card, outcome);
      return;
    }
    const slot = posting.get(approvalId);
    if (slot) slot.outcome = outcome;
  });

  return {
    decide: (event) => {
      const card = posted.get(event.approvalId);
      // Only a button this bridge posted, tapped in the owner's own chat.
      if (!card || event.channelId !== card.chatId || event.messageTs !== card.messageId) return;
      const actor = `human:telegram:${event.decidedByDisplay ?? event.decidedBy}`;
      const decided =
        event.decision === 'allow'
          ? opts.approvals.approve(event.approvalId, 'once', actor)
          : opts.approvals.deny(event.approvalId, undefined, actor);
      // `onResolved` edits the card on success. A refusal means the approval
      // settled without an event (`cancelForSession` emits none), so retire it here.
      void decided.catch(() => {
        posted.delete(event.approvalId);
        edit(card, 'no longer pending');
      });
    },
  };
}
