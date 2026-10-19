// The usage meter — the ONE owner of how a model call outside a turn's own
// `streamStep` is recorded (plan/phases/background-usage-accounting.md §5.4,
// D4). Pinned by `__tests__/usage-meter-wiring.test.ts`; the no-double-count
// invariant (§5.5) by `__tests__/usage-no-double-count.test.ts`.

import { join } from 'node:path';
import { activeUsageScope, MeteredProvider } from '@ethosagent/core';
import { estimateCost } from '@ethosagent/pricing';
import { SQLiteUsageLedger } from '@ethosagent/session-sqlite';
import type {
  DecisionProvider,
  DecisionResult,
  LLMProvider,
  UsageAttribution,
  UsageGate,
  UsageMeterEvent,
  UsageRecord,
  UsageRecorder,
  UsageSourceKind,
} from '@ethosagent/types';
import { sourceClassOf, usageMeterEventRecord } from '@ethosagent/types';

/** A row whose caller priced it; `ts` and `sourceClass` are filled in. */
export type ExternalUsage = Omit<UsageRecord, 'ts' | 'sourceClass'> & { ts?: string };

export interface UsageMeter {
  /** Fail-open, defaults-filling recorder — `AgentLoopConfig.usage.recorder`. */
  readonly recorder: UsageRecorder;
  /** `provider` metered as `kind`. Never hand it to a persistent loop's main call (§5.5). */
  meter(provider: LLMProvider, kind: UsageSourceKind, attribution?: UsageAttribution): LLMProvider;
  /**
   * Record a call that bypassed `LLMProvider`. The active usage scope fills
   * missing attribution, and a `turn_utility` row is charged to the turn whose
   * scope is still open — the same rules `MeteredProvider` applies.
   */
  recordExternal(row: ExternalUsage): void;
  /**
   * `provider` with each answered `decide()` recorded as one `decision` row,
   * priced with `estimateCost` (D13). Wrapped once per build, where wiring
   * creates the decision provider, so every decision site and the `decide`
   * tool share it (D29).
   */
  meterDecision(provider: DecisionProvider): DecisionProvider;
}

/** An answered `decide()` as a ledger row — no cache tokens, outcome `ok`. */
function decisionUsageRow(
  provider: string,
  result: Extract<DecisionResult, { ok: true }>,
): ExternalUsage {
  const { inputTokens, outputTokens } = result.usage;
  return {
    kind: 'decision',
    provider,
    model: result.model,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: estimateCost(result.model, { inputTokens, outputTokens }).costUsd,
    outcome: 'ok',
  };
}

export interface CreateUsageMeterOptions {
  /** Where rows go — `SQLiteUsageLedger` in production. May throw. */
  recorder: UsageRecorder;
  /** Attribution every row gets where its own is silent: the build's `botKey`. */
  defaults?: UsageAttribution;
  /**
   * Background-budget gate (Lane E, `Gateway.backgroundGate`). Asked with the
   * call's attribution filled from `defaults` where the call is silent, so it
   * judges the bot the row will be billed to. Absent → never gated.
   */
  gate?: UsageGate;
  /** `usage.background_skipped` / `usage.ledger_write_failed` land here (§8). */
  observability?: {
    recordSafetyBlock(opts: {
      code?: string;
      cause?: string;
      details?: Record<string, unknown>;
    }): void;
  };
}

export function createUsageMeter(opts: CreateUsageMeterOptions): UsageMeter {
  const onEvent = (event: UsageMeterEvent): void => {
    if (!opts.observability) return;
    try {
      opts.observability.recordSafetyBlock(usageMeterEventRecord(event));
    } catch {
      // Observability is fail-open: it must never break the call it observes.
    }
  };

  const outer = opts.gate;
  const gate: UsageGate | undefined = outer
    ? (request) => outer({ ...request, attribution: { ...opts.defaults, ...request.attribution } })
    : undefined;

  const recorder: UsageRecorder = {
    record(row) {
      try {
        opts.recorder.record({ ...opts.defaults, ...row });
      } catch (err) {
        onEvent({
          type: 'usage.ledger_write_failed',
          kind: row.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };

  const recordExternal = (row: ExternalUsage): void => {
    const cost = row.estimatedCostUsd;
    // A call that reached no provider (a cached or short-circuited answer) is not spend.
    if (row.inputTokens === 0 && row.outputTokens === 0 && cost === 0) return;
    const scope = activeUsageScope();
    const sourceClass = sourceClassOf(row.kind);
    recorder.record({
      ...scope?.attribution,
      ...row,
      ts: row.ts ?? new Date().toISOString(),
      sourceClass,
    });
    if (sourceClass === 'turn_utility' && scope?.open && scope.charge && cost > 0) {
      scope.charge(cost);
    }
  };

  return {
    recorder,
    meter(provider, kind, attribution) {
      return new MeteredProvider({
        inner: provider,
        recorder,
        kind,
        ...(attribution ? { attribution } : {}),
        ...(gate ? { gate } : {}),
        onEvent,
      });
    },
    recordExternal,
    meterDecision(provider) {
      return {
        name: provider.name,
        calibrated: provider.calibrated,
        decide: async (request) => {
          const result = await provider.decide(request);
          if (result.ok) recordExternal(decisionUsageRow(provider.name, result));
          return result;
        },
      };
    },
  };
}

export interface WithUsageMeterOptions extends Omit<CreateUsageMeterOptions, 'recorder'> {
  /** The state dir whose `sessions.db` holds the ledger. */
  dataDir: string;
}

/**
 * The meter for a command with no `AgentLoop` (`nightly`, `eval --evolve`,
 * `personality evolve`). A process that builds a loop must borrow
 * `CreateAgentLoopResult.usageMeter` instead, never open a second one (D4, D33).
 * The `<dataDir>/sessions.db` handle opens on the first recorded call, so a run
 * that makes no model call never opens it, and closes in `finally`. Diagnostics
 * must not call this (D12 — `diagnostics-never-migrate.test.ts`).
 */
export async function withUsageMeter<T>(
  opts: WithUsageMeterOptions,
  fn: (meter: UsageMeter) => Promise<T>,
): Promise<T> {
  const { dataDir, ...rest } = opts;
  let ledger: SQLiteUsageLedger | undefined;
  const meter = createUsageMeter({
    ...rest,
    recorder: {
      record(row) {
        ledger ??= new SQLiteUsageLedger(join(dataDir, 'sessions.db'));
        ledger.record(row);
      },
    },
  });
  try {
    return await fn(meter);
  } finally {
    ledger?.close();
  }
}
