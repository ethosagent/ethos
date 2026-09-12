// One contract, wherever a tool runs. A tool dispatched by the turn-end memory
// flush (packages/core/src/agent-loop/turn-end.ts) used to get a ToolContext
// with no `getContext`/`setContext` and no `rootSessionKey`, so a plugin tool
// that works in a normal batch silently loses those on the flush path — and the
// flush is the one dispatch a tool author never sees coming.

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Message,
  Tool,
  ToolContext,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

/** The system prompt the flush turn runs under (turn-end.ts). */
const FLUSH_MARKER = 'silent background memory maintenance';

const USAGE: CompletionChunk = {
  type: 'usage',
  usage: {
    // Well past the 0.001 flush threshold of the mock's 200k window.
    inputTokens: 1_000,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
  },
};

function toolUse(id: string, name: string, json: string): CompletionChunk[] {
  return [
    { type: 'tool_use_start', toolCallId: id, toolName: name },
    { type: 'tool_use_end', toolCallId: id, inputJson: json },
  ];
}

/**
 * Main turn: call `probe`, then answer. Flush turn: call `memory_write` once,
 * then stop. Told apart by the flush system prompt.
 */
function scriptedLLM(): LLMProvider {
  let flushCalls = 0;
  let mainCalls = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _messages: Message[],
      _tools: ToolDefinitionLite[],
      options?: { system?: string },
    ): AsyncIterable<CompletionChunk> {
      if (options?.system?.includes(FLUSH_MARKER)) {
        if (flushCalls++ === 0) {
          yield* toolUse('w1', 'memory_write', '{"store":"memory","action":"add","content":"f"}');
          yield { type: 'done', finishReason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'flush done' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      if (mainCalls++ === 0) {
        yield* toolUse('t1', 'probe', '{}');
        yield USAGE;
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'main reply' };
      yield USAGE;
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

function recordingTool(
  name: string,
  seen: ToolContext[],
  onRun?: (ctx: ToolContext) => void,
): Tool {
  return {
    name,
    description: name,
    toolset: 'memory',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      seen.push(ctx);
      onRun?.(ctx);
      return { ok: true, value: 'ok' };
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _event of gen) {
    // The turn tail (where the flush runs) only happens for a consumer that drains.
  }
}

/** One turn with a batch `probe` call and a turn-end flush `memory_write`. */
async function runTurn(opts: { rootSessionKey?: string } = {}) {
  const batch: ToolContext[] = [];
  const flush: ToolContext[] = [];
  const tools = new DefaultToolRegistry();
  tools.register(
    recordingTool('probe', batch, (ctx) => {
      ctx.setContext?.('set-in-batch', 'yes');
    }),
  );
  tools.register(recordingTool('memory_write', flush));
  tools.register(recordingTool('memory_read', []));
  const loop = new AgentLoop({
    llm: scriptedLLM(),
    tools,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
    memoryConsolidation: { enabled: true, flushThreshold: 0.001, minMessagesSinceFlush: 0 },
  });
  await drain(
    loop.run('hello', {
      sessionKey: 'cli:parity',
      ...(opts.rootSessionKey ? { rootSessionKey: opts.rootSessionKey } : {}),
    }),
  );
  return { batch: batch[0], flush: flush[0] };
}

describe('ToolContext parity — the turn-end memory flush', () => {
  it('hands the flush tool the accessors the batch path hands, over the same run store', async () => {
    const { batch, flush } = await runTurn();

    expect(batch).toBeDefined();
    expect(flush).toBeDefined();
    expect(typeof flush?.getContext).toBe('function');
    expect(typeof flush?.setContext).toBe('function');
    // Same store as the batch: the flush is the tail of THIS run, not a new one.
    expect(flush?.getContext?.('set-in-batch')).toBe('yes');
  });

  it('carries rootSessionKey: the run root when given, else the session key', async () => {
    const withRoot = await runTurn({ rootSessionKey: 'cli:root' });
    expect(withRoot.batch?.rootSessionKey).toBe('cli:root');
    expect(withRoot.flush?.rootSessionKey).toBe('cli:root');

    const without = await runTurn();
    expect(without.flush?.rootSessionKey).toBe('cli:parity');
  });
});
