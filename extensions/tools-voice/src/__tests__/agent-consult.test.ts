import {
  AgentLoop,
  DefaultContextEngineRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import type {
  AgentEvent,
  CompletionChunk,
  ContextEngine,
  LLMProvider,
  ToolContext,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import {
  AGENT_CONSULT_TOOL,
  buildRealtimeInstructions,
  createAgentConsultTool,
  REALTIME_BOUNDARY_POLICY,
} from '../agent-consult';

// A loop that replays a scripted event stream and records how it was called.
// `runOpts` is the assertion surface for the things the consult must thread:
// the talk-session key, the personality, and the voice origin the
// spoken-confirmation gate keys on.
function fakeLoop(events: AgentEvent[]): {
  loop: AgentLoop;
  runOpts: Array<Record<string, unknown>>;
  prompts: string[];
} {
  const runOpts: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  const loop = {
    async *run(prompt: string, opts: Record<string, unknown>): AsyncGenerator<AgentEvent> {
      prompts.push(prompt);
      runOpts.push(opts);
      for (const event of events) yield event;
    },
  } as unknown as AgentLoop;
  return { loop, runOpts, prompts };
}

const ctx = {
  sessionId: 'row-1',
  sessionKey: 'voice:web:browser:chat-9',
  platform: 'web',
  workingDir: '/tmp',
  personalityId: 'ada',
  currentTurn: 1,
  messageCount: 0,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 4_000,
} as ToolContext;

const OWNER_ORIGIN = { transport: 'browser-talk-mode', speaker: 'owner' } as const;

describe('agent_consult', () => {
  it('runs one agent turn and returns its text', async () => {
    const { loop, prompts } = fakeLoop([
      { type: 'text_delta', text: 'The migration ' },
      { type: 'text_delta', text: 'is on Friday.' },
      { type: 'done', text: '', turnCount: 1 },
    ]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    const result = await tool.execute({ prompt: 'when is the migration?' }, ctx);

    expect(result).toEqual({ ok: true, value: 'The migration is on Friday.' });
    expect(prompts).toEqual(['when is the migration?']);
  });

  it('runs on the CALLER’s session key so consults share one conversation', async () => {
    const { loop, runOpts } = fakeLoop([{ type: 'done', text: '', turnCount: 1 }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    await tool.execute({ prompt: 'hi' }, ctx);

    expect(runOpts[0]?.sessionKey).toBe('voice:web:browser:chat-9');
    expect(runOpts[0]?.personalityId).toBe('ada');
  });

  it('stamps the voice origin the spoken-confirmation gate reads', async () => {
    const { loop, runOpts } = fakeLoop([{ type: 'done', text: '', turnCount: 1 }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    await tool.execute({ prompt: 'delete the branch' }, ctx);

    expect(runOpts[0]?.voiceOrigin).toEqual(OWNER_ORIGIN);
  });

  it('carries a far-end origin through unchanged — the gate must see the caller', async () => {
    // Nothing in-repo constructs this yet; V4 will. The tool must not launder
    // it into `owner` on the way through, because that is the one substitution
    // that lets a caller's voice authorize an owner action.
    const farEnd = { transport: 'sip', speaker: 'far_end' } as const;
    const { loop, runOpts } = fakeLoop([{ type: 'done', text: '', turnCount: 1 }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: farEnd });

    await tool.execute({ prompt: 'wire the money' }, ctx);

    expect(runOpts[0]?.voiceOrigin).toEqual(farEnd);
  });

  it('surfaces a turn error as a tool failure rather than throwing', async () => {
    const { loop } = fakeLoop([{ type: 'error', error: 'provider exploded', code: 'llm' }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    const result = await tool.execute({ prompt: 'hi' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('provider exploded');
  });

  it('rejects an empty prompt without spending a turn', async () => {
    const { loop, prompts } = fakeLoop([{ type: 'done', text: '', turnCount: 1 }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    const result = await tool.execute({ prompt: '   ' }, ctx);

    expect(result.ok).toBe(false);
    expect(prompts).toEqual([]);
  });

  it('cannot nest — a consulted turn calling it back is refused', async () => {
    const { loop, prompts } = fakeLoop([{ type: 'done', text: '', turnCount: 1 }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    const inner = { ...ctx, agentId: 'voice-consult' } as ToolContext;
    const result = await tool.execute({ prompt: 'ask yourself' }, inner);

    expect(result.ok).toBe(false);
    expect(prompts).toEqual([]);
  });
});

describe('boundary policy', () => {
  it('is present in the instructions the mint sends', () => {
    expect(buildRealtimeInstructions('I am Ada.')).toContain(REALTIME_BOUNDARY_POLICY);
  });

  it('puts SOUL.md first — the personality opens the session, not the policy', () => {
    const instructions = buildRealtimeInstructions('I am Ada. I speak plainly.');
    expect(instructions.startsWith('I am Ada. I speak plainly.')).toBe(true);
  });

  it('still carries the policy when a personality has no SOUL.md', () => {
    for (const soul of [null, undefined, '   ']) {
      expect(buildRealtimeInstructions(soul)).toBe(REALTIME_BOUNDARY_POLICY);
    }
  });

  it('names the tool it routes to, and draws the direct-answer line', () => {
    // The three categories the plan makes non-negotiable, plus the tiebreak.
    expect(REALTIME_BOUNDARY_POLICY).toContain(AGENT_CONSULT_TOOL);
    expect(REALTIME_BOUNDARY_POLICY).toMatch(/greetings/i);
    expect(REALTIME_BOUNDARY_POLICY).toMatch(/clarify/i);
    expect(REALTIME_BOUNDARY_POLICY).toMatch(/question of fact/i);
    expect(REALTIME_BOUNDARY_POLICY).toMatch(/unsure/i);
  });
});

// ---------------------------------------------------------------------------
// F07 (plan/phases/architecture-suggestions-2026-09-10.md) — a spoken answer is
// not a finished turn.
//
// `AgentLoop.run()` yields `done` BEFORE its turn-end work
// (`maybeConsolidateAtTurnEnd`: the context engine's `onTurnComplete`, the
// memory flush, auto-compaction) and yields `error` before its usage flush and
// trace close. Breaking out of the iterator on either skips that work. Waiting
// for it before answering would put compaction between a spoken question and
// its answer. So the consult answers at the terminal event and keeps draining.
// ---------------------------------------------------------------------------

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Let pending microtasks and a few macrotasks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

/**
 * A loop shaped like `AgentLoop.run()` past its terminal event: it answers,
 * yields `terminal`, then parks in a "tail" on a gate the test releases.
 * `tailRan` only moves if the consumer keeps pulling after the terminal event —
 * a consumer that breaks (or throws) closes the generator at that yield.
 */
function tailedLoop(terminal: AgentEvent) {
  const state = { runs: 0, parked: 0, tailRan: 0 };
  const gates: Array<() => void> = [];
  const loop = {
    async *run(): AsyncGenerator<AgentEvent> {
      state.runs++;
      yield { type: 'text_delta', text: `answer ${state.runs}` };
      yield terminal;
      state.parked++;
      await new Promise<void>((resolve) => gates.push(resolve));
      state.tailRan++;
    },
  } as unknown as AgentLoop;
  return {
    loop,
    state,
    release: () => {
      while (gates.length) gates.shift()?.();
    },
  };
}

const DONE: AgentEvent = { type: 'done', text: '', turnCount: 1 };

describe('agent_consult — the turn-end tail (F07)', () => {
  it('answers at `done` without waiting for the tail, then drains it', async () => {
    const t = tailedLoop(DONE);
    const tool = createAgentConsultTool(t.loop, { voiceOrigin: OWNER_ORIGIN });

    const result = await tool.execute({ prompt: 'when?' }, ctx);

    // Answered while the tail is still parked…
    expect(result).toEqual({ ok: true, value: 'answer 1' });
    await waitUntil(() => t.state.parked === 1);
    expect(t.state.tailRan).toBe(0);
    // …and the tail was not closed: it runs to the end once released.
    t.release();
    await waitUntil(() => t.state.tailRan === 1);
  });

  it('drains past an `error` too — the loop still has work after it', async () => {
    const t = tailedLoop({ type: 'error', error: 'provider exploded', code: 'llm_error' });
    const tool = createAgentConsultTool(t.loop, { voiceOrigin: OWNER_ORIGIN });

    const result = await tool.execute({ prompt: 'hi' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('provider exploded');
    await waitUntil(() => t.state.parked === 1);
    t.release();
    await waitUntil(() => t.state.tailRan === 1);
  });

  it('starts the next consult on the same session only after the previous tail finishes', async () => {
    const t = tailedLoop(DONE);
    const tool = createAgentConsultTool(t.loop, { voiceOrigin: OWNER_ORIGIN });

    expect(await tool.execute({ prompt: 'first' }, ctx)).toEqual({ ok: true, value: 'answer 1' });
    const second = tool.execute({ prompt: 'second' }, ctx);
    await settle();
    // The realtime lane released its task when the first answer came back; it
    // is the consult itself that keeps the second turn off the first's tail.
    expect(t.state.runs).toBe(1);

    t.release();
    expect(await second).toEqual({ ok: true, value: 'answer 2' });
    expect(t.state.tailRan).toBe(1);
    t.release();
    await waitUntil(() => t.state.tailRan === 2);
  });

  it('does not hold a consult on a different session behind that tail', async () => {
    const t = tailedLoop(DONE);
    const tool = createAgentConsultTool(t.loop, { voiceOrigin: OWNER_ORIGIN });

    await tool.execute({ prompt: 'first' }, ctx);
    const other = { ...ctx, sessionKey: 'voice:web:browser:chat-10' } as ToolContext;
    expect(await tool.execute({ prompt: 'second' }, other)).toEqual({
      ok: true,
      value: 'answer 2',
    });
    t.release();
    await waitUntil(() => t.state.tailRan === 2);
  });

  // A returnDirect tool result reaches the turn only as `done.text`: processTools
  // yields `done` with the tool's value and no text_delta.
  it('answers with `done.text` when no text streamed — a returnDirect tool result', async () => {
    const { loop } = fakeLoop([{ type: 'done', text: 'DIRECT ANSWER', turnCount: 1 }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    expect(await tool.execute({ prompt: 'look it up' }, ctx)).toEqual({
      ok: true,
      value: 'DIRECT ANSWER',
    });
  });

  it('a returnDirect answer after a streamed preamble: both, in order', async () => {
    const { loop } = fakeLoop([
      { type: 'text_delta', text: 'Let me look that up.' },
      { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 },
    ]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    expect(await tool.execute({ prompt: 'look it up' }, ctx)).toEqual({
      ok: true,
      value: 'Let me look that up.\n\nDIRECT ANSWER',
    });
  });

  it('a tail that throws does not fail the next consult', async () => {
    let runs = 0;
    const loop = {
      async *run(): AsyncGenerator<AgentEvent> {
        runs++;
        yield { type: 'text_delta', text: `answer ${runs}` };
        yield DONE;
        if (runs === 1) throw new Error('compaction blew up');
      },
    } as unknown as AgentLoop;
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    expect(await tool.execute({ prompt: 'first' }, ctx)).toEqual({ ok: true, value: 'answer 1' });
    expect(await tool.execute({ prompt: 'second' }, ctx)).toEqual({ ok: true, value: 'answer 2' });
  });
});

// A real AgentLoop, not a script: the tail here is the loop's own
// `maybeConsolidateAtTurnEnd`, parked inside a context engine's
// `onTurnComplete` on a gate the test controls.
describe('agent_consult on a real AgentLoop (F07)', () => {
  function realLoop() {
    const parked: Array<() => void> = [];
    const turnCompleteCalls: string[] = [];
    const engine: ContextEngine = {
      name: 'gated',
      async compact(opts) {
        return { messages: opts.messages, notes: 'noop' };
      },
      async onTurnComplete(input) {
        turnCompleteCalls.push(input.sessionMetadata.sessionKey);
        await new Promise<void>((resolve) => parked.push(resolve));
        return null;
      },
    };
    const contextEngines = new DefaultContextEngineRegistry();
    contextEngines.register(engine);
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'default', name: 'Default', toolset: [], context_engine: 'gated' });
    const llmState = { calls: 0 };
    const llm: LLMProvider = {
      name: 'scripted',
      model: 'scripted-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(): AsyncIterable<CompletionChunk> {
        llmState.calls++;
        yield { type: 'text_delta', text: `answer ${llmState.calls}` };
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() {
        return 1;
      },
    };
    const loop = new AgentLoop({
      llm,
      tools: new DefaultToolRegistry(),
      session: new InMemorySessionStore(),
      personalities,
      contextEngines,
      safety: createTestSafety(),
      // Maintenance off: the engine callback is a contract with the framework,
      // not a feature of compaction.
      compaction: { autoCompact: false },
    });
    return {
      loop,
      llmState,
      turnCompleteCalls,
      parked: () => parked.length,
      releaseAll: () => {
        while (parked.length) parked.shift()?.();
      },
    };
  }

  const realCtx = { ...ctx, personalityId: 'default' } as ToolContext;

  it('returns the answer while onTurnComplete is parked; the next consult waits for it', async () => {
    const r = realLoop();
    const tool = createAgentConsultTool(r.loop, { voiceOrigin: OWNER_ORIGIN });

    expect(await tool.execute({ prompt: 'first' }, realCtx)).toEqual({
      ok: true,
      value: 'answer 1',
    });
    // The answer is back and the turn's tail is still running.
    await waitUntil(() => r.parked() === 1);
    expect(r.turnCompleteCalls).toEqual([realCtx.sessionKey]);

    const second = tool.execute({ prompt: 'second' }, realCtx);
    await settle();
    expect(r.llmState.calls).toBe(1);

    r.releaseAll();
    expect(await second).toEqual({ ok: true, value: 'answer 2' });
    await waitUntil(() => r.parked() === 1);
    r.releaseAll();
    await waitUntil(() => r.turnCompleteCalls.length === 2);
  });
});
