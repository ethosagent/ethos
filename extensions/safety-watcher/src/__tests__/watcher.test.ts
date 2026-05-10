import { describe, expect, it } from 'vitest';
import { compoundingErrorRule, tokenBudgetRule } from '../rules';
import type { WatcherDecision, WatcherEvent } from '../types';
import { Watcher } from '../watcher';

describe('Watcher', () => {
  it('returns allow when no rule fires', () => {
    const w = new Watcher({ rules: [] });
    expect(w.observe({ type: 'text_delta' })).toEqual({ action: 'allow' });
  });

  it('returns the first non-allow decision', () => {
    const w = new Watcher({ rules: [compoundingErrorRule({ threshold: 2 })] });
    expect(w.observe({ type: 'tool_end', toolName: 't', ok: false })).toEqual({ action: 'allow' });
    const r = w.observe({ type: 'tool_end', toolName: 't', ok: false });
    expect(r.action).toBe('pause');
  });

  it('records non-allow decisions via the observability adapter', () => {
    const calls: Array<{
      decision: 'pause' | 'force_approval' | 'terminate';
      code?: string;
      traceId?: string;
    }> = [];
    const observability = {
      recordWatcherDecision: (opts: {
        decision: 'pause' | 'force_approval' | 'terminate';
        code?: string;
        traceId?: string;
      }) => calls.push(opts),
    };
    const w = new Watcher({
      rules: [compoundingErrorRule({ threshold: 1 })],
      observability,
      traceId: 'tr1',
    });
    w.observe({ type: 'tool_end', toolName: 't', ok: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.decision).toBe('pause');
    expect(calls[0]?.code).toBe('compounding-error');
    expect(calls[0]?.traceId).toBe('tr1');
  });

  it('forwards terminate decisions through the adapter', () => {
    const calls: Array<{ decision: 'pause' | 'force_approval' | 'terminate' }> = [];
    const observability = {
      recordWatcherDecision: (opts: { decision: 'pause' | 'force_approval' | 'terminate' }) =>
        calls.push(opts),
    };
    const w = new Watcher({
      rules: [
        {
          id: 'always-terminate',
          evaluate(): WatcherDecision {
            return { action: 'terminate', rule: 'always-terminate', reason: 'test' };
          },
        },
      ],
      observability,
    });
    const ev: WatcherEvent = { type: 'tool_end' };
    w.observe(ev);
    expect(calls[0]?.decision).toBe('terminate');
  });

  it('resetTurn clears per-turn state', () => {
    const w = new Watcher({ rules: [tokenBudgetRule({ max: 100 })] });
    w.observe({ type: 'usage', outputTokens: 90 });
    w.resetTurn();
    expect(w.observe({ type: 'usage', outputTokens: 90 })).toEqual({ action: 'allow' });
  });
});
