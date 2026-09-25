// ---------------------------------------------------------------------------
// Agent events emitted by run()
//
// AgentEvent is a forward-compatible discriminated union. New event `type`
// values may be added in any release. **Consumers MUST treat unknown event
// types as a no-op, not throw.** A `switch (event.type)` with no `default`
// case is a forward-compat bug — it will silently break the moment a new
// variant ships. Use `isKnownAgentEvent(event)` if you want an opt-in
// warning during development that a new event type appeared.
//
// Known event types live in `KNOWN_AGENT_EVENT_TYPES` below. Keep it in
// sync when adding a new variant — the `isKnownAgentEvent` helper reads
// from it, and downstream tools (the CLI verbose mode, telemetry filters)
// can iterate it.
// ---------------------------------------------------------------------------

import type { DecisionErrorCode } from './decision';
import type { ModelDeviation, ModelResolutionSource } from './model-registry';

export const KNOWN_AGENT_EVENT_TYPES = [
  'text_delta',
  'thinking_delta',
  'tool_start',
  'tool_progress',
  'tool_end',
  'usage',
  'error',
  'done',
  'halt',
  'context_meta',
  'run_start',
  'dry_run_summary',
  'tool_approval_required',
  'tool_approval_response',
  'evaluators_complete',
  'credential_required',
  'notification_received',
  'decision',
] as const;

export type KnownAgentEventType = (typeof KNOWN_AGENT_EVENT_TYPES)[number];

/**
 * Returns true when the event's `type` is one a current consumer knows
 * about. Useful for development-mode warnings:
 *
 *     for await (const event of loop.run(...)) {
 *       if (!isKnownAgentEvent(event)) {
 *         console.warn('Unknown AgentEvent type:', event.type);
 *         continue;
 *       }
 *       switch (event.type) { ... }
 *     }
 *
 * Production code should silently skip unknown events; this helper is for
 * test runs and dev surfaces that want to alert on newly-added variants.
 */
export function isKnownAgentEvent(event: { type: string }): event is AgentEvent {
  return (KNOWN_AGENT_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * The part of a turn's answer that reached the consumer ONLY in `done.text`,
 * or `''`.
 *
 * In a normal turn `done.text` is the concatenation of every `text_delta` the
 * turn streamed (`fullText` in packages/core/src/agent-loop.ts), so nothing is
 * owed. On the `returnDirect` path it is the tool's answer, which never
 * streamed — possibly after a preamble the model did stream before calling
 * the tool (packages/core/src/agent-loop/stages/return-direct.ts). So the
 * answer is owed whenever `done.text` is non-empty and the streamed text does
 * not already end with it. One rule for every surface; pinned by
 * `__tests__/unstreamed-answer.test.ts`.
 *
 * NOT guaranteed — two known limits of deciding from text alone (no event says
 * "this turn was returnDirect"):
 *  - A preamble that happens to END WITH the tool's answer text (streamed
 *    `'…Done.'`, answer `'Done.'`) reads as a normal turn, so the answer is
 *    not appended. The user saw the same characters, but not as the answer.
 *  - The rule needs the WHOLE streamed text, and cannot tell that it was given
 *    less. A consumer that saw only the tail of a long turn (the web
 *    `SessionStreamBuffer` evicting its head, a client that joined late) holds
 *    a text that does not end with `done.text`, so it re-appends the full
 *    answer — a duplicate. Pass everything the turn streamed, or gate the call
 *    on having seen the turn start: the web reducer does, with `streamAnchored`
 *    (apps/web/src/lib/chat-reducer.ts).
 */
export function unstreamedAnswer(streamedText: string, doneText: string | undefined): string {
  if (!doneText || streamedText.endsWith(doneText)) return '';
  return doneText;
}

/**
 * What to append after the streamed text so the reply is complete: the
 * {@link unstreamedAnswer}, after a blank line when anything visible streamed
 * before it, or `''`. `streamedText + answerSuffix(...)` is the whole reply.
 */
export function answerSuffix(streamedText: string, doneText: string | undefined): string {
  const answer = unstreamedAnswer(streamedText, doneText);
  if (!answer) return '';
  return streamedText.trim() ? `\n\n${answer}` : answer;
}

export interface DryRunToolPlan {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export type ToolProgressAudience = 'internal' | 'user' | 'dashboard';

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  // tools-as-code-api Lane E — `audience` mirrors the Phase 30.2 field on
  // `tool_end`. In-script inner calls emit real tool_start events tagged
  // `'internal'` (toolCallId namespaced `<parentToolCallId>#<n>`); surfaces
  // MUST NOT render those to the user. Absent = LLM-issued call, renders as
  // before. Additive optional field — NOT a new event variant.
  | {
      type: 'tool_start';
      toolCallId: string;
      toolName: string;
      args: unknown;
      audience?: ToolProgressAudience;
    }
  // Phase 30.2 — `audience` gates whether channel adapters / chat.ts surface
  // this event to the user. Default is `'internal'`; tools opt in to `'user'`
  // per event. Framework-emitted budget warnings are `'user'` (see step 7).
  | {
      type: 'tool_progress';
      toolName: string;
      message: string;
      percent?: number;
      audience: ToolProgressAudience;
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      durationMs: number;
      // Phase 30.2 — same boundary applies to tool_end success rendering.
      // Failures (`ok: false`) ignore the field and always render.
      audience?: ToolProgressAudience;
      /**
       * Tool output body — the success value when `ok`, or the error
       * message when `ok: false`. Optional so consumers that only care
       * about the status (CLI ASCII chips, telemetry) can ignore it.
       * The web chip surfaces this on expand-on-click without a
       * follow-up history fetch.
       */
      result?: string;
      /** Structured payload from the tool's ToolResult, passed through for
       *  rich-content rendering (e.g. _uiType: 'image' | 'html'). */
      structured?: Record<string, unknown>;
      /** Error message from the tool's ToolResult. Only set when `ok: false`. */
      error?: string;
    }
  // A6 — `cacheReadTokens` / `cacheCreationTokens` are ADDITIVE-OPTIONAL (see
  // ARCHITECTURE.md §VII, Agent event union). They mirror the provider's
  // `TokenUsage` fields and are present only when the provider actually
  // reported cache activity; a cacheless call omits them rather than
  // reporting a misleading 0, so consumers can tell "no caching" apart from
  // "cached nothing this call".
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    }
  | { type: 'error'; error: string; code: string }
  // B3 — `traceId` is ADDITIVE-OPTIONAL (see ARCHITECTURE.md §VII, Agent event
  // union: the bump trigger is adding/removing/renaming a VARIANT, which this
  // is not). It is the turn's observability trace id — the same id the turn's
  // spans hang off and `messages.trace_id` carries — so a surface that only
  // sees the event stream can still name the turn. Absent when no
  // observability adapter is wired.
  | { type: 'done'; text: string; turnCount: number; traceId?: string }
  /**
   * Emitted when the loop stops a turn early for safety: a per-turn tool
   * budget tripped (`kind: 'budget'`, rule is one of 'tool-budget' |
   * 'identical-name' | 'identical-streak') or the safety watcher paused the
   * turn (`kind: 'watcher'`, rule is the watcher rule id). A normal `done`
   * still follows — consumers that judge or persist turn output (e.g. the
   * goal runner) use this event to know the output is truncated, not clean.
   * Watcher *terminations* remain `error` events, not `halt`.
   */
  | {
      type: 'halt';
      kind: 'budget' | 'watcher';
      rule: string;
      toolName?: string;
      count?: number;
      message: string;
    }
  // Emitted once after context injectors run; carries any metadata they wrote to PromptContext.meta.
  | { type: 'context_meta'; data: Record<string, unknown> }
  /**
   * Emitted once at the very start of each turn, before any LLM call.
   * Carries the resolved provider/model and the routing source so consumers
   * (TUI status bar, CLI verbose mode, telemetry) can show the effective model.
   * `source` reflects which routing rule selected the model (see model_update.md).
   *
   * B3 — `traceId` is ADDITIVE-OPTIONAL, same rationale as on `done`. This is
   * the first event of a turn, so it is where a surface learns the turn's
   * identity before any output arrives.
   */
  | {
      type: 'run_start';
      provider: string;
      model: string;
      /**
       * T1.15a / D7 — the SEVEN rung labels `resolveModel` returns, not a
       * parallel vocabulary. `'global'` was renamed `'default'` in the same
       * audit: one fact, one spelling. Widening a union on a frozen event is an
       * ARCHITECTURE.md §VII consumer audit — every consumer was walked
       * (`packages/agent-bridge`, `packages/web-contracts/src/events.ts`, the
       * CLI render gates, the web reducers, the golden fixtures).
       */
      source: ModelResolutionSource;
      /**
       * D17 — set when this turn is running on something other than what was
       * declared. Every surface renders it through `describeDeviation`
       * (`packages/core/src/model-resolution.ts`) rather than restating the
       * copy; `turn-setup.ts` attaches it, suppressing a `once: true` row it
       * has already announced for this `(personalityId, kind, declared)`.
       *
       * Additive-optional: absent → byte-identical to before.
       */
      deviation?: ModelDeviation;
      traceId?: string;
    }
  | {
      type: 'dry_run_summary';
      plan: DryRunToolPlan[];
      capped: number;
    }
  | { type: 'tool_approval_required'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_approval_response'; toolCallId: string; approved: boolean; reason?: string }
  | {
      type: 'evaluators_complete';
      results: Array<{ name: string; pass: boolean; reason?: string; score?: number }>;
    }
  | {
      type: 'credential_required';
      pluginId: string;
      credentialKey: string;
      kind: 'oauth' | 'api_key' | 'text';
      label: string;
      description?: string;
      authUrl?: string;
      sessionKey: string;
      pendingUserMessage: string;
    }
  | {
      type: 'notification_received';
      pluginId: string;
      sessionKey: string;
      message: string;
      startTurn: boolean;
      payload?: Record<string, unknown>;
    }
  /**
   * A decision site ran for this turn (plan decision-provider-personality §15,
   * N7). Emitted by `runDecisionSite` (packages/wiring/src/decision-site.ts)
   * through the per-call `DecisionSink` core hands the site, and yielded by the
   * loop at its next yield point — the post-`done` tail included, so only a
   * consumer that drains the iterator sees a late shadow row (PD17).
   *
   * Audience (§15.4): web, desktop and CLI chat may render it; channel
   * adapters, the gateway streamer, `ethos -z`, TUI, ACP, A2A and
   * `/v1/chat/completions` do not. Like internal `tool_progress`, it is
   * never a message to the user of a channel.
   *
   * Summaries only (K13): never the redacted digest, the question text or the
   * provider's raw answer object.
   */
  | {
      type: 'decision';
      /** Stable per call; a `started` and its `settled` share it. */
      id: string;
      /** PD20: `started` is emitted only in `on` mode, where the loop is waiting. */
      phase: 'started' | 'settled';
      site: 'injection' | 'approver' | 'router';
      /** Catalog id of the provider, e.g. `'typesafe'`. */
      provider: string;
      /** The model id the provider RETURNED (D8); absent on failure and on `started`. */
      model?: string;
      mode: 'on' | 'shadow';
      /** `settled` only. */
      outcome?: 'ok' | DecisionErrorCode;
      /** `on` only: whether the provider's verdict was acted on. */
      acted?: boolean;
      /** Short summary: `'clean' | 'flagged' | 'approve' | 'deny' | 'ask' | 'trivial' | 'default'`. */
      verdict?: string;
      /** `shadow` only: today's path's verdict, same vocabulary. */
      todayVerdict?: string;
      confidence?: number;
      /** `settled` only. */
      latencyMs?: number;
      /** `shadow` only, and only when both paths were measured on the same input. */
      todayLatencyMs?: number;
      /** `shadow` only: set when both a reading and today's verdict exist. */
      disagreed?: boolean;
      /** PD15: the personality whose `decisions.sites` enabled the call. */
      personalityId: string;
      /** injection / approver: the tool call it judged. */
      toolCallId?: string;
      /** The turn's observability trace; absent when none is wired. */
      traceId?: string;
    };
