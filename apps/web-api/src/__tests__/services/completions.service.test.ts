import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompletionsRepository } from '../../features/completions/repository';
import { CompletionsService } from '../../features/completions/service';
import type { ChatCompletionChunk, ChatCompletionRequest } from '../../routes/openai/schemas';
import { makeStubAgentLoop } from '../test-helpers';

const defaults = { model: 'claude-test', provider: 'anthropic' };
const fixedNow = () => new Date('2026-05-13T00:00:00.000Z');
const seqIds = () => {
  let n = 0;
  return () => `id-${++n}`;
};

function makeService(overrides: Parameters<typeof makeStubAgentLoop>[0] = {}) {
  const store = new SQLiteSessionStore(':memory:');
  const sessions = new CompletionsRepository(store);
  const loop = makeStubAgentLoop(overrides);
  const service = new CompletionsService({
    loop,
    sessions,
    defaults,
    now: fixedNow,
    newId: seqIds(),
  });
  return { service, sessions, store, loop };
}

const userOnly = (text: string): ChatCompletionRequest => ({
  model: 'engineer',
  messages: [{ role: 'user' as const, content: text }],
});

describe('CompletionsService.complete', () => {
  let store: SQLiteSessionStore;
  afterEach(() => store.close());
  beforeEach(() => {});

  it('returns OpenAI response shape for a single text turn', async () => {
    const ctx = makeService({
      events: [
        { type: 'text_delta', text: 'hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'usage', inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0 },
        { type: 'done', text: 'hello world', turnCount: 1 },
      ],
    });
    store = ctx.store;
    const out = await ctx.service.complete({ req: userOnly('hi'), personalityId: 'engineer' });
    expect(out.id).toBe('chatcmpl-id-1');
    expect(out.object).toBe('chat.completion');
    expect(out.created).toBe(Math.floor(fixedNow().getTime() / 1000));
    expect(out.model).toBe('engineer');
    expect(out.choices).toEqual([
      { index: 0, message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' },
    ]);
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });

  it('passes personalityId through to AgentLoop.run', async () => {
    let captured: { input: string; opts: unknown } | null = null;
    const ctx = makeService({
      onRun: (input, opts) => {
        captured = { input, opts };
      },
      events: [{ type: 'done', text: '', turnCount: 1 }],
    });
    store = ctx.store;
    await ctx.service.complete({ req: userOnly('hello'), personalityId: 'researcher' });
    expect(captured).not.toBeNull();
    const o = captured as unknown as {
      input: string;
      opts: { sessionKey: string; personalityId?: string };
    };
    expect(o.input).toBe('hello');
    expect(o.opts.personalityId).toBe('researcher');
    expect(o.opts.sessionKey).toMatch(/^openai:ephem:/);
  });

  it('omits personalityId on the run opts when undefined (ethos-default path)', async () => {
    let opts: { sessionKey: string; personalityId?: string } | null = null;
    const ctx = makeService({
      onRun: (_input, o) => {
        opts = o as typeof opts;
      },
      events: [{ type: 'done', text: '', turnCount: 1 }],
    });
    store = ctx.store;
    await ctx.service.complete({ req: userOnly('hi'), personalityId: undefined });
    expect(opts).not.toBeNull();
    const o = opts as unknown as { sessionKey: string; personalityId?: string };
    expect(o.personalityId).toBeUndefined();
  });

  it('throws on AgentLoop error event', async () => {
    const ctx = makeService({
      events: [
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: 'upstream went down', code: 'LLM_ERROR' },
      ],
    });
    store = ctx.store;
    await expect(
      ctx.service.complete({ req: userOnly('hi'), personalityId: 'engineer' }),
    ).rejects.toThrow(/upstream went down/);
  });

  it('throws when no user message ends the conversation', async () => {
    const ctx = makeService({});
    store = ctx.store;
    const req: ChatCompletionRequest = {
      model: 'engineer',
      messages: [{ role: 'assistant', content: 'unprompted' }],
    };
    await expect(ctx.service.complete({ req, personalityId: 'engineer' })).rejects.toThrow(
      /messages must end with a `user` message/,
    );
  });

  it('rejects [user, assistant] — refuses to silently rerun an earlier user prompt', async () => {
    const ctx = makeService({});
    store = ctx.store;
    const req: ChatCompletionRequest = {
      model: 'engineer',
      messages: [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'answer' },
      ],
    };
    await expect(ctx.service.complete({ req, personalityId: 'engineer' })).rejects.toThrow(
      /messages must end with a `user` message/,
    );
  });

  it('pre-populates the ephemeral session with prior user/assistant turns', async () => {
    const ctx = makeService({ events: [{ type: 'done', text: '', turnCount: 1 }] });
    store = ctx.store;
    const req: ChatCompletionRequest = {
      model: 'engineer',
      messages: [
        { role: 'system', content: 'ignored' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    };
    await ctx.service.complete({ req, personalityId: 'engineer' });
    const list = await store.listSessions({});
    expect(list).toHaveLength(1);
    const session = list[0];
    if (!session) throw new Error('expected one session');
    expect(session.key).toMatch(/^openai:ephem:/);
    const messages = await store.getMessages(session.id);
    // System dropped, q1+a1 prepopulated (q2 is the live turn and not appended by the service).
    expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual(['user:q1', 'assistant:a1']);
  });

  it('does NOT pre-populate when X-Ethos-Session (stateful) is supplied', async () => {
    const ctx = makeService({ events: [{ type: 'done', text: '', turnCount: 1 }] });
    store = ctx.store;
    const req: ChatCompletionRequest = {
      model: 'engineer',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    };
    await ctx.service.complete({
      req,
      personalityId: 'engineer',
      sessionKeyOverride: 'my-session',
    });
    // No session row created by the service; AgentLoop would lazily create
    // `openai:my-session` on its own. The stub doesn't, so there are zero
    // sessions in the store.
    const list = await store.listSessions({});
    expect(list).toHaveLength(0);
  });
});

describe('CompletionsService.stream', () => {
  let store: SQLiteSessionStore;
  afterEach(() => store.close());

  async function collect(gen: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
    const out: ChatCompletionChunk[] = [];
    for await (const chunk of gen) out.push(chunk);
    return out;
  }

  it('yields a role-bearing first delta, then content-only deltas, then a final finish_reason chunk', async () => {
    const ctx = makeService({
      events: [
        { type: 'text_delta', text: 'foo' },
        { type: 'text_delta', text: 'bar' },
        { type: 'done', text: 'foobar', turnCount: 1 },
      ],
    });
    store = ctx.store;
    const chunks = await collect(
      ctx.service.stream({ req: userOnly('hi'), personalityId: 'engineer' }),
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: 'assistant', content: 'foo' });
    expect(chunks[1]?.choices[0]?.delta).toEqual({ content: 'bar' });
    expect(chunks[2]?.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'stop' });
    expect(chunks[2]?.usage).toBeUndefined();
  });

  it('emits a usage chunk only when stream_options.include_usage is true', async () => {
    const ctx = makeService({
      events: [
        { type: 'text_delta', text: 'ok' },
        { type: 'usage', inputTokens: 4, outputTokens: 1, estimatedCostUsd: 0 },
        { type: 'done', text: 'ok', turnCount: 1 },
      ],
    });
    store = ctx.store;
    const req: ChatCompletionRequest = {
      model: 'engineer',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    };
    const chunks = await collect(ctx.service.stream({ req, personalityId: 'engineer' }));
    const usageChunk = chunks[chunks.length - 1];
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage).toEqual({ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
  });

  it('throws when AgentLoop emits an error event', async () => {
    const ctx = makeService({
      events: [{ type: 'error', error: 'boom', code: 'LLM_ERROR' }],
    });
    store = ctx.store;
    const gen = ctx.service.stream({ req: userOnly('hi'), personalityId: 'engineer' });
    await expect(
      (async () => {
        for await (const _ of gen) void _;
      })(),
    ).rejects.toThrow(/boom/);
  });

  it('forwards abortSignal into AgentLoop.run', async () => {
    let opts: { abortSignal?: AbortSignal } | null = null;
    const ctx = makeService({
      onRun: (_input, o) => {
        opts = o as typeof opts;
      },
      events: [{ type: 'done', text: '', turnCount: 1 }],
    });
    store = ctx.store;
    const controller = new AbortController();
    await collect(
      ctx.service.stream({
        req: userOnly('hi'),
        personalityId: 'engineer',
        abortSignal: controller.signal,
      }),
    );
    expect(opts).not.toBeNull();
    const o = opts as unknown as { abortSignal?: AbortSignal };
    expect(o.abortSignal).toBe(controller.signal);
  });
});

describe('CompletionsService — session personality binding', () => {
  let store: SQLiteSessionStore;
  afterEach(() => store.close());

  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  };

  async function bind(ctx: ReturnType<typeof makeService>, id: string, personalityId: string) {
    await ctx.store.createSession({
      key: `openai:${id}`,
      platform: 'openai',
      model: 'claude-test',
      provider: 'anthropic',
      personalityId,
      usage,
    });
  }

  it('assertPersonalityUnlocked rejects a conflicting personality on a pinned session', async () => {
    const ctx = makeService({});
    store = ctx.store;
    await bind(ctx, 'pinned', 'engineer');

    await expect(
      ctx.service.assertPersonalityUnlocked({
        req: userOnly('hi'),
        personalityId: 'researcher',
        sessionKeyOverride: 'pinned',
      }),
    ).rejects.toThrow(/bound to personality "engineer"/);
  });

  it('assertPersonalityUnlocked passes for a matching id, an unpinned request, and ethos-default', async () => {
    const ctx = makeService({});
    store = ctx.store;
    await bind(ctx, 'pinned', 'engineer');

    await expect(
      ctx.service.assertPersonalityUnlocked({
        req: userOnly('hi'),
        personalityId: 'engineer',
        sessionKeyOverride: 'pinned',
      }),
    ).resolves.toBeUndefined();
    // No pin — a fresh ephemeral session per request can never conflict.
    await expect(
      ctx.service.assertPersonalityUnlocked({ req: userOnly('hi'), personalityId: 'researcher' }),
    ).resolves.toBeUndefined();
    // `model: ethos-default` names no personality, so there is nothing to conflict.
    await expect(
      ctx.service.assertPersonalityUnlocked({
        req: userOnly('hi'),
        personalityId: undefined,
        sessionKeyOverride: 'pinned',
      }),
    ).resolves.toBeUndefined();
  });

  it("maps the loop's personality_locked refusal to INVALID_INPUT, not INTERNAL", async () => {
    const ctx = makeService({
      events: [
        {
          type: 'error',
          error: 'Session openai:pinned is bound to personality "engineer".',
          code: 'personality_locked',
        },
      ],
    });
    store = ctx.store;

    const err = await ctx.service
      .complete({ req: userOnly('hi'), personalityId: 'researcher' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    expect((err as EthosError).code).toBe('INVALID_INPUT');
    expect((err as EthosError).details).toEqual({ openAiCode: 'personality_locked' });
  });

  it('binds the personality when it pre-creates a session for prior messages', async () => {
    const ctx = makeService({ events: [{ type: 'done', text: '', turnCount: 1 }] });
    store = ctx.store;
    const req: ChatCompletionRequest = {
      model: 'engineer',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    };
    await ctx.service.complete({ req, personalityId: 'engineer' });

    const sessions = await ctx.store.listSessions();
    const created = sessions.find((s) => s.key.startsWith('openai:ephem:'));
    expect(created?.personalityId).toBe('engineer');
  });
});

// F07 (plan/phases/architecture-suggestions-2026-09-10.md). AgentLoop yields
// `error` BEFORE its usage flush and trace close (and `done` before its
// turn-end work). Throwing inside the `for await` closes the generator and
// skips that. The error must still become the response — after the drain.
describe('CompletionsService — drains the loop past its terminal event (F07)', () => {
  let store: SQLiteSessionStore;
  afterEach(() => store.close());

  /** A loop that yields `events`, then runs a tail only a draining consumer reaches. */
  function tailedService(events: AgentEvent[]) {
    const state = { tailRan: false };
    store = new SQLiteSessionStore(':memory:');
    const loop = {
      async *run(): AsyncGenerator<AgentEvent> {
        for (const event of events) yield event;
        await new Promise((r) => setTimeout(r, 5));
        state.tailRan = true;
      },
    } as unknown as AgentLoop;
    const service = new CompletionsService({
      loop,
      sessions: new CompletionsRepository(store),
      defaults,
      now: fixedNow,
      newId: seqIds(),
    });
    return { service, state };
  }

  const failing: AgentEvent[] = [
    { type: 'text_delta', text: 'partial' },
    { type: 'error', error: 'upstream went down', code: 'LLM_ERROR' },
  ];

  it('complete(): rejects with the loop error only after the loop has drained', async () => {
    const t = tailedService(failing);
    await expect(
      t.service.complete({ req: userOnly('hi'), personalityId: 'engineer' }),
    ).rejects.toThrow(/upstream went down/);
    expect(t.state.tailRan).toBe(true);
  });

  it('complete(): drains past `done` before answering', async () => {
    const t = tailedService([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', text: 'ok', turnCount: 1 },
    ]);
    const out = await t.service.complete({ req: userOnly('hi'), personalityId: 'engineer' });
    expect(out.choices[0]?.message.content).toBe('ok');
    expect(t.state.tailRan).toBe(true);
  });

  // A returnDirect tool result reaches the turn only as `done.text`: processTools
  // yields `done` with the tool's value and no text_delta.
  const direct: AgentEvent[] = [{ type: 'done', text: 'DIRECT ANSWER', turnCount: 1 }];

  it('complete(): answers with `done.text` when no text streamed — returnDirect', async () => {
    const t = tailedService(direct);
    const out = await t.service.complete({ req: userOnly('hi'), personalityId: 'engineer' });
    expect(out.choices[0]?.message.content).toBe('DIRECT ANSWER');
  });

  it('stream(): streams `done.text` when no text streamed — returnDirect', async () => {
    const t = tailedService(direct);
    const seen: ChatCompletionChunk[] = [];
    for await (const chunk of t.service.stream({
      req: userOnly('hi'),
      personalityId: 'engineer',
    })) {
      seen.push(chunk);
    }
    expect(seen.map((c) => c.choices[0]?.delta)).toEqual([
      { role: 'assistant', content: 'DIRECT ANSWER' },
      {},
    ]);
    expect(seen.at(-1)?.choices[0]?.finish_reason).toBe('stop');
  });

  // A streamed preamble, then a returnDirect tool: the answer is only in `done.text`.
  const preamble: AgentEvent[] = [
    { type: 'text_delta', text: 'Let me look that up.' },
    { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 },
  ];

  it('complete(): a returnDirect answer after a streamed preamble — both, in order', async () => {
    const t = tailedService(preamble);
    const out = await t.service.complete({ req: userOnly('hi'), personalityId: 'engineer' });
    expect(out.choices[0]?.message.content).toBe('Let me look that up.\n\nDIRECT ANSWER');
  });

  it('stream(): the answer streams after the preamble, before the finish chunk', async () => {
    const t = tailedService(preamble);
    const seen: ChatCompletionChunk[] = [];
    for await (const chunk of t.service.stream({
      req: userOnly('hi'),
      personalityId: 'engineer',
    })) {
      seen.push(chunk);
    }
    expect(seen.map((c) => c.choices[0]?.delta)).toEqual([
      { role: 'assistant', content: 'Let me look that up.' },
      { content: '\n\nDIRECT ANSWER' },
      {},
    ]);
  });

  it('stream(): throws the loop error only after the loop has drained', async () => {
    const t = tailedService(failing);
    const seen: ChatCompletionChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of t.service.stream({
          req: userOnly('hi'),
          personalityId: 'engineer',
        })) {
          seen.push(chunk);
        }
      })(),
    ).rejects.toThrow(/upstream went down/);
    expect(t.state.tailRan).toBe(true);
    // Text before the error still streamed; nothing after it did.
    expect(seen.map((c) => c.choices[0]?.delta.content)).toEqual(['partial']);
  });
});

// F07 — the streamed answer is complete at `done`; the rest of the turn is
// turn-end maintenance. The closing chunks go out at the terminal event, and
// the generator keeps draining the loop (yielding nothing more) until it ends.
describe('CompletionsService.stream — closing chunks at the terminal event (F07)', () => {
  let store: SQLiteSessionStore;
  afterEach(() => store.close());

  it('yields the finish_reason (and usage) chunk before the tail runs, then drains it', async () => {
    const state = { tailRan: false };
    store = new SQLiteSessionStore(':memory:');
    const loop = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'usage', inputTokens: 4, outputTokens: 1, estimatedCostUsd: 0 };
        yield { type: 'done', text: 'ok', turnCount: 1 };
        await new Promise((r) => setTimeout(r, 5));
        state.tailRan = true;
      },
    } as unknown as AgentLoop;
    const service = new CompletionsService({
      loop,
      sessions: new CompletionsRepository(store),
      defaults,
      now: fixedNow,
      newId: seqIds(),
    });
    const req: ChatCompletionRequest = {
      model: 'engineer',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    };

    const seen: Array<{ chunk: ChatCompletionChunk; tailRan: boolean }> = [];
    for await (const chunk of service.stream({ req, personalityId: 'engineer' })) {
      seen.push({ chunk, tailRan: state.tailRan });
    }

    expect(
      seen.map((s) => (s.chunk.choices.length === 0 ? 'usage' : s.chunk.choices[0]?.finish_reason)),
    ).toEqual([null, 'stop', 'usage']);
    // Both closing chunks were produced while the tail had not run…
    expect(seen.every((s) => !s.tailRan)).toBe(true);
    // …and the generator did not end until it had.
    expect(state.tailRan).toBe(true);
  });
});
