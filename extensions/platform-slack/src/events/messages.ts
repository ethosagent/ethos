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

const BACKFILL_FETCH_LIMIT = 50;
const BACKFILL_INCLUDE_LIMIT = 40;
const BACKFILL_CHAR_LIMIT = 4000;

async function fetchSlackHistory(
  client: App['client'],
  channelId: string,
  threadTs?: string,
  triggeringTs?: string,
): Promise<string | undefined> {
  try {
    let messages: {
      text?: string;
      user?: string;
      username?: string;
      subtype?: string;
      bot_id?: string;
    }[];
    if (threadTs) {
      const res = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: BACKFILL_FETCH_LIMIT,
      });
      messages = (res.messages ?? []) as typeof messages;
      if (triggeringTs) {
        messages = messages.filter((m) => (m as { ts?: string }).ts !== triggeringTs);
      }
    } else {
      const res = await client.conversations.history({
        channel: channelId,
        limit: BACKFILL_FETCH_LIMIT,
        ...(triggeringTs ? { latest: triggeringTs, inclusive: false } : {}),
      });
      messages = (res.messages ?? []) as typeof messages;
    }

    const lines = messages
      .filter((m) => m.text?.trim() && !m.bot_id && m.subtype !== 'bot_message')
      .reverse()
      .slice(-BACKFILL_INCLUDE_LIMIT)
      .map((m) => `${m.username ?? m.user ?? 'unknown'}: ${m.text?.trim()}`)
      .join('\n');

    if (!lines) return undefined;

    const trimmed =
      lines.length > BACKFILL_CHAR_LIMIT
        ? `[... earlier messages omitted]\n${lines.slice(-BACKFILL_CHAR_LIMIT)}`
        : lines;

    const label = threadTs ? 'thread history' : 'channel history';
    return `[Recent ${label} — before bot joined]\n\n${trimmed}`;
  } catch {
    return undefined;
  }
}

export function registerMessageEvents(
  app: App,
  triage: TriageContext,
  handlers: MessageEventHandlers,
): void {
  app.message(async ({ message }) => {
    const raw = message as MessageEvent;
    const triggeringTs = (raw as unknown as { ts?: string }).ts;
    const result = await triageMessage(raw as unknown as RawSlackMessage, triage);
    if (result.envelope && triage.backfillState) {
      const channelId = result.envelope.chatId;
      const threadTs = result.envelope.threadId;
      if (!triage.backfillState.hasDone(channelId, threadTs)) {
        const priorContext = await fetchSlackHistory(app.client, channelId, threadTs, triggeringTs);
        await triage.backfillState.mark(channelId, threadTs);
        if (priorContext) {
          result.envelope.priorContext = priorContext;
        }
      }
    }
    if (result.envelope) handlers.onEnvelope(result.envelope);
  });

  app.event('app_mention', async ({ event }) => {
    const triggeringTs = (event as unknown as { ts?: string }).ts;
    const result = await triageMention(event as unknown as RawSlackMention, triage);
    if (result.envelope && triage.backfillState) {
      const channelId = result.envelope.chatId;
      const threadTs = result.envelope.threadId;
      if (!triage.backfillState.hasDone(channelId, threadTs)) {
        const priorContext = await fetchSlackHistory(app.client, channelId, threadTs, triggeringTs);
        await triage.backfillState.mark(channelId, threadTs);
        if (priorContext) {
          result.envelope.priorContext = priorContext;
        }
      }
    }
    if (result.envelope) handlers.onEnvelope(result.envelope);
  });
}
