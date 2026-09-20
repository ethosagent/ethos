import type { ApiKeyMetadata } from '@ethosagent/web-contracts';
import { PHONE_PRESET_SCOPES } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  applyLastUsed,
  applyTimeout,
  buildConnectString,
  CONNECT_TIMEOUT_MS,
  canGenerateQr,
  IDLE_STATE,
  isPhoneKey,
  reveal,
  startGenerating,
} from '../lib/mobile-connect';

function key(patch: Partial<Pick<ApiKeyMetadata, 'scopes' | 'revokedAt'>> = {}) {
  return { scopes: [...PHONE_PRESET_SCOPES], revokedAt: null, ...patch };
}

describe('buildConnectString', () => {
  it('URL-encodes both the url and the key', () => {
    const out = buildConnectString('https://box.tailnet.ts.net:3000', 'sk-ethos-abc123&def');
    expect(out.startsWith('ethos://connect?url=')).toBe(true);
    // the literal `&` inside the key must not be read as a second query param
    expect(out).toContain('%26');
    expect(out).toBe(
      'ethos://connect?url=https%3A%2F%2Fbox.tailnet.ts.net%3A3000&key=sk-ethos-abc123%26def',
    );
  });

  it('produces a different string for an edited host, same key', () => {
    const a = buildConnectString('http://127.0.0.1:3000', 'sk-ethos-same');
    const b = buildConnectString('https://box.tailnet.ts.net', 'sk-ethos-same');
    expect(a).not.toBe(b);
  });
});

describe('isPhoneKey', () => {
  it('a key with exactly the preset scopes, not revoked → true', () => {
    expect(isPhoneKey(key())).toBe(true);
  });

  it('a key with extra scopes beyond the preset, not revoked → true (superset)', () => {
    expect(isPhoneKey(key({ scopes: [...PHONE_PRESET_SCOPES, 'kanban:read'] }))).toBe(true);
  });

  it('a key missing one preset scope → false', () => {
    expect(isPhoneKey(key({ scopes: PHONE_PRESET_SCOPES.slice(1) }))).toBe(false);
  });

  it('a key with every preset scope but revoked → false, revoked always wins', () => {
    expect(isPhoneKey(key({ revokedAt: '2026-09-20T12:00:00.000Z' }))).toBe(false);
  });
});

describe('the connect machine', () => {
  it('startGenerating() is generating, with no secret', () => {
    const s = startGenerating();
    expect(s.phase).toBe('generating');
    expect(s.key).toBeNull();
  });

  it('reveal() carries the secret in "revealed"', () => {
    const s = reveal({ keyId: 'k1', url: 'https://box.ts.net', key: 'sk-ethos-x', now: 0 });
    expect(s.phase).toBe('revealed');
    expect(s.key).toBe('sk-ethos-x');
    expect(s.url).toBe('https://box.ts.net');
  });

  it('applyLastUsed on "revealed" with lastUsed: null is a no-op — still waiting', () => {
    const revealed = reveal({ keyId: 'k1', url: 'https://box.ts.net', key: 'sk-ethos-x', now: 0 });
    const next = applyLastUsed(revealed, null);
    expect(next.phase).toBe('revealed');
    expect(next.key).toBe('sk-ethos-x');
  });

  it('applyLastUsed on "revealed" with a real timestamp moves to connected, drops the QR/secret', () => {
    const revealed = reveal({ keyId: 'k1', url: 'https://box.ts.net', key: 'sk-ethos-x', now: 0 });
    const next = applyLastUsed(revealed, '2026-09-20T12:00:00.000Z');
    expect(next.phase).toBe('connected');
    expect(next.url).toBeNull();
    expect(next.key).toBeNull();
  });

  it('applyLastUsed on a non-"revealed" state is an exact no-op', () => {
    expect(applyLastUsed(IDLE_STATE, '2026-09-20T12:00:00.000Z')).toBe(IDLE_STATE);
  });

  it('applyTimeout before 10 minutes leaves "revealed" untouched', () => {
    const revealed = reveal({ keyId: 'k1', url: 'https://box.ts.net', key: 'sk-ethos-x', now: 0 });
    const next = applyTimeout(revealed, 9 * 60 * 1000);
    expect(next.phase).toBe('revealed');
    expect(next.key).toBe('sk-ethos-x');
  });

  it('applyTimeout just past 10 minutes drops to expired, with no QR/secret', () => {
    const revealed = reveal({ keyId: 'k1', url: 'https://box.ts.net', key: 'sk-ethos-x', now: 0 });
    const next = applyTimeout(revealed, CONNECT_TIMEOUT_MS + 1);
    expect(next.phase).toBe('expired');
    expect(next.url).toBeNull();
    expect(next.key).toBeNull();
    expect(next.mintedAt).toBeNull();
  });

  it('holds the secret ONLY in "revealed" — every other reachable state carries key: null', () => {
    const revealed = reveal({ keyId: 'k1', url: 'https://box.ts.net', key: 'sk-ethos-x', now: 0 });
    const states = [
      IDLE_STATE,
      startGenerating(),
      revealed,
      applyLastUsed(revealed, '2026-09-20T12:00:00.000Z'),
      applyTimeout(revealed, CONNECT_TIMEOUT_MS + 1),
    ];
    for (const s of states) {
      expect(s.key !== null).toBe(s.phase === 'revealed');
    }
  });
});

describe('canGenerateQr', () => {
  it('a loopback bind cannot be reached by a phone — no Generate action', () => {
    expect(
      canGenerateQr({ url: 'http://127.0.0.1:3000', source: 'web.host', loopback: true }),
    ).toBe(false);
  });

  it('a reachable server offers Generate', () => {
    expect(
      canGenerateQr({ url: 'https://box.tailnet.ts.net', source: 'webBaseUrl', loopback: false }),
    ).toBe(true);
  });
});
