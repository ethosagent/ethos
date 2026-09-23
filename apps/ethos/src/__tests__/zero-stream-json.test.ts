import { Writable } from 'node:stream';
import { createEventTranslator } from '@ethosagent/surface-kit';
import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildResultLine, createJsonlWriter, encodeZeroEvent } from '../commands/zero-stream';

// Plan hermes-0.21.4-fixes §7.6 — the stream-json encoder: allow-list (D27),
// audience gate (D28), redaction (D30) and the backpressure-aware writer (D33).

const ev = (e: unknown) => e as AgentEvent;

describe('encodeZeroEvent', () => {
  it('maps every allow-listed event to a v:1 line', () => {
    const cases: Array<[AgentEvent, Record<string, unknown>]> = [
      [
        ev({ type: 'run_start', provider: 'p', model: 'm', source: 'default', traceId: 't1' }),
        { v: 1, type: 'run_start', provider: 'p', model: 'm', source: 'default', traceId: 't1' },
      ],
      [ev({ type: 'text_delta', text: 'hi' }), { v: 1, type: 'text_delta', text: 'hi' }],
      [
        ev({ type: 'tool_start', toolCallId: 'c1', toolName: 'read_file', args: { path: 'a' } }),
        { v: 1, type: 'tool_start', toolCallId: 'c1', toolName: 'read_file', args: { path: 'a' } },
      ],
      [
        ev({
          type: 'tool_progress',
          toolName: 'bash',
          message: 'step 2',
          percent: 50,
          audience: 'user',
        }),
        { v: 1, type: 'tool_progress', toolName: 'bash', message: 'step 2', percent: 50 },
      ],
      [
        ev({ type: 'tool_end', toolCallId: 'c1', toolName: 'read_file', ok: true, durationMs: 3 }),
        {
          v: 1,
          type: 'tool_end',
          toolCallId: 'c1',
          toolName: 'read_file',
          ok: true,
          durationMs: 3,
        },
      ],
      [
        ev({
          type: 'usage',
          inputTokens: 10,
          outputTokens: 2,
          estimatedCostUsd: 0.01,
          cacheReadTokens: 5,
        }),
        {
          v: 1,
          type: 'usage',
          inputTokens: 10,
          outputTokens: 2,
          estimatedCostUsd: 0.01,
          cacheReadTokens: 5,
        },
      ],
      [
        ev({ type: 'halt', kind: 'budget', rule: 'tool-budget', count: 3, message: 'stop' }),
        { v: 1, type: 'halt', kind: 'budget', rule: 'tool-budget', count: 3, message: 'stop' },
      ],
      [
        ev({ type: 'error', error: 'boom', code: 'LLM_ERROR' }),
        { v: 1, type: 'error', code: 'LLM_ERROR', error: 'boom' },
      ],
    ];
    for (const [input, expected] of cases) {
      expect(encodeZeroEvent(input)).toEqual(expected);
    }
  });

  it('drops everything not on the allow-list, including future variants', () => {
    expect(encodeZeroEvent(ev({ type: 'thinking_delta', thinking: 'hmm' }))).toBeNull();
    expect(encodeZeroEvent(ev({ type: 'done', text: 'x', turnCount: 1 }))).toBeNull();
    expect(encodeZeroEvent(ev({ type: 'context_meta', data: {} }))).toBeNull();
    expect(encodeZeroEvent(ev({ type: 'future_event' }))).toBeNull();
  });

  it('obeys the audience gate', () => {
    const progress = (audience: string) =>
      ev({ type: 'tool_progress', toolName: 't', message: 'm', audience });
    expect(encodeZeroEvent(progress('internal'))).toBeNull();
    expect(encodeZeroEvent(progress('dashboard'))).toBeNull();
    expect(encodeZeroEvent(progress('user'))).not.toBeNull();

    expect(
      encodeZeroEvent(
        ev({
          type: 'tool_start',
          toolCallId: 'p#1',
          toolName: 't',
          args: {},
          audience: 'internal',
        }),
      ),
    ).toBeNull();

    const end = (ok: boolean) =>
      ev({
        type: 'tool_end',
        toolCallId: 'p#1',
        toolName: 't',
        ok,
        durationMs: 1,
        audience: 'internal',
      });
    expect(encodeZeroEvent(end(true))).toBeNull();
    expect(encodeZeroEvent(end(false))).toMatchObject({ type: 'tool_end', ok: false });
  });

  it('redacts and truncates tool args, and never emits tool output bodies', () => {
    const key = `sk-ant-${'a'.repeat(95)}`;
    const long = 'x'.repeat(2000);
    const line = encodeZeroEvent(
      ev({ type: 'tool_start', toolCallId: 'c', toolName: 't', args: { key, nested: [long] } }),
    );
    const json = JSON.stringify(line);
    expect(json).not.toContain(key);
    expect(json).toContain('[REDACTED');
    expect(json).not.toContain(long);
    expect(json).toContain('truncated, 2000 chars');

    const end = encodeZeroEvent(
      ev({
        type: 'tool_end',
        toolCallId: 'c',
        toolName: 't',
        ok: false,
        durationMs: 1,
        result: 'secret body',
        structured: { a: 1 },
        error: `failed with ${key}`,
      }),
    );
    expect(end).not.toHaveProperty('result');
    expect(end).not.toHaveProperty('structured');
    expect(JSON.stringify(end)).not.toContain(key);

    const err = encodeZeroEvent(ev({ type: 'error', error: `bad ${key}`, code: 'LLM_ERROR' }));
    expect(JSON.stringify(err)).not.toContain(key);
  });
});

describe('buildResultLine', () => {
  it('folds the translator state, including a returnDirect answer', () => {
    const t = createEventTranslator();
    t.push(ev({ type: 'text_delta', text: 'Looking.' }));
    t.push(ev({ type: 'usage', inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.5 }));
    t.push(ev({ type: 'halt', kind: 'watcher', rule: 'r', message: 'paused' }));
    t.push(ev({ type: 'done', text: 'ANSWER', turnCount: 2 }));
    t.push(ev({ type: 'usage', inputTokens: 1, outputTokens: 0, estimatedCostUsd: 0.25 }));
    const line = buildResultLine(t, { sessionKey: 's', durationMs: 7, traceId: 'tr' });
    expect(line).toEqual({
      v: 1,
      type: 'result',
      ok: true,
      exitCode: 0,
      text: 'Looking.\n\nANSWER',
      turnCount: 2,
      traceId: 'tr',
      usage: { inputTokens: 2, outputTokens: 2, estimatedCostUsd: 0.75 },
      halt: { kind: 'watcher', rule: 'r', message: 'paused' },
      error: null,
      sessionKey: 's',
      durationMs: 7,
    });
  });

  it('reports the first error event, else a passed-in failure', () => {
    const t = createEventTranslator();
    t.push(ev({ type: 'error', error: 'first', code: 'A' }));
    t.push(ev({ type: 'error', error: 'second', code: 'B' }));
    expect(buildResultLine(t, { sessionKey: 's', durationMs: 0 })).toMatchObject({
      ok: false,
      exitCode: 1,
      turnCount: null,
      error: { code: 'A', message: 'first' },
    });

    const empty = createEventTranslator();
    expect(
      buildResultLine(empty, {
        sessionKey: 's',
        durationMs: 0,
        error: { code: 'CONFIG_MISSING', message: 'no config' },
      }),
    ).toMatchObject({ ok: false, exitCode: 1, error: { code: 'CONFIG_MISSING' } });
  });
});

describe('createJsonlWriter', () => {
  it('waits for drain after a full buffer, keeps order, and flushes on the final callback', async () => {
    const received: string[] = [];
    const pending: Array<() => void> = [];
    let calls = 0;
    const out = new Writable({
      highWaterMark: 1,
      write(chunk, _enc, cb) {
        received.push(String(chunk));
        // Hold every callback until the test releases it.
        pending.push(cb);
      },
    });
    const origWrite = out.write.bind(out);
    out.write = ((...a: Parameters<typeof out.write>) => {
      calls++;
      return origWrite(...a);
    }) as typeof out.write;

    const writer = createJsonlWriter(out);
    let firstDone = false;
    const first = writer.write({ v: 1, type: 'text_delta', text: 'a' }).then(() => {
      firstDone = true;
    });
    await new Promise((r) => setImmediate(r));
    // The buffer is over its high-water mark: the write waits for 'drain'.
    expect(firstDone).toBe(false);
    pending.shift()?.();
    await first;
    expect(firstDone).toBe(true);

    const second = writer.write({ v: 1, type: 'text_delta', text: 'b' });
    await new Promise((r) => setImmediate(r));
    pending.shift()?.();
    await second;

    let flushed = false;
    const flush = writer.flush().then(() => {
      flushed = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(flushed).toBe(false);
    // Release the final (empty) write's callback — flush resolves only then.
    while (pending.length > 0) pending.shift()?.();
    await flush;
    expect(flushed).toBe(true);

    const lines = received.filter((s) => s !== '');
    expect(lines.map((l) => JSON.parse(l).text)).toEqual(['a', 'b']);
    expect(calls).toBe(3);
  });
});
