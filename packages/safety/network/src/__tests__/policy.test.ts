import { describe, expect, it } from 'vitest';
import { checkAllowDeny, hostnameMatches } from '../policy';

describe('hostnameMatches', () => {
  it('matches exact hosts case-insensitively', () => {
    expect(hostnameMatches('api.github.com', 'api.github.com')).toBe(true);
    expect(hostnameMatches('API.GitHub.COM', 'api.github.com')).toBe(true);
    expect(hostnameMatches('api.github.com', 'github.com')).toBe(false);
  });

  it('matches *. globs against the suffix and bare suffix', () => {
    expect(hostnameMatches('api.anthropic.com', '*.anthropic.com')).toBe(true);
    expect(hostnameMatches('a.b.anthropic.com', '*.anthropic.com')).toBe(true);
    expect(hostnameMatches('anthropic.com', '*.anthropic.com')).toBe(true);
    expect(hostnameMatches('notanthropic.com', '*.anthropic.com')).toBe(false);
    expect(hostnameMatches('anthropic.com.evil.com', '*.anthropic.com')).toBe(false);
  });

  it('treats a bare * as matching every host', () => {
    expect(hostnameMatches('example.com', '*')).toBe(true);
    expect(hostnameMatches('api.github.com', '*')).toBe(true);
    // Only a BARE star is special; a star anywhere else stays literal.
    expect(hostnameMatches('example.com', '*example.com')).toBe(false);
  });
});

describe('checkAllowDeny', () => {
  it('allows everything when both lists are empty', () => {
    expect(checkAllowDeny('example.com', {}).allowed).toBe(true);
  });

  it('blocks deny matches even with no allow list', () => {
    const r = checkAllowDeny('evil.example.com', { deny: ['evil.example.com'] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/deny list/);
  });

  it('enters allowlist mode when allow is non-empty', () => {
    const policy = { allow: ['api.github.com', '*.anthropic.com'] };
    expect(checkAllowDeny('api.github.com', policy).allowed).toBe(true);
    expect(checkAllowDeny('api.anthropic.com', policy).allowed).toBe(true);
    expect(checkAllowDeny('example.com', policy).allowed).toBe(false);
  });

  it("allow: ['*'] admits every host (the floor lives in safeFetch, not here)", () => {
    expect(checkAllowDeny('example.com', { allow: ['*'] })).toEqual({ allowed: true });
    expect(checkAllowDeny('api.github.com', { allow: ['api.x.com', '*'] }).allowed).toBe(true);
  });

  it("deny: ['*'] refuses every host, even one the allow list names", () => {
    const r = checkAllowDeny('api.github.com', { allow: ['api.github.com'], deny: ['*'] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/deny list/);
  });

  it('deny wins over allow', () => {
    const policy = { allow: ['*.example.com'], deny: ['evil.example.com'] };
    const r = checkAllowDeny('evil.example.com', policy);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/deny list/);
  });
});
