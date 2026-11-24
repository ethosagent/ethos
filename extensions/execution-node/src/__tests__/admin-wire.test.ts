import { describe, expect, it } from 'vitest';
import { decodeApproveResult, decodeNodeAdminList } from '../admin-wire';

describe('admin wire decoders', () => {
  it('decodes a list response and drops unknown fields', () => {
    const wire = {
      nodes: [
        {
          name: 'laptop',
          keyId: 'k1',
          online: true,
          roots: [{ path: '/p', readOnly: false }],
          tools: ['read_file'],
          personalities: ['*'],
          lastSeen: '2026-01-01T00:00:00.000Z',
          connectedAt: '2026-01-01T00:00:00.000Z',
          extra: 1,
        },
      ],
      pending: [{ code: 'ABCD2345', name: 'l2', roots: [], expiresAt: 5 }],
    };
    const out = decodeNodeAdminList(wire);
    expect(out?.nodes[0]).not.toHaveProperty('extra');
    expect(out?.nodes[0]?.connectedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(out?.pending[0]?.code).toBe('ABCD2345');
  });

  it('refuses malformed lists', () => {
    expect(decodeNodeAdminList(null)).toBeNull();
    expect(decodeNodeAdminList({ nodes: [{}], pending: [] })).toBeNull();
    expect(decodeNodeAdminList({ nodes: [], pending: [{ code: 1 }] })).toBeNull();
  });

  it('decodes approve results', () => {
    expect(decodeApproveResult({ ok: true, name: 'a', keyId: 'k' })).toEqual({
      ok: true,
      name: 'a',
      keyId: 'k',
    });
    expect(decodeApproveResult({ ok: false, reason: 'expired' })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(decodeApproveResult({ ok: false, reason: 'boom' })).toBeNull();
    expect(decodeApproveResult('x')).toBeNull();
  });
});
