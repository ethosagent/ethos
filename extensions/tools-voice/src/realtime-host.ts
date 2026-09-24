// The realtime session's tool host: ONE object that both advertises and
// services, so the two can never drift.
//
// A realtime session's tool list is spoken capability. When the provider is
// told it has a tool, the model will offer that capability out loud —
// "sure, let me look that up" — and a person on a phone will wait for it. A
// list that names something the server cannot service is therefore not a
// dropped request, it is a lie delivered in a friendly voice with no way for
// the listener to detect it. So the advertised list and the handled set are not
// two lists that agree; they are one list, derived once from the tool registry
// that is actually wired, and the mint and the control lane both build it from
// here (voice V1b, "advertised == handled").
//
// EVERYTHING dispatched here goes through core's per-call gate,
// `enforceBeforeToolCall` (packages/core/src/agent-loop/stages/per-call-enforcement.ts),
// the same one the agent loop's batch path and the script bridge cross: the
// personality's deny rules first, then the `before_tool_call` hook carrying the
// same `voiceOrigin` and `personalityId`, then the deny rules again on any
// rewritten args. That is what keeps the approval surface — including A8's
// spoken-confirmation gate and its rule that a far-end caller's voice can
// never satisfy an owner confirmation — in force on a tool the realtime model
// called directly rather than through `agent_consult`. Every result then
// passes `redactToolResultSecrets`
// (packages/core/src/agent-loop/stages/result-redaction.ts) before it is
// spoken. Pinned by `__tests__/realtime-host.test.ts` ("core enforcement").

import {
  ContextStore,
  DefaultHookRegistry,
  enforceBeforeToolCall,
  type ResultRedactionDeps,
  redactToolResultSecrets,
} from '@ethosagent/core';
import type {
  HookRegistry,
  PersonalityConfig,
  RealtimeToolDefinition,
  ToolContext,
  ToolProgressEvent,
  ToolRegistry,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import { sanitizeForSpeech } from '@ethosagent/voice-text';
import { deriveRealtimeToolset, REALTIME_SAFE_TOOLS } from './agent-consult';

/** One tool call as the provider issued it. */
export interface RealtimeToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

/** Per-call context the host needs to build a `ToolContext`. */
export interface RealtimeDispatchContext {
  /** The talk session's own SessionStore row id. */
  sessionId: string;
  /** The talk session's lane key — also the consulted turn's session key. */
  sessionKey: string;
  platform: string;
  workingDir: string;
  abortSignal: AbortSignal;
  /** Stamped on the approval hook. See {@link RealtimeToolHostOptions.voiceOrigin}. */
  voiceOrigin: VoiceTurnOrigin;
}

export interface RealtimeToolResult {
  ok: boolean;
  /** Speakable text, already through `sanitizeForSpeech`. */
  output: string;
  /**
   * Machine code for telemetry and tests. Deliberately NOT part of `output`:
   * `sanitizeForSpeech` eats the underscores out of a snake_case code (it reads
   * them as markdown emphasis), and a code is not something to read aloud
   * anyway. It does not travel on the wire — the model gets prose.
   */
  code?: string;
}

export interface RealtimeToolHostOptions {
  registry: ToolRegistry;
  /**
   * Fires `before_tool_call`. Absent → no hook runs (an empty registry stands
   * in), but the personality's deny rules and result redaction still apply;
   * wire it in production.
   */
  hooks?: HookRegistry;
  /**
   * The personality this call acts as, resolved by the loop's own rule
   * (`AgentLoop.resolvePersonality`: the named one, else the registry default),
   * so a session that named none runs as the default, exactly as a turn does.
   * Its `id` is stamped on the hook payload and the tools' memory scope, its
   * `safety.denyRules` refuse a call before any hook runs, its `plugins` decide
   * which plugin `before_tool_call` handlers fire (as on the batch path), and
   * its `safety.injectionDefense.blockSecretResults` governs result redaction.
   * `undefined` — nothing resolved — refuses every dispatch rather than
   * running with no rules.
   */
  personality: PersonalityConfig | undefined;
  /**
   * The redaction seam every result passes through before it is spoken —
   * `AgentLoop.resultRedaction`, the same kit and observability the batch path
   * uses. Required: an omittable redaction step is not a guarantee.
   */
  resultRedaction: ResultRedactionDeps;
  /** The speaking personality's toolset; gates the direct-call allowlist. */
  personalityToolset?: readonly string[];
  /** Override the direct-call allowlist. Defaults to {@link REALTIME_SAFE_TOOLS}. */
  safeTools?: ReadonlySet<string>;
  /**
   * Per-call budget for a directly-dispatched tool's result. Small on purpose:
   * this text is spoken. `agent_consult` caps itself far lower still.
   */
  resultBudgetChars?: number;
}

export interface RealtimeToolHost {
  /** What the session is minted advertising. */
  readonly definitions: RealtimeToolDefinition[];
  /** What this host will service. Equal to `definitions.map(d => d.name)`, by construction. */
  readonly handled: string[];
  dispatch(call: RealtimeToolCall, ctx: RealtimeDispatchContext): Promise<RealtimeToolResult>;
}

/** Result code for a name the session was never given. Stable; tests match it. */
export const REALTIME_UNKNOWN_TOOL = 'unknown_tool';

const DEFAULT_RESULT_BUDGET_CHARS = 4_000;

export function createRealtimeToolHost(opts: RealtimeToolHostOptions): RealtimeToolHost {
  // A realtime call runs tools outside any `AgentLoop.run()`, so nothing else
  // can hand them the per-run plugin context store the batch path gives
  // (`asContextMethods`, packages/core/src/agent-loop/stages/tool-processing.ts).
  // The host IS the scope: one is created per realtime session
  // (`apps/web-api/src/voice/realtime-control-deps.ts`), which makes the store's
  // lifetime the spoken call — the closest thing here to "one turn", and never
  // shared with another call. Pinned by `__tests__/realtime-host.test.ts`.
  const contextStore = new ContextStore();
  const definitions = deriveRealtimeToolset({
    registry: opts.registry,
    ...(opts.personalityToolset ? { personalityToolset: opts.personalityToolset } : {}),
    ...(opts.safeTools ? { safeTools: opts.safeTools } : {}),
  });
  const handled = definitions.map((definition) => definition.name);
  const handledSet = new Set(handled);
  const budget = opts.resultBudgetChars ?? DEFAULT_RESULT_BUDGET_CHARS;
  const hooks = opts.hooks ?? new DefaultHookRegistry();
  const observability = opts.resultRedaction.observability;
  // Same plugin gate as the batch path (`allowedPlugins` in
  // packages/core/src/agent-loop/stages/turn-setup.ts).
  const allowedPlugins = opts.personality?.plugins ?? [];

  return {
    definitions,
    handled,

    async dispatch(call, ctx): Promise<RealtimeToolResult> {
      if (!handledSet.has(call.name)) {
        // Reached only if a provider invents a name or a session outlives a
        // configuration change. Answering with a refusal rather than silence
        // keeps the model's turn accounting intact — an unanswered tool call
        // leaves a realtime session waiting forever.
        return {
          ok: false,
          code: REALTIME_UNKNOWN_TOOL,
          output: speakable(`This call has no way to run "${call.name}".`),
        };
      }

      // Fail closed: with no personality there are no rules to enforce.
      const personality = opts.personality;
      if (!personality) {
        return {
          ok: false,
          code: 'refused',
          output: speakable('This call has no personality to act as, so it cannot run tools.'),
        };
      }

      // Core's per-call gate, the same one the batch path and the script bridge
      // cross: deny rules before any hook, `before_tool_call` with the voice
      // origin and personality, deny rules again on rewritten args.
      const gate = await enforceBeforeToolCall(
        { hooks, ...(observability ? { observability } : {}) },
        {
          sessionId: ctx.sessionId,
          toolCallId: call.callId,
          toolName: call.name,
          args: call.args,
          allowedPlugins,
          traceId: undefined,
          voiceOrigin: ctx.voiceOrigin,
          personalityId: personality.id,
          ...(personality.safety?.denyRules ? { denyRules: personality.safety.denyRules } : {}),
        },
      );
      if (!gate.allowed) return { ok: false, code: 'refused', output: speakable(gate.reason) };
      const args = gate.effectiveArgs;

      const toolCtx: ToolContext = {
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        // No parent run to inherit from — the call's own lane is its root, the
        // same fallback the batch path applies.
        rootSessionKey: ctx.sessionKey,
        platform: ctx.platform,
        workingDir: ctx.workingDir,
        // A voice call is a conversation with this personality, so its tools
        // see that personality's memory — the same `personality:<id>` scope
        // AgentLoop stamps on every turn (`memScopeId` in
        // packages/core/src/agent-loop/stages/turn-setup.ts). No resolved user
        // id reaches this host, so `userScopeId` stays unset and USER.md reads
        // fall back to the personality scope, as a turn without a user does.
        personalityId: personality.id,
        memoryScopeId: `personality:${personality.id}`,
        currentTurn: 1,
        messageCount: 0,
        abortSignal: ctx.abortSignal,
        // Realtime tool progress is internal by contract (Phase 30.2): the
        // spoken filler is this tier's user-facing progress, and a second
        // stream of it would talk over the first.
        emit: (_event: ToolProgressEvent) => {},
        resultBudgetChars: budget,
        ...contextStore.asContextMethods(),
      };

      const [outcome] = await opts.registry.executeParallel(
        [{ toolCallId: call.callId, name: call.name, args }],
        toolCtx,
        handled,
      );
      if (!outcome) {
        return {
          ok: false,
          code: 'no_result',
          output: speakable(`"${call.name}" did not return anything.`),
        };
      }
      // Secrets are redacted before the text can be spoken into the session.
      const result = redactToolResultSecrets(outcome.result, opts.resultRedaction, {
        personality,
        traceId: undefined,
      });
      return result.ok
        ? { ok: true, output: speakable(result.value) }
        : { ok: false, code: result.code, output: speakable(result.error) };
    },
  };
}

/**
 * Everything leaving this host is about to be read aloud by a provider that
 * will happily pronounce backticks, so it goes through the ONE speakable-text
 * implementation (`@ethosagent/voice-text`) on the way out — the realtime
 * tier's coverage for the "TTS speaks the wrong text" failure class. Applied
 * here rather than at the socket so a tier that grows a second surface cannot
 * acquire an unsanitized path.
 */
function speakable(text: string): string {
  const clean = sanitizeForSpeech(text).trim();
  // Never answer a tool call with nothing: a realtime model handed an empty
  // string tends to fill the silence with an invention.
  return clean || 'The assistant had nothing to say about that.';
}
