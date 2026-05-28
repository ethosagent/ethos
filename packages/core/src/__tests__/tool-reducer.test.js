import { describe, expect, it } from 'vitest';
import { DefaultToolResultReducerRegistry } from '../tool-reducer-registry';
import { DefaultToolRegistry } from '../tool-registry';

const makeCtx = () => ({
  sessionId: 's1',
  sessionKey: 'cli:default',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 10_000,
});
function makeTool(name, result) {
  return {
    name,
    description: 'test tool',
    schema: { type: 'object' },
    capabilities: {},
    execute: async () => result,
  };
}
// (a) Reducer runs and replaces the result value
describe('ToolResultReducer', () => {
  it('(a) reducer runs and replaces the result value', async () => {
    const reducers = new DefaultToolResultReducerRegistry();
    const reducer = {
      toolName: 'echo',
      reduce(_result, _ctx) {
        return { ok: true, value: 'reduced' };
      },
    };
    reducers.register(reducer);
    const registry = new DefaultToolRegistry(undefined, reducers);
    registry.register(makeTool('echo', { ok: true, value: 'original' }));
    const results = await registry.executeParallel(
      [{ toolCallId: 'tc1', name: 'echo', args: {} }],
      makeCtx(),
    );
    expect(results[0]?.result).toEqual({ ok: true, value: 'reduced' });
  });
  // (b) Reducer throwing returns the original result unchanged
  it('(b) reducer throwing returns the original result unchanged', async () => {
    const reducers = new DefaultToolResultReducerRegistry();
    const reducer = {
      toolName: 'echo',
      reduce() {
        throw new Error('reducer exploded');
      },
    };
    reducers.register(reducer);
    const registry = new DefaultToolRegistry(undefined, reducers);
    registry.register(makeTool('echo', { ok: true, value: 'original' }));
    const results = await registry.executeParallel(
      [{ toolCallId: 'tc1', name: 'echo', args: {} }],
      makeCtx(),
    );
    expect(results[0]?.result).toEqual({ ok: true, value: 'original' });
  });
  // (c) Reducer absent → result passes through untouched
  it('(c) reducer absent → result passes through untouched', async () => {
    const reducers = new DefaultToolResultReducerRegistry();
    // No reducer registered for 'echo'
    const registry = new DefaultToolRegistry(undefined, reducers);
    registry.register(makeTool('echo', { ok: true, value: 'untouched' }));
    const results = await registry.executeParallel(
      [{ toolCallId: 'tc1', name: 'echo', args: {} }],
      makeCtx(),
    );
    expect(results[0]?.result).toEqual({ ok: true, value: 'untouched' });
  });
  // (d) Reduced output is still budget-trimmed (compose order: reduce first, then trim)
  it('(d) reduced output is still budget-trimmed after reduction', async () => {
    const reducers = new DefaultToolResultReducerRegistry();
    const longValue = 'x'.repeat(200);
    const reducer = {
      toolName: 'echo',
      reduce(_result, _ctx) {
        return { ok: true, value: longValue };
      },
    };
    reducers.register(reducer);
    const ctx = makeCtx();
    ctx.resultBudgetChars = 100;
    const registry = new DefaultToolRegistry(undefined, reducers);
    registry.register(makeTool('echo', { ok: true, value: 'original' }));
    const results = await registry.executeParallel(
      [{ toolCallId: 'tc1', name: 'echo', args: {} }],
      ctx,
    );
    const result = results[0]?.result;
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      // Value should be truncated to budget (100 chars) + truncation marker
      expect(result.value.length).toBeGreaterThan(100);
      expect(result.value).toContain('[truncated');
      expect(result.value.startsWith('x'.repeat(100))).toBe(true);
    }
  });
  // (e) Registry throws on duplicate registration for same toolName
  it('(e) registry throws on duplicate registration for same toolName', () => {
    const reducers = new DefaultToolResultReducerRegistry();
    const reducer = {
      toolName: 'echo',
      reduce: (r) => r,
    };
    reducers.register(reducer);
    expect(() => reducers.register(reducer)).toThrow("Reducer already registered for tool 'echo'");
  });
  // Unregister cleanup function works
  it('unregister cleanup function removes the reducer', () => {
    const reducers = new DefaultToolResultReducerRegistry();
    const reducer = {
      toolName: 'echo',
      reduce: (r) => r,
    };
    const unregister = reducers.register(reducer);
    expect(reducers.get('echo')).toBe(reducer);
    unregister();
    expect(reducers.get('echo')).toBeUndefined();
  });
});
