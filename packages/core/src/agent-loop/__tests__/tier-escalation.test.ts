import { describe, expect, it } from 'vitest';
import {
  checkEscalationCap,
  ESCALATION_REASON_MAX_CHARS,
  escalationReason,
  MAX_ESCALATIONS_PER_SESSION,
  MAX_ESCALATIONS_PER_TURN,
} from '../tier-escalation';

describe('escalationReason', () => {
  it('passes a plain reason through', () => {
    expect(escalationReason('race condition')).toBe('race condition');
  });

  it('strips control and ANSI characters', () => {
    expect(escalationReason('\u001b[31mred\u001b[0m\u0007 alert\u0000')).toBe('red alert');
  });

  it('collapses whitespace, newlines included', () => {
    expect(escalationReason('  needs \n\n  multi-step\t analysis  ')).toBe(
      'needs multi-step analysis',
    );
  });

  it('truncates to 160 characters with an ellipsis', () => {
    const out = escalationReason('x'.repeat(500));
    expect(out).toHaveLength(ESCALATION_REASON_MAX_CHARS);
    expect(ESCALATION_REASON_MAX_CHARS).toBe(160);
    expect(out.endsWith('…')).toBe(true);
  });

  it('keeps a reason of exactly the limit untouched', () => {
    const exact = 'y'.repeat(ESCALATION_REASON_MAX_CHARS);
    expect(escalationReason(exact)).toBe(exact);
  });

  it('returns an empty string for non-string input', () => {
    expect(escalationReason(undefined)).toBe('');
    expect(escalationReason(42)).toBe('');
    expect(escalationReason({ reason: 'x' })).toBe('');
  });
});

describe('checkEscalationCap', () => {
  it('hard-codes 2 per turn and 10 per session', () => {
    expect(MAX_ESCALATIONS_PER_TURN).toBe(2);
    expect(MAX_ESCALATIONS_PER_SESSION).toBe(10);
  });

  it('allows below both caps', () => {
    expect(checkEscalationCap({ perTurn: 1, perSession: 9 })).toEqual({ ok: true });
  });

  it('rejects at the per-turn cap with the turn message', () => {
    const r = checkEscalationCap({ perTurn: 2, perSession: 2 });
    expect(r).toEqual({
      ok: false,
      message: 'Escalation limit reached for this turn (2). Continue on the current model.',
    });
  });

  it('rejects at the per-session cap with the session message', () => {
    const r = checkEscalationCap({ perTurn: 0, perSession: 10 });
    expect(r).toEqual({
      ok: false,
      message: 'Escalation limit reached for this session (10). Continue on the current model.',
    });
  });
});
