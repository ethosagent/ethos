// Usage accounting for model calls made outside a turn's own `streamStep` call
// (plan/phases/background-usage-accounting.md §5.1). A new file, not a change to
// a frozen schema: `CompletionChunk`, `CompletionOptions` and `AgentEvent` are
// untouched (D15) — attribution travels in the metering decorator
// (`MeteredProvider`, packages/core/src/providers/metered-provider.ts) and the
// usage scope (packages/core/src/usage-scope.ts), never through the provider call.

/** Who caused the spend: a user's turn, background work, or an operator command. */
export type UsageSourceClass = 'turn_utility' | 'background' | 'operator';

/**
 * Every place a non-turn model call can come from. Closed (D5): a new call site
 * picks a kind, and a new kind is added here AND in {@link sourceClassOf}'s
 * table — the map is typed total, so a kind cannot exist without a class.
 * Pinned by `__tests__/usage-kinds.test.ts`.
 */
export type UsageSourceKind =
  // turn_utility
  | 'tool_llm'
  | 'memory_flush'
  | 'compaction'
  | 'injection_classifier'
  | 'smart_approver'
  | 'decision'
  | 'completion_verifier'
  | 'title'
  // background
  | 'memory_capture'
  | 'memory_consolidation'
  | 'improvement_fork'
  | 'learning_replay'
  | 'goal_judge'
  | 'call_summary'
  | 'channel_digest'
  | 'plugin_monitor'
  | 'embedding'
  // operator
  | 'nightly'
  | 'skill_evolver'
  | 'personality_draft'
  | 'debug_assistant';

const SOURCE_CLASS: Readonly<Record<UsageSourceKind, UsageSourceClass>> = {
  tool_llm: 'turn_utility',
  memory_flush: 'turn_utility',
  compaction: 'turn_utility',
  injection_classifier: 'turn_utility',
  smart_approver: 'turn_utility',
  decision: 'turn_utility',
  completion_verifier: 'turn_utility',
  title: 'turn_utility',
  memory_capture: 'background',
  memory_consolidation: 'background',
  improvement_fork: 'background',
  learning_replay: 'background',
  goal_judge: 'background',
  call_summary: 'background',
  channel_digest: 'background',
  plugin_monitor: 'background',
  embedding: 'background',
  nightly: 'operator',
  skill_evolver: 'operator',
  personality_draft: 'operator',
  debug_assistant: 'operator',
};

/** Every {@link UsageSourceKind}, in declaration order. */
export const USAGE_SOURCE_KINDS: readonly UsageSourceKind[] = Object.freeze(
  Object.keys(SOURCE_CLASS) as UsageSourceKind[],
);

/**
 * Background kinds the daily-cap gate never skips, though still recorded.
 * `goal_judge`: a skipped judge fails its check and re-runs the whole goal
 * attempt, spending more, not less (plan background-usage-accounting D38).
 * Read by `MeteredProvider` (packages/core/src/providers/metered-provider.ts).
 */
export const GATE_EXEMPT_KINDS: ReadonlySet<UsageSourceKind> = new Set<UsageSourceKind>([
  'goal_judge',
]);

/** The class a kind's spend belongs to — decides which caps it counts against. */
export function sourceClassOf(kind: UsageSourceKind): UsageSourceClass {
  return SOURCE_CLASS[kind];
}

/** Who a call is billed to. Every field is optional: a background call may know none. */
export interface UsageAttribution {
  personalityId?: string;
  botKey?: string;
  platform?: string;
  sessionId?: string;
  sessionKey?: string;
  traceId?: string;
  /** Tool name, goal id, job id, decision site, plugin id. */
  sourceRef?: string;
}

/** One ledger row: one metered call (or one externally priced charge). */
export interface UsageRecord extends UsageAttribution {
  /** ISO-8601 UTC, the same shape as a message's timestamp. */
  ts: string;
  kind: UsageSourceKind;
  sourceClass: UsageSourceClass;
  provider: string;
  /** `modelOverride ?? provider.model` — the model the call asked for. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** The provider's own figure (D7) — never re-priced. */
  estimatedCostUsd: number;
  costBasis?: 'priced' | 'local' | 'unknown';
  outcome: 'ok' | 'error' | 'aborted';
}

/** Where usage rows go. Synchronous, like every store behind it; may throw. */
export interface UsageRecorder {
  record(row: UsageRecord): void;
}

/** What a background-budget gate is asked before a background call is made. */
export interface UsageGateRequest {
  kind: UsageSourceKind;
  attribution: UsageAttribution;
}

/** A gate's answer. `skip` means the call is not made (§7.2). */
export interface UsageGateVerdict {
  decision: 'allow' | 'skip';
  spentUsd?: number;
  capUsd?: number;
}

/** Consulted for `background` kinds only. A gate that throws is treated as `allow`. */
export type UsageGate = (request: UsageGateRequest) => UsageGateVerdict | Promise<UsageGateVerdict>;

/** Signals the metering decorator raises for its host to record (§8). */
export type UsageMeterEvent =
  | {
      type: 'usage.background_skipped';
      kind: UsageSourceKind;
      attribution: UsageAttribution;
      spentUsd?: number;
      capUsd?: number;
    }
  | { type: 'usage.ledger_write_failed'; kind: UsageSourceKind; error: string };

/** `cause` text for each {@link UsageMeterEvent}, as recorded through `recordSafetyBlock`. */
const USAGE_EVENT_CAUSE: Readonly<
  Record<UsageMeterEvent['type'], (kind: UsageSourceKind) => string>
> = {
  'usage.ledger_write_failed': (kind) => `usage ledger write failed (${kind})`,
  'usage.background_skipped': (kind) =>
    `background ${kind} call skipped: the daily budget is spent`,
};

/**
 * The ONE observability record shape for a {@link UsageMeterEvent} (§8): `code`
 * is the event type, `details` the rest of the event. Used by the usage meter
 * (`createUsageMeter`, packages/wiring/src/usage-meter.ts) and the channel digest
 * (extensions/gateway/src/channel-digest.ts).
 */
export function usageMeterEventRecord(event: UsageMeterEvent): {
  code: UsageMeterEvent['type'];
  cause: string;
  details: Record<string, unknown>;
} {
  const { type, ...details } = event;
  return { code: type, cause: USAGE_EVENT_CAUSE[type](event.kind), details };
}
