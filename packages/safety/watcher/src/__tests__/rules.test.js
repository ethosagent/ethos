import { describe, expect, it } from 'vitest';
import {
  compoundingErrorRule,
  rateLimitRule,
  suspiciousSequenceRule,
  tokenBudgetRule,
} from '../rules';
import { makeInitialState } from '../types';

describe('rateLimitRule', () => {
  it('does not fire below the threshold', () => {
    const rule = rateLimitRule({ max: 5, windowMs: 60_000 });
    const state = makeInitialState();
    for (let i = 0; i < 5; i++) {
      const r = rule.evaluate({ type: 'tool_end', toolName: 't' }, state);
      expect(r).toBeNull();
    }
  });
  it('fires when calls exceed the threshold within the window', () => {
    const rule = rateLimitRule({ max: 3, windowMs: 60_000 });
    const state = makeInitialState();
    for (let i = 0; i < 3; i++) rule.evaluate({ type: 'tool_end', toolName: 't' }, state);
    const r = rule.evaluate({ type: 'tool_end', toolName: 't' }, state);
    expect(r?.action).toBe('pause');
    if (r && r.action !== 'allow') expect(r.rule).toBe('rate-limit');
  });
  it('ignores non-tool_end events', () => {
    const rule = rateLimitRule({ max: 1, windowMs: 60_000 });
    const state = makeInitialState();
    for (let i = 0; i < 100; i++) {
      const r = rule.evaluate({ type: 'text_delta' }, state);
      expect(r).toBeNull();
    }
  });
});
describe('tokenBudgetRule', () => {
  it('accumulates output tokens and pauses when over budget', () => {
    const rule = tokenBudgetRule({ max: 100 });
    const state = makeInitialState();
    expect(rule.evaluate({ type: 'usage', outputTokens: 60 }, state)).toBeNull();
    expect(rule.evaluate({ type: 'usage', outputTokens: 50 }, state)?.action).toBe('pause');
  });
  it('resets across turns', () => {
    const rule = tokenBudgetRule({ max: 100 });
    const state = makeInitialState();
    rule.evaluate({ type: 'usage', outputTokens: 90 }, state);
    rule.onTurnReset?.(state);
    expect(rule.evaluate({ type: 'usage', outputTokens: 90 }, state)).toBeNull();
  });
});
describe('compoundingErrorRule', () => {
  it('fires after threshold consecutive failures', () => {
    const rule = compoundingErrorRule({ threshold: 3 });
    const state = makeInitialState();
    expect(rule.evaluate({ type: 'tool_end', toolName: 'foo', ok: false }, state)).toBeNull();
    expect(rule.evaluate({ type: 'tool_end', toolName: 'foo', ok: false }, state)).toBeNull();
    const r = rule.evaluate({ type: 'tool_end', toolName: 'foo', ok: false }, state);
    expect(r?.action).toBe('pause');
    if (r && r.action !== 'allow') expect(r.rule).toBe('compounding-error');
  });
  it('resets count on a successful call', () => {
    const rule = compoundingErrorRule({ threshold: 3 });
    const state = makeInitialState();
    rule.evaluate({ type: 'tool_end', toolName: 'foo', ok: false }, state);
    rule.evaluate({ type: 'tool_end', toolName: 'foo', ok: false }, state);
    rule.evaluate({ type: 'tool_end', toolName: 'foo', ok: true }, state);
    expect(rule.evaluate({ type: 'tool_end', toolName: 'foo', ok: false }, state)).toBeNull();
  });
  it('counts each tool independently', () => {
    const rule = compoundingErrorRule({ threshold: 3 });
    const state = makeInitialState();
    for (let i = 0; i < 2; i++) {
      rule.evaluate({ type: 'tool_end', toolName: 'a', ok: false }, state);
      rule.evaluate({ type: 'tool_end', toolName: 'b', ok: false }, state);
    }
    // Neither has hit 3 yet
    expect(rule.evaluate({ type: 'tool_end', toolName: 'a', ok: true }, state)).toBeNull();
  });
});
describe('suspiciousSequenceRule', () => {
  it('terminates when read of ~/.ssh is followed by web_post', () => {
    const rule = suspiciousSequenceRule();
    const state = makeInitialState();
    rule.evaluate(
      { type: 'tool_start', toolName: 'read_file', args: { path: '/home/u/.ssh/id_rsa' } },
      state,
    );
    const r = rule.evaluate(
      { type: 'tool_start', toolName: 'web_post', args: { url: 'http://x' } },
      state,
    );
    expect(r?.action).toBe('terminate');
    if (r && r.action !== 'allow') expect(r.rule).toBe('suspicious-sequence');
  });
  it('terminates when /etc/passwd read is followed by email_send', () => {
    const rule = suspiciousSequenceRule();
    const state = makeInitialState();
    rule.evaluate(
      { type: 'tool_start', toolName: 'terminal', args: { command: 'cat /etc/passwd' } },
      state,
    );
    const r = rule.evaluate(
      { type: 'tool_start', toolName: 'email_send', args: { to: 'evil@x' } },
      state,
    );
    expect(r?.action).toBe('terminate');
  });
  it('does not fire on benign sequences', () => {
    const rule = suspiciousSequenceRule();
    const state = makeInitialState();
    rule.evaluate(
      { type: 'tool_start', toolName: 'read_file', args: { path: '/proj/notes.md' } },
      state,
    );
    expect(
      rule.evaluate({ type: 'tool_start', toolName: 'web_post', args: { url: 'http://x' } }, state),
    ).toBeNull();
  });
  it('respects the window — old credential-read drops out', () => {
    const rule = suspiciousSequenceRule({ window: 2 });
    const state = makeInitialState();
    rule.evaluate(
      { type: 'tool_start', toolName: 'read_file', args: { path: '/u/.ssh/id_rsa' } },
      state,
    );
    rule.evaluate(
      { type: 'tool_start', toolName: 'read_file', args: { path: '/proj/a.md' } },
      state,
    );
    rule.evaluate(
      { type: 'tool_start', toolName: 'read_file', args: { path: '/proj/b.md' } },
      state,
    );
    expect(
      rule.evaluate({ type: 'tool_start', toolName: 'web_post', args: { url: 'http://x' } }, state),
    ).toBeNull();
  });
});
