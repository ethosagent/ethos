import { describe, expect, it } from 'vitest';
import { checkScheme } from '../scheme';

describe('checkScheme', () => {
  it('accepts http and https', () => {
    expect(checkScheme('http://example.com').ok).toBe(true);
    expect(checkScheme('https://example.com/path').ok).toBe(true);
  });

  it.each([
    ['file:///etc/passwd'],
    ['gopher://internal.host:25/'],
    ['dict://localhost:11211'],
    ['ldap://localhost'],
    ['ftp://example.com'],
    ['data:text/plain,hello'],
    ['javascript:alert(1)'],
    ['chrome://settings'],
    ['about:blank'],
  ])('rejects scheme %s', (url) => {
    const r = checkScheme(url);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/URL_SCHEME_REJECTED/);
  });

  it('rejects URLs with embedded credentials', () => {
    const r = checkScheme('http://user:pass@example.com/');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/embedded credentials/);
  });

  it('rejects malformed URLs', () => {
    expect(checkScheme('not a url').ok).toBe(false);
    expect(checkScheme('').ok).toBe(false);
  });
});
