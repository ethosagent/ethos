import { describe, expect, it } from 'vitest';
import {
  describeGscApiError,
  describeThrownGscError,
  describeTokenMintError,
  ServiceAccountJsonError,
  TokenMintError,
} from '../errors';
import { CLIENT_EMAIL } from './fixtures';

const CTX = { clientEmail: CLIENT_EMAIL, siteUrl: 'sc-domain:example.com' };

function reasonBody(reason: string): Response {
  return new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status: 403 });
}

describe('describeGscApiError', () => {
  it('maps 403 accessNotConfigured to the enable-the-API fix', async () => {
    const result = await describeGscApiError(reasonBody('accessNotConfigured'), CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(result.error).toContain('not enabled');
    expect(result.error).toContain('console.cloud.google.com/apis/library/searchconsole');
  });

  it('maps a 403 with another reason to the grant message', async () => {
    const result = await describeGscApiError(reasonBody('forbidden'), CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(result.error).toContain(CLIENT_EMAIL);
    expect(result.error).toContain('sc-domain:example.com');
    expect(result.error).toContain('Users and permissions');
  });

  it('still yields the grant message when the 403 body is unparseable', async () => {
    const result = await describeGscApiError(new Response('<html>', { status: 403 }), CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(result.error).toContain('Users and permissions');
  });

  it('says "this Search Console property" when no siteUrl was named', async () => {
    const result = await describeGscApiError(reasonBody('forbidden'), {
      clientEmail: CLIENT_EMAIL,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('this Search Console property');
  });

  it('maps 429 to the rate-limit message as execution_failed', async () => {
    const result = await describeGscApiError(new Response('', { status: 429 }), CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
    expect(result.error).toContain('rate limit');
  });

  it('falls back to a generic message with the status and body', async () => {
    const result = await describeGscApiError(new Response('boom', { status: 500 }), CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
    expect(result.error).toBe('Search Console API error 500: boom');
  });

  it('produces a DISTINCT message per mapped status', async () => {
    const messages = await Promise.all([
      describeGscApiError(reasonBody('accessNotConfigured'), CTX),
      describeGscApiError(reasonBody('forbidden'), CTX),
      describeGscApiError(new Response('', { status: 429 }), CTX),
      describeGscApiError(new Response('boom', { status: 500 }), CTX),
    ]);
    const texts = messages.map((m) => (m.ok ? '' : m.error));
    expect(new Set(texts).size).toBe(4);
  });
});

describe('describeTokenMintError', () => {
  // A deleted key never produces a 401 from Search Console — the call is never
  // made. It fails one step earlier, at the mint, with the RFC 6749 shape (D26).
  it('names BOTH likely causes of invalid_grant with their fixes', () => {
    const result = describeTokenMintError(
      new TokenMintError(
        400,
        JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }),
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(result.error).toContain('clock');
    expect(result.error).toContain('5 minutes');
    expect(result.error).toContain('deleted or disabled');
    expect(result.error).toContain('Add key');
  });

  it('reports any other RFC 6749 error with its description', () => {
    const result = describeTokenMintError(
      new TokenMintError(
        401,
        JSON.stringify({ error: 'invalid_client', error_description: 'The client is unknown.' }),
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
    expect(result.error).toContain('invalid_client');
    expect(result.error).toContain('The client is unknown.');
  });

  it('survives a mint body that is not JSON', () => {
    const result = describeTokenMintError(new TokenMintError(502, '<html>bad gateway</html>'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('HTTP 502');
  });
});

describe('describeThrownGscError', () => {
  // ScopedFetchImpl THROWS HOST_NOT_ALLOWED rather than returning a Response,
  // so a Response-keyed error table can never see this case (plan §18).
  it('maps a HOST_NOT_ALLOWED throw to a message naming BOTH required hosts', () => {
    const result = describeThrownGscError(
      new Error('HOST_NOT_ALLOWED: oauth2.googleapis.com is not in the declared allowedHosts'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(result.error).toContain('searchconsole.googleapis.com');
    expect(result.error).toContain('oauth2.googleapis.com');
    expect(result.error).toContain('safety.network.allow');
  });

  it('routes a TokenMintError through describeTokenMintError', () => {
    const result = describeThrownGscError(
      new TokenMintError(400, JSON.stringify({ error: 'invalid_grant' })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('deleted or disabled');
  });

  it('maps a credential-shape refusal to input_invalid', () => {
    const result = describeThrownGscError(new ServiceAccountJsonError('missing "private_key"'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('private_key');
  });

  it('falls back to execution_failed for anything else', () => {
    const result = describeThrownGscError(new Error('socket hang up'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
    expect(result.error).toBe('socket hang up');
  });
});
