// `SlackAdapter` — implements the `PlatformAdapter` contract by wiring
// `@slack/bolt`'s Socket Mode app to the gateway. The class is intentionally
// thin: it owns the Bolt lifecycle and the inbound→outbound plumbing.
// Triage, channel-mode, slash commands, and Block Kit rendering live in
// sibling modules.
import { join } from 'node:path';
import { deriveBotKey } from '@ethosagent/core';
import { noopLogger } from '@ethosagent/logger';
import boltPkg from '@slack/bolt';
import {
  APPROVE_ACTION_ID,
  approvalPendingBlocks,
  approvalResolvedBlocks,
  DENY_ACTION_ID,
} from './blocks/approval';
import {
  CLARIFY_ANSWER_ACTION_ID,
  CLARIFY_CANCEL_ACTION_ID,
  CLARIFY_CHOICE_ACTION_ID,
  CLARIFY_MODAL_CALLBACK_ID,
} from './blocks/clarify';
import { plaintextFallback } from './blocks/shared';
import { chunkText, reflowChunks } from './chunking';
import { dispatch as dispatchSlash } from './commands';
import { DEFAULT_CHANNEL_MODE } from './config';
import { registerLinkEvents } from './events/links';
import { registerMemberEvents } from './events/members';
import { registerMessageEvents } from './events/messages';
import { toNativeMarkdown } from './format';
import { registerHomeEvents } from './home/handlers';
import { handleApprovalAction } from './interactions/actions';
import { handleClarifyAction, handleClarifyModalSubmission } from './interactions/clarify';
import { resolveChannelMode } from './routing/triage';
import { BackfillStateStore } from './store/backfill-state';
import { ChannelOverrideStore } from './store/channel-overrides';
import { ThreadStateStore } from './store/thread-state';

const { App } = boltPkg;
/**
 * Normalize a configured `webUiBaseUrl`. The value is interpolated directly
 * into Slack mrkdwn link syntax (`<url|text>`) in `blocks/session.ts`, so a
 * bad value containing `>` or `|` would break the markup. We validate it once
 * here at the boundary: accept only `http:` / `https:` URLs, and return the
 * parser-canonicalized `href` — not the raw string — so any character that
 * would otherwise breach the `<url|text>` delimiters is already percent-
 * encoded by `URL`. Trailing slashes are stripped so `${base}/sessions/<id>`
 * concatenation stays clean (path-prefixed deployments are still supported —
 * `href` preserves the path). Anything absent or invalid is treated as absent:
 * the home view already degrades gracefully to plain-text session rows when
 * there's no base URL, and a misconfigured optional cosmetic field must not
 * crash startup.
 */
function normalizeWebUiBaseUrl(raw) {
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.href.replace(/\/+$/, '');
}
/** Maximum file size in bytes that we'll download into memory. */
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg', 'tiff']);
const SKIP_EXTS = new Set([
  'mp3',
  'mp4',
  'mov',
  'webm',
  'wav',
  'ogg',
  'flac',
  'aac',
  'm4a',
  'avi',
  'mkv',
]);
export class SlackAdapter {
  id;
  displayName = 'Slack';
  get canSendTyping() {
    // Before the first probe, report true so the gateway attempts the call.
    // After probing, report the actual runtime result.
    return !this.typingProbed || this.typingAvailable;
  }
  canEditMessage = true;
  canReact = true;
  canSendFiles = false;
  maxMessageLength = 3000;
  get capabilities() {
    return {
      platform: 'slack',
      typing: this.typingAvailable,
      editDetection: true,
      replyToThreading: false,
      persistence: true,
      channelModes: true,
      homeView: true,
      joinGreeting: true,
      roleBasedApprovals: false,
      outboundFiles: false,
      webhookMode: false,
    };
  }
  botKey;
  binding;
  defaultChannelMode;
  app;
  client;
  backfillState;
  channelOverrides;
  threadState;
  memory;
  kanban;
  personalityCard;
  session;
  sessionUnfurl;
  kanbanUnfurl;
  personalityUnfurl;
  webUiBaseUrl;
  storage;
  cache;
  botToken;
  messageHandler;
  /** Approval-card button-click handler, wired by the approval coordinator. */
  approvalDecisionHandler;
  /** Clarify-card button-click handler, wired by the Slack clarify surface. */
  clarifyActionHandler;
  /** Clarify-modal submission handler, wired by the Slack clarify surface. */
  clarifyModalSubmitHandler;
  /** Source of pending clarifies for the App Home "Waiting on you" section.
   *  Wired by the Slack clarify surface after construction; read inside
   *  `start()` when the home events are registered. */
  clarifyHomeReader;
  /** Bolt-internal inbound handle. Resolved during `start()` via auth.test. */
  selfUserId = null;
  /** The bot's Slack display name. Resolved during `start()` via auth.test;
   *  falls back to `displayName` ('Slack') when unavailable. */
  selfDisplayName = null;
  /** Chunk-id ledger so editMessage can re-flow multi-chunk responses. */
  chunkMap = new Map();
  chunkMapMaxEntries = 1024;
  logger;
  /** Whether the Slack workspace supports the unofficial typing indicator API. */
  typingAvailable = false;
  typingProbed = false;
  /** Emoji name (no colons) for the inbound-receipt reaction. */
  receiptReaction;
  /**
   * Pending receipt-reaction ledger. Keyed by `${chatId}:${threadTs|'top'}`
   * so concurrent in-flight replies in different threads of the same channel
   * don't clobber each other's tracked message ts. Value is the original
   * inbound message ts that carries the reaction.
   */
  pendingReactions = new Map();
  pendingReactionsMaxEntries = 1024;
  constructor(config) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      signingSecret: config.signingSecret,
      socketMode: true,
    });
    this.client = this.app.client;
    this.botKey = config.botKey ?? deriveBotKey(config.botToken);
    this.id = `slack:${this.botKey}`;
    this.binding = config.binding;
    this.defaultChannelMode = config.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
    this.storage = config.storage;
    this.memory = config.memory;
    this.kanban = config.kanban;
    this.personalityCard = config.personalityCard;
    this.session = config.session;
    this.sessionUnfurl = config.sessionUnfurl;
    this.kanbanUnfurl = config.kanbanUnfurl;
    this.personalityUnfurl = config.personalityUnfurl;
    this.webUiBaseUrl = normalizeWebUiBaseUrl(config.webUiBaseUrl);
    this.cache = config.cache;
    this.botToken = config.botToken;
    this.receiptReaction = config.receiptReaction ?? 'eyes';
    this.logger = (config.logger ?? noopLogger).child({ component: 'slack' });
    if (config.storage) {
      const slackDir = config.slackDir ?? join(homeEthosDir(), 'slack');
      this.backfillState = new BackfillStateStore(config.storage, slackDir, this.botKey);
      this.channelOverrides = new ChannelOverrideStore(config.storage, slackDir, this.botKey);
      this.threadState = new ThreadStateStore(config.storage, slackDir, this.botKey);
    }
  }
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  async start() {
    // Hydrate persistent state before we accept events.
    await this.backfillState?.load();
    await this.channelOverrides?.load();
    await this.threadState?.load();
    // Resolve the bot's own user id so member-joined can distinguish
    // self-join from third-party joins. We tolerate failure (missing
    // scope, network blip) by leaving selfUserId null and skipping the
    // greeting — the rest of the adapter still works.
    try {
      const auth = await this.client.auth.test();
      const { user_id: userId, user: userName } = auth;
      this.selfUserId = userId ?? null;
      this.selfDisplayName = userName ?? null;
      const botName = userName ?? userId ?? 'unknown';
      this.logger.info(`Slack bot authenticated as @${botName}`);
    } catch {
      this.selfUserId = null;
      this.selfDisplayName = null;
    }
    registerMessageEvents(
      this.app,
      {
        botKey: this.botKey,
        defaultChannelMode: this.defaultChannelMode,
        channelOverrides: this.channelOverrides,
        threadState: this.threadState,
        backfillState: this.backfillState,
      },
      {
        onEnvelope: (msg) => {
          // Acknowledge receipt with an emoji reaction immediately, before
          // any attachment download or agent work. Matches Telegram's UX:
          // the user sees we got their message in <100 ms.
          this.addReceiptReaction(msg);
          const raw = msg.raw;
          const files = raw?.files;
          if (files && files.length > 0 && this.cache) {
            void this.extractFileAttachments(msg, files).then((enriched) => {
              this.messageHandler?.(enriched);
            });
          } else {
            this.messageHandler?.(msg);
          }
        },
      },
    );
    if (this.binding) {
      registerMemberEvents(this.app, {
        selfUserId: this.selfUserId,
        binding: this.binding,
        resolveChannelMode: (channel) =>
          resolveChannelMode(channel, {
            botKey: this.botKey,
            defaultChannelMode: this.defaultChannelMode,
            channelOverrides: this.channelOverrides,
          }),
      });
    }
    // Slash command — only register when the operator has set up `/ethos`
    // in the Slack app manifest. Bolt registers the handler regardless;
    // missing manifest entry just means Slack never delivers the event.
    this.app.command('/ethos', async ({ command, ack, respond }) => {
      await ack();
      const payload = {
        command: command.command,
        text: command.text ?? '',
        channel_id: command.channel_id,
        user_id: command.user_id,
        trigger_id: command.trigger_id,
      };
      const response = await dispatchSlash(payload, {
        binding: this.binding ?? { type: 'personality', name: 'unbound' },
        defaultChannelMode: this.defaultChannelMode,
        channelOverrides: this.channelOverrides,
        memory: this.memory,
        kanban: this.kanban,
        personalityCard: this.personalityCard,
        storage: this.storage,
        submitAgentTurn: this.makeAskSubmitter(),
      });
      try {
        await respond({
          response_type: response.responseType,
          text: response.text,
          blocks: response.blocks,
        });
      } catch {
        // ignore — Slack ack already sent
      }
    });
    // Approval-card button clicks. Bolt delivers `block_actions` events here;
    // we parse the raw payload down to the fields `handleApprovalAction`
    // needs and let it route to the coordinator's decision handler. Registered
    // unconditionally — a click with no handler wired is a harmless no-op.
    //
    // Slack is the one thing we don't control: a malformed payload or Bolt
    // API drift must not throw inside the event loop. We defensively probe
    // the shape before dereferencing, ack when we can, and bail otherwise.
    const onApprovalButton = async (raw) => {
      const evt = raw ?? {};
      if (typeof evt.ack === 'function') {
        // `ack()` is the one call we can't reason about — a Bolt/Slack API
        // change could make it throw synchronously, not just reject. Wrap the
        // invocation itself, not only the returned promise, so a bad ack can
        // never escape this handler and poison Bolt's event loop.
        try {
          await evt.ack();
        } catch {
          // best-effort ack — proceed with the decision regardless
        }
      }
      const handler = this.approvalDecisionHandler;
      if (!handler) return;
      const body = evt.body;
      const action = evt.action;
      if (
        typeof body !== 'object' ||
        body === null ||
        typeof action !== 'object' ||
        action === null
      )
        return;
      const payload = {
        actionId: action.action_id ?? '',
        approvalId: action.value ?? '',
        userId: body.user?.id ?? '',
        channelId: body.channel?.id ?? '',
        messageTs: body.message?.ts ?? '',
      };
      await handleApprovalAction(payload, { onDecision: async (event) => handler(event) });
    };
    this.app.action(APPROVE_ACTION_ID, onApprovalButton);
    this.app.action(DENY_ACTION_ID, onApprovalButton);
    // Clarify-card button clicks. Bolt delivers `block_actions` events here
    // for the choice/cancel/answer buttons; we narrow the raw payload to
    // `ClarifyActionPayload` and let the pure handler route it. Same shape as
    // the approval handler — defensively probe the payload before dereferencing
    // and ack as the very first thing.
    const onClarifyButton = async (raw) => {
      const evt = raw ?? {};
      if (typeof evt.ack === 'function') {
        try {
          await evt.ack();
        } catch {
          // best-effort ack — proceed regardless
        }
      }
      const handler = this.clarifyActionHandler;
      if (!handler) return;
      const body = evt.body;
      const action = evt.action;
      if (
        typeof body !== 'object' ||
        body === null ||
        typeof action !== 'object' ||
        action === null
      )
        return;
      // App Home payloads omit `body.channel` and `body.message` entirely
      // (the click happened on a view, not a channel message). Detect this
      // so the surface can relax its channel/messageTs cross-tenant gate
      // for Home — a Home view is per-user, so cross-message replay isn't
      // a risk; the gate's purpose doesn't apply.
      const fromHome = body.view?.type === 'home' || !body.channel;
      const payload = {
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
    this.app.action(CLARIFY_CHOICE_ACTION_ID, onClarifyButton);
    this.app.action(CLARIFY_CANCEL_ACTION_ID, onClarifyButton);
    this.app.action(CLARIFY_ANSWER_ACTION_ID, onClarifyButton);
    // Free-form modal submission. Bolt delivers `view_submission` events
    // when the user clicks Submit on the clarify modal. Same defensive shape.
    this.app.view(CLARIFY_MODAL_CALLBACK_ID, async (raw) => {
      const evt = raw;
      if (typeof evt.ack === 'function') {
        try {
          await evt.ack();
        } catch {
          // best-effort ack
        }
      }
      const handler = this.clarifyModalSubmitHandler;
      if (!handler) return;
      const view = evt.body?.view;
      if (!view) return;
      const payload = {
        callbackId: view.callback_id ?? '',
        privateMetadata: view.private_metadata ?? '',
        userId: evt.body?.user?.id ?? '',
        values: view.state?.values ?? {},
      };
      await handleClarifyModalSubmission(payload, { onSubmit: async (e) => handler(e) });
    });
    // App Home tab. `registerHomeEvents` wires `app_home_opened` (publish the
    // view) and the `home:refresh` button (re-publish). It gathers data from
    // the injected readers; sections backed by an unwired reader degrade to a
    // tasteful empty state. Registered unconditionally — when `binding` is
    // unset the header still renders with the default identity.
    registerHomeEvents(this.app, {
      binding: this.binding ?? { type: 'personality', name: 'unbound' },
      displayName: this.selfDisplayName ?? this.displayName,
      channelOverrides: this.channelOverrides,
      session: this.session,
      memory: this.memory,
      kanban: this.kanban,
      clarify: this.clarifyHomeReader,
      webUiBaseUrl: this.webUiBaseUrl,
    });
    // `link_shared` URL unfurling. `registerLinkEvents` is a no-op when
    // `webUiBaseUrl` is unset (it can't recognize an Ethos URL without a base
    // to match against); the lookup readers are optional and each URL type
    // degrades to a skipped unfurl when its reader is absent.
    registerLinkEvents(this.app, {
      webUiBaseUrl: this.webUiBaseUrl,
      session: this.sessionUnfurl,
      kanban: this.kanbanUnfurl,
      personality: this.personalityUnfurl,
    });
    await this.app.start();
  }
  async stop() {
    await this.app.stop();
  }
  async sendTyping(chatId) {
    if (!this.canSendTyping) return;
    try {
      await this.app.client.apiCall('conversations.setTypingIndicator', {
        channel: chatId,
        typing: true,
      });
      if (!this.typingProbed) {
        this.typingProbed = true;
        this.typingAvailable = true;
      }
    } catch {
      this.typingProbed = true;
      this.typingAvailable = false;
    }
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------
  async send(chatId, message) {
    try {
      // `threadId` is the canonical thread routing field. We deliberately
      // do NOT fall back to `replyToId` — that field has Discord/Telegram
      // "this is a reply to message X" semantics and would over-thread
      // every Slack reply if accidentally set by a generic caller. The
      // Gateway sets `threadId` from the originating inbound; nothing
      // sets `replyToId` for outbound today.
      const threadTs = message.threadId;
      const chunks = chunkText(toNativeMarkdown(message.text), this.maxMessageLength);
      const ids = [];
      for (const chunk of chunks) {
        const result = await this.client.chat.postMessage({
          channel: chatId,
          text: chunk,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          mrkdwn: true,
        });
        const ts = result.ts;
        if (ts) ids.push(ts);
      }
      this.rememberChunkIds(ids);
      // `thread_follow` mode needs to know we've posted in this thread.
      if (threadTs) {
        await this.threadState?.recordPost(chatId, threadTs);
      }
      // Clear the receipt reaction now that the reply has landed.
      this.clearReceiptReaction(chatId, threadTs);
      return { ok: true, messageId: ids[0] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  // ---------------------------------------------------------------------------
  // Receipt reactions — best-effort acknowledgement of inbound messages.
  //
  // Telegram has the same behaviour: set 👀 on inbound, clear when the reply
  // lands. Slack's analogue uses `reactions.add`/`reactions.remove`, which
  // require the `reactions:write` bot scope. Both calls are fire-and-forget;
  // missing scope, transient network failures, and "already_reacted" are all
  // swallowed silently so the agent still works without the scope.
  // ---------------------------------------------------------------------------
  /** Compose the pending-reactions ledger key for a (channel, thread) pair.
   *  Top-level posts have no threadTs and bucket under the `'top'` suffix. */
  reactionLaneKey(chatId, threadTs) {
    return `${chatId}:${threadTs ?? 'top'}`;
  }
  addReceiptReaction(msg) {
    const ts = msg.messageId;
    if (!ts) return;
    const lane = this.reactionLaneKey(msg.chatId, msg.threadId);
    // Bound the ledger so a long-running adapter never grows unboundedly when
    // sends fail repeatedly and never clear their entries.
    while (
      this.pendingReactions.size >= this.pendingReactionsMaxEntries &&
      !this.pendingReactions.has(lane)
    ) {
      const oldestKey = this.pendingReactions.keys().next().value;
      if (oldestKey === undefined) break;
      this.pendingReactions.delete(oldestKey);
    }
    this.pendingReactions.set(lane, ts);
    this.client.reactions
      .add({ channel: msg.chatId, timestamp: ts, name: this.receiptReaction })
      .catch(() => {});
  }
  clearReceiptReaction(chatId, threadTs) {
    const lane = this.reactionLaneKey(chatId, threadTs);
    const ts = this.pendingReactions.get(lane);
    if (!ts) return;
    this.pendingReactions.delete(lane);
    this.client.reactions
      .remove({ channel: chatId, timestamp: ts, name: this.receiptReaction })
      .catch(() => {});
  }
  async editMessage(chatId, messageId, text) {
    try {
      const newChunks = chunkText(toNativeMarkdown(text), this.maxMessageLength);
      const existingIds = this.chunkMap.get(messageId) ?? [messageId];
      const updatedIds = await reflowChunks(newChunks, existingIds, {
        edit: async (ts, chunk) => {
          await this.client.chat.update({ channel: chatId, ts, text: chunk });
          return ts;
        },
        append: async (chunk) => {
          const result = await this.client.chat.postMessage({
            channel: chatId,
            text: chunk,
            mrkdwn: true,
          });
          return result.ts ?? '';
        },
        deleteId: async (ts) => {
          await this.client.chat.delete({ channel: chatId, ts });
        },
      });
      this.chunkMap.delete(messageId);
      this.rememberChunkIds(updatedIds);
      return { ok: true, messageId: updatedIds[0] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  rememberChunkIds(ids) {
    if (ids.length === 0) return;
    const primary = ids[0];
    while (this.chunkMap.size >= this.chunkMapMaxEntries && !this.chunkMap.has(primary)) {
      const oldestKey = this.chunkMap.keys().next().value;
      if (oldestKey === undefined) break;
      this.chunkMap.delete(oldestKey);
    }
    this.chunkMap.set(primary, ids);
  }
  // ---------------------------------------------------------------------------
  // Tool-approval cards
  //
  // The Slack adapter is the only platform with an interactive approval
  // affordance, so these methods live here rather than on `PlatformAdapter`.
  // The approval coordinator (apps layer) drives them: post a card when a
  // dangerous tool call is gated, update it in place once resolved. The
  // adapter never imports `@ethosagent/gateway` — the coordinator hands it a
  // plain `chatId` / `threadId`, so layering stays one-directional.
  // ---------------------------------------------------------------------------
  /** Post the pending approval card. Returns the message `ts` so the
   *  coordinator can `chat.update` it in place once the user decides. */
  async postApprovalCard(input) {
    const blocks = approvalPendingBlocks({
      approvalId: input.approvalId,
      toolName: input.toolName,
      reason: input.reason,
      args: input.args,
    });
    try {
      const result = await this.client.chat.postMessage({
        channel: input.chatId,
        text: plaintextFallback(blocks),
        blocks: blocks,
        ...(input.threadId ? { thread_ts: input.threadId } : {}),
      });
      const ts = result.ts;
      if (!ts) return { error: 'Slack accepted the approval card but returned no message ts' };
      return { messageTs: ts };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  /** Replace a posted approval card with its resolved (decision) state —
   *  removes the buttons so the card can't be clicked twice. */
  async updateApprovalCard(input) {
    const blocks = approvalResolvedBlocks({
      toolName: input.toolName,
      decision: input.decision,
      decidedBy: input.decidedBy,
    });
    try {
      await this.client.chat.update({
        channel: input.chatId,
        ts: input.messageTs,
        text: plaintextFallback(blocks),
        blocks: blocks,
      });
      return { ok: true };
    } catch (err) {
      // A stale card left showing live buttons is misleading on a privileged
      // surface — report the failure rather than swallowing it. The caller
      // (gateway) decides how loud to be; the decision itself is already
      // final regardless.
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  /** Register the approval-card button-click handler. The coordinator wires
   *  this to its `approve()` / `deny()` calls. */
  onApprovalDecision(handler) {
    this.approvalDecisionHandler = handler;
  }
  // ---------------------------------------------------------------------------
  // Clarify cards (interactive question/answer)
  //
  // Mirrors the approval-card lifecycle. The Slack clarify surface drives
  // them: post a card when the agent calls `clarify`, update it in place
  // once resolved (answered, timed out, or cancelled). The adapter takes
  // the rendered Block Kit blocks from the surface — block builders live in
  // `blocks/clarify.ts` and stay pure.
  // ---------------------------------------------------------------------------
  /** Post the pending clarify card. Returns the message `ts` so the surface
   *  can `chat.update` it in place once the row resolves. */
  async postClarifyCard(input) {
    try {
      const result = await this.client.chat.postMessage({
        channel: input.chatId,
        text: plaintextFallback(input.blocks),
        blocks: input.blocks,
        ...(input.threadId ? { thread_ts: input.threadId } : {}),
      });
      const ts = result.ts;
      if (!ts) return { error: 'Slack accepted the clarify card but returned no message ts' };
      return { messageTs: ts };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  /** Replace a posted clarify card with its resolved state — removes the
   *  buttons so the card can't be clicked twice. */
  async updateClarifyCard(input) {
    try {
      await this.client.chat.update({
        channel: input.chatId,
        ts: input.messageTs,
        text: plaintextFallback(input.blocks),
        blocks: input.blocks,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  /** Open a Block Kit modal — used for free-form clarify answers. */
  async openClarifyModal(input) {
    try {
      await this.client.views.open({
        trigger_id: input.triggerId,
        view: input.view,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  /** Register the clarify-card button-click handler. The Slack clarify
   *  surface wires this to its `bridge.respond()` calls. */
  onClarifyAction(handler) {
    this.clarifyActionHandler = handler;
  }
  /** Register the clarify-modal submission handler. */
  onClarifyModalSubmit(handler) {
    this.clarifyModalSubmitHandler = handler;
  }
  /** Register the App Home "Waiting on you" data source. Set by the clarify
   *  surface after construction; consumed inside `start()`. Idempotent —
   *  the most recent set wins, but only the value present at `start()` time
   *  is registered with Bolt. */
  setClarifyHomeReader(reader) {
    this.clarifyHomeReader = reader;
  }
  // ---------------------------------------------------------------------------
  // File attachment extraction
  // ---------------------------------------------------------------------------
  /**
   * Enrich an inbound envelope with file attachments downloaded from Slack.
   * Best-effort: files that fail to download or exceed the size cap are
   * silently skipped. Audio/video files are skipped in v1.
   */
  async extractFileAttachments(envelope, files) {
    if (!this.cache || files.length === 0) return envelope;
    const attachments = [];
    const sessionKey = `slack:${this.botKey}:${envelope.chatId}`;
    const messageId = envelope.messageId ?? String(Date.now());
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = (file.filetype ?? '').toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      if ((file.size ?? 0) > MAX_FILE_SIZE) continue;
      if (!file.url_private_download) continue;
      const type = IMAGE_EXTS.has(ext) ? 'image' : 'file';
      try {
        const res = await fetch(file.url_private_download, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        if (!res.ok) continue;
        const contentLength = Number(res.headers.get('content-length') ?? 0);
        if (contentLength > MAX_FILE_SIZE) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > MAX_FILE_SIZE) continue;
        const filename = file.name ?? `att-${i}`;
        const mime = file.mimetype ?? 'application/octet-stream';
        const url = await this.cache.write(bytes, {
          sessionKey,
          messageId,
          filename,
          mime,
        });
        attachments.push({
          type,
          ref: `att-${i}`,
          url,
          mimeType: mime,
          filename: file.name,
          sizeBytes: file.size,
        });
      } catch {
        // Download failed — skip this file silently
      }
    }
    if (attachments.length === 0) return envelope;
    return {
      ...envelope,
      attachments,
    };
  }
  async health() {
    try {
      const start = Date.now();
      await this.client.auth.test();
      return {
        ok: true,
        latencyMs: Date.now() - start,
      };
    } catch {
      return { ok: false };
    }
  }
  /** Builds the `/ethos ask` callback that injects a synthetic inbound
   *  message into the gateway. Returns undefined when no `messageHandler`
   *  is registered (i.e. the gateway hasn't wired up yet). */
  makeAskSubmitter() {
    const handler = this.messageHandler;
    if (!handler) return undefined;
    return async (input) => {
      const envelope = {
        platform: 'slack',
        botKey: this.botKey,
        chatId: input.channel,
        userId: input.user,
        text: input.text,
        isDm: false,
        // Slash invocations are always treated as a direct address — the
        // user explicitly invoked the bot, so channel-mode is bypassed.
        // No `threadId`: slash commands fire from the channel root.
        isGroupMention: true,
        raw: { source: 'slash:/ethos ask' },
      };
      handler(envelope);
    };
  }
}
function homeEthosDir() {
  // Late import keeps node:os out of the test surface that doesn't need it.
  // Same convention the rest of the repo uses (apps/ethos/src/config.ts).
  // We reach for HOME directly so the adapter doesn't pull in
  // `apps/ethos/src/config.ts` (an apps→extension dependency would
  // invert the layering).
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return join(home, '.ethos');
}
