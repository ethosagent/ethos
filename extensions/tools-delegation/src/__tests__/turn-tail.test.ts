// F07 (plan/phases/architecture-suggestions-2026-09-10.md) — a sub-agent's
// answer is not its finished turn.
//
// `AgentLoop.run()` yields `done` BEFORE its turn-end work
// (`maybeConsolidateAtTurnEnd`: the context engine's `onTurnComplete`, the
// memory flush, auto-compaction) and yields `error` before its usage flush and
// trace close. `runSubAgent` used to `break` on the first and `throw` on the
// second, which closes the generator and skips that work. It now drains the
// sub-turn to the end before the parent's tool call returns.

import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createDelegateTaskTool, createMixtureOfAgentsTool } from '../index';

/**
 * A loop shaped like `AgentLoop.run()` past its terminal event. `tailRan`
 * counts turns whose post-terminal code ran — which happens only if the
 * consumer keeps pulling after `terminal`; a `break`/`throw` closes the
 * generator at that yield.
 */
function tailedLoop(terminal: (prompt: string) => AgentEvent) {
  const state = { tailRan: 0 };
  const loop = {
    async *run(prompt: string): AsyncGenerator<AgentEvent> {
      yield { type: 'text_delta', text: `answer to ${prompt}` };
      yield terminal(prompt);
      // A real tail awaits I/O; so does this one.
      await new Promise((r) => setTimeout(r, 5));
      state.tailRan++;
    },
  } as unknown as AgentLoop;
  return { loop, state };
}

const done = (prompt: string): AgentEvent => ({
  type: 'done',
  text: `answer to ${prompt}`,
  turnCount: 1,
});

function makeCtx(): ToolContext {
  return {
    sessionId: 'parent-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    agentId: 'depth:0',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

describe('runSubAgent drains the sub-turn past its terminal event (F07)', () => {
  it('delegate_task returns only after the sub-turn tail has run', async () => {
    const t = tailedLoop(done);
    const tool = createDelegateTaskTool(t.loop);

    const result = await tool.execute({ prompt: 'the task' }, makeCtx());

    expect(result).toEqual({ ok: true, value: 'answer to the task' });
    expect(t.state.tailRan).toBe(1);
  });

  // A returnDirect tool result reaches the sub-turn only as `done.text`.
  it('delegate_task returns `done.text` when no text streamed — a returnDirect tool result', async () => {
    const loop = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 };
      },
    } as unknown as AgentLoop;
    const tool = createDelegateTaskTool(loop);

    expect(await tool.execute({ prompt: 'the task' }, makeCtx())).toEqual({
      ok: true,
      value: 'DIRECT ANSWER',
    });
  });

  it('delegate_task: a returnDirect answer after a streamed preamble — both, in order', async () => {
    const loop = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'Let me look that up.' };
        yield { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 };
      },
    } as unknown as AgentLoop;
    const tool = createDelegateTaskTool(loop);

    expect(await tool.execute({ prompt: 'the task' }, makeCtx())).toEqual({
      ok: true,
      value: 'Let me look that up.\n\nDIRECT ANSWER',
    });
  });

  it('delegate_task reports a sub-turn error only after draining past it', async () => {
    const t = tailedLoop(() => ({ type: 'error', error: 'provider exploded', code: 'llm_error' }));
    const tool = createDelegateTaskTool(t.loop);

    const result = await tool.execute({ prompt: 'the task' }, makeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Sub-agent failed: provider exploded');
    expect(t.state.tailRan).toBe(1);
  });

  it('mixture_of_agents drains every sub-agent and the synthesis', async () => {
    const t = tailedLoop(done);
    const tool = createMixtureOfAgentsTool(t.loop);

    const result = await tool.execute(
      { agents: [{ prompt: 'one' }, { prompt: 'two' }], synthesis_prompt: 'combine' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    // Two sub-agents plus the synthesis turn.
    expect(t.state.tailRan).toBe(3);
  });
});
