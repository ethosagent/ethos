import { describe, expect, it } from 'vitest';
import { resolveCorsOrigin } from '../../routes/index';

// WEB-002 — credentialed CORS must reflect ONLY operator-enumerated origins.
// The prior policy reflected any localhost port / file:// / RFC1918 host with
// `credentials: true`, letting a co-resident localhost origin ride the auth
// cookie.

describe('resolveCorsOrigin (WEB-002)', () => {
  it('reflects an allowlisted origin', () => {
    expect(resolveCorsOrigin('http://localhost:3001', ['http://localhost:3001'])).toBe(
      'http://localhost:3001',
    );
  });

  it('does NOT reflect a foreign localhost port when unlisted', () => {
    expect(resolveCorsOrigin('http://localhost:6666', ['http://localhost:3001'])).toBeNull();
  });

  it('fails closed when no allowlist is configured', () => {
    expect(resolveCorsOrigin('http://localhost:5173', [])).toBeNull();
    expect(resolveCorsOrigin('http://127.0.0.1:9999', [])).toBeNull();
  });

  it('does NOT reflect file:// origins', () => {
    expect(resolveCorsOrigin('file://', [])).toBeNull();
  });

  it('does NOT reflect RFC1918 origins by default', () => {
    expect(resolveCorsOrigin('http://192.168.1.20:3000', [])).toBeNull();
    expect(resolveCorsOrigin('http://10.0.0.5:3000', [])).toBeNull();
  });

  it('returns null for a missing (same-origin) Origin', () => {
    expect(resolveCorsOrigin(undefined, ['http://localhost:3001'])).toBeNull();
    expect(resolveCorsOrigin('', ['http://localhost:3001'])).toBeNull();
  });
});
