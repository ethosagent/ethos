// Bridges Slack message + app_mention events to the adapter's
// `messageHandler` callback (which the gateway hooks into via
// `adapter.onMessage()`). All Slack-specific decisions live in
// `routing/triage`; this file just wires Bolt up to it.

import type { InboundMessage } from '@ethosagent/types';
import type { App, MessageEvent } from '@slack/bolt';
import {
  type RawSlackMention,
  type RawSlackMessage,
  type TriageContext,
  triageMention,
  triageMessage,
} from '../routing/triage';

export interface MessageEventHandlers {
  onEnvelope(message: InboundMessage): void;
}

export function registerMessageEvents(
  app: App,
  triage: TriageContext,
  handlers: MessageEventHandlers,
): void {
  app.message(async ({ message }) => {
    const raw = message as MessageEvent;
    const result = await triageMessage(raw as unknown as RawSlackMessage, triage);
    if (result.envelope) handlers.onEnvelope(result.envelope);
  });

  app.event('app_mention', async ({ event }) => {
    const result = await triageMention(event as unknown as RawSlackMention, triage);
    if (result.envelope) handlers.onEnvelope(result.envelope);
  });
}
