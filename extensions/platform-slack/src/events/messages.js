// Bridges Slack message + app_mention events to the adapter's
// `messageHandler` callback (which the gateway hooks into via
// `adapter.onMessage()`). All Slack-specific decisions live in
// `routing/triage`; this file just wires Bolt up to it.
import { triageMention, triageMessage } from '../routing/triage';

const BACKFILL_FETCH_LIMIT = 50;
const BACKFILL_INCLUDE_LIMIT = 40;
const BACKFILL_CHAR_LIMIT = 4000;
/** Debounce window (ms) for `message_changed` events. Rapid successive
 *  edits to the same message collapse into a single inbound envelope. */
const EDIT_DEBOUNCE_MS = 200;
async function fetchSlackHistory(client, channelId, threadTs, triggeringTs) {
  try {
    let messages;
    if (threadTs) {
      const res = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: BACKFILL_FETCH_LIMIT,
      });
      messages = res.messages ?? [];
      if (triggeringTs) {
        messages = messages.filter((m) => m.ts !== triggeringTs);
      }
    } else {
      const res = await client.conversations.history({
        channel: channelId,
        limit: BACKFILL_FETCH_LIMIT,
        ...(triggeringTs ? { latest: triggeringTs, inclusive: false } : {}),
      });
      messages = res.messages ?? [];
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
export function registerMessageEvents(app, triage, handlers) {
  /** Pending debounce timers for edited messages, keyed by
   *  `${channelId}:${messageTs}`. */
  const editTimers = new Map();
  app.message(async ({ message }) => {
    const raw = message;
    const triggeringTs = raw.ts;
    // `message_changed` subtype: the actual content lives in `event.message`,
    // not at the top level. We debounce rapid successive edits (200 ms) so
    // the agent doesn't process two envelopes for a quick typo-fix cycle.
    if (raw.subtype === 'message_changed') {
      const rawObj = raw;
      const inner = rawObj.message;
      if (!inner) return;
      // Reject edited bot messages to prevent feedback loops
      if (inner.bot_id || inner.bot_profile) return;
      const channel = rawObj.channel;
      if (!channel) return;
      const ts = inner.ts;
      if (!ts) return;
      const key = `${channel}:${ts}`;
      // Clear any pending timer for the same message — the latest edit wins.
      const existing = editTimers.get(key);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => {
        editTimers.delete(key);
        const syntheticMsg = {
          channel,
          user: inner.user,
          text: inner.text,
          ts,
          thread_ts: inner.thread_ts,
          channel_type: rawObj.channel_type,
          subtype: inner.subtype,
          files: inner.files,
        };
        void triageMessage(syntheticMsg, triage)
          .then((result) => {
            if (result.envelope) {
              handlers.onEnvelope({ ...result.envelope, isEdit: true });
            }
          })
          .catch(() => {
            // Best-effort — matches adapter error policy for normal messages
          });
      }, EDIT_DEBOUNCE_MS);
      editTimers.set(key, timer);
      return;
    }
    const result = await triageMessage(raw, triage);
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
    const triggeringTs = event.ts;
    const result = await triageMention(event, triage);
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
