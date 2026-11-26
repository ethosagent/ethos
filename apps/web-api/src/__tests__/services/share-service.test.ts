import { incognitoSessionMetadata } from '@ethosagent/core';
import type { Session, StoredMessage } from '@ethosagent/types';
import { ShareCreateOutputSchema, SharePreviewOutputSchema } from '@ethosagent/web-contracts';
import { SqliteShareLinkStore } from '@ethosagent/wiring';
import { afterEach, describe, expect, it } from 'vitest';
import { ShareService } from '../../features/share/service';
import type { ShareSettings } from '../../features/share/settings';

// plan share-links §3 Service, §4 rows 'shared rooms', 'host-header', D4, D9, D11, D13, D15.
// The refusal ladder itself is pinned in packages/wiring share-publish.test.ts; this file pins
// that the web service maps every refusal onto the contract, records the actor, builds the URL
// from webBaseUrl or the bind address and never leaks a token or snapshot through `list`.

const NOW = new Date('2026-11-26T10:00:00.000Z');
const GHP = `ghp_${'a'.repeat(36)}`;

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    key: 'web:1',
    platform: 'web',
    model: 'm',
    provider: 'p',
    personalityId: 'researcher',
    title: 'Debug run',
    usage: {} as Session['usage'],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}
const msg = (role: StoredMessage['role'], content: string): StoredMessage => ({
  id: 'm',
  sessionId: 's1',
  role,
  content,
  timestamp: NOW,
});

const stores: SqliteShareLinkStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function setup(
  opts: {
    settings?: Partial<ShareSettings>;
    sess?: Session | null;
    msgs?: StoredMessage[];
    bind?: { host: string; port: number };
    webBaseUrl?: string;
    noHost?: boolean;
  } = {},
) {
  const store = new SqliteShareLinkStore(':memory:', { now: () => NOW });
  stores.push(store);
  const settings: ShareSettings = { enabled: true, excludePersonalities: [], ...opts.settings };
  const sess = opts.sess === undefined ? session() : opts.sess;
  const reads = { settings: 0, actor: 0 };
  const service = new ShareService({
    host: opts.noHost ? null : { store, bind: opts.bind ?? { host: '127.0.0.1', port: 3000 } },
    sessions: {
      getSession: async () => sess,
      getMessages: async () => opts.msgs ?? [msg('user', 'hi'), msg('assistant', 'hello')],
    },
    settings: async () => {
      reads.settings += 1;
      return settings;
    },
    actor: async () => {
      reads.actor += 1;
      return 'web:alice';
    },
    ...(opts.webBaseUrl ? { webBaseUrl: opts.webBaseUrl } : {}),
    now: () => NOW,
  });
  return { store, service, settings, reads };
}

const input = { sessionId: 's1', expiresIn: '7d' as const, includeToolNames: false, pii: true };

describe('refusals map onto the contract', () => {
  const cases: Array<[string, Parameters<typeof setup>[0], object]> = [
    ['disabled', { settings: { enabled: false } }, { ok: false, reason: 'disabled' }],
    ['no host (onboarding)', { noHost: true }, { ok: false, reason: 'disabled' }],
    ['not_found', { sess: null }, { ok: false, reason: 'not_found' }],
    [
      'shared and incognito refused: shared room',
      { sess: session({ metadata: { roomAudience: 'shared' } } as Partial<Session>) },
      { ok: false, reason: 'shared_session' },
    ],
    [
      'shared and incognito refused: incognito',
      { sess: session({ metadata: incognitoSessionMetadata() } as Partial<Session>) },
      { ok: false, reason: 'shared_session' },
    ],
    [
      'excluded_personality',
      { settings: { excludePersonalities: ['researcher'] } },
      { ok: false, reason: 'excluded_personality', personalityId: 'researcher' },
    ],
    ['empty', { msgs: [] }, { ok: false, reason: 'empty' }],
  ];
  it.each(cases)('%s', async (_n, opts, expected) => {
    const { service, store } = setup(opts);
    const created = await service.create(input);
    const previewed = await service.preview({
      sessionId: 's1',
      includeToolNames: false,
      pii: true,
    });
    expect(created).toEqual(expected);
    expect(previewed).toEqual(expected);
    expect(ShareCreateOutputSchema.safeParse(created).success).toBe(true);
    expect(SharePreviewOutputSchema.safeParse(previewed).success).toBe(true);
    expect(store.list({ activeOnly: false })).toEqual([]);
  });

  it('too_large names the limit', async () => {
    const { service } = setup({ msgs: [msg('user', 'x'.repeat(2 * 1024 * 1024 + 10))] });
    expect(await service.create(input)).toEqual({
      ok: false,
      reason: 'too_large',
      limitBytes: 2 * 1024 * 1024,
    });
  });
});

describe('preview and create', () => {
  it('preview returns the redacted snapshot and writes nothing', async () => {
    const { service, store } = setup({
      msgs: [msg('user', `token ${GHP}`), msg('assistant', 'ok')],
    });
    const out = await service.preview({ sessionId: 's1', includeToolNames: false, pii: true });
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out)).not.toContain(GHP);
    expect(SharePreviewOutputSchema.safeParse(out).success).toBe(true);
    expect(store.list({ activeOnly: false })).toEqual([]);
  });

  it('create returns url, prefix, expiry and loopback; the url carries the token', async () => {
    const { service } = setup();
    const out = await service.create(input);
    expect(out).toMatchObject({ ok: true, loopback: true });
    if (!out.ok) throw new Error('unreachable');
    expect(out.url).toMatch(/^http:\/\/127\.0\.0\.1:3000\/share\/[A-Za-z0-9_-]{43}$/);
    expect(out.url).toContain(`/share/${out.prefix}`);
    expect(out.expiresAt).toBe('2026-12-03T10:00:00.000Z');
  });

  it('actor: created and revoked events record web:<admin>', async () => {
    const { service, store } = setup();
    const out = await service.create(input);
    if (!out.ok) throw new Error('unreachable');
    const [row] = store.list({ activeOnly: true });
    expect(await service.revoke({ id: row?.id ?? '' })).toEqual({ ok: true });
    expect(store.listEvents(row?.id ?? '').map((e) => [e.kind, e.actor])).toEqual([
      ['created', 'web:alice'],
      ['revoked', 'web:alice'],
    ]);
  });
});

describe('one settings read per call', () => {
  it('create reads config once; preview reads config once and never the admin actor', async () => {
    const { service, reads } = setup();
    await service.create(input);
    expect(reads.settings).toBe(1);
    reads.settings = 0;
    reads.actor = 0;
    await service.preview({ sessionId: 's1', includeToolNames: false, pii: true });
    expect(reads.settings).toBe(1);
    expect(reads.actor).toBe(0);
  });
});

describe('url base', () => {
  it('uses webBaseUrl from live settings, not loopback', async () => {
    const { service } = setup({ settings: { webBaseUrl: 'https://ethos.example.com/' } });
    const out = await service.create(input);
    expect(out).toMatchObject({ ok: true, loopback: false });
    if (out.ok) expect(out.url.startsWith('https://ethos.example.com/share/')).toBe(true);
  });

  it('falls back to the createWebApi webBaseUrl, then to the bind address', async () => {
    const a = await setup({ webBaseUrl: 'https://boot.example.com' }).service.create(input);
    if (a.ok) expect(a.url.startsWith('https://boot.example.com/share/')).toBe(true);
    const b = await setup({ bind: { host: '10.0.0.5', port: 4001 } }).service.create(input);
    expect(b).toMatchObject({ ok: true, loopback: false });
    if (b.ok) expect(b.url.startsWith('http://10.0.0.5:4001/share/')).toBe(true);
  });

  it('reads the port after bind, and a wildcard bind reads as this machine', async () => {
    const bind = { host: '0.0.0.0', port: 3000 };
    const { service } = setup({ bind });
    bind.port = 3004;
    const out = await service.create(input);
    expect(out).toMatchObject({ ok: true, loopback: true });
    if (out.ok) expect(out.url.startsWith('http://localhost:3004/share/')).toBe(true);
  });
});

describe('list', () => {
  it('never exposes token or snapshot, and reports the live switch', async () => {
    const { service, settings } = setup({
      msgs: [msg('user', 'secret plan'), msg('assistant', 'ok')],
    });
    const out = await service.create(input);
    if (!out.ok) throw new Error('unreachable');
    const token = out.url.split('/share/')[1] ?? '';
    const listed = await service.list({});
    expect(listed.enabled).toBe(true);
    expect(listed.links).toHaveLength(1);
    const json = JSON.stringify(listed);
    expect(json).not.toContain(token);
    expect(json).not.toContain('secret plan');
    expect(json).not.toContain('snapshot');
    expect(Object.keys(listed.links[0] ?? {}).sort()).toEqual(
      [
        'createdAt',
        'expiresAt',
        'id',
        'lastViewedAt',
        'prefix',
        'revokedAt',
        'sessionId',
        'title',
        'viewCount',
      ].sort(),
    );
    settings.enabled = false;
    expect((await service.list({})).enabled).toBe(false);
    expect((await service.list({})).links).toHaveLength(1);
  });

  it('activeOnly defaults on; revoked rows show with activeOnly false', async () => {
    const { service } = setup();
    await service.create(input);
    const { links } = await service.list({});
    await service.revoke({ id: links[0]?.id ?? '' });
    expect((await service.list({})).links).toEqual([]);
    expect((await service.list({ activeOnly: false })).links[0]?.revokedAt).not.toBeNull();
  });
});

describe('revoke', () => {
  it('maps misses to typed results, and works while the feature is off', async () => {
    const { service, settings } = setup();
    expect(await service.revoke({ id: 'nope0000' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await service.revoke({ id: 'ab' })).toEqual({ ok: false, reason: 'prefix_too_short' });
    await service.create(input);
    const id = (await service.list({})).links[0]?.id ?? '';
    settings.enabled = false;
    expect(await service.revoke({ id })).toEqual({ ok: true });
  });
});
