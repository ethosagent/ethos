// A4 — the compact-and-retry after a context-overflow rejection is announced
// to the user: exactly one `{ type: 'tool_progress', toolName: '_loop',
// audience: 'user' }` per retry, none on a turn that never overflows.

import type {
  CompletionChunk,
  ContextEngine,
  ContextEngineCompactInput,
  LLMProvider,
  Message,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { DefaultContextEngineRegistry } from '../context-engines/registry';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { createTestSafety } from './helpers/test-safety';

/** Engine that always shrinks the compactible history to its first message. */
const shrinkEngine: ContextEngine['compact'] = async (opts: ContextEngineCompactInput) => ({
  messages: opts.messages.slice(0, 1),
  notes: 'kept the head',
});

function registryWithShrink() {
  const registry = new DefaultContextEngineRegistry();
  registry.register({ name: 'drop_oldest', compact: shrinkEngine });
  return registry;
}

/** LLM that throws a context overflow on the calls `overflowOn` selects
 *  (1-based call number) and streams a short answer otherwise. */
function stubLlm(overflowOn: (call: number) => boolean): { llm: LLMProvider; calls: () => number } {
  let calls = 0;
  const llm = {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 200_000,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (overflowOn(calls)) {
        throw new Error('400 invalid_request_error: prompt is too long');
      }
      yield { type: 'text_delta', text: 'answer' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens(messages: Message[]) {
      return messages.length;
    },
  } as unknown as LLMProvider;
  return { llm, calls: () => calls };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function loopNotices(events: AgentEvent[]): Extract<AgentEvent, { type: 'tool_progress' }>[] {
  return events.filter(
    (e): e is Extract<AgentEvent, { type: 'tool_progress' }> =>
      e.type === 'tool_progress' && e.toolName === '_loop',
  );
}

function makeLoop(llm: LLMProvider) {
  return new AgentLoop({
    llm,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
    contextEngines: registryWithShrink(),
  });
}

/** The retry path only engages on a SECOND turn: the engine compacts history
 *  older than the current turn, so a first turn has nothing to shrink. Call 1
 *  is turn 1 (must succeed so turn 2 has compactible history); call 2 is turn
 *  2's first attempt; call 3 is turn 2's retry. */
async function secondTurn(loop: AgentLoop, sessionKey: string): Promise<AgentEvent[]> {
  await collect(loop.run('first', { sessionKey }));
  return collect(loop.run('go', { sessionKey }));
}

describe('A4 — overflow compact-and-retry notice', () => {
  it('a turn that overflows once yields exactly one _loop progress and then the answer', async () => {
    const { llm, calls } = stubLlm((call) => call === 2);
    const events = await secondTurn(makeLoop(llm), 'cli:retry-once');
    const notices = loopNotices(events);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.audience).toBe('user');
    expect(notices[0]?.message).toBe('context overflow — compacting and retrying');
    // The retry ran and succeeded: three LLM calls, an answer, no error.
    expect(calls()).toBe(3);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('a turn that overflows past the single retry still yields exactly one notice', async () => {
    const { llm } = stubLlm((call) => call >= 2);
    const events = await secondTurn(makeLoop(llm), 'cli:retry-exhausted');
    expect(loopNotices(events)).toHaveLength(1);
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' && err.code).toBe('context_overflow');
  });

  it('a turn with no overflow yields no _loop notice', async () => {
    const { llm } = stubLlm(() => false);
    const events = await secondTurn(makeLoop(llm), 'cli:clean');
    expect(loopNotices(events)).toHaveLength(0);
  });
});
