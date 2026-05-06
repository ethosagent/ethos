import type { BeforeToolCallPayload, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createDangerPredicate } from '../danger-predicate';

function payload(toolName: string, args: unknown = {}): BeforeToolCallPayload {
  return { sessionId: 's', toolCallId: 'tc', toolName, args };
}

function person(approvalMode?: 'manual' | 'smart' | 'off'): PersonalityConfig {
  return {
    id: 'p',
    name: 'P',
    ...(approvalMode ? { safety: { approvalMode } } : {}),
  };
}

describe('createDangerPredicate — Ch.4b approvalMode', () => {
  describe('hardline (terminal checkCommand)', () => {
    it('manual mode surfaces the hardline reason', () => {
      const pred = createDangerPredicate({ getPersonality: () => person('manual') });
      const r = pred(payload('terminal', { command: 'rm -rf /' }));
      expect(r).toMatch(/recursive force-delete/);
    });

    it('off mode does NOT auto-approve hardline (still surfaces the reason)', () => {
      // The terminalGuardHook hard-blocks regardless of mode; the
      // predicate keeps returning the reason so the approval flow's
      // error message stays meaningful.
      const pred = createDangerPredicate({ getPersonality: () => person('off') });
      const r = pred(payload('terminal', { command: 'rm -rf /' }));
      expect(r).toMatch(/recursive force-delete/);
    });

    it('smart mode does NOT auto-approve hardline either', () => {
      const pred = createDangerPredicate({
        getPersonality: () => person('smart'),
        smartApprove: () => true,
      });
      const r = pred(payload('terminal', { command: 'rm -rf /' }));
      expect(r).toMatch(/recursive force-delete/);
    });
  });

  describe('non-hardline (alwaysAsk)', () => {
    it('manual surfaces the always-ask reason', () => {
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('manual'),
      });
      const r = pred(payload('email_send', { to: 'a@b' }));
      expect(r).toMatch(/email_send requires explicit approval/);
    });

    it('off auto-approves only when allowAutoApproveDangerousTools is set (cli/cron)', () => {
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('off'),
        allowAutoApproveDangerousTools: true,
      });
      expect(pred(payload('email_send', { to: 'a@b' }))).toBeNull();
    });

    it('off WITHOUT the capability flag falls back to manual (returns the reason)', () => {
      // The personality registry's load-time check rejects off+channel
      // ingress, but the predicate cannot rely on cross-module invariants.
      // Without the explicit capability flag, off is treated as manual.
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('off'),
      });
      expect(pred(payload('email_send', { to: 'a@b' }))).toMatch(/explicit approval/);
    });

    it('smart consults the callback — true → auto-approve', () => {
      let callbackArgs: { tool?: string; reason?: string } = {};
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('smart'),
        smartApprove: (p, reason) => {
          callbackArgs = { tool: p.toolName, reason };
          return true;
        },
      });
      expect(pred(payload('email_send', { to: 'a@b' }))).toBeNull();
      expect(callbackArgs.tool).toBe('email_send');
      expect(callbackArgs.reason).toMatch(/explicit approval/);
    });

    it('smart consults the callback — false → surface the reason', () => {
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('smart'),
        smartApprove: () => false,
      });
      expect(pred(payload('email_send', { to: 'a@b' }))).toMatch(/explicit approval/);
    });

    it('smart without callback degrades to manual', () => {
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('smart'),
      });
      expect(pred(payload('email_send', { to: 'a@b' }))).toMatch(/explicit approval/);
    });
  });

  describe('non-dangerous tools', () => {
    it('returns null for benign terminal commands', () => {
      const pred = createDangerPredicate({ getPersonality: () => person('manual') });
      expect(pred(payload('terminal', { command: 'echo hi' }))).toBeNull();
    });

    it('returns null when no getPersonality and no danger', () => {
      const pred = createDangerPredicate();
      expect(pred(payload('terminal', { command: 'echo hi' }))).toBeNull();
    });
  });
});
