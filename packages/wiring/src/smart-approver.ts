// LLM-judged smart approvals — the reviewer behind `approvalMode: 'smart'`.
//
// The danger predicate calls this only for tool calls that already reached the
// danger branch (hardline commands, always-ask tools). The common path never
// pays for it, and a personality on `manual` or `off` never constructs the
// provider at all.
//
// Decision-provider site (plan/phases/decision-provider-jev.md §8.2, D17, C5).
// With the optional `decision` option, a flagged call is reviewed in this order:
//
//   verdict cache ──hit──► cached verdict (neither the provider nor the LLM runs)
//        │ miss
//   runDecisionSite (./decision-site: off / shadow / on, redaction, calibrated
//        │           check, fail → today's path)
//        ├─ on, gate passes (`approverVerdictFrom`) ──► Jev's verdict, cached
//        └─ otherwise ──► today's LLM review, cached only when model-produced
//
// all inside the one `timeoutMs` outer bound (default 15 s), whose expiry is
// `ask` and never cached. The decision call itself runs on the site's own
// budget (`decisions.timeouts.approver`, R9). Without `decision`, the review
// path is exactly the LLM path below. Pinned by
// `__tests__/smart-approver-decision.test.ts`; the no-decision behaviour by
// the unchanged `__tests__/smart-approver.test.ts` (R7).

import { createHash } from 'node:crypto';
import type { DecisionSiteMode } from '@ethosagent/config';
import type {
  BeforeToolCallPayload,
  DecisionAnswer,
  DecisionProvider,
  LLMProvider,
  Message,
} from '@ethosagent/types';
import type { SmartApprovalCallback, SmartVerdict } from './danger-predicate';
import { canonicalizeArgs } from './danger-predicate';
import {
  APPROVER_CHOICES,
  APPROVER_QUESTIONS,
  type ApproverChoice,
  approverDigest,
  DECISION_QUESTION_IDS,
} from './decision-questions';
import {
  type DecisionRecordTracker,
  type DecisionSiteRecorder,
  meetsThreshold,
  runDecisionSite,
} from './decision-site';

/** Wall-clock bound on the reviewer round-trip. Exceeding it yields `ask`. */
const DEFAULT_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT =
  'You review tool calls an autonomous agent wants to make, and decide whether ' +
  'the call needs a human in the loop. Answer with a single JSON object and no ' +
  'other text: {"decision":"approve"|"deny"|"ask","reason":"..."} where\n' +
  '  approve — the call is routine and reversible; let it run unattended.\n' +
  '  deny    — the call is destructive, irreversible, or clearly outside the ' +
  'stated task; it must not run.\n' +
  '  ask     — anything you are not confident about; a human decides.\n' +
  'Prefer "ask" over "approve" whenever you hesitate. Keep "reason" to one ' +
  'short sentence naming the concrete risk.';

export interface CreateSmartApproverOptions {
  /**
   * Lazy provider handle. Never invoked unless a tool call actually reaches
   * the reviewer, so `manual` / `off` personalities pay nothing for it.
   */
  getProvider: () => Promise<LLMProvider>;
  /** Model the reviewer runs on, passed as `modelOverride`. */
  model: string;
  /** Round-trip bound; on expiry the verdict is `ask`. Default 15s. */
  timeoutMs?: number;
  /**
   * The approver's decision site (plan decision-provider-jev §8.2). Absent →
   * no decision layer: exactly the LLM reviewer.
   */
  decision?: SmartApproverDecisionSite;
}

/** What the composition root resolved for the `approver` decision site. */
export interface SmartApproverDecisionSite {
  /** The ONE provider instance of the composition root (shared breaker, §5.5). */
  decisions: DecisionProvider | undefined;
  /** `decisions.sites.approver`, EFFECTIVE (R6: `on` without both thresholds is `shadow`). */
  mode: DecisionSiteMode;
  /** `decisions.thresholds.approver.approve` / `.deny` (T_approve, T_deny). */
  thresholds: { approve?: number; deny?: number };
  /** `decisions.timeouts.approver` resolved (R9, default 2000). */
  timeoutMs: number;
  recorder?: DecisionSiteRecorder;
  /** The build's shadow-record tracker, drained at dispose (R8). */
  tracker?: DecisionRecordTracker;
}

/** The single question id this site asks. */
export const APPROVER_QUESTION_ID = DECISION_QUESTION_IDS.approver;

function isApproverChoice(choice: string): choice is ApproverChoice {
  return APPROVER_CHOICES.some((c) => c === choice);
}

/** The answer to this site's question, or `null` for a missing / off-list one. */
function approverChoice(
  answers: Record<string, DecisionAnswer>,
): { choice: ApproverChoice; confidence: number } | null {
  const a = answers[APPROVER_QUESTION_ID];
  if (a?.type !== 'choice' || !isApproverChoice(a.choice)) return null;
  return { choice: a.choice, confidence: a.confidence };
}

/**
 * D17: `approve` only when the choice is `approve` at `confidence ≥ T_approve`;
 * `deny` only when the choice is `deny` at `confidence ≥ T_deny`; an `ask`
 * answer is `ask` at any confidence, because asking is never less safe than
 * today. The reason is `dangerReason`, which is deterministic — a provider
 * writes no text, so no justification it did not make is shown. `null` →
 * today's LLM path. A missing threshold never passes (`meetsThreshold`).
 */
export function approverVerdictFrom(
  answers: Record<string, DecisionAnswer>,
  thresholds: { approve?: number; deny?: number },
  dangerReason: string,
): SmartVerdict | null {
  const a = approverChoice(answers);
  if (!a) return null;
  switch (a.choice) {
    case 'approve':
      return meetsThreshold(a.confidence, thresholds.approve)
        ? { decision: 'approve', reason: dangerReason }
        : null;
    case 'deny':
      return meetsThreshold(a.confidence, thresholds.deny)
        ? { decision: 'deny', reason: dangerReason }
        : null;
    case 'ask':
      return { decision: 'ask', reason: dangerReason };
  }
}

/**
 * A verdict tagged with whether it may be cached (C5). Only a verdict a model
 * or the provider actually produced is `cacheable`; every fail-closed `ask`
 * (timeout, parse failure, error) is not.
 */
interface Reviewed {
  verdict: SmartVerdict;
  cacheable: boolean;
}

function isReviewed(value: unknown): value is Reviewed {
  return typeof value === 'object' && value !== null && 'verdict' in value && 'cacheable' in value;
}

/**
 * Shadow records carry today's bare `SmartVerdict`: `cacheable` is this file's
 * cache bookkeeping (C5), not a verdict. Pinned by
 * `__tests__/smart-approver-decision.test.ts` ("shadow caches only today's verdict").
 */
function bareVerdictRecorder(recorder: DecisionSiteRecorder): DecisionSiteRecorder {
  return {
    recordDecisionCall: (record) =>
      recorder.recordDecisionCall(
        isReviewed(record.todayVerdict)
          ? { ...record, todayVerdict: record.todayVerdict.verdict }
          : record,
      ),
  };
}

/**
 * Cache key. Scoped to the exact call, NOT the tool name: an approval for
 * `rm -rf ./build` must never short-circuit `rm -rf ./src`.
 */
function verdictKey(payload: BeforeToolCallPayload): string {
  return createHash('sha256')
    .update(`${payload.toolName} ${canonicalizeArgs(payload.args)}`)
    .digest('hex');
}

function parseVerdict(text: string): SmartVerdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { decision, reason } = parsed as { decision?: unknown; reason?: unknown };
  if (decision !== 'approve' && decision !== 'deny' && decision !== 'ask') return null;
  return { decision, reason: typeof reason === 'string' ? reason : 'no reason given' };
}

async function review(
  provider: LLMProvider,
  model: string,
  payload: BeforeToolCallPayload,
  dangerReason: string,
): Promise<SmartVerdict | null> {
  const messages: Message[] = [
    {
      role: 'user',
      content:
        `Tool: ${payload.toolName}\n` +
        `Arguments: ${canonicalizeArgs(payload.args)}\n` +
        `Why it was flagged: ${dangerReason}`,
    },
  ];
  let text = '';
  for await (const chunk of provider.complete(messages, [], {
    system: SYSTEM_PROMPT,
    maxTokens: 200,
    temperature: 0,
    modelOverride: model,
  })) {
    if (chunk.type === 'text_delta') text += chunk.text;
  }
  return parseVerdict(text);
}

/**
 * Build the `approvalMode: 'smart'` reviewer.
 *
 * **Fail closed.** Every failure mode — provider construction error, stream
 * error, timeout, unparseable response — yields `{ decision: 'ask' }`, which
 * routes the call back into the normal approval flow. `approve` is only ever
 * returned for a verdict the model actually produced — the LLM reviewer's, or,
 * with the `decision` option, the decision provider's at `confidence ≥
 * T_approve` (`approverVerdictFrom`).
 *
 * **Never throws.** `fireModifying` is fail-OPEN on handler throw
 * (`packages/core/src/hook-registry.ts:105-107` catches and continues), so an
 * approver that propagated an exception would let the dangerous tool *execute*
 * — the exact inverse of this module's posture. Every error is caught here.
 *
 * **Known limitation: reviewer spend is not attributed.** There is no path
 * from a `before_tool_call` hook into per-turn cost accounting — `sessionCosts`
 * has two writers, both needing a `ToolResult` or stage deps, and the map is
 * private to `AgentLoop`. Closing it means an `extraCostUsd` field on
 * `BeforeToolCallResult`, a contract change under `packages/types/`. Existing
 * precedent discards usage the same way: `extensions/tools-kanban/src/verifier.ts`
 * records nothing, and `extensions/eval-harness/src/scorers.ts` drops the usage
 * chunks entirely. Volume is bounded instead of measured: the reviewer fires
 * only for calls that already reached the danger branch. Attribution is a
 * follow-up.
 *
 * The cheap-model auxiliary split (an `auxiliary.approvals` config block, the
 * shape `build-agent-loop.ts` uses for `auxiliaryVision` / `auxiliaryWeb`) is a
 * deliberate follow-up. `approvalMode: 'smart'` ships in no personality today,
 * so wiring config surface for it now would be speculative; callers pass the
 * primary model until someone opts in.
 */
export function createSmartApprover(opts: CreateSmartApproverOptions): SmartApprovalCallback {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Only model-produced verdicts are cached — a timeout or parse failure must
  // not stick to the call forever. A verdict the decision provider decided
  // above its threshold is model-produced too (C5); see `Reviewed`.
  const cache = new Map<string, SmartVerdict>();

  // Today's path: the LLM review, bounded by `bound` ms.
  const reviewByLlm = async (
    payload: BeforeToolCallPayload,
    dangerReason: string,
    bound: number,
  ): Promise<Reviewed> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const provider = await opts.getProvider();
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), bound);
        timer.unref?.();
      });
      const verdict = await Promise.race([
        review(provider, opts.model, payload, dangerReason),
        timeout,
      ]);
      if (!verdict) {
        return {
          verdict: { decision: 'ask', reason: 'reviewer gave no usable verdict' },
          cacheable: false,
        };
      }
      return { verdict, cacheable: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        verdict: { decision: 'ask', reason: `reviewer error (fail-closed): ${message}` },
        cacheable: false,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const decision = opts.decision;

  // The decision site in front of today's path, all under the one outer bound.
  const reviewWithDecision = async (
    site: SmartApproverDecisionSite,
    payload: BeforeToolCallPayload,
    dangerReason: string,
  ): Promise<Reviewed> => {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const outer = new Promise<Reviewed>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            verdict: { decision: 'ask', reason: 'reviewer gave no usable verdict' },
            cacheable: false,
          }),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([
        runDecisionSite<Reviewed, ApproverChoice>({
          site: 'approver',
          mode: site.mode,
          provider: site.decisions,
          digest: {
            kind: 'json',
            value: approverDigest({ toolName: payload.toolName, args: payload.args, dangerReason }),
          },
          questions: APPROVER_QUESTIONS,
          timeoutMs: site.timeoutMs,
          gate: (answers) => {
            const verdict = approverVerdictFrom(answers, site.thresholds, dangerReason);
            return verdict ? { verdict, cacheable: true } : null;
          },
          // Shadow reading (plan §8): the argmax choice, before any threshold.
          interpret: (answers) => approverChoice(answers)?.choice ?? null,
          disagrees: (jev, today) => jev !== today.verdict.decision,
          // Today's path gets what is left of the outer bound.
          today: () =>
            reviewByLlm(payload, dangerReason, Math.max(0, timeoutMs - (Date.now() - started))),
          ...(site.recorder ? { recorder: bareVerdictRecorder(site.recorder) } : {}),
          ...(site.tracker ? { tracker: site.tracker } : {}),
        }),
        outer,
      ]);
    } catch (err) {
      // runDecisionSite rethrows only what today's path throws, and
      // `reviewByLlm` never throws; kept so this callback can never throw.
      const message = err instanceof Error ? err.message : String(err);
      return {
        verdict: { decision: 'ask', reason: `reviewer error (fail-closed): ${message}` },
        cacheable: false,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return async (payload, dangerReason) => {
    const key = verdictKey(payload);
    const cached = cache.get(key);
    if (cached) return cached;

    const reviewed = decision
      ? await reviewWithDecision(decision, payload, dangerReason)
      : await reviewByLlm(payload, dangerReason, timeoutMs);
    if (reviewed.cacheable) cache.set(key, reviewed.verdict);
    return reviewed.verdict;
  };
}
