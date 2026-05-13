// `SlackAdapter` — implements the `PlatformAdapter` contract by wiring
// `@slack/bolt`'s Socket Mode app to the gateway. The class is intentionally
// thin: it owns the Bolt lifecycle and the inbound→outbound plumbing.
// Triage, channel-mode, slash commands, and Block Kit rendering live in
// sibling modules.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  Storage,
} from '@ethosagent/types';
import boltPkg from '@slack/bolt';
import {
  APPROVE_ACTION_ID,
  approvalPendingBlocks,
  approvalResolvedBlocks,
  DENY_ACTION_ID,
} from './blocks/approval';
import { plaintextFallback } from './blocks/shared';
import { chunkText, reflowChunks } from './chunking';
import {
  dispatch as dispatchSlash,
  type KanbanReader,
  type MemoryReader,
  type SlashCommandPayload,
} from './commands';
import type { Binding, ChannelMode } from './config';
import { DEFAULT_CHANNEL_MODE } from './config';
import {
  type KanbanUnfurlReader,
  type PersonalityUnfurlReader,
  registerLinkEvents,
  type SessionUnfurlReader,
} from './events/links';
import { registerMemberEvents } from './events/members';
import { registerMessageEvents } from './events/messages';
import { registerHomeEvents, type SessionReader } from './home/handlers';
import {
  type ApprovalActionPayload,
  type ApprovalDecisionEvent,
  handleApprovalAction,
} from './interactions/actions';
import { resolveChannelMode } from './routing/triage';
import { ChannelOverrideStore } from './store/channel-overrides';
import { ThreadStateStore } from './store/thread-state';

const { App } = boltPkg;
type App = InstanceType<typeof App>;

/**
 * First 24 hex chars of sha256(botToken). Matches `deriveBotKey` in
 * `apps/ethos/src/config.ts` so an adapter constructed without an
 * explicit `botKey` round-trips the same identity the boot path
 * would have produced.
 */
function deriveDefaultBotKey(botToken: string): string {
  return createHash('sha256').update(botToken).digest('hex').slice(0, 24);
}

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
function normalizeWebUiBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.href.replace(/\/+$/, '');
}

export interface SlackAdapterConfig {
  /** Bot token (xoxb-...) */
  botToken: string;
  /** App-level token for socket mode (xapp-...) */
  appToken: string;
  /** Signing secret from Slack app config */
  signingSecret: string;
  /** Stable identifier for multi-bot routing. See `deriveDefaultBotKey`. */
  botKey?: string;
  /** Bot binding — used by slash commands and the member-join greeting.
   *  Optional for back-compat: callers that don't wire it get default
   *  responses. New deployments should always set this. */
  binding?: Binding;
  /** Default channel mode for unmapped channels. Defaults to `mention_only`. */
  defaultChannelMode?: ChannelMode;
  /** Storage instance rooted at `~/.ethos`. When provided, the adapter
   *  persists per-channel mode overrides and thread-participation state
   *  under `~/.ethos/slack/<botKey>/`. */
  storage?: Storage;
  /** Optional override for the slack data directory. Defaults to
   *  `<storageRoot>/slack`. Tests pass an explicit dir to avoid the
   *  `~/.ethos` filesystem dance. */
  slackDir?: string;
  /** Optional memory reader for `/ethos memory show|add`. */
  memory?: MemoryReader;
  /** Optional kanban reader for `/ethos kanban list` (team bots only). */
  kanban?: KanbanReader;
  /** Optional session reader for the App Home "Recent sessions" section. */
  session?: SessionReader;
  /** Ethos web UI origin (no trailing slash). When set, App Home session rows
   *  deep-link to `<base>/sessions/<id>`; when absent they render as plain
   *  text. Also gates `link_shared` URL unfurling — without it the adapter
   *  can't recognize Ethos URLs and the `link_shared` handler is not
   *  registered. There is no web-UI base URL elsewhere in the adapter config
   *  today. */
  webUiBaseUrl?: string;
  /** Optional lookup-by-id reader for unfurling `<base>/sessions/<id>` URLs. */
  sessionUnfurl?: SessionUnfurlReader;
  /** Optional lookup-by-id reader for unfurling `<base>/kanban/<ticket>` URLs. */
  kanbanUnfurl?: KanbanUnfurlReader;
  /** Optional lookup-by-id reader for unfurling `<base>/personalities/<id>` URLs. */
  personalityUnfurl?: PersonalityUnfurlReader;
}

/**
 * The interactive tool-approval surface — a `PlatformAdapter` extension that
 * only Slack implements today. Declared as an explicit, named contract so
 * the gateway can depend on it via `import type` (erased at runtime, so the
 * adapter stays lazily loaded) instead of duck-typing the method shape. A
 * future approval-capable adapter implements this deliberately rather than
 * matching by coincidence.
 */
export interface ApprovalCapableAdapter {
  /** Stable per-bot identifier — matches a gateway `botKey`. */
  readonly botKey: string;
  postApprovalCard(input: {
    chatId: string;
    threadId?: string;
    approvalId: string;
    toolName: string;
    reason: string | null;
    args: unknown;
  }): Promise<{ messageTs: string } | { error: string }>;
  updateApprovalCard(input: {
    chatId: string;
    messageTs: string;
    toolName: string;
    decision: 'allow' | 'deny';
    decidedBy: string;
  }): Promise<DeliveryResult>;
  onApprovalDecision(handler: (event: ApprovalDecisionEvent) => void): void;
}

export class SlackAdapter implements PlatformAdapter, ApprovalCapableAdapter {
  readonly id: string;
  readonly displayName = 'Slack';
  readonly canSendTyping = false;
  readonly canEditMessage = true;
  readonly canReact = false; // capabilities don't lie — reactions land in a future phase
  readonly canSendFiles = false;
  readonly maxMessageLength = 3000;

  readonly botKey: string;
  readonly binding: Binding | undefined;
  readonly defaultChannelMode: ChannelMode;

  private readonly app: App;
  private readonly client: App['client'];
  private readonly channelOverrides: ChannelOverrideStore | undefined;
  private readonly threadState: ThreadStateStore | undefined;
  private readonly memory: MemoryReader | undefined;
  private readonly kanban: KanbanReader | undefined;
  private readonly session: SessionReader | undefined;
  private readonly sessionUnfurl: SessionUnfurlReader | undefined;
  private readonly kanbanUnfurl: KanbanUnfurlReader | undefined;
  private readonly personalityUnfurl: PersonalityUnfurlReader | undefined;
  private readonly webUiBaseUrl: string | undefined;
  private readonly storage: Storage | undefined;
  private messageHandler?: (message: InboundMessage) => void;
  /** Approval-card button-click handler, wired by the approval coordinator. */
  private approvalDecisionHandler?: (event: ApprovalDecisionEvent) => void;
  /** Bolt-internal inbound handle. Resolved during `start()` via auth.test. */
  private selfUserId: string | null = null;
  /** The bot's Slack display name. Resolved during `start()` via auth.test;
   *  falls back to `displayName` ('Slack') when unavailable. */
  private selfDisplayName: string | null = null;

  /** Chunk-id ledger so editMessage can re-flow multi-chunk responses. */
  private readonly chunkMap = new Map<string, string[]>();
  private readonly chunkMapMaxEntries = 1024;

  constructor(config: SlackAdapterConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      signingSecret: config.signingSecret,
      socketMode: true,
    });
    this.client = this.app.client;
    this.botKey = config.botKey ?? deriveDefaultBotKey(config.botToken);
    this.id = `slack:${this.botKey}`;
    this.binding = config.binding;
    this.defaultChannelMode = config.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
    this.storage = config.storage;
    this.memory = config.memory;
    this.kanban = config.kanban;
    this.session = config.session;
    this.sessionUnfurl = config.sessionUnfurl;
    this.kanbanUnfurl = config.kanbanUnfurl;
    this.personalityUnfurl = config.personalityUnfurl;
    this.webUiBaseUrl = normalizeWebUiBaseUrl(config.webUiBaseUrl);

    if (config.storage) {
      const slackDir = config.slackDir ?? join(homeEthosDir(), 'slack');
      this.channelOverrides = new ChannelOverrideStore(config.storage, slackDir, this.botKey);
      this.threadState = new ThreadStateStore(config.storage, slackDir, this.botKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // Hydrate persistent state before we accept events.
    await this.channelOverrides?.load();
    await this.threadState?.load();

    // Resolve the bot's own user id so member-joined can distinguish
    // self-join from third-party joins. We tolerate failure (missing
    // scope, network blip) by leaving selfUserId null and skipping the
    // greeting — the rest of the adapter still works.
    try {
      const auth = await this.client.auth.test();
      const { user_id: userId, user: userName } = auth as { user_id?: string; user?: string };
      this.selfUserId = userId ?? null;
      this.selfDisplayName = userName ?? null;
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
      },
      {
        onEnvelope: (msg) => this.messageHandler?.(msg),
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
      const payload: SlashCommandPayload = {
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
        storage: this.storage,
        submitAgentTurn: this.makeAskSubmitter(),
      });
      try {
        await respond({
          response_type: response.responseType,
          text: response.text,
          blocks: response.blocks as never,
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
      const payload: ApprovalActionPayload = {
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
      memory: this.memory,
      memoryScope: this.binding?.name,
    });

    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    try {
      // `threadId` is the canonical thread routing field. We deliberately
      // do NOT fall back to `replyToId` — that field has Discord/Telegram
      // "this is a reply to message X" semantics and would over-thread
      // every Slack reply if accidentally set by a generic caller. The
      // Gateway sets `threadId` from the originating inbound; nothing
      // sets `replyToId` for outbound today.
      const threadTs = message.threadId;

      const chunks = chunkText(message.text, this.maxMessageLength);
      const ids: string[] = [];

      for (const chunk of chunks) {
        const result = await this.client.chat.postMessage({
          channel: chatId,
          text: chunk,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          mrkdwn: true,
        });
        const ts = result.ts as string | undefined;
        if (ts) ids.push(ts);
      }

      this.rememberChunkIds(ids);
      // `thread_follow` mode needs to know we've posted in this thread.
      if (threadTs) {
        await this.threadState?.recordPost(chatId, threadTs);
      }
      return { ok: true, messageId: ids[0] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<DeliveryResult> {
    try {
      const newChunks = chunkText(text, this.maxMessageLength);
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
          return (result.ts as string | undefined) ?? '';
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

  private rememberChunkIds(ids: string[]): void {
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
  async postApprovalCard(input: {
    chatId: string;
    threadId?: string;
    approvalId: string;
    toolName: string;
    reason: string | null;
    args: unknown;
  }): Promise<{ messageTs: string } | { error: string }> {
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
        blocks: blocks as never,
        ...(input.threadId ? { thread_ts: input.threadId } : {}),
      });
      const ts = result.ts as string | undefined;
      if (!ts) return { error: 'Slack accepted the approval card but returned no message ts' };
      return { messageTs: ts };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Replace a posted approval card with its resolved (decision) state —
   *  removes the buttons so the card can't be clicked twice. */
  async updateApprovalCard(input: {
    chatId: string;
    messageTs: string;
    toolName: string;
    decision: 'allow' | 'deny';
    decidedBy: string;
  }): Promise<DeliveryResult> {
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
        blocks: blocks as never,
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
  onApprovalDecision(handler: (event: ApprovalDecisionEvent) => void): void {
    this.approvalDecisionHandler = handler;
  }

  async health(): Promise<{ ok: boolean; latencyMs?: number }> {
    try {
      const start = Date.now();
      await this.client.auth.test();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false };
    }
  }

  /** Builds the `/ethos ask` callback that injects a synthetic inbound
   *  message into the gateway. Returns undefined when no `messageHandler`
   *  is registered (i.e. the gateway hasn't wired up yet). */
  private makeAskSubmitter():
    | ((input: { channel: string; user: string; text: string }) => Promise<void>)
    | undefined {
    const handler = this.messageHandler;
    if (!handler) return undefined;
    return async (input) => {
      const envelope: InboundMessage = {
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

function homeEthosDir(): string {
  // Late import keeps node:os out of the test surface that doesn't need it.
  // Same convention the rest of the repo uses (apps/ethos/src/config.ts).
  // We reach for HOME directly so the adapter doesn't pull in
  // `apps/ethos/src/config.ts` (an apps→extension dependency would
  // invert the layering).
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return join(home, '.ethos');
}
