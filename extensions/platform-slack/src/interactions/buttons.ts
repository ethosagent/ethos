// Bolt `block_actions` registrations for the approval, initiative and clarify buttons, moved out of
// `SlackAdapter.start` (size gate; no behaviour change except the new `init:` route). Each handler
// is read through a getter, so a click with no handler wired is a harmless no-op.

import type { ApprovalDecisionEvent } from '@ethosagent/types';
import type { App } from '@slack/bolt';
import { APPROVE_ACTION_ID, DENY_ACTION_ID } from '../blocks/approval';
import {
  CLARIFY_ANSWER_ACTION_ID,
  CLARIFY_CANCEL_ACTION_ID,
  CLARIFY_CHOICE_ACTION_ID,
} from '../blocks/clarify';
import { type ApprovalActionPayload, handleApprovalAction } from './actions';
import { type ClarifyActionEvent, type ClarifyActionPayload, handleClarifyAction } from './clarify';
import { type InitiativeActionEvent, toInitiativeAction } from './initiative';

export interface ButtonHandlers {
  approval(): ((event: ApprovalDecisionEvent) => void) | undefined;
  clarify(): ((event: ClarifyActionEvent) => void) | undefined;
  initiative(): ((event: InitiativeActionEvent) => void | Promise<void>) | undefined;
}

export function registerButtonActions(app: App, client: App['client'], h: ButtonHandlers): void {
  // Approval-card button clicks. Bolt delivers `block_actions` events here;
  // we parse the raw payload down to the fields `handleApprovalAction`
  // needs and let it route to the coordinator's decision handler. Registered
  // unconditionally — a click with no handler wired is a harmless no-op.
  //
  // Slack is the one thing we don't control: a malformed payload or Bolt
  // API drift must not throw inside the event loop. We defensively probe
  // the shape before dereferencing, ack when we can, and bail otherwise.
  const onApprovalButton = async (raw: unknown): Promise<void> => {
    const evt = (raw ?? {}) as {
      ack?: unknown;
      body?: { user?: { id?: string }; channel?: { id?: string }; message?: { ts?: string } };
      action?: { action_id?: string; value?: string };
    };
    if (typeof evt.ack === 'function') {
      // `ack()` is the one call we can't reason about — a Bolt/Slack API
      // change could make it throw synchronously, not just reject. Wrap the
      // invocation itself, not only the returned promise, so a bad ack can
      // never escape this handler and poison Bolt's event loop.
      try {
        await (evt.ack as () => Promise<void>)();
      } catch {
        // best-effort ack — proceed with the decision regardless
      }
    }
    const handler = h.approval();
    if (!handler) return;
    const body = evt.body;
    const action = evt.action;
    if (typeof body !== 'object' || body === null || typeof action !== 'object' || action === null)
      return;
    const payload: ApprovalActionPayload = {
      actionId: action.action_id ?? '',
      approvalId: action.value ?? '',
      userId: body.user?.id ?? '',
      channelId: body.channel?.id ?? '',
      messageTs: body.message?.ts ?? '',
    };
    await handleApprovalAction(payload, { onDecision: async (event) => handler(event) });
  };
  app.action(APPROVE_ACTION_ID, onApprovalButton);
  app.action(DENY_ACTION_ID, onApprovalButton);
  // Initiative digest / brief buttons: `action_id` is `init:<verb>:<target>`. Same defensive
  // shape as the approval handler; whose tap counts is the wiring's call, not the adapter's.
  app.action(/^init:/, async (raw: unknown): Promise<void> => {
    const evt = (raw ?? {}) as {
      ack?: unknown;
      body?: { user?: { id?: string }; channel?: { id?: string }; message?: { ts?: string } };
      action?: { action_id?: string };
    };
    if (typeof evt.ack === 'function') {
      try {
        await (evt.ack as () => Promise<void>)();
      } catch {
        // best-effort ack — proceed regardless
      }
    }
    const handler = h.initiative();
    const body = evt.body;
    if (!handler || typeof body !== 'object' || body === null) return;
    const channelId = body.channel?.id ?? '';
    const userId = body.user?.id ?? '';
    const event = toInitiativeAction(
      {
        actionId: evt.action?.action_id ?? '',
        userId,
        channelId,
        messageTs: body.message?.ts ?? '',
      },
      async (text) => {
        if (!channelId) return false;
        try {
          await client.chat.postEphemeral({ channel: channelId, user: userId, text });
          return true;
        } catch {
          return false;
        }
      },
    );
    if (!event) return;
    try {
      await handler(event);
    } catch {
      // A failing handler must not poison Bolt's event loop.
    }
  });

  // Clarify-card button clicks. Bolt delivers `block_actions` events here
  // for the choice/cancel/answer buttons; we narrow the raw payload to
  // `ClarifyActionPayload` and let the pure handler route it. Same shape as
  // the approval handler — defensively probe the payload before dereferencing
  // and ack as the very first thing.
  const onClarifyButton = async (raw: unknown): Promise<void> => {
    const evt = (raw ?? {}) as {
      ack?: unknown;
      body?: {
        user?: { id?: string };
        channel?: { id?: string };
        message?: { ts?: string };
        trigger_id?: string;
        /** Present for App Home / modal-triggered block_actions; absent for
         *  channel-message clicks. We use it to detect the Home tab path. */
        view?: { type?: string };
      };
      action?: { action_id?: string; value?: string };
    };
    if (typeof evt.ack === 'function') {
      try {
        await (evt.ack as () => Promise<void>)();
      } catch {
        // best-effort ack — proceed regardless
      }
    }
    const handler = h.clarify();
    if (!handler) return;
    const body = evt.body;
    const action = evt.action;
    if (typeof body !== 'object' || body === null || typeof action !== 'object' || action === null)
      return;
    // App Home payloads omit `body.channel` and `body.message` entirely
    // (the click happened on a view, not a channel message). Detect this
    // so the surface can relax its channel/messageTs cross-tenant gate
    // for Home — a Home view is per-user, so cross-message replay isn't
    // a risk; the gate's purpose doesn't apply.
    const fromHome = body.view?.type === 'home' || !body.channel;
    const payload: ClarifyActionPayload = {
      actionId: action.action_id ?? '',
      value: action.value ?? '',
      userId: body.user?.id ?? '',
      channelId: body.channel?.id ?? '',
      messageTs: body.message?.ts ?? '',
      triggerId: body.trigger_id ?? '',
      fromHome,
    };
    await handleClarifyAction(payload, { onAction: async (e) => handler(e) });
  };
  app.action(CLARIFY_CHOICE_ACTION_ID, onClarifyButton);
  app.action(CLARIFY_CANCEL_ACTION_ID, onClarifyButton);
  app.action(CLARIFY_ANSWER_ACTION_ID, onClarifyButton);
}
