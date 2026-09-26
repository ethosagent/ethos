// Containment 3b — the approval scope vocabulary gains exactly one value, the
// one-hour lease, and the wire request says whether the tool is always-ask.

import { describe, expect, it } from 'vitest';
import { ApprovalLeaseSchema, ApprovalRequestSchema, ApprovalScopeSchema } from '../schemas';

describe('ApprovalScopeSchema', () => {
  it("parses 'lease-1h'", () => {
    expect(ApprovalScopeSchema.parse('lease-1h')).toBe('lease-1h');
  });

  it('still parses the existing scopes', () => {
    for (const scope of ['once', 'exact-args', 'any-args']) {
      expect(ApprovalScopeSchema.parse(scope)).toBe(scope);
    }
  });

  it('rejects an unknown scope', () => {
    expect(ApprovalScopeSchema.safeParse('lease-24h').success).toBe(false);
    expect(ApprovalScopeSchema.safeParse('forever').success).toBe(false);
  });
});

describe('ApprovalRequestSchema', () => {
  const base = {
    approvalId: 'ap_1',
    sessionId: 's',
    toolCallId: 'tc',
    toolName: 'skills_pending_approve',
    args: {},
    reason: null,
  };

  it('requires alwaysAsk', () => {
    expect(ApprovalRequestSchema.safeParse({ ...base, hardline: false }).success).toBe(false);
    expect(
      ApprovalRequestSchema.parse({ ...base, alwaysAsk: true, hardline: false }).alwaysAsk,
    ).toBe(true);
  });

  // openclaw-advisory-fixes Item 10 — the modal hides every storing scope for
  // a hardline call, as the server stores nothing for one.
  it('requires hardline', () => {
    expect(ApprovalRequestSchema.safeParse({ ...base, alwaysAsk: false }).success).toBe(false);
    expect(
      ApprovalRequestSchema.parse({ ...base, alwaysAsk: false, hardline: true }).hardline,
    ).toBe(true);
  });
});

describe('ApprovalLeaseSchema', () => {
  it('requires expiresAt — a lease always ends', () => {
    const lease = {
      id: 'l1',
      toolName: 'skills_pending_approve',
      sessionId: 's',
      personalityId: null,
      grantedBy: 'tab-A',
      grantedAt: '2026-09-24T10:00:00.000Z',
      expiresAt: '2026-09-24T11:00:00.000Z',
      revokedAt: null,
    };
    expect(ApprovalLeaseSchema.parse(lease)).toEqual(lease);
    const { expiresAt: _dropped, ...open } = lease;
    expect(ApprovalLeaseSchema.safeParse(open).success).toBe(false);
  });
});
