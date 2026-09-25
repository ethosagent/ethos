// The current turn's user message is never dropped.
//
// Live smoke: `provider: ollama`, no `contextWindow` → the catalog window capped
// to 32,768 (ARCH_WINDOW_CAP_TOKENS). A ~92k-char system prompt plus ~17k chars
// of tool schemas already sat above the pressure gate, so `maybeCompact` ran
// drop_oldest with a target the system prompt alone exceeded — and drop_oldest
// dropped every message, the question included. The provider received the
// system message alone and the model answered without the user's question.
//
// Pins: `currentTurnStart` (compaction never hands the current turn to an
// engine), `currentTurnFitError` + `streamStep` (a prefix too large for even
// the question fails the turn loudly and sends nothing).

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  PersonalityConfig,
  Tool,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { currentTurnFitError, currentTurnStart, maybeCompact } from '../agent-loop/compaction';
import { emergencyCompact } from '../agent-loop/overflow';
import { DropOldestEngine } from '../context-engines/drop-oldest';
import { DefaultContextEngineRegistry } from '../context-engines/registry';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultHookRegistry } from '../hook-registry';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

const personality = { id: 'p', name: 'p' } as PersonalityConfig;
const meta = { sessionId: 's1', sessionKey: 'cli:s1', turnNumber: 2, lastCompactionTurn: 0 };
const sessionMock = {
  recordCompression: async () => ({}),
  updateUsage: async () => {},
  recordCompactionTurn: async () => {},
  // biome-ignore lint/suspicious/noExplicitAny: standard test mock
} as any;

function registry(): DefaultContextEngineRegistry {
  const r = new DefaultContextEngineRegistry();
  r.register(new DropOldestEngine());
  return r;
}

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content });

describe('currentTurnStart', () => {
  it('finds the newest user input, skipping tool_result-only user messages', () => {
    const msgs: Message[] = [
      user('old'),
      assistant('a'),
      user('question'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
    ];
    expect(currentTurnStart(msgs)).toBe(2);
    expect(currentTurnStart([assistant('only')])).toBe(1);
  });
});

describe('maybeCompact — the current turn survives', () => {
  it('keeps the user message when the system prompt alone exceeds the target (the 32k ollama case)', async () => {
    const question = user('What is the capital of France?');
    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 32_768 } as any,
        contextEngines: registry(),
        session: sessionMock,
      },
      [user('q0'), assistant('a0'), question],
      's'.repeat(92_000),
      personality,
      meta,
    );
    expect(result.messages.at(-1)).toBe(question);
    // Older history went first: the system prompt left no room for it.
    expect(result.messages).toEqual([question]);
  });

  it('trims the oldest history first and keeps the newest that fits', async () => {
    // 8 history messages of 1000 tokens each + a 100-token question in an 8192
    // window (no output reserve). Gate 0.8 → fires; target 0.7*8192 = 5734,
    // minus the question's 100 → the 5 newest history messages fit.
    const history = Array.from({ length: 8 }, (_, i) => user(`${i}`.repeat(4_000)));
    const question = user('?'.repeat(400));
    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registry(),
        session: sessionMock,
        reservedOutputTokens: 0,
      },
      [...history, question],
      '',
      personality,
      meta,
    );
    expect(result.messages).toEqual([...history.slice(3), question]);
  });
});

describe('emergencyCompact — the overflow retry keeps the whole current turn', () => {
  it('drops only older history, never the question or its tool round-trip', async () => {
    const turn: Message[] = [
      user('question'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r'.repeat(2_000) }],
      },
    ];
    const { messages } = await emergencyCompact(
      new DropOldestEngine(),
      [user('old'.repeat(1_000)), assistant('older'.repeat(1_000)), ...turn],
      '',
      personality,
      meta,
    );
    expect(messages).toEqual(turn);
  });
});

describe('currentTurnFitError', () => {
  const llm = { maxContextTokens: 32_768, model: 'llama3.2' };

  it('passes when the prefix plus the question fits the usable window', () => {
    // ~92k system + ~17k tool chars ≈ 27.3k tokens < 32768 − 4096.
    expect(
      currentTurnFitError(
        { llm },
        {
          systemPrompt: 's'.repeat(92_000),
          toolSchemas: 't'.repeat(17_000),
          currentTurn: [user('hi')],
        },
      ),
    ).toBeUndefined();
  });

  it('names contextWindow, tool_loading and the small-window toolset when it cannot fit', () => {
    const err = currentTurnFitError(
      { llm },
      { systemPrompt: 's'.repeat(120_000), toolSchemas: '', currentTurn: [user('hi')] },
    );
    expect(err).toContain('context window too small');
    expect(err).toContain('28672 usable');
    expect(err).toContain('contextWindow');
    expect(err).toContain('tool_loading');
    expect(err).toContain('small_window_toolset');
  });
});

// ---------------------------------------------------------------------------
// AgentLoop — end to end through a real turn
// ---------------------------------------------------------------------------

interface Captured {
  messages: Message[];
  system?: string;
}

function captureLLM(maxContextTokens: number, calls: Captured[]): LLMProvider {
  return {
    name: 'ollama',
    model: 'llama3.2',
    maxContextTokens,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[], _tools, opts?: CompletionOptions) {
      calls.push({
        messages: structuredClone(messages),
        ...(opts?.system ? { system: opts.system } : {}),
      });
      const chunks: CompletionChunk[] = [
        { type: 'text_delta', text: 'Paris.' },
        { type: 'done', finishReason: 'end_turn' },
      ];
      for (const c of chunks) yield c;
    },
    async countTokens() {
      return 10;
    },
  };
}

/** ~17k chars of tool schema, like the default personality's 20 tools. */
const bulkyTool: Tool = {
  name: 'bulky',
  description: 'd'.repeat(17_000),
  schema: { type: 'object' },
  capabilities: {},
  execute: async () => ({ ok: true, value: 'x' }),
};

function loopWith(
  maxContextTokens: number,
  systemChars: number,
  calls: Captured[],
  codes: string[],
) {
  const hooks = new DefaultHookRegistry();
  // A large static prefix, standing in for the project-context injector.
  hooks.registerModifying('before_prompt_build', async () => ({
    appendSystem: 'p'.repeat(systemChars),
  }));
  const tools = new DefaultToolRegistry();
  tools.register(bulkyTool);
  const observability: AgentLoopObservability = {
    startTurnTrace: () => 'tr1',
    endTrace: () => {},
    startSpan: () => 'sp1',
    endSpan: () => {},
    recordSafetyBlock: () => {},
    recordCompaction: (e) => codes.push(`${e.severity ?? 'info'}:${e.code ?? ''}`),
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
  return new AgentLoop({
    llm: captureLLM(maxContextTokens, calls),
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
    hooks,
    tools,
    observability,
  });
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const lastUserText = (c: Captured | undefined): string => {
  const m = c?.messages.at(-1);
  return m?.role === 'user' && typeof m.content === 'string' ? m.content : '';
};

describe('AgentLoop — the observed ollama 32768 regression', () => {
  it('sends the user message on every turn of a 32k window with a ~27k-token static prefix', async () => {
    const calls: Captured[] = [];
    const loop = loopWith(32_768, 92_000, calls, []);
    await collect(loop.run('What is the capital of France?', { sessionKey: 'cli:ollama' }));
    await collect(loop.run('And of Spain?', { sessionKey: 'cli:ollama' }));
    expect(calls).toHaveLength(2);
    expect(lastUserText(calls[0])).toContain('What is the capital of France?');
    expect(lastUserText(calls[1])).toContain('And of Spain?');
  });

  it('fails the turn loudly — and sends nothing — when the prefix plus the question cannot fit', async () => {
    const calls: Captured[] = [];
    const codes: string[] = [];
    const loop = loopWith(16_384, 92_000, calls, codes);
    const events = await collect(
      loop.run('What is the capital of France?', { sessionKey: 'cli:tiny' }),
    );
    expect(calls).toHaveLength(0);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    const err = errors[0];
    expect(err?.type === 'error' && err.code).toBe('context_window_too_small');
    expect(err?.type === 'error' && err.error).toContain('contextWindow');
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(codes).toContain('error:context_window_too_small');
  });
});
