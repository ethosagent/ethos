// runDecisionSite — the ONE helper every decision site runs through
// (plan/phases/decision-provider-jev.md §8, R4). Tier 0: it bounds how much
// authority a decision provider's answer carries (ARCHITECTURE.md Law 11, plan
// §11), so it is listed in `@ethosagent/wiring`'s `kernel_paths` in
// `.architecture-state.yaml`.
//
//                site call (injection | approver | router)
//                                │
//                  mode = decisions.sites.<site>   (R6: `on` with no threshold ⇒ `shadow`)
//       ┌────────────────────────┼─────────────────────────────┐
//      off                    shadow                           on
//       │                        │                              │
//  today's path   ┌──────────────┴──────────────┐      redact digest (R2)
//                 │                             │               │
//         today's path (awaited)   redact → decide()    decide(site budget, R9)
//                 │                NOT awaited (R8)             │
//         return today's verdict   └─► record Jev +     ok ∧ calibrated ∧ conf ≥ T ?
//                                      disagreement        yes │            │ no / error
//                                      when it settles         ▼            ▼
//                                                      Jev verdict     today's path (D11)
//                                                      (bounded by the kernel, Law 11)
//
// What this file guarantees, each pinned by `__tests__/decision-site.test.ts`:
// - `off`, or no provider → `today()` only; `decide()` is never called.
// - The digest is redacted (`redactString` / `redactJson`, @ethosagent/safety-redact)
//   BEFORE it is handed to `decide()` (R2) — here, never in the extension.
// - `on` acts on the provider's answer only when `ok`, `calibrated`, and the
//   site's `gate` maps it to a verdict (the gate applies the site threshold via
//   `meetsThreshold`, which fails closed on a missing threshold). Anything
//   else takes `today()` (D11).
// - `shadow` never awaits the provider (R8): today's verdict returns the moment
//   `today()` settles; the provider's reading and the disagreement are recorded
//   whenever `decide()` settles, however late.
// - The provider can never make a site throw. A throwing `today()` propagates
//   exactly as it would without this helper.
//
// Cost accounting (D13) — KNOWN LIMITATION. The plan asks for decision usage to
// flow "through the same accounting as LLM usage". No such path exists from a
// classifier or approver: `InjectionClassifier` (packages/types/src/safety.ts)
// returns only a verdict, `result-defense.ts` has no cost channel, and the
// per-turn `sessionCosts` map is private to `AgentLoop` (the same gap
// `smart-approver.ts`'s "Known limitation: reviewer spend is not attributed"
// documents; today's LLM classifier discards its usage too). Closing it is a
// contract change under packages/types/. Until then the cost is computed with
// `estimateCost` (@ethosagent/pricing) and recorded on every `decision.call` /
// `decision.shadow` observability event, where it is queryable but NOT seen by
// budget watchers.

import type { DecisionSiteId, DecisionSiteMode } from '@ethosagent/config';
import { estimateCost } from '@ethosagent/pricing';
import { redactJson, redactString } from '@ethosagent/safety-redact';
import type {
  DecisionAnswer,
  DecisionErrorCode,
  DecisionProvider,
  DecisionQuestion,
  DecisionResult,
} from '@ethosagent/types';

/** What leaves the machine. `text` is redacted with `redactString`, `json` with `redactJson`. */
export type DecisionDigest =
  | { kind: 'text'; value: string }
  | { kind: 'json'; value: Record<string, unknown> };

/** One `decide()` call as observability records it (D13). */
export interface DecisionCallRecord {
  site: DecisionSiteId;
  mode: 'shadow' | 'on';
  provider: string;
  /** The model id the provider RETURNED (D8); absent when the call failed. */
  model?: string;
  latencyMs: number;
  inputTokens: number;
  questionCount: number;
  outcome: 'ok' | DecisionErrorCode;
  estimatedCostUsd: number;
  /** `on` only: whether the provider's verdict was acted on. */
  acted?: boolean;
  /** `shadow` only: the provider's pre-threshold reading, when it answered. */
  jevVerdict?: unknown;
  /** `shadow` only: the verdict today's path returned (absent when it threw). */
  todayVerdict?: unknown;
  /** `shadow` only: set when both a reading and today's verdict exist. */
  disagreed?: boolean;
}

export interface DecisionSiteRecorder {
  recordDecisionCall(record: DecisionCallRecord): void;
}

export interface RunDecisionSiteOptions<V, J> {
  site: DecisionSiteId;
  /** The site's EFFECTIVE mode (R6), from `resolveDecisionsConfig`. */
  mode: DecisionSiteMode;
  provider: DecisionProvider | undefined;
  digest: DecisionDigest;
  questions: Record<string, DecisionQuestion>;
  /** This site's per-call budget (R9). */
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * The provider's answers → a verdict to act on, or `null` when the answer is
   * not usable (below threshold, missing threshold, wrong shape). Use
   * `meetsThreshold` so every site applies the threshold the same way (D12).
   */
  gate: (answers: Record<string, DecisionAnswer>) => V | null;
  /**
   * `shadow`: the provider's PRE-threshold reading, recorded as `jevVerdict`
   * (p ≥ 0.5 for a boolean, the argmax for a choice — plan §8). `null` when
   * the answer cannot be read.
   */
  interpret: (answers: Record<string, DecisionAnswer>) => J | null;
  disagrees: (jev: J, today: V) => boolean;
  today: () => Promise<V>;
  recorder?: DecisionSiteRecorder;
  now?: () => number;
}

/**
 * The uniform threshold rule (plan §8, D12): act only at `confidence ≥ T`. A
 * missing threshold never passes — config already reads `on` without one as
 * `shadow` (R6), and this keeps the rule true for any caller that did not.
 */
export function meetsThreshold(confidence: number, threshold: number | undefined): boolean {
  return threshold !== undefined && confidence >= threshold;
}

interface Consultation {
  result: DecisionResult;
  latencyMs: number;
}

export async function runDecisionSite<V, J>(opts: RunDecisionSiteOptions<V, J>): Promise<V> {
  const provider = opts.provider;
  if (opts.mode === 'off' || provider === undefined) return opts.today();

  const now = opts.now ?? Date.now;
  const questionCount = Object.keys(opts.questions).length;

  // Never rejects: every failure — redaction included — becomes an error result.
  const consult = async (): Promise<Consultation> => {
    const started = now();
    try {
      const state =
        opts.digest.kind === 'text'
          ? redactString(opts.digest.value)
          : redactJson(opts.digest.value);
      const result = await provider.decide({
        state,
        questions: opts.questions,
        timeoutMs: opts.timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      return { result, latencyMs: now() - started };
    } catch (err) {
      return {
        result: {
          ok: false,
          code: 'unavailable',
          message: err instanceof Error ? err.message : String(err),
        },
        latencyMs: now() - started,
      };
    }
  };

  const record = (
    mode: 'shadow' | 'on',
    c: Consultation,
    extra: Partial<DecisionCallRecord>,
  ): void => {
    if (!opts.recorder) return;
    const r = c.result;
    const inputTokens = r.ok ? r.usage.inputTokens : 0;
    const outputTokens = r.ok ? r.usage.outputTokens : 0;
    try {
      opts.recorder.recordDecisionCall({
        site: opts.site,
        mode,
        provider: provider.name,
        ...(r.ok ? { model: r.model } : {}),
        latencyMs: c.latencyMs,
        inputTokens,
        questionCount,
        outcome: r.ok ? 'ok' : r.code,
        estimatedCostUsd: r.ok ? estimateCost(r.model, { inputTokens, outputTokens }).costUsd : 0,
        ...extra,
      });
    } catch {
      // Observability is fail-open: a broken recorder must not change a verdict.
    }
  };

  const safely = <T>(fn: () => T): T | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  if (opts.mode === 'on') {
    const c = await consult();
    const r = c.result;
    const verdict = r.ok && provider.calibrated ? safely(() => opts.gate(r.answers)) : null;
    record('on', c, { acted: verdict !== null });
    if (verdict !== null) return verdict;
    return opts.today();
  }

  // shadow (R8): start the provider, await only today's path.
  const pending = consult();
  let todayVerdict: V;
  try {
    todayVerdict = await opts.today();
  } catch (err) {
    void pending.then((c) => record('shadow', c, readingOf(c)));
    throw err;
  }
  void pending.then((c) => {
    const reading = readingOf(c);
    const jev = reading.jevVerdict;
    const disagreed =
      jev === undefined ? undefined : safely(() => opts.disagrees(jev, todayVerdict));
    record('shadow', c, {
      ...reading,
      todayVerdict,
      ...(typeof disagreed === 'boolean' ? { disagreed } : {}),
    });
  });
  return todayVerdict;

  function readingOf(c: Consultation): { jevVerdict?: J } {
    if (!c.result.ok) return {};
    const answers = c.result.answers;
    const jev = safely(() => opts.interpret(answers));
    return jev === null ? {} : { jevVerdict: jev };
  }
}
