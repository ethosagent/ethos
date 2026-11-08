// @ethosagent/test-kit — canonical test helpers that need only `@ethosagent/types`.
//
// Test files import these instead of redefining them per file. Helpers that
// need `AgentLoop` (e.g. `stubLoop`) stay local: a support package cannot
// import core. Each signature is the most common of the per-file copies it
// replaces; a call site migrates only where its local helper behaves the same.

import type {
  CompletionChunk,
  CompletionOptions,
  DeliveryResult,
  LLMProvider,
  Message,
  PlatformAdapter,
  ToolContext,
  ToolDefinitionLite,
} from '@ethosagent/types';

/** Consume an async iterable to exhaustion, discarding every item. */
export async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iter) void _;
}

/** Consume an async iterable to exhaustion and return its items in order. */
export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

/** A complete `ToolContext` for tool unit tests; `overrides` win field by field. */
export function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1',
    sessionKey: 'cli:default',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 10_000,
    ...overrides,
  };
}

/** One scripted tool call. `input` is JSON-stringified into `tool_use_end`. */
export interface ScriptedToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** A scripted step: a string is a text reply, an array is a batch of tool calls. */
export type ScriptedStep = string | ScriptedToolCall[];

/** What one `complete()` call received. */
export interface ScriptedLLMCall {
  messages: Message[];
  tools: ToolDefinitionLite[];
  options: CompletionOptions;
}

export type ScriptedLLM = LLMProvider & { readonly calls: ScriptedLLMCall[] };

/**
 * An `LLMProvider` that answers each `complete()` call with the next step. A
 * text step ends the turn (`end_turn`); a tool-call step ends with `tool_use`.
 * Once the steps run out it answers `'ok'`, so a loop that keeps asking still
 * terminates. Every call's arguments are recorded on `calls`.
 */
export function scriptedLLM(steps: ScriptedStep[] = []): ScriptedLLM {
  let i = 0;
  const calls: ScriptedLLMCall[] = [];
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    calls,
    async *complete(messages, tools, options): AsyncIterable<CompletionChunk> {
      calls.push({ messages, tools, options });
      const step = steps[i++];
      if (step === undefined || typeof step === 'string') {
        yield { type: 'text_delta', text: step ?? 'ok' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      for (const tc of step) {
        yield { type: 'tool_use_start', toolCallId: tc.id, toolName: tc.name };
        yield { type: 'tool_use_end', toolCallId: tc.id, inputJson: JSON.stringify(tc.input) };
      }
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

export type FakeAdapter = PlatformAdapter & { sentMessages: string[] };

/**
 * A `PlatformAdapter` whose `send` succeeds and records each message's text on
 * `sentMessages`. `overrides` win field by field (pass `send` to replace the
 * recorder).
 */
export function makeFakeAdapter(overrides: Partial<PlatformAdapter> = {}): FakeAdapter {
  const sentMessages: string[] = [];
  return {
    id: 'telegram:bot-1',
    displayName: 'Telegram',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: true,
    canReact: true,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(_chatId, msg): Promise<DeliveryResult> {
      sentMessages.push(msg.text);
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
    ...overrides,
    sentMessages,
  };
}
