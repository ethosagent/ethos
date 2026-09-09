import { createVerify } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildAssertion, clearTokenCache, getAccessToken, parseServiceAccountJson } from '../auth';
import { SCOPE } from '../constants';
import { ServiceAccountJsonError, TokenMintError } from '../errors';
import {
  CLIENT_EMAIL,
  serviceAccountJson,
  TEST_PRIVATE_KEY_2,
  TEST_PUBLIC_KEY,
  TOKEN_URL,
} from './fixtures';

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

beforeEach(() => {
  clearTokenCache();
});

describe('parseServiceAccountJson', () => {
  it('reads client_email, private_key and token_uri', () => {
    const sa = parseServiceAccountJson(serviceAccountJson());
    expect(sa.clientEmail).toBe(CLIENT_EMAIL);
    expect(sa.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(sa.tokenUri).toBe(TOKEN_URL);
  });

  it('defaults token_uri when the key omits it', () => {
    const sa = parseServiceAccountJson(serviceAccountJson({ token_uri: undefined }));
    expect(sa.tokenUri).toBe(TOKEN_URL);
  });

  it('refuses a value that is not JSON, without a raw JSON.parse throw', () => {
    expect(() => parseServiceAccountJson('not json at all')).toThrow(ServiceAccountJsonError);
    try {
      parseServiceAccountJson('not json at all');
    } catch (err) {
      expect((err as Error).message).toContain('not valid JSON');
    }
  });

  it('refuses a JSON key missing private_key, naming the field', () => {
    try {
      parseServiceAccountJson(serviceAccountJson({ private_key: undefined }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceAccountJsonError);
      expect((err as Error).message).toContain('private_key');
    }
  });

  it('refuses a JSON key missing client_email, naming the field', () => {
    try {
      parseServiceAccountJson(serviceAccountJson({ client_email: undefined }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceAccountJsonError);
      expect((err as Error).message).toContain('client_email');
    }
  });

  it('refuses a token_uri pointing anywhere but Google', () => {
    try {
      parseServiceAccountJson(serviceAccountJson({ token_uri: 'https://evil.example/token' }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceAccountJsonError);
      expect((err as Error).message).toContain('token_uri');
    }
  });
});

describe('buildAssertion', () => {
  it('signs an RS256 JWT whose claim set carries iss, scope and aud', () => {
    const sa = parseServiceAccountJson(serviceAccountJson());
    const assertion = buildAssertion(sa, 1_700_000_000_000);
    const [headerSeg = '', claimSeg = '', signatureSeg = ''] = assertion.split('.');

    expect(decodeSegment(headerSeg)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeSegment(claimSeg)).toEqual({
      iss: CLIENT_EMAIL,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_000_000 + 3600,
    });

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSeg}.${claimSeg}`);
    expect(verifier.verify(TEST_PUBLIC_KEY, Buffer.from(signatureSeg, 'base64url'))).toBe(true);
  });

  it('requests the read-only scope and nothing wider', () => {
    expect(SCOPE).toBe('https://www.googleapis.com/auth/webmasters.readonly');
  });
});

/** A mint stub that counts exchanges and can be held open. */
function makeMint(expiresIn = 3600) {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    get calls() {
      return calls;
    },
    release: () => release?.(),
    fetch: async (_url: string | URL, _init?: RequestInit): Promise<Response> => {
      calls++;
      return Response.json({ access_token: `token-${calls}`, expires_in: expiresIn });
    },
    gatedFetch: async (_url: string | URL, _init?: RequestInit): Promise<Response> => {
      calls++;
      await gate;
      return Response.json({ access_token: `token-${calls}`, expires_in: expiresIn });
    },
  };
}

describe('getAccessToken', () => {
  it('reuses a cached token inside the safety margin', async () => {
    const sa = parseServiceAccountJson(serviceAccountJson());
    const mint = makeMint(3600);
    expect(await getAccessToken(sa, mint.fetch)).toBe('token-1');
    expect(await getAccessToken(sa, mint.fetch)).toBe('token-1');
    expect(mint.calls).toBe(1);
  });

  it('re-mints when less than the 5-minute margin is left', async () => {
    const sa = parseServiceAccountJson(serviceAccountJson());
    // 60s of life against a 300s margin — never reusable.
    const mint = makeMint(60);
    expect(await getAccessToken(sa, mint.fetch)).toBe('token-1');
    expect(await getAccessToken(sa, mint.fetch)).toBe('token-2');
    expect(mint.calls).toBe(2);
  });

  it('coalesces concurrent mints into one exchange (D30)', async () => {
    const sa = parseServiceAccountJson(serviceAccountJson());
    const mint = makeMint(3600);
    const both = Promise.all([
      getAccessToken(sa, mint.gatedFetch),
      getAccessToken(sa, mint.gatedFetch),
    ]);
    mint.release();
    const [a, b] = await both;
    expect(a).toBe(b);
    expect(mint.calls).toBe(1);
  });

  it('keys the cache on the private key, not client_email (D31)', async () => {
    const rotated = parseServiceAccountJson(serviceAccountJson({}, TEST_PRIVATE_KEY_2));
    const original = parseServiceAccountJson(serviceAccountJson());
    expect(rotated.clientEmail).toBe(original.clientEmail);

    const mint = makeMint(3600);
    expect(await getAccessToken(original, mint.fetch)).toBe('token-1');
    // Same email, replacement key — must NOT serve the revoked key's token.
    expect(await getAccessToken(rotated, mint.fetch)).toBe('token-2');
    expect(mint.calls).toBe(2);
  });

  it('throws TokenMintError on a non-ok mint and leaves no in-flight entry behind', async () => {
    const sa = parseServiceAccountJson(serviceAccountJson());
    let calls = 0;
    const failing = async (): Promise<Response> => {
      calls++;
      return new Response('{"error":"invalid_grant"}', { status: 400 });
    };
    await expect(getAccessToken(sa, failing)).rejects.toBeInstanceOf(TokenMintError);
    await expect(getAccessToken(sa, failing)).rejects.toBeInstanceOf(TokenMintError);
    expect(calls).toBe(2);
  });
});
