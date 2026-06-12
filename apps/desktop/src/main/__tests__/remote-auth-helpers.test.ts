import { describe, expect, it } from 'vitest';
import { remoteOrigin, withBearerToken } from '../remote-auth-helpers';

describe('remoteOrigin', () => {
  it('normalizes a URL to its origin', () => {
    expect(remoteOrigin('https://ethos.example.com')).toBe('https://ethos.example.com');
  });

  it('strips paths, query, and trailing slashes', () => {
    expect(remoteOrigin('https://ethos.example.com/some/path?x=1')).toBe(
      'https://ethos.example.com',
    );
    expect(remoteOrigin('https://ethos.example.com/')).toBe('https://ethos.example.com');
  });

  it('preserves non-default ports', () => {
    expect(remoteOrigin('http://10.0.0.5:3001')).toBe('http://10.0.0.5:3001');
  });

  it('returns null for unparseable input', () => {
    expect(remoteOrigin('')).toBeNull();
    expect(remoteOrigin('not a url')).toBeNull();
  });
});

describe('withBearerToken', () => {
  it('adds an Authorization header', () => {
    expect(withBearerToken({ Accept: 'text/event-stream' }, 'sk-ethos-abc')).toEqual({
      Accept: 'text/event-stream',
      Authorization: 'Bearer sk-ethos-abc',
    });
  });

  it('does not overwrite an existing Authorization header', () => {
    const headers = { Authorization: 'Bearer other' };
    expect(withBearerToken(headers, 'sk-ethos-abc')).toEqual({ Authorization: 'Bearer other' });
  });

  it('treats Authorization as case-insensitive', () => {
    const headers = { authorization: 'Bearer other' };
    expect(withBearerToken(headers, 'sk-ethos-abc')).toEqual({ authorization: 'Bearer other' });
  });

  it('does not mutate the input headers', () => {
    const headers = { Accept: 'application/json' };
    withBearerToken(headers, 'sk-ethos-abc');
    expect(headers).toEqual({ Accept: 'application/json' });
  });
});
