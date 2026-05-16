export interface Attachment {
  type: 'image' | 'file';
  ref: string;
  url: string;
  mimeType: string;
  filename?: string;
  sizeBytes?: number;
}

export interface InboundMessage {
  platform: string;
  chatId: string;
  userId?: string;
  username?: string;
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  /** Sender ID of the quoted/replied-to message. Set by adapters that can provide it. */
  replyToUserId?: string;
  isDm: boolean;
  isGroupMention: boolean;
  /**
   * Platform-native message ID. When set, Gateway dedupes duplicate inbounds
   * sharing the same `(platform, chatId, messageId)` triple — protecting
   * against polling reconnects, double-delivery, and webhook retries.
   * See plan/IMPROVEMENT.md P2-2 / OpenClaw #71761.
   */
  messageId?: string;
  /**
   * Set to `true` by adapters when this message is a re-delivery of a
   * previously-sent message that the user edited on the platform. The
   * gateway uses this to bypass inbound dedup (same `messageId`, different
   * content) and — when the original message is still within the adapter's
   * edit window — to abort the in-flight turn and re-issue.
   */
  isEdit?: boolean;
  /**
   * Stable identifier of the bot this message arrived through, when the
   * adapter is bound to a specific bot via multi-bot routing. The Gateway
   * uses this as part of the lane key (`${platform}:${botKey}:${chatId}`)
   * so concurrent conversations across multiple bots stay isolated and
   * route to the correct personality/team binding. Optional for back-compat:
   * single-adapter deployments may omit it.
   */
  botKey?: string;
  /**
   * Adapter-owned sub-chat routing segment. When set, the Gateway extends
   * the lane key with the threadId so concurrent sub-conversations in the
   * same chat stay isolated.
   *
   * Leave undefined for top-level / unsplit conversations — the Gateway
   * routes those to an unthreaded lane scoped by `(platform, botKey,
   * chatId)`. Adapters with no sub-chat concept (Discord DMs, Email)
   * always leave it undefined. Telegram sets it for forum-mode topics
   * (message_thread_id > 1); the General topic (id 1) maps to undefined.
   *
   * Contract: a stable, opaque identifier scoped within `(platform,
   * botKey, chatId)`. The Gateway treats it opaquely — no parsing, no
   * decoding, no sentinel values — and the lane-key encoder escapes any
   * separator characters internally, so adapters can use whatever
   * identifier their platform provides without character restrictions.
   *
   * If a future platform's sub-chat model doesn't fit this shape (e.g. a
   * deeply nested structure), it should add a parallel field rather than
   * overload this one.
   */
  threadId?: string;
  raw: unknown;
}

export interface OutboundMessage {
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  parseMode?: 'markdown' | 'html' | 'plain';
  /**
   * Routes the outbound to a specific sub-conversation (Slack thread).
   * The Gateway populates this from the originating `InboundMessage.threadId`,
   * so an agent reply lands in the same thread the user wrote in. Undefined
   * for top-level conversations. Distinct from `replyToId`: `replyToId`
   * says "this is a reply to message X" (Telegram / Discord semantic);
   * `threadId` says "post into this thread" (Slack `chat.postMessage`
   * `thread_ts`). Adapters without a thread concept ignore the field.
   */
  threadId?: string;
}

export interface DeliveryResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface PlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly canSendTyping: boolean;
  readonly canEditMessage: boolean;
  readonly canReact: boolean;
  readonly canSendFiles: boolean;
  readonly maxMessageLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, message: OutboundMessage): Promise<DeliveryResult>;
  sendTyping?(chatId: string): Promise<void>;
  editMessage?(chatId: string, messageId: string, text: string): Promise<DeliveryResult>;
  onMessage(handler: (message: InboundMessage) => void): void;
  health(): Promise<{ ok: boolean; latencyMs?: number }>;
}

// ---------------------------------------------------------------------------
// Approval surface — interactive tool-call approval
//
// A PlatformAdapter extension for adapters that can post interactive
// approve/deny cards. The gateway narrows to this interface via duck-typing
// (`isApprovalCapable`) so it can drive the approval flow on any platform
// that implements it. Originally lived in @ethosagent/platform-slack; moved
// here so multiple adapters can implement it without cross-platform imports.
// ---------------------------------------------------------------------------

/** The decision event forwarded by an adapter when a user clicks Approve or Deny. */
export interface ApprovalDecisionEvent {
  approvalId: string;
  decision: 'allow' | 'deny';
  decidedBy: string;
  channelId: string;
  messageTs: string;
}

/**
 * Interactive tool-approval surface. Adapters that can post inline approve/deny
 * cards implement this so the gateway's approval coordinator can drive them.
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
