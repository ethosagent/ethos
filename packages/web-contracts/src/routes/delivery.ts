import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  A2aIdentityViewSchema,
  A2aPeerRowSchema,
  AmendmentRecordViewSchema,
  AmendmentReviewViewSchema,
  AmendmentStatusSchema,
  LearningCandidateKindSchema,
  LearningCandidateStatusSchema,
  LearningCandidateViewSchema,
  LearningReplayReportViewSchema,
  LearningTimelineEntryViewSchema,
  OutboxItemViewSchema,
  OutboxRevisionViewSchema,
  OutboxStateSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Deliveries — read-only view of the durable delivery-obligation ledger
//
// The gateway writes a `pending` obligation before every covered outbound send
// and flips it to `delivered` only on a confirmed platform ack. This namespace
// is the operator's window onto that: how many replies are owed, how many were
// abandoned, and — for a voice deployment — the same counts for voice notes,
// whose payload is an artifact on disk.
//
// The OUTBOUND half is read-only by construction: there is no RPC that
// records, claims, delivers or prunes an obligation. Redelivery is the
// gateway's decision, made against its own botKeys; a settings page must not be
// able to re-send someone's message.
//
// The INBOUND half (plan reach-and-containment §2.6) lists dead-lettered
// inbound messages and offers exactly two operator decisions on one: requeue
// (the running gateway's replay tick runs the turn again) or discard. Neither
// sends anything from here — a requeue hands the message back to the gateway,
// which re-runs its safety filter and its own delivery path.
// ---------------------------------------------------------------------------

const DeliveryStatusCountsSchema = z.object({
  pending: z.number(),
  redelivering: z.number(),
  delivered: z.number(),
  abandoned: z.number(),
});

const DeliveryStatsSchema = DeliveryStatusCountsSchema.extend({
  /** The same counts restricted to `kind = 'voice'`, so a voice deployment can
   *  see whether the loss it is looking at is specific to voice notes. */
  voice: DeliveryStatusCountsSchema,
});

const DeliveryObligationSchema = z.object({
  id: z.string(),
  platform: z.string(),
  chatId: z.string(),
  /** Null for the root chat — a thread is a distinct conversation. */
  threadId: z.string().nullable(),
  status: z.enum(['pending', 'redelivering', 'delivered', 'abandoned']),
  kind: z.enum(['text', 'voice']),
  /**
   * The reply text — for a voice obligation, the SPOKEN text — truncated to 200
   * characters. Nothing here is redacted: the operator owns this text and it is
   * their own agent's outbound reply. It is truncated because a settings page
   * asking "what is still owed" must not become a way to read whole
   * conversations out of the ledger, on screen or in a browser network log.
   */
  content: z.string(),
  /** Container of the stored artifact for a voice obligation; null for text. */
  mediaFormat: z.string().nullable(),
  /** Epoch milliseconds. */
  createdAt: z.number(),
});

const DeliveriesSummaryInput = z.object({
  /** Rows to return, newest first. Clamped to 1–200 by the ledger. */
  limit: z.number().int().min(1).max(200).optional(),
});

const DeliveriesSummaryOutput = z.object({
  stats: DeliveryStatsSchema,
  recent: z.array(DeliveryObligationSchema),
});

const DeadInboundSchema = z.object({
  id: z.string(),
  /** `dead` — given up on. `interrupted` — cut after a tool had started, so
   *  never replayed; the chat was asked to reply `retry`. Replay re-runs it. */
  status: z.enum(['dead', 'interrupted']),
  platform: z.string(),
  chatId: z.string(),
  /** Null for the root chat. */
  threadId: z.string().nullable(),
  attempts: z.number(),
  /** Why it died: the turn's last error, `stale`, or `unreadable payload`;
   *  for an interrupted row, why it was cut. */
  lastError: z.string().nullable(),
  /** The message text, truncated to 200 characters, for the same reason
   *  `DeliveryObligationSchema.content` is. Empty when the payload is gone. */
  text: z.string(),
  /** Epoch milliseconds. */
  receivedAt: z.number(),
  updatedAt: z.number(),
});

const ListDeadInboundInput = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});
const ListDeadInboundOutput = z.object({ rows: z.array(DeadInboundSchema) });
const InboundActionInput = z.object({ id: z.string().min(1) });
/** `false` when the row is no longer dead or interrupted (already requeued,
 *  retried or discarded). */
const InboundActionOutput = z.object({ ok: z.boolean() });

// ---------------------------------------------------------------------------
// Usage — spend and tokens over a window (plan openclaw-2026.9.6-gaps U3)
//
// The web face of `ethos usage`: the same `usageAggregate` rows folded by the
// same `summarizeUsageRows` (@ethosagent/session-sqlite), so a window reads the
// same in the terminal and the browser. The CLI's observability-backed parts
// (turn outcomes, `--by tool|skill`) are not here.
// ---------------------------------------------------------------------------

const UsageRowSchema = z.object({
  /**
   * The group: a UTC date, model, personality id, platform, session id, or — for
   * `by: 'source'` — `turn`, `turn:<background prefix>` or `<class>:<kind>`
   * (e.g. `background:memory_capture`).
   */
  key: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  estimatedCostUsd: z.number(),
  messages: z.number(),
  /** Usage-ledger rows (non-turn model calls) in the group. Defaults to 0 for older servers. */
  calls: z.number().default(0),
});

const UsageDimensionSchema = z.enum(['model', 'personality', 'channel', 'session', 'source']);

const UsageSummaryInput = z.object({
  /** Window length ending now, in ms. 1 minute to 366 days. */
  windowMs: z
    .number()
    .int()
    .min(60_000)
    .max(366 * 24 * 60 * 60 * 1000),
  /** Optional breakdown, as `ethos usage --by`. */
  by: UsageDimensionSchema.optional(),
});

const UsageSummaryOutput = z.object({
  /** Epoch milliseconds. */
  since: z.number(),
  until: z.number(),
  totals: UsageRowSchema.omit({ key: true }).extend({
    /** Share of billable input served from cache, 0–1. */
    cacheHitRate: z.number(),
  }),
  /** One row per UTC day with spend, `key` = `YYYY-MM-DD`. */
  daily: z.array(UsageRowSchema),
  by: z.object({ dimension: UsageDimensionSchema, rows: z.array(UsageRowSchema) }).optional(),
});

/** @experimental */
export const usage = {
  summary: oc.input(UsageSummaryInput).output(UsageSummaryOutput),
};

/** @experimental */
export const deliveries = {
  summary: oc.input(DeliveriesSummaryInput).output(DeliveriesSummaryOutput),
  listDeadInbound: oc.input(ListDeadInboundInput).output(ListDeadInboundOutput),
  requeueInbound: oc.input(InboundActionInput).output(InboundActionOutput),
  discardInbound: oc.input(InboundActionInput).output(InboundActionOutput),
};

// ---------------------------------------------------------------------------
// Outbox — the personality approval queue (plan `trust-before-reach.md` Part 2)
//
// A personality with `outbound_policy.approve_before_send` does not publish: its
// `send_message` queues an item here and returns "NOT sent". This namespace is
// the WEB approval surface for that queue (O-D5: any authenticated `/rpc`
// session counts as the operator, the same rule `deliveries` rides on).
//
// It writes DECISIONS ONLY. There is no procedure that sends, claims, retries a
// delivery or touches an adapter — web-api holds no adapters at all. The
// gateway dispatcher polls the same SQLite file, claims `approved` rows for its
// own bots and calls `sendTracked`. `outbox.retry` is named for the human
// action it is (re-approve a failed item at the same revision), not for a
// network retry.
//
// The binding is what makes an approval mean something: `approve` carries back
// the `revision` and `contentHash` the human READ, and the store's conditional
// UPDATE refuses it if either has moved. That surfaces as `CONFLICT` —
// "changed since you viewed it" — and the UI re-reads rather than publishing
// text nobody approved.
// ---------------------------------------------------------------------------

/**
 * Filters for one pane. Absent `personalityId` AND `teamId` means every item in
 * the deployment — the count behind a global "needs you" badge.
 *
 * `teamId` expands to that team's member personalities (the manifest's roster),
 * which is what the team pane shows. Given both, the intersection applies: a
 * personality that is not a member of the team matches nothing.
 */
const OutboxListInput = z.object({
  personalityId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  /** Restrict to these states — the four UI sections. Absent means all. */
  states: z.array(OutboxStateSchema).min(1).optional(),
  /** Items to return, newest first. */
  limit: z.number().int().min(1).max(200).optional(),
});
const OutboxListOutput = z.object({ items: z.array(OutboxItemViewSchema) });

const OutboxGetInput = z.object({ itemId: z.string().min(1) });
/** The item plus its full revision history, oldest first — the card's
 *  "revision 2 · edited by you" line and the timeline are rendered from it. */
const OutboxGetOutput = z.object({
  item: OutboxItemViewSchema,
  revisions: z.array(OutboxRevisionViewSchema),
});

/** Every decision answers with the item as it now stands, so a client never
 *  has to guess the resulting state or issue a second read. */
const OutboxItemOutput = z.object({ item: OutboxItemViewSchema });

/**
 * A BOUND approval. `revision` and `contentHash` are the ones the human read
 * off the card; if the item has been edited, revoked, rejected or expired since
 * it was rendered, nothing is approved and the call fails `CONFLICT`.
 */
const OutboxApproveInput = z.object({
  itemId: z.string().min(1),
  revision: z.number().int().positive(),
  contentHash: z.string().min(1),
  /** Tab identity, recorded as `decidedBy` on the `outbox.approve` audit row.
   *  A LABEL for the trail, never the gate: authentication is the gate. */
  clientId: z.string().min(1),
});

const OutboxRejectInput = z.object({
  itemId: z.string().min(1),
  /** Shown to the agent and kept in the audit trail. */
  reason: z.string().min(1),
  clientId: z.string().min(1),
});

/** Replace the text with revision n+1. `revision` is the one the editor started
 *  from; any approval on it is void. Destination and sender are NOT editable —
 *  to publish somewhere else, reject and let the agent propose again. */
const OutboxEditInput = z.object({
  itemId: z.string().min(1),
  revision: z.number().int().positive(),
  text: z.string().min(1),
  clientId: z.string().min(1),
});

/** `revoke` (withdraw an approval before the dispatcher claims it) and `retry`
 *  (re-approve a failed item at the same revision) need no binding: neither
 *  puts new text in front of anyone. */
const OutboxDecisionInput = z.object({
  itemId: z.string().min(1),
  clientId: z.string().min(1),
});

/** @experimental */
export const outbox = {
  list: oc.input(OutboxListInput).output(OutboxListOutput),
  get: oc.input(OutboxGetInput).output(OutboxGetOutput),
  approve: oc.input(OutboxApproveInput).output(OutboxItemOutput),
  reject: oc.input(OutboxRejectInput).output(OutboxItemOutput),
  edit: oc.input(OutboxEditInput).output(OutboxItemOutput),
  revoke: oc.input(OutboxDecisionInput).output(OutboxItemOutput),
  retry: oc.input(OutboxDecisionInput).output(OutboxItemOutput),
};

// ---------------------------------------------------------------------------
// Learning — the review inbox for replay-gated learning
// (plan `trust-before-reach.md` Part 4, L-T8)
//
// Every learned change (a new skill, a skill rewrite, an Expression) waits here
// with its evidence, its replay scorecard and its timeline. This namespace is
// the web half of `LearningInbox` (`extensions/learning-inbox/src/inbox.ts`),
// which owns the two rules a client has to know:
//
//   - `approve` on a verdict other than `pass` — a candidate that was NEVER
//     replayed included — needs `override.reason`, and fails
//     `OVERRIDE_REQUIRED` without one. The reason lands on the timeline.
//   - every decision that lands writes exactly one `learning.approve |
//     override | reject | rollback` row to `ethos audit decisions`.
//
// Auth: cookie only. `learning` is deliberately absent from `SCOPE_MAP`
// (`apps/web-api/src/middleware/dual-auth.ts`), so a bearer API key fails
// closed on every procedure — approving a learned change is at least as
// sensitive as approving a publication, and `outbox` set that precedent.
// ---------------------------------------------------------------------------

const LearningListInput = z.object({
  personalityId: z.string().min(1).optional(),
  kind: LearningCandidateKindSchema.optional(),
  /** Restrict to these statuses — the inbox's list groups. Absent means all. */
  statuses: z.array(LearningCandidateStatusSchema).min(1).optional(),
  /** Candidates to return, newest first. */
  limit: z.number().int().min(1).max(500).optional(),
});
const LearningListOutput = z.object({ candidates: z.array(LearningCandidateViewSchema) });

const LearningCandidateIdInput = z.object({ candidateId: z.string().min(1) });

const LearningGetOutput = z.object({
  candidate: LearningCandidateViewSchema,
  /** What is live now — the left side of the diff. `core` is set for an Expression only. */
  current: z.object({ content: z.string().nullable(), core: z.string().nullable() }),
  /** The newest scorecard; null when the candidate was never replayed ("Not run"). */
  replay: LearningReplayReportViewSchema.nullable(),
  /** Every replay run, oldest first. */
  replayRunIds: z.array(z.string()),
  timeline: z.array(LearningTimelineEntryViewSchema),
  /**
   * Whether Rollback would proceed now. When not, `code` (`not_promoted`,
   * `live_edited`, `not_latest`, `no_record`) and `reason` explain the disabled
   * button — `live_edited` is "the live file has been edited since".
   */
  rollback: z.object({
    allowed: z.boolean(),
    code: z.string().nullable(),
    reason: z.string().nullable(),
  }),
});

/** Run once, synchronously; a replay costs minutes and real money (L-D6, L-D7). */
const LearningReplayOutput = z.object({
  candidate: LearningCandidateViewSchema,
  replay: LearningReplayReportViewSchema,
  /** True when L-D3's auto resolver promoted it on a `pass`. */
  promoted: z.boolean(),
  /** Why it did not promote, when it did not. */
  decisionReason: z.string().nullable(),
});

const LearningApproveInput = z.object({
  candidateId: z.string().min(1),
  /** Tab identity, recorded as `decidedBy` on the audit row. A label, never the gate. */
  clientId: z.string().min(1),
  /** Required unless the verdict is `pass` ("Approve anyway…"). */
  override: z.object({ reason: z.string().trim().min(1) }).optional(),
});

const LearningDecisionInput = z.object({
  candidateId: z.string().min(1),
  clientId: z.string().min(1),
  /** Optional free text for the timeline. */
  reason: z.string().trim().min(1).optional(),
});

/** Every decision answers with the candidate as it now stands. */
const LearningCandidateOutput = z.object({ candidate: LearningCandidateViewSchema });

/** @experimental */
export const learning = {
  list: oc.input(LearningListInput).output(LearningListOutput),
  get: oc.input(LearningCandidateIdInput).output(LearningGetOutput),
  replay: oc.input(LearningCandidateIdInput).output(LearningReplayOutput),
  approve: oc.input(LearningApproveInput).output(LearningCandidateOutput),
  reject: oc.input(LearningDecisionInput).output(LearningCandidateOutput),
  rollback: oc.input(LearningDecisionInput).output(LearningCandidateOutput),
};

// ---------------------------------------------------------------------------
// Amendments — a personality's request to add or remove tools from its own
// toolset (plan personality-memory-boundary-and-self-amendment G2).
//
// READ-ONLY in v1 (D30). There is no apply, decline or rollback here: the
// owner acts from the CLI (`ethos personality amendments apply <id>`), where
// the TTY and typed-confirmation gate lives (D32). The read service web-api
// holds is `Pick<AmendmentService, 'list' | 'get'>`
// (apps/web-api/src/services/amendments.service.ts), so no web path reaches
// a write even structurally.
//
// Auth: cookie only. `amendments` is deliberately absent from `SCOPE_MAP`
// (`apps/web-api/src/middleware/dual-auth.ts`), so a bearer API key fails
// closed — a pending amendment is a personality asking for more reach, and
// its rationale and evidence are the owner's to read. Pinned by
// apps/web-api/src/__tests__/services/amendments.service.test.ts.
// ---------------------------------------------------------------------------

const AmendmentsListInput = z.object({
  personalityId: z.string().min(1).optional(),
  /** Restrict to these statuses. Absent means all. */
  statuses: z.array(AmendmentStatusSchema).min(1).optional(),
});
const AmendmentsListOutput = z.object({ amendments: z.array(AmendmentRecordViewSchema) });
const AmendmentsGetInput = z.object({ amendmentId: z.string().min(1) });
const AmendmentsGetOutput = z.object({ review: AmendmentReviewViewSchema });

/** @experimental */
export const amendments = {
  list: oc.input(AmendmentsListInput).output(AmendmentsListOutput),
  get: oc.input(AmendmentsGetInput).output(AmendmentsGetOutput),
};

// ---------------------------------------------------------------------------
// Observed chats — the rooms a bot WATCHES and never answers
// (plan/phases/ambient-group-monitoring.md R12).
//
// Read-only, and deliberately thin: every field below is a field
// `ChannelTranscriptStore.listLanes` actually returns. Nothing is derived, and
// in particular NO MESSAGE TEXT crosses this wire. A room the agent is merely
// present in is not a room the operator gets to read out of a settings page —
// the transcript exists to be summarised by the digest turn, not browsed. The
// privacy line is the plan's (§8, "Never the last message text") and this
// schema is where it is actually enforced.
// ---------------------------------------------------------------------------

const ChannelObservedLaneSchema = z.object({
  /** `platform:botKey:chatId[:threadId]`, URL-encoded per segment. The row key. */
  laneKey: z.string(),
  platform: z.string(),
  /** Which configured bot watches this room. */
  botKey: z.string(),
  chatId: z.string(),
  /** Null for the root chat — a thread is a distinct room, and a distinct lane. */
  threadId: z.string().nullable(),
  /**
   * Messages whose `sentAt` falls inside the requested `since` window. Zero is
   * a real answer, not an absence: a watched room that was quiet today is
   * still watched, and dropping it would read as "we stopped listening".
   */
  count: z.number(),
  /** Newest `sentAt` in the lane, epoch ms — ignores `since`. */
  lastSentAt: z.number(),
});

const ChannelsObservedInput = z.object({
  /**
   * Window for `count`, epoch ms. The CALLER picks it, because "today" is a
   * question about the reader's clock and the server does not know their
   * timezone. Omitted means all time.
   */
  since: z.number().int().nonnegative().optional(),
  /** Lanes to return, newest-active first. Defaults to the store's own 500. */
  limit: z.number().int().min(1).max(500).optional(),
});

const ChannelsObservedOutput = z.object({
  lanes: z.array(ChannelObservedLaneSchema),
  /**
   * Watched lanes beyond `limit`. Same meaning, and the same name, as
   * `ChannelTranscriptPage.omittedCount`: the count that was dropped, said out
   * loud. `0` means the list is complete. Never truncate in silence (feedback
   * & activity contract §7, "nothing vanishes").
   */
  omittedCount: z.number(),
  /**
   * Why the transcript could not be read, when it could not be. NOT a thrown
   * error: a failed read is a `✗ failed` ROW that stays on the page beside
   * whatever else it says (contract §6), and a rejected RPC gives the client
   * an exception to render as a disappearing toast instead. `null` on success.
   *
   * `lanes: [], omittedCount: 0, error: null` is the honest empty house — no
   * bot has ever observed anything here.
   */
  error: z.string().nullable(),
});

/** @experimental */
export const channels = {
  observed: oc.input(ChannelsObservedInput).output(ChannelsObservedOutput),
};

// ---------------------------------------------------------------------------
// A2A peering (admin surface) — thin RPC wrappers over the wiring
// `A2aPeeringService` + the runtime enable/disable control. Rides the same
// cookie/bearer `/rpc` auth as the other management namespaces; NOT the public
// peer-facing `/a2a` surface. Serve-wide `settings` toggle plus per-personality
// identity / peer / skill-exposure reads (plan §6, §13).
// ---------------------------------------------------------------------------

const A2aSettingsGetOutput = z.object({ enabled: z.boolean() });
const A2aSettingsSetInput = z.object({ enabled: z.boolean() });
const A2aSettingsSetOutput = z.object({ enabled: z.boolean() });

const A2aIdentityInput = z.object({ personalityId: z.string().min(1) });

const A2aPeersListInput = z.object({ personalityId: z.string().min(1) });

const A2aPeersPreviewInput = z.object({ url: z.string().min(1) });
// Only what the verify-step UI needs — the fetched fingerprint + peer
// name/description — NOT the whole signed card.
const A2aPeersPreviewOutput = z.object({
  fingerprint: z.string(),
  name: z.string(),
  description: z.string().optional(),
});

const A2aPeersAddInput = z.object({
  personalityId: z.string().min(1),
  url: z.string().min(1),
  /** The out-of-band fingerprint the peer gave you; must match the fetched
   *  card's fingerprint or the add is rejected (verify-first, plan §8). */
  expectedFingerprint: z.string().min(1),
  label: z.string().optional(),
});

const A2aPeersSetEnabledInput = z.object({
  personalityId: z.string().min(1),
  fingerprint: z.string().min(1),
  enabled: z.boolean(),
});

const A2aPeersRemoveInput = z.object({
  personalityId: z.string().min(1),
  fingerprint: z.string().min(1),
});

const A2aOkOutput = z.object({ ok: z.literal(true) });

const A2aSkillsListExposableInput = z.object({ personalityId: z.string().min(1) });
const A2aSkillsListExposableOutput = z.array(z.object({ name: z.string(), exposed: z.boolean() }));

/** @experimental */
export const a2a = {
  settings: {
    get: oc.output(A2aSettingsGetOutput),
    set: oc.input(A2aSettingsSetInput).output(A2aSettingsSetOutput),
  },
  identity: oc.input(A2aIdentityInput).output(A2aIdentityViewSchema),
  peers: {
    list: oc.input(A2aPeersListInput).output(z.array(A2aPeerRowSchema)),
    preview: oc.input(A2aPeersPreviewInput).output(A2aPeersPreviewOutput),
    add: oc.input(A2aPeersAddInput).output(A2aPeerRowSchema),
    setEnabled: oc.input(A2aPeersSetEnabledInput).output(A2aOkOutput),
    remove: oc.input(A2aPeersRemoveInput).output(A2aOkOutput),
  },
  skills: {
    listExposable: oc.input(A2aSkillsListExposableInput).output(A2aSkillsListExposableOutput),
  },
};
