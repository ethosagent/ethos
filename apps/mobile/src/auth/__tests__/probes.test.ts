import { describe, expect, it } from 'vitest';
import {
  isLocalHost,
  probeHealth,
  probeWhoami,
  refusals,
  unreachable,
  type Whoami,
} from '../probes';

function answer(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function fail(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe('probeHealth', () => {
  it('answers 200 with a version', async () => {
    const res = await probeHealth(
      'http://192.168.1.5:3000',
      answer(200, { status: 'ok', version: '0.8.1' }),
    );
    expect(res.ok).toBe(true);
    expect(res.version).toBe('0.8.1');
    expect(res.row.glyph).toBe('✓');
    expect(res.row.subject).toBe('GET /healthz');
    expect(res.row.result).toBe('v0.8.1');
    expect(res.row.time).toMatch(/^\d+ ms$/);
  });

  it('answers 503 with no version', async () => {
    const res = await probeHealth('http://192.168.1.5:3000', answer(503, { status: 'degraded' }));
    expect(res.ok).toBe(true);
    expect(res.version).toBeNull();
    expect(res.row.result).toBe('version · unknown');
  });

  it('fails on 404 with the host as subject', async () => {
    const res = await probeHealth('http://192.168.1.5:3000', answer(404, {}));
    expect(res.ok).toBe(false);
    expect(res.row.glyph).toBe('✗');
    expect(res.row.subject).toBe('192.168.1.5:3000');
    expect(res.row.result).toBe('connection refused · nothing is listening — check web.host');
  });

  it('maps a fetch rejection to the refused row', async () => {
    const res = await probeHealth('http://10.0.0.2:3000', fail('Timed out after 5000 ms'));
    expect(res.ok).toBe(false);
    expect(res.row.result).toBe('connection refused · nothing is listening — check web.host');
  });

  // The device symptom: a server bound to 127.0.0.1, reached from a phone.
  // expo/fetch rejects with iOS's NSURLError text and the probe must resolve
  // to the ✗ row — never let the rejection escape (a full-screen error in
  // Expo Go).
  it('resolves an expo/fetch "Could not connect" rejection to the ✗ row, leaking nothing', async () => {
    const leaked: unknown[] = [];
    const collect = (reason: unknown) => leaked.push(reason);
    process.on('unhandledRejection', collect);
    try {
      const refused = (async () => {
        throw new TypeError('fetch failed: Could not connect to the server.');
      }) as unknown as typeof fetch;
      const res = await probeHealth('http://192.168.1.20:3000', refused);
      await new Promise((r) => setImmediate(r));
      expect(res.ok).toBe(false);
      expect(res.row).toEqual({
        glyph: '✗',
        word: 'probe',
        subject: '192.168.1.20:3000',
        result: 'connection refused · nothing is listening — check web.host',
      });
      expect(leaked).toEqual([]);
    } finally {
      process.off('unhandledRejection', collect);
    }
  });
});

describe('unreachable', () => {
  it.each([
    [
      'http://ethos.example.com',
      'Network request failed',
      "cleartext blocked · use https, or the app's ATS exemption",
    ],
    [
      'https://ethos.example.com',
      'The certificate for this server is invalid.',
      'certificate not trusted',
    ],
    [
      'http://192.168.1.5:3000',
      'The Internet connection appears to be offline.',
      'local network denied · allow Local Network for Ethos in iOS Settings',
    ],
    [
      'http://mac-mini.local:3000',
      'The Internet connection appears to be offline.',
      'local network denied · allow Local Network for Ethos in iOS Settings',
    ],
    [
      'http://192.168.1.5:3000',
      'Could not connect to the server.',
      'connection refused · nothing is listening — check web.host',
    ],
    [
      'http://100.101.102.103:3000',
      'Could not connect to the server.',
      'connection refused · nothing is listening — check web.host',
    ],
    [
      'not a url',
      'Enter an http:// or https:// server URL.',
      'Enter an http:// or https:// server URL.',
    ],
  ])('maps %s + %s', (url, error, expected) => {
    expect(unreachable(url, error)).toBe(expected);
  });
});

describe('isLocalHost', () => {
  it.each([
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.0.9', true],
    ['100.64.0.1', true],
    ['100.128.0.1', false],
    ['mac.local', true],
    ['nas', true],
    ['8.8.8.8', false],
    ['ethos.example.com', false],
  ])('%s is local: %s', (host, expected) => {
    expect(isLocalHost(host)).toBe(expected);
  });
});

describe('probeWhoami', () => {
  it('reports the key name and scopes', async () => {
    const me = {
      authMethod: 'bearer',
      key: {
        name: 'iphone',
        prefix: 'sk-ethos-4f2c',
        scopes: ['chat:send', 'sessions:read'],
        createdAt: '2026-09-01T00:00:00Z',
        lastUsed: null,
      },
    } as unknown as Whoami;
    const res = await probeWhoami(async () => me, { host: 'h', version: '0.8.1' });
    expect(res.ok).toBe(true);
    expect(res.scopes).toEqual(['chat:send', 'sessions:read']);
    expect(res.row).toEqual({
      glyph: '✓',
      word: 'probe',
      subject: 'meta.whoami',
      result: 'bearer · iphone · scopes chat:send, sessions:read',
    });
  });

  it('maps UNAUTHORIZED to a revoked key', async () => {
    const res = await probeWhoami(
      async () => {
        throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
      },
      { host: 'h', version: '0.8.1' },
    );
    expect(res.ok).toBe(false);
    expect(res.row.result).toBe('key invalid or revoked');
    expect(res.scopes).toEqual([]);
  });

  it('maps FORBIDDEN to a too-old server', async () => {
    const res = await probeWhoami(
      async () => {
        throw Object.assign(new Error('Method meta.whoami is not mapped'), { code: 'FORBIDDEN' });
      },
      { host: 'mini.local:3000', version: '0.8.0' },
    );
    expect(res.row.result).toBe(
      'needs ≥ 0.8.1 · this server is 0.8.0 · update ethos on mini.local:3000',
    );
  });

  it('maps FORBIDDEN without a version to a generic hint', async () => {
    const res = await probeWhoami(
      async () => {
        throw Object.assign(new Error('Method meta.whoami is not mapped'), { code: 'FORBIDDEN' });
      },
      { host: 'h', version: null },
    );
    expect(res.row.result).toBe('server too old · update ethos');
  });
});

describe('refusals', () => {
  const ALL = [
    'sessions:read',
    'sessions:write',
    'chat:send',
    'personalities:read',
    'tools:approve',
    'activity:read',
    'events:subscribe',
    'push:register',
    'kanban:read',
    'kanban:write',
    'teams:read',
    'cron:read',
  ];

  it('is empty when the server and scopes are fine', () => {
    expect(refusals(ALL, '0.8.1', 'h')).toEqual([]);
  });

  // `ALL` is a pre-Phase-3 phone key: the preset has since gained voice:talk,
  // which is optional (`PHONE_OPTIONAL_PRESET_SCOPES`), so it is not refused.
  it('does not refuse a key minted before voice:talk joined the preset', () => {
    expect(ALL).not.toContain('voice:talk');
    expect(refusals([...ALL, 'voice:talk'], '0.8.1', 'h')).toEqual([]);
  });

  it('refuses a key missing scopes', () => {
    const rows = refusals(['chat:send'], '0.8.1', 'h');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.glyph).toBe('✗');
    expect(rows[0]?.word).toBe('scopes');
    expect(rows[0]?.subject.startsWith('missing sessions:read')).toBe(true);
    expect(rows[0]?.result).toContain('ethos api-key create --preset phone --qr');
    expect(rows[0]?.result).toContain('Settings → Mobile app');
  });

  it('refuses an old server', () => {
    const rows = refusals(ALL, '0.8.0', 'h');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.word).toBe('server');
    expect(rows[0]?.result).toBe('needs ≥ 0.8.1 · this server is 0.8.0 · update ethos on h');
  });

  it('compares versions numerically, not as strings', () => {
    expect(refusals(ALL, '0.10.0', 'h')).toEqual([]);
  });
});
