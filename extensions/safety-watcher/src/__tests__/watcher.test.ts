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

  it('records non-allow decisions in observability', () => {
    const events: Array<{ category: string; code?: string; severity?: string }> = [];
    const observability = {
      startTrace: () => 'tr',
      endTrace: () => {},
      startSpan: () => 'sp',
      endSpan: () => {},
      recordEvent: (e: { category: string; code?: string; severity?: string }) => events.push(e),
      flush: () => {},
    };
    const w = new Watcher({
      rules: [compoundingErrorRule({ threshold: 1 })],
      observability,
      traceId: 'tr1',
    });
    w.observe({ type: 'tool_end', toolName: 't', ok: false });
    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe('audit.watcher');
    expect(events[0]?.code).toBe('compounding-error');
    expect(events[0]?.severity).toBe('warn');
  });

  it('records terminate decisions at severity=critical', () => {
    const events: Array<{ severity?: string }> = [];
    const observability = {
      startTrace: () => 'tr',
      endTrace: () => {},
      startSpan: () => 'sp',
      endSpan: () => {},
      recordEvent: (e: { severity?: string }) => events.push(e),
      flush: () => {},
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
    expect(events[0]?.severity).toBe('critical');
  });

  it('resetTurn clears per-turn state', () => {
    const w = new Watcher({ rules: [tokenBudgetRule({ max: 100 })] });
    w.observe({ type: 'usage', outputTokens: 90 });
    w.resetTurn();
    expect(w.observe({ type: 'usage', outputTokens: 90 })).toEqual({ action: 'allow' });
  });
});
