import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createEventTranslator, shouldSurfaceProgress } from '../event-translator';

describe('createEventTranslator', () => {
  it('accumulates text_delta in arrival order', () => {
    const t = createEventTranslator();
    t.push({ type: 'text_delta', text: 'Hello' });
    t.push({ type: 'text_delta', text: ', ' });
    t.push({ type: 'text_delta', text: 'world' });
    expect(t.text).toBe('Hello, world');
  });

  it('sums usage across events', () => {
    const t = createEventTranslator();
    t.push({ type: 'usage', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 });
    t.push({ type: 'usage', inputTokens: 3, outputTokens: 2, estimatedCostUsd: 0.02 });
    expect(t.usage).toEqual({ inputTokens: 13, outputTokens: 7, estimatedCostUsd: 0.03 });
  });

  it('latches the first error and marks stopped', () => {
    const t = createEventTranslator();
    expect(t.stopped).toBe(false);
    t.push({ type: 'error', error: 'boom', code: 'INTERNAL' });
    t.push({ type: 'error', error: 'later', code: 'OTHER' });
    expect(t.error).toEqual({ error: 'boom', code: 'INTERNAL' });
    expect(t.stopped).toBe(true);
  });

  it('latches done and marks stopped', () => {
    const t = createEventTranslator();
    t.push({ type: 'text_delta', text: 'hi' });
    t.push({ type: 'done', text: 'hi', turnCount: 2 });
    expect(t.done).toEqual({ text: 'hi', turnCount: 2 });
    expect(t.stopped).toBe(true);
  });

  it('records halt with optional fields', () => {
    const t = createEventTranslator();
    t.push({ type: 'halt', kind: 'budget', rule: 'tool-budget', message: 'stop', count: 3 });
    expect(t.halt).toEqual({ kind: 'budget', rule: 'tool-budget', message: 'stop', count: 3 });
  });

  it('tracks tool-call lifecycle from start to end', () => {
    let clock = 100;
    const t = createEventTranslator({ now: () => clock });
    t.push({ type: 'tool_start', toolCallId: 'c1', toolName: 'read_file', args: { path: 'a' } });
    clock = 250;
    t.push({ type: 'tool_end', toolCallId: 'c1', toolName: 'read_file', ok: true, durationMs: 42 });
    const call = t.tools.get('c1');
    expect(call).toMatchObject({
      toolCallId: 'c1',
      toolName: 'read_file',
      args: { path: 'a' },
      startedAt: 100,
      ended: true,
      ok: true,
      durationMs: 42,
    });
  });

  it('handles a tool_end without a preceding tool_start', () => {
    const t = createEventTranslator({ now: () => 7 });
    t.push({ type: 'tool_end', toolCallId: 'orphan', toolName: 'bash', ok: false, durationMs: 1 });
    expect(t.tools.get('orphan')).toMatchObject({
      toolCallId: 'orphan',
      toolName: 'bash',
      args: undefined,
      ended: true,
      ok: false,
      durationMs: 1,
    });
  });

  it('ignores unknown / unhandled event types (forward-compat)', () => {
    const t = createEventTranslator();
    // A hypothetical future variant — must be a no-op, not throw.
    t.push({ type: 'future_event', foo: 1 } as unknown as AgentEvent);
    t.push({ type: 'thinking_delta', thinking: 'hmm' });
    t.push({ type: 'run_start', provider: 'x', model: 'y', source: 'global' });
    expect(t.text).toBe('');
    expect(t.stopped).toBe(false);
  });
});

describe('shouldSurfaceProgress', () => {
  it('surfaces only user-audience progress', () => {
    expect(
      shouldSurfaceProgress({
        type: 'tool_progress',
        toolName: 'x',
        message: 'm',
        audience: 'user',
      }),
    ).toBe(true);
    expect(
      shouldSurfaceProgress({
        type: 'tool_progress',
        toolName: 'x',
        message: 'm',
        audience: 'internal',
      }),
    ).toBe(false);
    expect(
      shouldSurfaceProgress({
        type: 'tool_progress',
        toolName: 'x',
        message: 'm',
        audience: 'dashboard',
      }),
    ).toBe(false);
  });
});
