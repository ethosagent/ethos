// Pins the share-publish refusals and URL rules of plan/phases/share-links.md §3, §4, D2, D4,
// D7, D9, D11, D13, D15 and §10 (snapshot cap): every typed refusal, preview == stored snapshot,
// URL base from webBaseUrl or the bind address (never a request Host), exact expiry, redacted
// title, token only in the returned URL, actor on the `created` event.
import { createHash } from 'node:crypto';
import { incognitoSessionMetadata } from '@ethosagent/core';
import { MAX_SNAPSHOT_BYTES, SqliteShareLinkStore } from '@ethosagent/share-links';
import type { Session, StoredMessage } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  previewShare,
  publishShare,
  resolveShareBaseUrl,
  type SharePublishDeps,
  type SharePublishInput,
} from '../share-publish';

const NOW = new Date('2026-11-26T10:00:00.000Z');
const GHP = `ghp_${'a'.repeat(36)}`;

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    key: 'cli:researcher:1',
    platform: 'cli',
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

function row(role: StoredMessage['role'], content: string): StoredMessage {
  return { id: 'm1', sessionId: 's1', role, content, timestamp: NOW };
}

const baseUrl = { url: 'http://127.0.0.1:3000', loopback: true };
const input: SharePublishInput = {
  sessionId: 's1',
  expiresIn: '7d',
  includeToolNames: false,
  pii: true,
  actor: 'cli',
  baseUrl,
};

const stores: SqliteShareLinkStore[] = [];
function setup(opts: {
  enabled?: boolean;
  exclude?: string[];
  sess?: Session | null;
  msgs?: StoredMessage[];
}) {
  const store = new SqliteShareLinkStore(':memory:', { now: () => NOW });
  stores.push(store);
  const sess = opts.sess === undefined ? session() : opts.sess;
  const msgs = opts.msgs ?? [row('user', 'hi'), row('assistant', 'hello')];
  const deps: SharePublishDeps = {
    store,
    shareLinks: { enabled: opts.enabled ?? true, excludePersonalities: opts.exclude ?? [] },
    sessions: {
      getSession: async () => sess,
      getMessages: async () => msgs,
    },
    now: () => NOW,
  };
  return { store, deps };
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

describe('refusals', () => {
  it('disabled', async () => {
    const { deps, store } = setup({ enabled: false });
    expect(await publishShare(deps, input)).toEqual({ ok: false, reason: 'disabled' });
    expect(await previewShare(deps, input)).toEqual({ ok: false, reason: 'disabled' });
    expect(store.list({ activeOnly: false })).toEqual([]);
  });

  it('not_found', async () => {
    const { deps } = setup({ sess: null });
    expect(await publishShare(deps, input)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('shared_session for a shared room', async () => {
    const { deps } = setup({ sess: session({ metadata: { roomAudience: 'shared' } }) });
    expect(await publishShare(deps, input)).toEqual({ ok: false, reason: 'shared_session' });
  });

  it('shared_session for an incognito session', async () => {
    const { deps } = setup({ sess: session({ metadata: incognitoSessionMetadata() }) });
    expect(await previewShare(deps, input)).toEqual({ ok: false, reason: 'shared_session' });
  });

  it('excluded_personality', async () => {
    const { deps } = setup({ exclude: ['researcher'] });
    expect(await publishShare(deps, input)).toEqual({
      ok: false,
      reason: 'excluded_personality',
      personalityId: 'researcher',
    });
  });

  it('too_large names the limit and stores nothing', async () => {
    const big = 'x'.repeat(MAX_SNAPSHOT_BYTES + 10);
    const { deps, store } = setup({ msgs: [row('user', big)] });
    expect(await publishShare(deps, input)).toEqual({
      ok: false,
      reason: 'too_large',
      limitBytes: MAX_SNAPSHOT_BYTES,
    });
    expect(store.list({ activeOnly: false })).toEqual([]);
  });

  it('empty when no user or assistant turn survives', async () => {
    const { deps } = setup({ msgs: [row('system', 'S'), row('tool_result', 'T')] });
    expect(await publishShare(deps, input)).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('publish', () => {
  it('preview equals the stored snapshot (D15)', async () => {
    const { deps, store } = setup({
      msgs: [row('user', `key ${GHP}`), row('assistant', 'ok bob@example.com')],
    });
    const prev = await previewShare(deps, input);
    const pub = await publishShare(deps, input);
    if (!prev.ok || !pub.ok) throw new Error('expected ok');
    const [link] = store.list({ activeOnly: true });
    const rec = store.findLive(
      createHash('sha256')
        .update(pub.url.split('/share/')[1] ?? '')
        .digest('hex'),
      NOW,
    );
    expect(JSON.parse(rec?.snapshot ?? 'null')).toEqual(prev.snapshot);
    expect(JSON.stringify(prev.snapshot)).not.toContain(GHP);
    expect(link?.id).toBe(rec?.id);
  });

  it('stores the redacted title, never the raw one', async () => {
    const { deps, store } = setup({ sess: session({ title: `leak ${GHP}` }) });
    const pub = await publishShare(deps, input);
    expect(pub.ok).toBe(true);
    const [link] = store.list({ activeOnly: true });
    expect(link?.title).not.toContain(GHP);
    expect(link?.title).toContain('REDACTED');
  });

  it.each([
    ['1h', 3_600_000],
    ['1d', 86_400_000],
    ['7d', 7 * 86_400_000],
    ['30d', 30 * 86_400_000],
  ] as const)('expiry %s is exact', async (expiresIn, ms) => {
    const { deps } = setup({});
    const pub = await publishShare(deps, { ...input, expiresIn });
    if (!pub.ok) throw new Error('expected ok');
    expect(pub.expiresAt).toBe(new Date(NOW.getTime() + ms).toISOString());
  });

  it('token only in the url; row holds the hash; actor on the created event; options JSON', async () => {
    const { deps, store } = setup({});
    const pub = await publishShare(deps, { ...input, actor: 'web:admin', includeToolNames: true });
    if (!pub.ok) throw new Error('expected ok');
    const token = pub.url.split('/share/')[1] ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pub.url).toBe(`http://127.0.0.1:3000/share/${token}`);
    expect(pub.prefix).toBe(token.slice(0, 8));
    expect(pub.loopback).toBe(true);
    const [link] = store.list({ activeOnly: true });
    expect(JSON.stringify(link)).not.toContain(token);
    expect(JSON.parse(link?.options ?? '{}')).toEqual({
      expiresIn: '7d',
      includeToolNames: true,
      pii: true,
    });
    expect(store.listEvents(link?.id ?? '').map((e) => [e.kind, e.actor])).toEqual([
      ['created', 'web:admin'],
    ]);
  });
});

describe('resolveShareBaseUrl', () => {
  it('uses webBaseUrl with the trailing slash trimmed; loopback false for a public host', () => {
    expect(
      resolveShareBaseUrl({
        webBaseUrl: 'https://ethos.example.com/',
        bindHost: '127.0.0.1',
        port: 3000,
      }),
    ).toEqual({ url: 'https://ethos.example.com', loopback: false });
  });
  it('webBaseUrl pointing at localhost is loopback', () => {
    expect(
      resolveShareBaseUrl({ webBaseUrl: 'http://localhost:3000', bindHost: '0.0.0.0', port: 3000 })
        .loopback,
    ).toBe(true);
  });
  it.each(['127.0.0.1', 'localhost', '::1'])('bind %s is loopback', (bindHost) => {
    expect(resolveShareBaseUrl({ bindHost, port: 3000 }).loopback).toBe(true);
  });
  it('LAN bind is not loopback; IPv6 is bracketed', () => {
    expect(resolveShareBaseUrl({ bindHost: '192.168.1.5', port: 8080 })).toEqual({
      url: 'http://192.168.1.5:8080',
      loopback: false,
    });
    expect(resolveShareBaseUrl({ bindHost: '::1', port: 3000 }).url).toBe('http://[::1]:3000');
    expect(resolveShareBaseUrl({ bindHost: 'fd00::1', port: 3000 }).url).toBe(
      'http://[fd00::1]:3000',
    );
  });
  it.each(['0.0.0.0', '::', '[::]'])(
    'wildcard bind %s names no reachable host: localhost URL, loopback warning',
    (bindHost) => {
      expect(resolveShareBaseUrl({ bindHost, port: 4100 })).toEqual({
        url: 'http://localhost:4100',
        loopback: true,
      });
    },
  );
  it.each(['127.0.0.2', '127.255.255.254'])('all of 127.0.0.0/8 is loopback (%s)', (bindHost) => {
    expect(resolveShareBaseUrl({ bindHost, port: 3000 }).loopback).toBe(true);
    expect(
      resolveShareBaseUrl({ webBaseUrl: `http://${bindHost}:3000`, bindHost: '10.0.0.1', port: 1 })
        .loopback,
    ).toBe(true);
  });
  it('128.0.0.1 and a hostname starting with 127. are not loopback', () => {
    expect(resolveShareBaseUrl({ bindHost: '128.0.0.1', port: 1 }).loopback).toBe(false);
    expect(resolveShareBaseUrl({ bindHost: '127.example.com', port: 1 }).loopback).toBe(false);
  });
  it('blank webBaseUrl falls back to the bind', () => {
    expect(resolveShareBaseUrl({ webBaseUrl: '  ', bindHost: '127.0.0.1', port: 1 }).url).toBe(
      'http://127.0.0.1:1',
    );
  });
});
