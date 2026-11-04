import type {
  AgentEvent,
  LLMProvider,
  SessionStore,
  UsageAttribution,
  UsageRecorder,
  UsageSourceKind,
} from '@ethosagent/types';
import { isIncognitoSession } from '../chat-audience';
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
  turn: {
    sessionId: string;
    sessionKey: string;
    personalityId: string;
    traceId?: string;
    incognito?: boolean;
  },
): TurnUsageCharges {
  if (!deps.usage) return PASSTHROUGH;
  // Plan incognito-sessions D16 — an incognito turn's ledger rows carry no
  // session or trace link. The charge target (`turn.sessionKey` into
  // `sessionCosts`) is unchanged, so the in-turn budget still holds. Pinned by
  // the incognito case in `packages/wiring/src/__tests__/usage-no-double-count.test.ts`.
  return new TurnUsageCharges(
    deps.sessionCosts,
    turn.sessionKey,
    turn.incognito === true
      ? { personalityId: turn.personalityId, platform: deps.platform }
      : {
          sessionId: turn.sessionId,
          sessionKey: turn.sessionKey,
          personalityId: turn.personalityId,
          platform: deps.platform,
          ...(turn.traceId ? { traceId: turn.traceId } : {}),
        },
  );
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

/**
 * Attribution for work outside a turn that names a session by key (manual
 * `/compact`). Plan incognito-sessions D16: an incognito session's ledger rows
 * carry no `sessionKey`. Fails closed — a lookup that throws also omits it.
 * Pinned by 'manual compact on an incognito session' in
 * `../__tests__/incognito.test.ts`.
 */
async function sessionKeyAttribution(
  session: Pick<SessionStore, 'getSessionByKey'>,
  sessionKey: string,
  platform: string | undefined,
): Promise<UsageAttribution> {
  const found = await session.getSessionByKey(sessionKey).then(
    (s) => s,
    () => undefined,
  );
  const incognito = found === undefined || (found !== null && isIncognitoSession(found));
  return { ...(incognito ? {} : { sessionKey }), ...(platform ? { platform } : {}) };
}

/** Open a usage scope for `run` attributed by {@link sessionKeyAttribution}. */
export async function withSessionKeyScope<T>(
  session: Pick<SessionStore, 'getSessionByKey'>,
  sessionKey: string,
  platform: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const attribution = await sessionKeyAttribution(session, sessionKey, platform);
  return withUsageScope({ attribution }, run);
}
