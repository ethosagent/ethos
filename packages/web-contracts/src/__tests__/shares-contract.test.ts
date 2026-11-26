import { describe, expect, it } from 'vitest';
import { contract } from '../router';
import {
  ShareCreateInputSchema,
  ShareCreateOutputSchema,
  ShareLinkSummaryWireSchema,
  ShareListOutputSchema,
  SharePreviewOutputSchema,
  ShareRevokeOutputSchema,
} from '../schemas';

// plan share-links §3 Contracts, D12, D15. The wire shapes the Settings list and the
// ShareDialog depend on; the web-api side is pinned by
// apps/web-api/src/__tests__/services/share-service.test.ts.

describe('shares contract', () => {
  it('exposes preview, create, list and revoke', () => {
    expect(Object.keys(contract.shares).sort()).toEqual(['create', 'list', 'preview', 'revoke']);
  });

  it('create input accepts only the four expiries', () => {
    const base = { sessionId: 's1', includeToolNames: false, pii: true };
    for (const expiresIn of ['1h', '1d', '7d', '30d']) {
      expect(ShareCreateInputSchema.safeParse({ ...base, expiresIn }).success).toBe(true);
    }
    for (const expiresIn of ['never', '2d', '', 7]) {
      expect(ShareCreateInputSchema.safeParse({ ...base, expiresIn }).success).toBe(false);
    }
  });

  it('a list row has no token, url or snapshot field', () => {
    const keys = Object.keys(ShareLinkSummaryWireSchema.shape);
    expect(keys).toEqual(
      expect.arrayContaining(['id', 'prefix', 'title', 'createdAt', 'expiresAt', 'viewCount']),
    );
    for (const banned of ['token', 'url', 'snapshot', 'tokenHash', 'turns']) {
      expect(keys).not.toContain(banned);
    }
    expect(Object.keys(ShareListOutputSchema.shape).sort()).toEqual(['enabled', 'links']);
  });

  it('every refusal parses on preview and create, with its detail field', () => {
    const refusals = [
      { ok: false, reason: 'disabled' },
      { ok: false, reason: 'not_found' },
      { ok: false, reason: 'shared_session' },
      { ok: false, reason: 'excluded_personality', personalityId: 'ops' },
      { ok: false, reason: 'too_large', limitBytes: 2_097_152 },
      { ok: false, reason: 'empty' },
    ];
    for (const r of refusals) {
      expect(SharePreviewOutputSchema.safeParse(r).success, r.reason).toBe(true);
      expect(ShareCreateOutputSchema.safeParse(r).success, r.reason).toBe(true);
    }
    expect(
      SharePreviewOutputSchema.safeParse({ ok: false, reason: 'excluded_personality' }).success,
    ).toBe(false);
    expect(SharePreviewOutputSchema.safeParse({ ok: false, reason: 'nope' }).success).toBe(false);
  });

  it('revoke answers ok or a typed miss', () => {
    expect(ShareRevokeOutputSchema.safeParse({ ok: true }).success).toBe(true);
    for (const reason of ['not_found', 'ambiguous_prefix', 'prefix_too_short']) {
      expect(ShareRevokeOutputSchema.safeParse({ ok: false, reason }).success).toBe(true);
    }
  });
});
