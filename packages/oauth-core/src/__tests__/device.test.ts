import { describe, expect, it } from 'vitest';
import {
  buildDeviceAuthorizationParams,
  buildDeviceTokenParams,
  classifyDeviceTokenResponse,
  DEVICE_CODE_GRANT_TYPE,
  parseDeviceAuthorizationResponse,
} from '../device';

const NOW = 1_700_000_000_000;

const VALID = {
  device_code: 'dev-123',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.example.com/device',
  expires_in: 300,
  interval: 7,
};

describe('buildDeviceAuthorizationParams', () => {
  it('form-encodes client_id and space-joined scope', () => {
    const { body, headers } = buildDeviceAuthorizationParams({
      clientId: 'cid',
      scopes: ['read', 'write'],
    });
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('scope')).toBe('read write');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('omits scope when none are given', () => {
    const { body } = buildDeviceAuthorizationParams({ clientId: 'cid' });
    expect(body.has('scope')).toBe(false);
  });
});

describe('parseDeviceAuthorizationResponse', () => {
  it('maps a valid response', () => {
    const r = parseDeviceAuthorizationResponse(
      { ...VALID, verification_uri_complete: 'https://auth.example.com/device?c=1' },
      { now: NOW },
    );
    expect(r).toEqual({
      deviceCode: 'dev-123',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.example.com/device',
      verificationUriComplete: 'https://auth.example.com/device?c=1',
      expiresAt: NOW + 300_000,
      intervalSec: 7,
    });
  });

  it('defaults interval to 5 and caps expiresAt at 15 minutes', () => {
    const { interval: _i, ...rest } = VALID;
    const r = parseDeviceAuthorizationResponse({ ...rest, expires_in: 99_999 }, { now: NOW });
    expect(r.intervalSec).toBe(5);
    expect(r.expiresAt).toBe(NOW + 15 * 60_000);
    expect(
      parseDeviceAuthorizationResponse({ ...VALID, interval: 0 }, { now: NOW }).intervalSec,
    ).toBe(5);
  });

  it('rejects a non-https verification_uri', () => {
    expect(() =>
      parseDeviceAuthorizationResponse(
        { ...VALID, verification_uri: 'http://auth.example.com/device' },
        { now: NOW },
      ),
    ).toThrow('verification_uri');
    expect(() =>
      parseDeviceAuthorizationResponse(
        { ...VALID, verification_uri_complete: 'javascript:alert(1)' },
        { now: NOW },
      ),
    ).toThrow('verification_uri_complete');
  });

  it('rejects a missing device_code / user_code / expires_in', () => {
    for (const key of ['device_code', 'user_code', 'expires_in'] as const) {
      const copy: Record<string, unknown> = { ...VALID };
      delete copy[key];
      expect(() => parseDeviceAuthorizationResponse(copy, { now: NOW })).toThrow(key);
    }
    expect(() =>
      parseDeviceAuthorizationResponse({ ...VALID, expires_in: 0 }, { now: NOW }),
    ).toThrow('expires_in');
    expect(() => parseDeviceAuthorizationResponse(null, { now: NOW })).toThrow();
  });

  it('never puts the codes in an error message', () => {
    try {
      parseDeviceAuthorizationResponse(
        { ...VALID, verification_uri: 'http://x.example/d' },
        { now: NOW },
      );
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('dev-123');
      expect((err as Error).message).not.toContain('ABCD-EFGH');
    }
  });
});

describe('buildDeviceTokenParams', () => {
  it('uses the RFC 8628 grant type', () => {
    const { body } = buildDeviceTokenParams({ deviceCode: 'dev-123', clientId: 'cid' });
    expect(body.get('grant_type')).toBe(DEVICE_CODE_GRANT_TYPE);
    expect(body.get('device_code')).toBe('dev-123');
    expect(body.get('client_id')).toBe('cid');
  });
});

describe('classifyDeviceTokenResponse', () => {
  it('maps the four RFC 8628 errors, a 200 token body, an unknown error and a non-object body', () => {
    expect(classifyDeviceTokenResponse(400, { error: 'authorization_pending' })).toEqual({
      kind: 'pending',
    });
    expect(classifyDeviceTokenResponse(400, { error: 'slow_down' })).toEqual({ kind: 'slow_down' });
    expect(classifyDeviceTokenResponse(400, { error: 'access_denied' })).toEqual({
      kind: 'denied',
    });
    expect(classifyDeviceTokenResponse(400, { error: 'expired_token' })).toEqual({
      kind: 'expired',
    });
    const ok = classifyDeviceTokenResponse(200, { access_token: 'at', refresh_token: 'rt' });
    expect(ok.kind).toBe('tokens');
    if (ok.kind === 'tokens') expect(ok.tokens.access_token).toBe('at');
    expect(classifyDeviceTokenResponse(400, { error: 'invalid_grant' })).toEqual({
      kind: 'error',
      code: 'invalid_grant',
    });
    expect(classifyDeviceTokenResponse(200, 'nope')).toEqual({
      kind: 'error',
      code: 'invalid_response',
    });
    expect(classifyDeviceTokenResponse(200, { no: 'token' })).toEqual({
      kind: 'error',
      code: 'invalid_response',
    });
  });
});
