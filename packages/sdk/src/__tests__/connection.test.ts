import { describe, expect, it, vi } from 'vitest';

import {
  normalizeRemoteUrl,
  probeConnection,
  remoteHost,
  remoteOrigin,
  wsOriginFor,
} from '../connection';

describe('normalizeRemoteUrl', () => {
  it('returns the origin with no trailing slash', () => {
    expect(normalizeRemoteUrl('https://ethos.example.com/')).toBe('https://ethos.example.com');
    expect(normalizeRemoteUrl('https://ethos.example.com/some/path?x=1')).toBe(
      'https://ethos.example.com',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeRemoteUrl('  https://ethos.example.com  ')).toBe('https://ethos.example.com');
  });

  it('preserves non-default ports', () => {
    expect(normalizeRemoteUrl('http://10.0.0.5:3001')).toBe('http://10.0.0.5:3001');
  });

  it('rejects non-http(s) protocols', () => {
    expect(normalizeRemoteUrl('ftp://ethos.example.com')).toBeNull();
    expect(normalizeRemoteUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects garbage and empty input', () => {
    expect(normalizeRemoteUrl('')).toBeNull();
    expect(normalizeRemoteUrl('   ')).toBeNull();
    expect(normalizeRemoteUrl('not a url')).toBeNull();
    expect(normalizeRemoteUrl('ethos.example.com')).toBeNull();
  });
});

describe('remoteOrigin', () => {
  it('normalizes a URL to its origin', () => {
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

describe('remoteHost', () => {
  it('returns the host for a parseable URL', () => {
    expect(remoteHost('https://ethos.example.com/some/path')).toBe('ethos.example.com');
  });

  it('preserves non-default ports', () => {
    expect(remoteHost('http://10.0.0.5:3001')).toBe('10.0.0.5:3001');
  });

  it('returns null for unparseable input', () => {
    expect(remoteHost('not a url')).toBeNull();
  });
});

describe('wsOriginFor', () => {
  it('maps https to wss and http to ws', () => {
    expect(wsOriginFor('https://ethos.example.com')).toBe('wss://ethos.example.com');
    expect(wsOriginFor('http://10.0.0.5:3001')).toBe('ws://10.0.0.5:3001');
  });

  it('leaves anything else alone', () => {
    expect(wsOriginFor('wss://ethos.example.com')).toBe('wss://ethos.example.com');
  });
});

describe('probeConnection', () => {
  it('rejects a non-http(s) URL without making any request', async () => {
    const fetchMock = vi.fn();
    const result = await probeConnection('ftp://ethos.example.com', { fetch: fetchMock });
    expect(result).toEqual({ ok: false, error: 'Enter an http:// or https:// server URL.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok with version and latencyMs when /healthz returns 200 with a version', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 }));
    const result = await probeConnection('https://ethos.example.com', { fetch: fetchMock });
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.2.3');
    expect(result.latencyMs).toBeTypeOf('number');
  });

  it('returns ok with undefined version when /healthz returns 200 without a version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await probeConnection('https://ethos.example.com', { fetch: fetchMock });
    expect(result.ok).toBe(true);
    expect(result.version).toBeUndefined();
  });

  it('returns ok when /healthz returns 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    const result = await probeConnection('https://ethos.example.com', { fetch: fetchMock });
    expect(result.ok).toBe(true);
  });

  it('returns not ok when /healthz returns some other status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const result = await probeConnection('https://ethos.example.com', { fetch: fetchMock });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Server returned 404.');
  });

  it('surfaces a network error', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('getaddrinfo ENOTFOUND ethos.example.com'));
    const result = await probeConnection('https://ethos.example.com', { fetch: fetchMock });
    expect(result).toEqual({ ok: false, error: 'getaddrinfo ENOTFOUND ethos.example.com' });
  });

  it('surfaces a timeout error', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    const result = await probeConnection('https://ethos.example.com', { fetch: fetchMock });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('The operation timed out.');
  });

  it('makes only the /healthz call when no apiKey is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await probeConnection('https://ethos.example.com', { fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the bearer token to the auth probe when apiKey is supplied', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await probeConnection('https://ethos.example.com', {
      fetch: fetchMock,
      apiKey: 'secret-key',
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe('https://ethos.example.com/rpc/personalities/list');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer secret-key',
      Origin: 'https://ethos.example.com',
    });
    expect((init as RequestInit).body).toBe(JSON.stringify({ json: {} }));
  });

  it.each([401, 403])('returns not ok when the auth probe returns %i', async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status }));
    const result = await probeConnection('https://ethos.example.com', {
      fetch: fetchMock,
      apiKey: 'secret-key',
    });
    expect(result).toMatchObject({ ok: false, error: 'Server rejected the token.' });
  });

  it('treats a non-401/403 auth probe status as token-accepted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const result = await probeConnection('https://ethos.example.com', {
      fetch: fetchMock,
      apiKey: 'secret-key',
    });
    expect(result.ok).toBe(true);
  });

  it('treats a throwing auth probe as token-accepted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockRejectedValueOnce(new Error('network down'));
    const result = await probeConnection('https://ethos.example.com', {
      fetch: fetchMock,
      apiKey: 'secret-key',
    });
    expect(result.ok).toBe(true);
  });
});
