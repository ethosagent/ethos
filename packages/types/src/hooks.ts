import type { PersonalityConfig } from './personality';
import type { InboundMessage, OutboundMessage } from './platform';
import type { StoredMessage } from './session';
import type { ToolResult } from './tool';

// ---------------------------------------------------------------------------
// Hook payload types
// ---------------------------------------------------------------------------

export interface SessionStartPayload {
  sessionId: string;
  sessionKey: string;
  platform: string;
  personalityId?: string;
}

export interface BeforePromptBuildPayload {
  sessionId: string;
  personalityId?: string;
  history: StoredMessage[];
}

export interface BeforePromptBuildResult {
  prependSystem?: string;
  appendSystem?: string;
  overrideSystem?: string;
}

export interface BeforeLLMCallPayload {
  sessionId: string;
  model: string;
  turnNumber: number;
}

export interface AfterLLMCallPayload {
  sessionId: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface BeforeToolCallPayload {
  sessionId: string;
  /** Stable id for the tool_use block this hook is gating. Hooks that need to
   *  surface external state (e.g. an approval modal) key off this id so they
   *  can correlate the response back to the right call. */
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface BeforeToolCallResult {
  args?: unknown;
  error?: string;
}

export interface AfterToolCallPayload {
  sessionId: string;
  toolName: string;
  result: ToolResult;
  durationMs: number;
}

/**
 * E5 — emitted after `tool_end` for any tool whose arguments referenced a
 * filesystem path (`read_file`, `write_file`, `patch_file`, `terminal` with
 * `cwd`, etc.). Subscribers can use this to react to where the agent is
 * navigating — e.g. progressive context-file discovery in a monorepo.
 *
 * `filePath` may be relative (resolved against `workingDir`) or absolute;
 * subscribers should normalize before use. `workingDir` is the AgentLoop's
 * working directory at the time the tool ran.
 */
export interface ToolEndWithPathPayload {
  sessionId: string;
  personalityId?: string;
  toolName: string;
  filePath: string;
  workingDir: string;
}

export interface AgentDonePayload {
  sessionId: string;
  text: string;
  turnCount: number;
  /**
   * E3 — extra metadata used by the skill-evolver auto-trigger to decide
   * whether the turn was substantive enough to queue an analysis. Optional
   * so existing call sites stay unchanged.
   */
  personalityId?: string;
  successfulToolCalls?: number;
  totalToolCalls?: number;
  toolNames?: string[];
  /** First user message of the turn — context for skill candidate analysis. */
  initialPrompt?: string;
}

export interface MessageReceivedPayload {
  message: InboundMessage;
  sessionId?: string;
}

export interface MessageSendingPayload {
  chatId: string;
  message: OutboundMessage;
}

export interface MessageSendingResult {
  message?: OutboundMessage;
}

export interface MessageSentPayload {
  chatId: string;
  messageId?: string;
}

export interface InboundClaimPayload {
  message: InboundMessage;
}

export interface InboundClaimResult {
  handled: boolean;
}

export interface BeforeDispatchPayload {
  chatId: string;
  platform: string;
  text: string;
}

export interface BeforeDispatchResult {
  handled: boolean;
}

export interface PersonalitySwitchedPayload {
  sessionId: string;
  from?: string;
  to: string;
}

export interface PersonalitySwitchedResult {
  personality?: PersonalityConfig;
}

export interface SubagentSpawningPayload {
  parentSessionId: string;
  prompt: string;
  personalityId?: string;
}

export interface SubagentSpawningResult {
  prompt?: string;
  personalityId?: string;
}

export interface SubagentSpawnedPayload {
  parentSessionId: string;
  childSessionId: string;
  personalityId?: string;
}

export interface SubagentEndedPayload {
  parentSessionId: string;
  childSessionId: string;
  result: string;
}

// ---------------------------------------------------------------------------
// Hook map — groups by execution model
// ---------------------------------------------------------------------------

export interface VoidHooks {
  session_start: SessionStartPayload;
  before_llm_call: BeforeLLMCallPayload;
  after_llm_call: AfterLLMCallPayload;
  after_tool_call: AfterToolCallPayload;
  tool_end_with_path: ToolEndWithPathPayload;
  agent_done: AgentDonePayload;
  message_received: MessageReceivedPayload;
  message_sent: MessageSentPayload;
  subagent_spawned: SubagentSpawnedPayload;
  subagent_ended: SubagentEndedPayload;
}

export interface ModifyingHooks {
  before_prompt_build: [BeforePromptBuildPayload, BeforePromptBuildResult];
  before_tool_call: [BeforeToolCallPayload, BeforeToolCallResult];
  message_sending: [MessageSendingPayload, MessageSendingResult];
  personality_switched: [PersonalitySwitchedPayload, PersonalitySwitchedResult];
  subagent_spawning: [SubagentSpawningPayload, SubagentSpawningResult];
}

export interface ClaimingHooks {
  inbound_claim: [InboundClaimPayload, InboundClaimResult];
  before_dispatch: [BeforeDispatchPayload, BeforeDispatchResult];
}

export type HookName = keyof VoidHooks | keyof ModifyingHooks | keyof ClaimingHooks;

export interface HookRegistry {
  registerVoid<K extends keyof VoidHooks>(
    name: K,
    handler: (payload: VoidHooks[K]) => Promise<void>,
    opts?: { pluginId?: string; failurePolicy?: 'fail-open' | 'fail-closed' },
  ): () => void;

  registerModifying<K extends keyof ModifyingHooks>(
    name: K,
    handler: (payload: ModifyingHooks[K][0]) => Promise<Partial<ModifyingHooks[K][1]> | null>,
    opts?: { pluginId?: string },
  ): () => void;

  registerClaiming<K extends keyof ClaimingHooks>(
    name: K,
    handler: (payload: ClaimingHooks[K][0]) => Promise<ClaimingHooks[K][1]>,
    opts?: { pluginId?: string },
  ): () => void;

  /**
   * `allowedPlugins` gates which plugin-registered handlers fire:
   *   undefined  → all handlers fire (no personality context / gateway hooks)
   *   []         → only built-in handlers (no pluginId) fire
   *   ['p', …]   → built-in handlers + handlers whose pluginId is in the list
   */
  fireVoid<K extends keyof VoidHooks>(
    name: K,
    payload: VoidHooks[K],
    allowedPlugins?: string[],
  ): Promise<void>;

  fireModifying<K extends keyof ModifyingHooks>(
    name: K,
    payload: ModifyingHooks[K][0],
    allowedPlugins?: string[],
  ): Promise<ModifyingHooks[K][1]>;

  fireClaiming<K extends keyof ClaimingHooks>(
    name: K,
    payload: ClaimingHooks[K][0],
    allowedPlugins?: string[],
  ): Promise<ClaimingHooks[K][1]>;

  unregisterPlugin(pluginId: string): void;
}
