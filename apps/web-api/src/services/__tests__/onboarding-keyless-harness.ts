import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { ORPCError } from '@orpc/server';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { ConfigRepository } from '../../repositories/config.repository';
import { OnboardingService, type ProbeHost } from '../onboarding.service';

export const GIB = 1024 ** 3;
export const FAKE_ACCESS = 'fakeAccessTokenValue.payload.sig';
export const FAKE_REFRESH = 'fakeRefreshTokenValue';
export const FAKE_ID = 'fakeIdTokenValue.payload.sig';
export const DATA_DIR = '/data/.ethos';

export type Cfg = { provider?: string; apiKey?: string; personality?: string } | null;

export function makeConfig(initial: Cfg) {
  let cfg = initial;
  return {
    read: async () => cfg,
    update: async (patch: Record<string, unknown>) => {
      cfg = { ...(cfg ?? {}), ...patch } as Cfg;
    },
  } as unknown as ConfigRepository;
}

/** A registry fake: just the three methods namePersonality touches. */
export function makeRegistry(ids: string[]) {
  const known = new Set(ids);
  const duplicate = vi.fn(async (_src: string, newId: string) => {
    known.add(newId);
    return {};
  });
  const registry = {
    get: (id: string) => (known.has(id) ? { id } : undefined),
    duplicate,
    loadFromDirectory: vi.fn(async () => {}),
  } as unknown as FilePersonalityRegistry;
  return { registry, duplicate };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Fake fetch keyed by "host:port". Unlisted hosts refuse the connection. */
export function makeFetch(handlers: Record<string, (url: URL) => Response>) {
  const urls: string[] = [];
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const u = new URL(url);
    const h = handlers[u.host];
    if (!h) throw new Error('ECONNREFUSED');
    return h(u);
  }) as unknown as typeof fetch;
  return { impl, urls };
}

export const ollamaUp = (models: string[]) => (u: URL) => {
  if (u.pathname === '/api/version') return json({ version: '0.9.0' });
  if (u.pathname.endsWith('/api/ps')) return json({ models: [] });
  return json({ data: models.map((id) => ({ id })) });
};

export function useKeylessHarness() {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'onboarding-keyless-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const host = (over: Partial<ProbeHost> = {}): (() => ProbeHost) => {
    return () => ({
      platform: 'linux',
      totalMemBytes: 16 * GIB,
      isRoot: false,
      home,
      ...over,
    });
  };

  function make(opts: {
    config?: Cfg;
    fetchFn?: typeof fetch;
    secrets?: InMemorySecretsResolver;
    registry?: FilePersonalityRegistry;
    probeHost?: () => ProbeHost;
    funnel?: ConstructorParameters<typeof OnboardingService>[0]['funnel'];
    pullFn?: ConstructorParameters<typeof OnboardingService>[0]['pullFn'];
    storage?: InMemoryStorage;
  }) {
    const storage = opts.storage ?? new InMemoryStorage();
    const secrets = opts.secrets ?? new InMemorySecretsResolver();
    const service = new OnboardingService({
      config: makeConfig(opts.config ?? null),
      personalities: opts.registry ?? makeRegistry(['researcher']).registry,
      secrets,
      storage,
      dataDir: DATA_DIR,
      probeHost: opts.probeHost ?? host(),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      ...(opts.funnel ? { funnel: opts.funnel } : {}),
      ...(opts.pullFn ? { pullFn: opts.pullFn } : {}),
    });
    return { service, storage, secrets };
  }

  const done: Cfg = { provider: 'ollama', apiKey: 'local', personality: 'researcher' };

  async function expectOrpc(p: Promise<unknown>, code: string, status: number) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ORPCError);
    const e = err as ORPCError<string, unknown>;
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
  }

  return { host, make, done, expectOrpc, home: () => home };
}
