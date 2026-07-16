// Phase 3 — context-overflow detection. When a provider rejects a completion
// because the request exceeds the model's context window, the turn should
// compact-and-retry instead of surfacing a raw error. Providers report this
// differently (Anthropic: 400 `invalid_request_error` "prompt is too long";
// OpenAI-compat: `context_length_exceeded` / "maximum context length"), so we
// match on both the structured error code/type and the message text.

import type {
  ContextEngine,
  ContextEngineLLMHandle,
  Message,
  PersonalityConfig,
} from '@ethosagent/types';
import { estimateMessagesTokens, estimateTokens } from '../context-engines/token-estimator';
import type { LoopDeps } from './turn-context';

const OVERFLOW_MESSAGE_RE =
  /context[_ ]?length|context window|maximum context|prompt is too long|too many tokens|reduce the (?:length|number)|input is too long|exceeds? the maximum (?:context|number of tokens)|too long for/i;

const OVERFLOW_CODES = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'string_above_max_length',
]);

/**
 * Best-effort classification of a provider error as a context-window overflow.
 * Deliberately conservative on the structured signals (a fixed code set) and
 * broad on the message text — a false negative just surfaces the original
 * error (status quo), while a false positive would waste one compaction+retry.
 */
export function isContextOverflowError(err: unknown): boolean {
  if (err == null) return false;
  const e = err as { code?: unknown; type?: unknown; message?: unknown; error?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const type = typeof e.type === 'string' ? e.type : undefined;
  if ((code && OVERFLOW_CODES.has(code)) || (type && OVERFLOW_CODES.has(type))) return true;
  // Some SDKs nest the structured error one level down.
  const nested = e.error as { code?: unknown; type?: unknown } | undefined;
  if (nested && typeof nested === 'object') {
    const ncode = typeof nested.code === 'string' ? nested.code : undefined;
    const ntype = typeof nested.type === 'string' ? nested.type : undefined;
    if ((ncode && OVERFLOW_CODES.has(ncode)) || (ntype && OVERFLOW_CODES.has(ntype))) return true;
  }
  const msg = err instanceof Error ? err.message : typeof e.message === 'string' ? e.message : '';
  return msg.length > 0 && OVERFLOW_MESSAGE_RE.test(msg);
}

/**
 * Deterministically shrink an over-long in-memory history for the compact-and-
 * retry path. An overflow means the pressure estimate UNDERSHOT the real token
 * count, so the target is derived from the CURRENT estimate (halved), not a
 * window fraction — guaranteeing the engine actually drops when there is more
 * than one message. Falls back to keeping the last message so the retry never
 * ships an empty history. Returns the original messages on engine failure.
 */
export async function emergencyCompact(
  engine: ContextEngine,
  messages: Message[],
  systemPrompt: string,
  personality: PersonalityConfig,
  sessionMetadata: {
    sessionId: string;
    sessionKey: string;
    turnNumber: number;
    lastCompactionTurn: number;
  },
  extra?: { llm?: ContextEngineLLMHandle; countTokens?: (m: Message[]) => Promise<number> },
): Promise<Message[]> {
  const currentEstimate = estimateTokens(systemPrompt) + estimateMessagesTokens(messages);
  const targetTokens = Math.max(1, Math.floor(currentEstimate / 2));
  try {
    const result = await engine.compact({
      messages,
      currentSystem: systemPrompt,
      targetTokens,
      personality,
      sessionMetadata,
      ...(extra?.llm ? { llm: extra.llm } : {}),
      ...(extra?.countTokens ? { countTokens: extra.countTokens } : {}),
    });
    if (result.messages.length === 0 && messages.length > 0) {
      const last = messages[messages.length - 1];
      return last ? [last] : messages;
    }
    return result.messages;
  } catch {
    return messages;
  }
}

/**
 * Overflow→compact-and-retry seam for the loop. Resolves the personality's
 * engine (or the per-model-class default), runs {@link emergencyCompact}, and —
 * when it shrinks — replaces `llmMessages` IN PLACE and returns `true` so the
 * caller re-runs the current iteration. Returns `false` when nothing could be
 * trimmed (the caller then surfaces the overflow error).
 */
export async function applyOverflowRetry(
  deps: Pick<LoopDeps, 'llm' | 'contextEngines' | 'llmHandle' | 'compaction'>,
  llmMessages: Message[],
  systemPrompt: string,
  personality: PersonalityConfig,
  sessionMeta: {
    sessionId: string;
    sessionKey: string;
    turnNumber: number;
    lastCompactionTurn: number;
  },
): Promise<boolean> {
  const engineName = personality.context_engine ?? deps.compaction?.defaultEngine ?? 'drop_oldest';
  const engine = deps.contextEngines.get(engineName) ?? deps.contextEngines.get('drop_oldest');
  if (!engine) return false;
  const trimmed = await emergencyCompact(
    engine,
    llmMessages,
    systemPrompt,
    personality,
    sessionMeta,
    {
      ...(deps.llmHandle ? { llm: deps.llmHandle } : {}),
      countTokens: deps.llm.countTokens.bind(deps.llm),
    },
  );
  if (trimmed.length >= llmMessages.length) return false;
  llmMessages.length = 0;
  llmMessages.push(...trimmed);
  return true;
}
