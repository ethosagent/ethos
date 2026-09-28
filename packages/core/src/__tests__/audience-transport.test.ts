// plan personality-memory-boundary G1-6 (step 1a) — `roomAudience` and
// `initiator` survive every hop between `RunOptions` and the tool:
//
//   RunOptions → agent-loop opts subset → processTools `toolCtxBase`
//     → DefaultToolRegistry.executeParallel request build
//     → LocalToolTransport ctx rebuild → Tool.execute(ctx)
//   and, for the turn-end flush, buildTurnEndCtx → the flush toolCtx.
//
// A field dropped at any one of those sites reaches the tool as `undefined`,
// which a later forwarder would read as "private". So each case dispatches
// through the real registry/transport, never `tool.execute` directly.

import type {
  CompletionChunk,
  LLMProvider,
  Message,
  Tool,
  ToolContext,
  ToolDefinitionLite,
  ToolExecuteRequest,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { LocalToolTransport } from '../local-tool-transport';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

function probe(seen: ToolContext[], name = 'probe'): Tool {
  return {
    name,
    description: name,
    toolset: 'test',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      seen.push(ctx);
      return { ok: true, value: 'ok' };
    },
  };
}

function baseCtx(extra: Partial<ToolContext>): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'k',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 10_000,
    ...extra,
  };
}

/** Main turn calls `probe` once then answers; a flush call writes memory once. */
function scriptedLLM(): LLMProvider {
  let main = 0;
  let flush = 0;
  const usage: CompletionChunk = {
    type: 'usage',
    usage: {
      inputTokens: 1_000,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
    },
  };
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _m: Message[],
      _t: ToolDefinitionLite[],
      opts?: { system?: string },
    ): AsyncIterable<CompletionChunk> {
      if (opts?.system?.includes('silent background memory maintenance')) {
        if (flush++ === 0) {
          yield { type: 'tool_use_start', toolCallId: 'w1', toolName: 'memory_write' };
          yield {
            type: 'tool_use_end',
            toolCallId: 'w1',
            inputJson: '{"store":"memory","action":"add","content":"f"}',
          };
          yield { type: 'done', finishReason: 'tool_use' };
          return;
        }
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      if (main++ === 0) {
        yield { type: 'tool_use_start', toolCallId: 't1', toolName: 'probe' };
        yield { type: 'tool_use_end', toolCallId: 't1', inputJson: '{}' };
        yield usage;
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'reply' };
      yield usage;
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // Drain to exhaustion: the flush runs in the turn tail.
  }
}

describe('audience transport — registry and transport hops', () => {
  it('DefaultToolRegistry.executeParallel (default LocalToolTransport) delivers both fields', async () => {
    const seen: ToolContext[] = [];
    const reg = new DefaultToolRegistry();
    reg.register(probe(seen));

    await reg.executeParallel(
      [{ toolCallId: 'c1', name: 'probe', args: {} }],
      baseCtx({ roomAudience: 'shared', initiator: 'user' }),
    );

    expect(seen[0]?.roomAudience).toBe('shared');
    expect(seen[0]?.initiator).toBe('user');
  });

  it('absent fields stay absent (no invented default at the hop)', async () => {
    const seen: ToolContext[] = [];
    const reg = new DefaultToolRegistry();
    reg.register(probe(seen));

    await reg.executeParallel([{ toolCallId: 'c1', name: 'probe', args: {} }], baseCtx({}));

    expect(seen[0] && 'roomAudience' in seen[0]).toBe(false);
    expect(seen[0] && 'initiator' in seen[0]).toBe(false);
  });

  it('LocalToolTransport.execute rebuilds both fields from the serializable request', async () => {
    const seen: ToolContext[] = [];
    const tool = probe(seen);
    const transport = new LocalToolTransport((n) => (n === tool.name ? tool : undefined));
    const request: ToolExecuteRequest = {
      toolCallId: 'c1',
      name: 'probe',
      args: {},
      sessionId: 's',
      sessionKey: 'k',
      platform: 'cli',
      workingDir: '/tmp',
      roomAudience: 'shared',
      initiator: 'system',
      currentTurn: 1,
      messageCount: 1,
      resultBudgetChars: 10_000,
    };

    await transport.execute(request, new AbortController().signal);

    expect(seen[0]?.roomAudience).toBe('shared');
    expect(seen[0]?.initiator).toBe('system');
  });
});

describe('audience transport — end to end through AgentLoop.run', () => {
  function loopWith(
    batch: ToolContext[],
    flush: ToolContext[],
    session = new InMemorySessionStore(),
  ) {
    const tools = new DefaultToolRegistry();
    tools.register(probe(batch));
    tools.register(probe(flush, 'memory_write'));
    tools.register(probe([], 'memory_read'));
    return new AgentLoop({
      llm: scriptedLLM(),
      tools,
      session,
      safety: createTestSafety(),
      memoryConsolidation: { enabled: true, flushThreshold: 0.001, minMessagesSinceFlush: 0 },
    });
  }

  it('a shared, user-initiated turn hands the tool roomAudience shared + initiator user', async () => {
    const batch: ToolContext[] = [];
    await drain(
      loopWith(batch, []).run('hi', {
        sessionKey: 'cli:a',
        roomAudience: 'shared',
        initiator: 'user',
      }),
    );

    expect(batch[0]?.roomAudience).toBe('shared');
    expect(batch[0]?.initiator).toBe('user');
  });

  it('a turn with no audience resolves to private; the tool sees the RESOLVED value', async () => {
    const batch: ToolContext[] = [];
    await drain(loopWith(batch, []).run('hi', { sessionKey: 'cli:b' }));

    expect(batch[0]?.roomAudience).toBe('private');
    expect(batch[0]?.initiator).toBeUndefined();
  });

  it('the sticky stamp reaches the tool on a later turn that did not ask for shared', async () => {
    const session = new InMemorySessionStore();
    const first: ToolContext[] = [];
    const second: ToolContext[] = [];
    await drain(
      loopWith(first, [], session).run('a', { sessionKey: 'cli:c', roomAudience: 'shared' }),
    );
    await drain(loopWith(second, [], session).run('b', { sessionKey: 'cli:c' }));

    expect(second[0]?.roomAudience).toBe('shared');
  });

  it('buildTurnEndCtx carries both fields to a flush-dispatched tool (private turn)', async () => {
    const batch: ToolContext[] = [];
    const flush: ToolContext[] = [];
    await drain(loopWith(batch, flush).run('hi', { sessionKey: 'cli:d', initiator: 'user' }));

    expect(flush).toHaveLength(1);
    expect(flush[0]?.roomAudience).toBe('private');
    expect(flush[0]?.initiator).toBe('user');
  });
});
