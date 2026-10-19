import type {
  AgentEvent,
  LLMProvider,
  UsageAttribution,
  UsageRecorder,
  UsageSourceKind,
} from '@ethosagent/types';
import { MeteredProvider } from '../providers/metered-provider';
import { withUsageScope } from '../usage-scope';

/** `AgentLoopConfig.usage` — present → in-turn utility calls are metered and charged. */
export interface LoopUsageConfig {
  recorder: UsageRecorder;
}

const NONE: readonly AgentEvent[] = Object.freeze([]);

/**
 * The turn-side half of plan background-usage-accounting §5.2: one per turn,
 * built by turn setup (`TurnSetup.charges`, ./stages/turn-setup.ts). `wrap`
 * opens a usage scope attributed to this turn around one piece of awaited work
 * (a tool batch, a `before_tool_call` dispatch, the injection classifier, a
 * compaction, the memory flush); a `turn_utility` call metered inside it is
 * charged to the session budget (`sessionCosts`, which `checkCostBudget` reads
 * at the next iteration) and queued as a `usage` AgentEvent — the existing
 * variant, so `AgentEvent` is unchanged (D15). The stage yields `drain()` after
 * the work, where a generator can. A scope never spans a `yield`.
 *
 * Without `AgentLoopConfig.usage` the turn gets {@link PASSTHROUGH}: no scope,
 * no charge, no event, no allocation — the loop is byte-identical to before
 * (pinned by the fixture case in `../__tests__/utility-usage-charges.test.ts`).
 */
export class TurnUsageCharges {
  private readonly queued: AgentEvent[] = [];
  /** Absent on {@link PASSTHROUGH}: nothing is scoped or charged. */
  private readonly sessionCosts?: Map<string, number>;
  private readonly sessionKey: string;
  private readonly attribution: UsageAttribution;

  constructor(
    sessionCosts?: Map<string, number>,
    sessionKey = '',
    attribution: UsageAttribution = {},
  ) {
    if (sessionCosts) this.sessionCosts = sessionCosts;
    this.sessionKey = sessionKey;
    this.attribution = attribution;
  }

  wrap<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.sessionCosts) return fn();
    return withUsageScope({ attribution: this.attribution, charge: this.charge }, fn);
  }

  drain(): readonly AgentEvent[] {
    return this.queued.length === 0 ? NONE : this.queued.splice(0);
  }

  private readonly charge = (usd: number): void => {
    const costs = this.sessionCosts;
    if (!costs) return;
    costs.set(this.sessionKey, (costs.get(this.sessionKey) ?? 0) + usd);
    this.queued.push({ type: 'usage', inputTokens: 0, outputTokens: 0, estimatedCostUsd: usd });
  };
}

/** The shared no-op instance for a loop that does not meter usage. */
const PASSTHROUGH = new TurnUsageCharges();

/** This turn's charges: {@link PASSTHROUGH} unless the loop meters usage. */
export function turnUsageCharges(
  deps: { usage?: LoopUsageConfig; sessionCosts: Map<string, number>; platform: string },
  turn: { sessionId: string; sessionKey: string; personalityId: string; traceId?: string },
): TurnUsageCharges {
  if (!deps.usage) return PASSTHROUGH;
  return new TurnUsageCharges(deps.sessionCosts, turn.sessionKey, {
    sessionId: turn.sessionId,
    sessionKey: turn.sessionKey,
    personalityId: turn.personalityId,
    platform: deps.platform,
    ...(turn.traceId ? { traceId: turn.traceId } : {}),
  });
}

/** `llm` metered as `kind` when the loop meters usage; `llm` itself otherwise. */
export function meteredFor(
  llm: LLMProvider,
  usage: LoopUsageConfig | undefined,
  kind: UsageSourceKind,
  attribution?: UsageAttribution,
): LLMProvider {
  if (!usage) return llm;
  return new MeteredProvider({
    inner: llm,
    recorder: usage.recorder,
    kind,
    ...(attribution ? { attribution } : {}),
  });
}
