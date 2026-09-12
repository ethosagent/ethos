// F07 (plan/phases/architecture-suggestions-2026-09-10.md) — a streamed answer
// is not a finished turn.
//
// `AgentLoop.run()` yields `done` BEFORE its turn-end work
// (`maybeConsolidateAtTurnEnd`: the context engine's `onTurnComplete`, the
// memory flush, auto-compaction). The streaming route used to send the
// `finish_reason` chunk and `[DONE]` only once the iterator ended — behind that
// work. Now the client-visible stream finishes at the terminal event and the
// handler keeps draining the loop server-side until it ends.
//
// The case that makes this more than a reordering: closing the response must
// not count as the client going away. The route aborts the turn on
// `stream.onAbort` — a genuine disconnect BEFORE the answer — and a close that
// fired that would cut the drain it exists to protect.

import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompletionsRepository } from '../../features/completions/repository';
import { CompletionsService } from '../../features/completions/service';
import { openAiRoutes } from '../../routes/openai';
import type { PersonalitiesService } from '../../services/personalities.service';
import { makeStubConfigService } from '../test-helpers';

/** A loop that answers, then parks in a tail until released. Records its abort signal. */
function tailedLoop() {
  const state = { tailRan: false, signal: undefined as AbortSignal | undefined };
  const gates: Array<() => void> = [];
  const loop = {
    hooks: new DefaultHookRegistry(),
    async *run(_input: string, opts: { abortSignal?: AbortSignal }): AsyncGenerator<AgentEvent> {
      state.signal = opts.abortSignal;
      yield { type: 'text_delta', text: 'the answer' };
      yield { type: 'usage', inputTokens: 4, outputTokens: 2, estimatedCostUsd: 0 };
      yield { type: 'done', text: 'the answer', turnCount: 1 };
      await new Promise<void>((resolve) => gates.push(resolve));
      state.tailRan = true;
    },
  } as unknown as AgentLoop;
  return {
    loop,
    state,
    parked: () => gates.length,
    release: () => {
      while (gates.length) gates.shift()?.();
    },
  };
}

async function setup(loop: AgentLoop) {
  const apiKeys = new SqliteApiKeyStore(':memory:');
  const sessions = new SQLiteSessionStore(':memory:');
  const created = await apiKeys.create({ name: 'cursor', scopes: ['chat'] });
  const app = openAiRoutes({
    apiKeys,
    personalities: {
      list: () => ({ items: [{ id: 'engineer' }], nextCursor: null, defaultId: 'engineer' }),
    } as unknown as PersonalitiesService,
    completions: new CompletionsService({
      loop,
      sessions: new CompletionsRepository(sessions),
      defaults: { model: 'claude-test', provider: 'anthropic' },
    }),
    config: makeStubConfigService(),
  });
  const close = () => {
    apiKeys.close();
    sessions.close();
  };
  return { app, close, bearer: { Authorization: `Bearer ${created.secret}` } };
}

/** Read the whole SSE body. Resolves only when the server ENDS the response. */
async function readSse(body: ReadableStream<Uint8Array> | null): Promise<string[]> {
  if (!body) throw new Error('no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  return buf
    .split('\n\n')
    .map((part) => part.trim())
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: timed out`)), ms)),
  ]);
}

describe('POST /v1/chat/completions (stream) — the turn-end tail (F07)', () => {
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function request(t: ReturnType<typeof tailedLoop>, includeUsage = false) {
    const s = await setup(t.loop);
    close = s.close;
    return s.app.request('/chat/completions', {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'engineer',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      }),
    });
  }

  it('finishes the client stream while the tail is parked, then drains it', async () => {
    const t = tailedLoop();
    const res = await request(t);

    const frames = await within(readSse(res.body), 1000, 'response end');
    expect(frames.at(-1)).toBe('[DONE]');
    const finish = JSON.parse(frames.at(-2) ?? '{}') as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(finish.choices[0]?.finish_reason).toBe('stop');
    expect(t.state.tailRan).toBe(false);
    // The handler is still pulling the loop: it reaches the parked tail.
    await vi.waitFor(() => expect(t.parked()).toBe(1));

    // Ending the response was not a client disconnect: the turn is not aborted
    // and its tail runs to the end.
    expect(t.state.signal?.aborted).toBe(false);
    t.release();
    await vi.waitFor(() => expect(t.state.tailRan).toBe(true));
    expect(t.state.signal?.aborted).toBe(false);
  });

  it('a client disconnect BEFORE the answer still aborts the turn', async () => {
    const state = { started: false, signal: undefined as AbortSignal | undefined };
    let answer: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const loop = {
      hooks: new DefaultHookRegistry(),
      async *run(_i: string, opts: { abortSignal?: AbortSignal }): AsyncGenerator<AgentEvent> {
        state.signal = opts.abortSignal;
        state.started = true;
        await gate;
        yield { type: 'text_delta', text: 'too late' };
        yield { type: 'done', text: 'too late', turnCount: 1 };
      },
    } as unknown as AgentLoop;
    const s = await setup(loop);
    close = s.close;
    const res = await s.app.request('/chat/completions', {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'engineer',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });

    await vi.waitFor(() => expect(state.started).toBe(true));
    await res.body?.cancel();
    await vi.waitFor(() => expect(state.signal?.aborted).toBe(true));
    answer?.();
  });

  it('logs a tail failure with the request id', async () => {
    const loop = {
      hooks: new DefaultHookRegistry(),
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'the answer' };
        yield { type: 'done', text: 'the answer', turnCount: 1 };
        throw new Error('compaction blew up');
      },
    } as unknown as AgentLoop;
    const s = await setup(loop);
    close = s.close;
    const outer = new Hono();
    outer.use('*', requestId({ headerName: 'x-request-id' }));
    outer.route('/', s.app);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await outer.request('/chat/completions', {
        method: 'POST',
        headers: { ...s.bearer, 'content-type': 'application/json', 'x-request-id': 'req-tail-1' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      await within(readSse(res.body), 1000, 'response end');
      await vi.waitFor(() =>
        expect(logged).toHaveBeenCalledWith(
          '[stream_tail_failed]',
          'req-tail-1',
          expect.any(Error),
        ),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it('with include_usage, the usage chunk is the last frame before [DONE] — still before the tail', async () => {
    const t = tailedLoop();
    const res = await request(t, true);

    const frames = await within(readSse(res.body), 1000, 'response end');
    expect(frames.at(-1)).toBe('[DONE]');
    expect(JSON.parse(frames.at(-2) ?? '{}')).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
    expect(t.state.tailRan).toBe(false);
    await vi.waitFor(() => expect(t.parked()).toBe(1));
    t.release();
    await vi.waitFor(() => expect(t.state.tailRan).toBe(true));
  });
});
