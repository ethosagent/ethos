import { describe, expect, it } from 'vitest';
import {
  authErrorMessage,
  extractPrefillToken,
  fetchAuthState,
  parseRetryAfterHeader,
  postAuth,
  resolveAccessSection,
  resolveGateMode,
} from '../auth-flow';

describe('resolveGateMode (plan D9/D16)', () => {
  it('shows the login form on a claimed instance after a 401', () => {
    expect(
      resolveGateMode({ unauthorized: true, unreachable: false, probe: { claimed: true } }),
    ).toBe('login');
  });

  it('shows the token form on an unclaimed instance after a 401', () => {
    expect(
      resolveGateMode({ unauthorized: true, unreachable: false, probe: { claimed: false } }),
    ).toBe('token');
  });

  it('shows a neutral checking state while the first probe is in flight', () => {
    expect(resolveGateMode({ unauthorized: true, unreachable: false, probe: null })).toBe(
      'checking',
    );
  });

  it('a 401 with a live probe answer never shows reconnecting (D9)', () => {
    for (const claimed of [true, false]) {
      expect(
        resolveGateMode({ unauthorized: true, unreachable: true, probe: { claimed } }),
      ).not.toBe('reconnecting');
    }
  });

  it('an unreachable backend never shows credential fields (D9)', () => {
    for (const probe of [null, 'unreachable'] as const) {
      const mode = resolveGateMode({ unauthorized: false, unreachable: true, probe });
      expect(mode).toBe('reconnecting');
    }
  });

  it('a backend that died AFTER the 401 shows reconnecting until the probe answers', () => {
    expect(resolveGateMode({ unauthorized: true, unreachable: true, probe: 'unreachable' })).toBe(
      'reconnecting',
    );
  });
});

describe('extractPrefillToken (?t= prefill + scrub, plan D7)', () => {
  it('extracts the token and scrubs only the t param', () => {
    const { token, scrubbedSearch } = extractPrefillToken('?t=9f2c17&x=1');
    expect(token).toBe('9f2c17');
    expect(scrubbedSearch).toBe('?x=1');
  });

  it('returns an empty search when t was the only param', () => {
    expect(extractPrefillToken('?t=abc')).toEqual({ token: 'abc', scrubbedSearch: '' });
  });

  it('leaves a token-free search alone', () => {
    expect(extractPrefillToken('?session=s1')).toEqual({
      token: null,
      scrubbedSearch: '?session=s1',
    });
    expect(extractPrefillToken('')).toEqual({ token: null, scrubbedSearch: '' });
  });
});

describe('authErrorMessage (named refusals, plan D14)', () => {
  it('maps login 401 to the uniform wrong-credentials line', () => {
    expect(authErrorMessage('login', 401, 'UNAUTHORIZED', null)).toBe(
      'Wrong username or password.',
    );
  });

  it('maps 429 to a retry-after countdown when the header arrived', () => {
    expect(authErrorMessage('login', 429, null, 42)).toBe('Too many attempts. Try again in 42s.');
    expect(authErrorMessage('login', 429, null, null)).toBe(
      'Too many attempts. Try again in a few minutes.',
    );
  });

  it('names PASSWORD_TOO_SHORT, TOKEN_LOGIN_RETIRED, ALREADY_CLAIMED and NOT_CLAIMED', () => {
    expect(authErrorMessage('setup', 400, 'PASSWORD_TOO_SHORT', null)).toBe(
      'Password must be at least 12 characters.',
    );
    expect(authErrorMessage('token-login', 410, 'TOKEN_LOGIN_RETIRED', null)).toBe(
      'This instance now uses username & password sign-in.',
    );
    expect(authErrorMessage('setup', 409, 'ALREADY_CLAIMED', null)).toContain(
      'already has an admin account',
    );
    expect(authErrorMessage('login', 409, 'NOT_CLAIMED', null)).toContain('no admin account yet');
  });

  it('distinguishes token 401s from login 401s', () => {
    expect(authErrorMessage('token-login', 401, 'UNAUTHORIZED', null)).toContain('Invalid token');
    expect(authErrorMessage('setup', 401, 'UNAUTHORIZED', null)).toContain(
      'Invalid bootstrap token',
    );
    expect(authErrorMessage('reset', 401, 'UNAUTHORIZED', null)).toContain(
      'Invalid bootstrap token',
    );
  });
});

describe('parseRetryAfterHeader', () => {
  it('parses positive integer seconds and rejects the rest', () => {
    expect(parseRetryAfterHeader('30')).toBe(30);
    expect(parseRetryAfterHeader('0')).toBeNull();
    expect(parseRetryAfterHeader('soon')).toBeNull();
    expect(parseRetryAfterHeader(null)).toBeNull();
  });
});

describe('postAuth (form → endpoint mapping)', () => {
  function capturingFetch(response: Response) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(response);
    };
    return { calls, fetchFn };
  }

  it('posts setup to /auth/setup with JSON credentials included', async () => {
    const { calls, fetchFn } = capturingFetch(new Response(null, { status: 204 }));
    const result = await postAuth(
      'setup',
      { token: 't', username: 'u', password: 'p'.repeat(12) },
      fetchFn,
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url.endsWith('/auth/setup')).toBe(true);
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.credentials).toBe('include');
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      token: 't',
      username: 'u',
      password: 'p'.repeat(12),
    });
  });

  it.each([
    ['login', '/auth/login'],
    ['token-login', '/auth/token-login'],
    ['reset', '/auth/reset'],
  ] as const)('posts %s to %s', async (kind, path) => {
    const { calls, fetchFn } = capturingFetch(new Response(null, { status: 204 }));
    await postAuth(kind, {}, fetchFn);
    expect(calls[0]?.url.endsWith(path)).toBe(true);
  });

  it('surfaces a 401 refusal with the mapped message and code', async () => {
    const { fetchFn } = capturingFetch(
      new Response(JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }), { status: 401 }),
    );
    const result = await postAuth('login', { username: 'u', password: 'p' }, fetchFn);
    expect(result).toMatchObject({
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Wrong username or password.',
    });
  });

  it('reads Retry-After on a 429', async () => {
    const { fetchFn } = capturingFetch(
      new Response(JSON.stringify({ ok: false, code: 'RATE_LIMITED' }), {
        status: 429,
        headers: { 'Retry-After': '17' },
      }),
    );
    const result = await postAuth('login', {}, fetchFn);
    expect(result).toMatchObject({
      ok: false,
      status: 429,
      retryAfterSeconds: 17,
      message: 'Too many attempts. Try again in 17s.',
    });
  });

  it('maps TOKEN_LOGIN_RETIRED on a claimed instance', async () => {
    const { fetchFn } = capturingFetch(
      new Response(JSON.stringify({ ok: false, code: 'TOKEN_LOGIN_RETIRED' }), { status: 410 }),
    );
    const result = await postAuth('token-login', { token: 't' }, fetchFn);
    expect(result).toMatchObject({
      ok: false,
      code: 'TOKEN_LOGIN_RETIRED',
      message: 'This instance now uses username & password sign-in.',
    });
  });

  it('turns a rejected fetch into a status-0 refusal, not a throw', async () => {
    const fetchFn: typeof fetch = () => Promise.reject(new TypeError('network down'));
    const result = await postAuth('login', {}, fetchFn);
    expect(result).toMatchObject({ ok: false, status: 0, code: null });
  });
});

describe('fetchAuthState', () => {
  it('parses the claimed/tokenFromEnv pair', async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ claimed: true, tokenFromEnv: false }), { status: 200 }),
      );
    expect(await fetchAuthState(fetchFn)).toEqual({ claimed: true, tokenFromEnv: false });
  });

  it('reports unreachable on a rejected fetch or a non-2xx answer', async () => {
    const rejecting: typeof fetch = () => Promise.reject(new TypeError('down'));
    expect(await fetchAuthState(rejecting)).toBe('unreachable');
    const failing: typeof fetch = () => Promise.resolve(new Response('bad', { status: 500 }));
    expect(await fetchAuthState(failing)).toBe('unreachable');
  });
});

describe('resolveAccessSection (Settings access section, plan D18)', () => {
  it('claimed → reset entry to /welcome/reset with the glyph+word warning', () => {
    const view = resolveAccessSection({ claimed: true, tokenFromEnv: false });
    expect(view.kind).toBe('claimed');
    expect(view.action).toEqual({ label: 'Reset credentials…', target: '/welcome/reset' });
    // Copy must state both consequences (D18), warned glyph + word, never
    // color alone (DESIGN.md).
    expect(view.warningLine).toContain('⚠');
    expect(view.warningLine).toContain('bootstrap token');
    expect(view.warningLine).toContain('Signs out every active session');
    expect(view.tokenLine).toContain('generated file');
  });

  it('claimed with an env-managed token names the deployment (D2/D12)', () => {
    const view = resolveAccessSection({ claimed: true, tokenFromEnv: true });
    expect(view.kind).toBe('claimed');
    expect(view.tokenLine).toContain('managed by your deployment');
    expect(view.tokenLine).toContain('ETHOS_WEB_TOKEN');
  });

  it('unclaimed → token access is active, offers the claim wizard (D16)', () => {
    const view = resolveAccessSection({ claimed: false, tokenFromEnv: false });
    expect(view.kind).toBe('unclaimed');
    expect(view.statusLine).toContain('Token access is active');
    expect(view.action).toEqual({ label: 'Set up username & password', target: '/welcome' });
    expect(view.warningLine).toBeNull();
  });

  it('unreachable → no action, no token line', () => {
    const view = resolveAccessSection('unreachable');
    expect(view.kind).toBe('unavailable');
    expect(view.action).toBeNull();
    expect(view.tokenLine).toBeNull();
    expect(view.warningLine).toBeNull();
  });
});
