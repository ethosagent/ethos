// B-T2: a refused turn used to arrive as an empty success — `askPersonality`
// dropped the `error` and `halt` AgentEvents entirely.

import type { AgentEvent } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { collectTurnResult } from '../turn-result';

async function* stream(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e;
}

describe('collectTurnResult', () => {
  it('surfaces an `error` event with its code', async () => {
    const result = await collectTurnResult(
      stream([
        { type: 'error', error: 'turn budget exhausted', code: 'BUDGET_EXCEEDED' },
        { type: 'done', text: '', turnCount: 1 },
      ]),
    );
    expect(result.error).toEqual({ code: 'BUDGET_EXCEEDED', message: 'turn budget exhausted' });
  });

  it('surfaces a `halt` as HALT_<kind> and keeps the partial text', async () => {
    const result = await collectTurnResult(
      stream([
        { type: 'text_delta', text: 'partial ' },
        {
          type: 'halt',
          kind: 'watcher',
          rule: 'no-exfil',
          message: 'stopped by watcher',
        },
        { type: 'done', text: '', turnCount: 2 },
      ]),
    );
    expect(result.error?.code).toBe('HALT_WATCHER');
    expect(result.error?.message).toContain('no-exfil');
    expect(result.text).toBe('partial ');
    expect(result.turnCount).toBe(2);
  });

  it('first failure wins', async () => {
    const result = await collectTurnResult(
      stream([
        { type: 'error', error: 'first', code: 'FIRST' },
        { type: 'error', error: 'second', code: 'SECOND' },
        { type: 'done', text: '', turnCount: 1 },
      ]),
    );
    expect(result.error?.code).toBe('FIRST');
  });

  it('a clean turn carries no error, and sums usage', async () => {
    const result = await collectTurnResult(
      stream([
        { type: 'text_delta', text: 'hello' },
        { type: 'usage', inputTokens: 10, outputTokens: 3, estimatedCostUsd: 0 },
        { type: 'usage', inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0 },
        { type: 'done', text: 'hello', turnCount: 1 },
      ]),
    );
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('hello');
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(5);
  });

  it('appends a returnDirect answer to the streamed preamble', async () => {
    const result = await collectTurnResult(
      stream([
        { type: 'text_delta', text: 'Let me look that up.' },
        { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 },
      ]),
    );
    expect(result.text).toBe('Let me look that up.\n\nDIRECT ANSWER');
  });

  it('drains the iterator past `done` — the turn tail must still run', async () => {
    let drained = false;
    async function* withTail(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', text: 'answer', turnCount: 1 };
      drained = true;
    }
    await collectTurnResult(withTail());
    expect(drained).toBe(true);
  });
});
