// E4 — Per-personality context engine.
//
// Pluggable strategy that decides how to compact a long conversation when it
// approaches the model's context window. Different personalities benefit from
// different policies — a coordinator doing multi-team synthesis cannot afford
// to lose the original task description (drop-oldest is wrong); a coach doing
// short reflection turns is fine with drop-oldest.
//
// Three concrete implementations ship in @ethosagent/core. Plugin authors can
// register custom engines via `EthosPluginApi.registerContextEngine`.

import type { Message } from './llm';
import type { PersonalityConfig } from './personality';

export interface ContextEngineCompactInput {
  /** Full message history to compact. */
  messages: Message[];
  /** Current system prompt (read-only — engines never mutate it). */
  currentSystem: string;
  /** Engine should aim to bring the message list under this token count. */
  targetTokens: number;
  /** Personality whose `context_engine_options` may carry per-instance config. */
  personality: PersonalityConfig;
  /** Free-form session metadata (sessionId, sessionKey, turn count, etc.). */
  sessionMetadata: ContextEngineSessionMetadata;
}

export interface ContextEngineSessionMetadata {
  sessionId: string;
  sessionKey: string;
  turnNumber: number;
}

export interface ContextEngineCompactOutput {
  /** Compacted message list — must remain a valid Anthropic / OpenAI history. */
  messages: Message[];
  /** Free-form notes for telemetry / `ethos doctor` (e.g. "summarized 12 → 1"). */
  notes: string;
  /**
   * The synthetic summary text, when the engine produced one. Persisted to the
   * `compressions` table so a session's compaction history stays auditable.
   * Engines that drop messages rather than summarize leave this unset.
   */
  summaryText?: string;
  /**
   * context_compression F2 — indices into `messages` that mark stable
   * `cache_control` boundaries (e.g. end of preserved-front, the summary
   * message). The AgentLoop forwards these to the provider so the prompt
   * cache survives compaction. Engines that produce no stable boundary
   * leave this unset.
   */
  cacheBreakpoints?: number[];
}

export interface ContextEngine {
  readonly name: string;
  compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput>;
}

export interface ContextEngineRegistry {
  /** Register an engine factory. Plugin-author entry point. */
  register(engine: ContextEngine): void;
  /** Resolve an engine by name. Returns undefined when the name is unknown. */
  get(name: string): ContextEngine | undefined;
  /** Snapshot of all registered engine names — for `ethos doctor`. */
  names(): string[];
}
