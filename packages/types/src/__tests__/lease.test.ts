import { describe, expect, it } from 'vitest';
import { type ApprovalLease, isLeaseActive } from '../lease';

const lease = (over: Partial<ApprovalLease> = {}): ApprovalLease => ({
  id: 'l1',
  toolName: 'skills_pending_approve',
  sessionId: 's1',
  personalityId: 'engineer',
  grantedBy: 'tab-A',
  grantedAt: '2026-09-24T10:00:00.000Z',
  expiresAt: '2026-09-24T11:00:00.000Z',
  revokedAt: null,
  ...over,
});

const END = Date.parse('2026-09-24T11:00:00.000Z');

describe('isLeaseActive', () => {
  it('is active before expiresAt', () => {
    expect(isLeaseActive(lease(), END - 1)).toBe(true);
  });

  it('is inactive at the exact expiry boundary', () => {
    expect(isLeaseActive(lease(), END)).toBe(false);
  });

  it('is inactive once revoked, even before expiry', () => {
    expect(isLeaseActive(lease({ revokedAt: '2026-09-24T10:30:00.000Z' }), END - 1)).toBe(false);
  });

  it('is inactive when expiresAt is unparseable', () => {
    expect(isLeaseActive(lease({ expiresAt: 'soon' }), 0)).toBe(false);
    expect(isLeaseActive(lease({ expiresAt: '' }), 0)).toBe(false);
  });
});
