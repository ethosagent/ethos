// F07 (plan/phases/architecture-suggestions-2026-09-10.md). AgentLoop yields
// `error` BEFORE its usage flush and trace close (and `done` before its
// turn-end work). `runBlocking` used to `throw` inside its `for await`, which
// closes the generator and skips that. The error must still become the JSON-RPC
// error — after the drain, while the session is still marked busy.

import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { AgentEvent } from '@ethosagent/core';
import type { Logger, SessionStore } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpServer, type AgentRunner } from '../index';

/** A runner that yields `events`, then runs a tail only a draining consumer reaches. */
function tailedRunner(events: AgentEvent[]) {
  const state = { tailRan: false };
  const runner: AgentRunner = {
    run: async function* () {
      for (const event of events) yield event;
      await new Promise((r) => setTimeout(r, 5));
      state.tailRan = true;
    },
  };
  return { runner, state };
}

describe('AcpServer runBlocking drains the turn past its terminal event (F07)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function promptOverHttp(runner: AgentRunner): Promise<Record<string, unknown>> {
    // The HTTP `prompt` path never touches the session store.
    const server = new AcpServer({ runner, session: {} as SessionStore, authToken: 'tok' });
    const http = server.startHttp(0);
    await new Promise<void>((resolve) => http.on('listening', () => resolve()));
    close = () => new Promise<void>((resolve) => http.close(() => resolve()));
    const { port } = http.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'prompt',
        params: { sessionKey: 'acp:s1', text: 'hi' },
      }),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  it('reports a turn error only after the loop has drained past it', async () => {
    const t = tailedRunner([
      { type: 'text_delta', text: 'partial' },
      { type: 'error', error: 'provider exploded', code: 'llm_error' },
    ]);

    const body = await promptOverHttp(t.runner);

    expect(body.error).toEqual({ code: -32000, message: 'provider exploded' });
    expect(t.state.tailRan).toBe(true);
  });

  // A returnDirect tool result reaches the turn only as `done.text`.
  it('answers with `done.text` when no text streamed — a returnDirect tool result', async () => {
    const t = tailedRunner([{ type: 'done', text: 'DIRECT ANSWER', turnCount: 1 }]);

    const body = await promptOverHttp(t.runner);

    expect(body.result).toEqual({ text: 'DIRECT ANSWER', turnCount: 1 });
  });

  it('a returnDirect answer after a streamed preamble: both, in order', async () => {
    const t = tailedRunner([
      { type: 'text_delta', text: 'Let me look that up.' },
      { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 },
    ]);

    const body = await promptOverHttp(t.runner);

    expect(body.result).toEqual({ text: 'Let me look that up.\n\nDIRECT ANSWER', turnCount: 1 });
  });

  it('answers only after the loop has drained past `done`', async () => {
    const t = tailedRunner([
      { type: 'text_delta', text: 'the answer' },
      { type: 'done', text: 'the answer', turnCount: 1 },
    ]);

    const body = await promptOverHttp(t.runner);

    expect(body.result).toEqual({ text: 'the answer', turnCount: 1 });
    expect(t.state.tailRan).toBe(true);
  });
});

// The streaming `prompt` (stdio / WebSocket) answers at the terminal event and
// drains behind it: the result must not wait for the turn-end tail, and the
// session stays busy until the drain ends — a next prompt on it WAITS for the
// drain instead of being refused, because the client did nothing wrong by
// sending it after the result.
describe('AcpServer streaming prompt answers at the terminal event (F07)', () => {
  function stdioServer(runner: AgentRunner, logger?: Logger) {
    const input = new PassThrough();
    const output = new PassThrough();
    new AcpServer({
      runner,
      session: {} as SessionStore,
      input,
      output,
      ...(logger ? { logger } : {}),
    }).start();
    const messages: Array<Record<string, unknown>> = [];
    let buf = '';
    output.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
    });
    const prompt = (id: number, text: string) =>
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method: 'prompt', params: { sessionKey: 'sk', text } })}\n`,
      );
    return { messages, prompt };
  }

  /** Each run answers, yields `terminal`, parks in a tail, then yields a tail event. */
  function parkedRunner(terminal: AgentEvent) {
    const state = { runs: 0, tailsRan: 0 };
    const gates: Array<() => void> = [];
    const runner: AgentRunner = {
      run: async function* () {
        state.runs++;
        yield { type: 'text_delta', text: `answer ${state.runs}` };
        yield terminal;
        await new Promise<void>((resolve) => gates.push(resolve));
        // What a turn-end compaction yields: drained, not streamed.
        yield {
          type: 'tool_progress',
          toolName: '_compaction',
          message: 'TAIL-NOTICE',
          audience: 'user',
        };
        state.tailsRan++;
      },
    };
    return {
      runner,
      state,
      parked: () => gates.length,
      release: () => {
        while (gates.length) gates.shift()?.();
      },
    };
  }

  const resultFor = (messages: Array<Record<string, unknown>>, id: number) =>
    messages.find((m) => m.id === id && 'result' in m);

  it('sends the result while the tail is parked, and nothing from the tail after it', async () => {
    const r = parkedRunner({ type: 'done', text: 'answer 1', turnCount: 1 });
    const s = stdioServer(r.runner);

    s.prompt(1, 'first');
    await vi.waitFor(() => expect(resultFor(s.messages, 1)).toBeDefined());
    expect(resultFor(s.messages, 1)).toMatchObject({ result: { text: 'answer 1', turnCount: 1 } });
    expect(r.parked()).toBe(1);

    r.release();
    await vi.waitFor(() => expect(r.state.tailsRan).toBe(1));
    expect(JSON.stringify(s.messages)).not.toContain('TAIL-NOTICE');
  });

  it('answers with `done.text` when no text streamed — a returnDirect tool result', async () => {
    const runner: AgentRunner = {
      run: async function* () {
        yield { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 };
      },
    };
    const s = stdioServer(runner);

    s.prompt(1, 'look it up');
    await vi.waitFor(() => expect(resultFor(s.messages, 1)).toBeDefined());
    expect(resultFor(s.messages, 1)).toMatchObject({
      result: { text: 'DIRECT ANSWER', turnCount: 1 },
    });
  });

  it('streaming: a returnDirect answer after a streamed preamble is in the result', async () => {
    const runner: AgentRunner = {
      run: async function* () {
        yield { type: 'text_delta', text: 'Let me look that up.' };
        yield { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 };
      },
    };
    const s = stdioServer(runner);

    s.prompt(1, 'look it up');
    await vi.waitFor(() => expect(resultFor(s.messages, 1)).toBeDefined());
    expect(resultFor(s.messages, 1)).toMatchObject({
      result: { text: 'Let me look that up.\n\nDIRECT ANSWER' },
    });
  });

  it('logs a tail failure after the result instead of swallowing it silently', async () => {
    const runner: AgentRunner = {
      run: async function* () {
        yield { type: 'text_delta', text: 'the answer' };
        yield { type: 'done', text: 'the answer', turnCount: 1 };
        throw new Error('compaction blew up');
      },
    };
    const warn = vi.fn();
    const logger = { debug() {}, info() {}, warn, error() {}, child: () => logger } as Logger;
    const s = stdioServer(runner, logger);

    s.prompt(1, 'first');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(resultFor(s.messages, 1)).toMatchObject({ result: { text: 'the answer' } });
    // One response for the request id — the tail failure sends no second one.
    expect(s.messages.filter((m) => m.id === 1)).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain('compaction blew up');
  });

  it('answers at an `error` too', async () => {
    const r = parkedRunner({ type: 'error', error: 'provider exploded', code: 'llm_error' });
    const s = stdioServer(r.runner);

    s.prompt(1, 'first');
    await vi.waitFor(() => expect(resultFor(s.messages, 1)).toBeDefined());
    expect(r.parked()).toBe(1);
    r.release();
    await vi.waitFor(() => expect(r.state.tailsRan).toBe(1));
  });

  it('a next prompt on the session waits for the drain, then runs — it is not refused', async () => {
    const r = parkedRunner({ type: 'done', text: '', turnCount: 1 });
    const s = stdioServer(r.runner);

    s.prompt(1, 'first');
    await vi.waitFor(() => expect(resultFor(s.messages, 1)).toBeDefined());
    s.prompt(2, 'second');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.state.runs).toBe(1);
    expect(s.messages.some((m) => m.id === 2)).toBe(false);

    r.release();
    await vi.waitFor(() => expect(resultFor(s.messages, 2)).toBeDefined());
    expect(resultFor(s.messages, 2)).toMatchObject({ result: { text: 'answer 2' } });
    expect(r.state.tailsRan).toBe(1);
    r.release();
    await vi.waitFor(() => expect(r.state.tailsRan).toBe(2));
  });
});
