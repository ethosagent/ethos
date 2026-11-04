import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type FilePersonalityRegistry, hasBirthMarker } from '@ethosagent/personalities';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import {
  contract,
  KeylessModelIdSchema,
  OnboardingProbeOutputSchema,
} from '@ethosagent/web-contracts';
import { FunnelTracker } from '@ethosagent/wiring';
import { KEYLESS_MODEL_IDS } from '@ethosagent/wiring/keyless-probe';
import { ORPCError } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigRepository } from '../../repositories/config.repository';
import { OnboardingService, type ProbeHost } from '../onboarding.service';

const GIB = 1024 ** 3;
const FAKE_ACCESS = 'fakeAccessTokenValue.payload.sig';
const FAKE_REFRESH = 'fakeRefreshTokenValue';
const FAKE_ID = 'fakeIdTokenValue.payload.sig';
const DATA_DIR = '/data/.ethos';

type Cfg = { provider?: string; apiKey?: string; personality?: string } | null;

function makeConfig(initial: Cfg) {
  let cfg = initial;
  return {
    read: async () => cfg,
    update: async (patch: Record<string, unknown>) => {
      cfg = { ...(cfg ?? {}), ...patch } as Cfg;
    },
  } as unknown as ConfigRepository;
}

/** A registry fake: just the three methods namePersonality touches. */
function makeRegistry(ids: string[]) {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Fake fetch keyed by "host:port". Unlisted hosts refuse the connection. */
function makeFetch(handlers: Record<string, (url: URL) => Response>) {
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

const ollamaUp = (models: string[]) => (u: URL) => {
  if (u.pathname === '/api/version') return json({ version: '0.9.0' });
  if (u.pathname.endsWith('/api/ps')) return json({ models: [] });
  return json({ data: models.map((id) => ({ id })) });
};

describe('onboarding keyless RPCs', () => {
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

  // -------------------------------------------------------------------------
  describe('already configured', () => {
    it('every new mutation is refused with 409 ALREADY_CONFIGURED once step is done', async () => {
      const { service } = make({ config: done });
      await expectOrpc(service.probe(), 'ALREADY_CONFIGURED', 409);
      await expectOrpc(
        service.importCodexLogin({ source: 'codex-cli' }),
        'ALREADY_CONFIGURED',
        409,
      );
      await expectOrpc(service.pullModel({ model: 'qwen3' }), 'ALREADY_CONFIGURED', 409);
      await expectOrpc(
        service.namePersonality({ sourceId: 'researcher', name: 'Sage' }),
        'ALREADY_CONFIGURED',
        409,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('probe', () => {
    it('recommends a running Ollama and matches the wire schema', async () => {
      const { impl } = makeFetch({ '127.0.0.1:11434': ollamaUp(['llama3.2:latest']) });
      const { service } = make({ fetchFn: impl });

      const out = await service.probe();

      expect(OnboardingProbeOutputSchema.safeParse(out).success).toBe(true);
      expect(out.candidates[out.recommended]).toMatchObject({
        kind: 'local',
        runtime: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: ['llama3.2:latest'],
      });
      expect(out.machine).toEqual({
        totalMemGiB: 16,
        pick: { modelId: 'qwen3', approxDownloadGb: 5.2 },
      });
      expect(out.candidates.at(-1)).toEqual({ kind: 'paste-key' });
    });

    it('passes belowContextFloor through on a below-floor local candidate', async () => {
      const { impl } = makeFetch({
        '127.0.0.1:11434': (u) =>
          u.pathname.endsWith('/api/ps')
            ? json({ models: [{ name: 'llama3.2:latest', context_length: 8192 }] })
            : ollamaUp(['llama3.2:latest'])(u),
      });
      const { service } = make({ fetchFn: impl });

      const out = await service.probe();

      expect(OnboardingProbeOutputSchema.safeParse(out).success).toBe(true);
      expect(out.candidates[0]).toMatchObject({
        kind: 'local',
        contextWindow: 8192,
        belowContextFloor: { servedTokens: 8192, floorTokens: 16000 },
      });
    });

    it('with nothing local: install-offer, paste-key, and install is command TEXT only', async () => {
      const { impl } = makeFetch({});
      const { service } = make({ fetchFn: impl });

      const out = await service.probe();

      expect(out.candidates.map((c) => c.kind)).toEqual(['install-offer', 'paste-key']);
      expect(out.install).toEqual({
        os: 'linux',
        command: 'curl -fsSL https://ollama.com/install.sh | sh',
        notes: expect.stringContaining('sudo'),
        downloadUrl: null,
      });
    });

    it('as root the offered command is still text; nothing about it is runnable on the wire', async () => {
      const { impl } = makeFetch({});
      const { service } = make({ fetchFn: impl, probeHost: host({ isRoot: true }) });
      const out = await service.probe();
      expect(out.install).not.toHaveProperty('runnable');
      expect(out.install).not.toHaveProperty('argv');
    });

    it('path is omitted from external-login on the wire and no token leaks', async () => {
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(
        join(home, '.codex', 'auth.json'),
        JSON.stringify({
          tokens: { access_token: FAKE_ACCESS, refresh_token: FAKE_REFRESH, id_token: FAKE_ID },
        }),
      );
      const { impl } = makeFetch({});
      const { service, secrets } = make({ fetchFn: impl });

      const out = await service.probe();

      const login = out.candidates.find((c) => c.kind === 'external-login');
      expect(login).toEqual({ kind: 'external-login', source: 'codex-cli', provider: 'codex' });
      expect(login).not.toHaveProperty('path');
      const wire = JSON.stringify(out);
      expect(wire).not.toContain(home);
      for (const secret of [FAKE_ACCESS, FAKE_REFRESH, FAKE_ID]) {
        expect(wire).not.toContain(secret);
      }
      // Reporting a login never copies it.
      expect(await secrets.get('providers/codex/tokens')).toBeNull();
    });

    it('finds brew through Storage (PATH lookup) and offers the brew command on macOS', async () => {
      const storage = new InMemoryStorage();
      await storage.mkdir('/opt/homebrew/bin');
      await storage.write('/opt/homebrew/bin/brew', '#!/bin/sh');
      vi.stubEnv('PATH', ['/usr/bin', '/opt/homebrew/bin'].join(delimiter));
      try {
        const { impl } = makeFetch({});
        const { service } = make({
          fetchFn: impl,
          storage,
          probeHost: host({ platform: 'darwin' }),
        });
        const out = await service.probe();
        expect(out.install.command).toBe('brew install ollama && brew services start ollama');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('importCodexLogin', () => {
    async function writeCodex(shape: 'ok' | 'bad') {
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(
        join(home, '.codex', 'auth.json'),
        JSON.stringify(
          shape === 'ok'
            ? {
                tokens: {
                  access_token: FAKE_ACCESS,
                  refresh_token: FAKE_REFRESH,
                  id_token: FAKE_ID,
                },
              }
            : { tokens: { access_token: FAKE_ACCESS } },
        ),
      );
    }

    it('imports to the vault and returns only model ids, never a token', async () => {
      await writeCodex('ok');
      const { impl } = makeFetch({
        'chatgpt.com': () => json({ models: [{ id: 'gpt-5.5-codex' }] }),
      });
      const { service, secrets } = make({ fetchFn: impl });

      const out = await service.importCodexLogin({ source: 'codex-cli' });

      expect(out).toEqual({ ok: true, models: ['gpt-5.5-codex'] });
      expect(await secrets.get('providers/codex/tokens')).not.toBeNull();
      const wire = JSON.stringify(out);
      for (const secret of [FAKE_ACCESS, FAKE_REFRESH, FAKE_ID]) {
        expect(wire).not.toContain(secret);
      }
    });

    it('absent file → { ok:false, code:"absent" }', async () => {
      const { service } = make({});
      expect(await service.importCodexLogin({ source: 'hermes' })).toEqual({
        ok: false,
        code: 'absent',
      });
    });

    it('a file missing a token → invalid_shape, and nothing is stored', async () => {
      await writeCodex('bad');
      const { service, secrets } = make({});
      expect(await service.importCodexLogin({ source: 'codex-cli' })).toEqual({
        ok: false,
        code: 'invalid_shape',
      });
      expect(await secrets.get('providers/codex/tokens')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('pullModel / pullStatus', () => {
    it('starts a pull, reports byte progress, and ends in done', async () => {
      const { impl } = makeFetch({ '127.0.0.1:11434': ollamaUp([]) });
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const pullFn = vi.fn(async (o: { onProgress?: (p: unknown) => void; model: string }) => {
        o.onProgress?.({ status: 'pulling a', digest: 'a', total: 100, completed: 40 });
        o.onProgress?.({ status: 'pulling b', digest: 'b', total: 50, completed: 10 });
        await gate;
      }) as unknown as NonNullable<ConstructorParameters<typeof OnboardingService>[0]['pullFn']>;
      const { service } = make({ fetchFn: impl, pullFn });

      expect(service.pullStatus().state).toBe('idle');
      expect(await service.pullModel({ model: 'qwen3' })).toEqual({ ok: true });
      expect(pullFn).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen3' }));
      expect(service.pullStatus()).toEqual({
        state: 'pulling',
        completedBytes: 50,
        totalBytes: 150,
        error: null,
      });

      release();
      await vi.waitFor(() => expect(service.pullStatus().state).toBe('done'));
      expect(service.pullStatus()).toMatchObject({
        completedBytes: 50,
        totalBytes: 150,
        error: null,
      });
    });

    it('a second pull while one runs → 409 PULL_IN_PROGRESS', async () => {
      const { impl } = makeFetch({ '127.0.0.1:11434': ollamaUp([]) });
      const pullFn = vi.fn(() => new Promise<void>(() => {})) as unknown as NonNullable<
        ConstructorParameters<typeof OnboardingService>[0]['pullFn']
      >;
      const { service } = make({ fetchFn: impl, pullFn });
      await service.pullModel({ model: 'llama3.2' });
      await expectOrpc(service.pullModel({ model: 'qwen3' }), 'PULL_IN_PROGRESS', 409);
    });

    it('no Ollama on 127.0.0.1:11434 → 503 LOCAL_RUNTIME_UNREACHABLE, no pull started', async () => {
      const { impl } = makeFetch({});
      const pullFn = vi.fn() as unknown as NonNullable<
        ConstructorParameters<typeof OnboardingService>[0]['pullFn']
      >;
      const { service } = make({ fetchFn: impl, pullFn });
      await expectOrpc(service.pullModel({ model: 'qwen3' }), 'LOCAL_RUNTIME_UNREACHABLE', 503);
      expect(pullFn).not.toHaveBeenCalled();
      expect(service.pullStatus().state).toBe('idle');
    });

    it('a failed pull ends in error with Ollama status text only', async () => {
      const { impl } = makeFetch({ '127.0.0.1:11434': ollamaUp([]) });
      const { OllamaPullError } = await import('@ethosagent/wiring/ollama');
      const pullFn = vi.fn(async () => {
        throw new OllamaPullError('pull model manifest: file does not exist');
      }) as unknown as NonNullable<ConstructorParameters<typeof OnboardingService>[0]['pullFn']>;
      const { service } = make({ fetchFn: impl, pullFn });
      await service.pullModel({ model: 'qwen3' });
      await vi.waitFor(() => expect(service.pullStatus().state).toBe('error'));
      expect(service.pullStatus().error).toBe('pull model manifest: file does not exist');
      // A new pull may start after an error.
      await expect(service.pullModel({ model: 'qwen3' })).resolves.toEqual({ ok: true });
    });

    it('a model outside the enum is a 400 at the contract', () => {
      const schema = contract.onboarding.pullModel['~orpc'].inputSchema;
      expect(schema?.['~standard'].validate({ model: 'llama2:70b' })).toMatchObject({
        issues: expect.any(Array),
      });
    });

    it('pullModel enum equals KEYLESS_MODEL_IDS (drift guard for the web-contracts copy)', () => {
      expect([...KeylessModelIdSchema.options]).toEqual([...KEYLESS_MODEL_IDS]);
    });
  });

  // -------------------------------------------------------------------------
  describe('namePersonality', () => {
    it('duplicates, marks the copy born, and reloads the registry', async () => {
      const { registry, duplicate } = makeRegistry(['researcher']);
      const { service, storage } = make({ registry });

      const out = await service.namePersonality({ sourceId: 'researcher', name: 'Sage' });

      expect(out).toEqual({ personalityId: 'sage' });
      expect(duplicate).toHaveBeenCalledWith('researcher', 'sage');
      expect(await hasBirthMarker(storage, DATA_DIR, 'sage')).toBe(true);
      expect(registry.loadFromDirectory).toHaveBeenCalledWith(join(DATA_DIR, 'personalities'));
    });

    it('slugs spaces to dashes', async () => {
      const { service } = make({});
      expect(
        await service.namePersonality({ sourceId: 'researcher', name: '  My Research Bot ' }),
      ).toEqual({ personalityId: 'my-research-bot' });
    });

    it('unknown source → 404 PERSONALITY_NOT_FOUND', async () => {
      const { service } = make({});
      await expectOrpc(
        service.namePersonality({ sourceId: 'nope', name: 'Sage' }),
        'PERSONALITY_NOT_FOUND',
        404,
      );
    });

    it('taken id → 409 PERSONALITY_EXISTS and no second duplicate', async () => {
      const { registry, duplicate } = makeRegistry(['researcher', 'sage']);
      const { service } = make({ registry });
      await expectOrpc(
        service.namePersonality({ sourceId: 'researcher', name: 'Sage' }),
        'PERSONALITY_EXISTS',
        409,
      );
      expect(duplicate).not.toHaveBeenCalled();
    });

    it.each(['../etc', '.hidden', 'a/b', 'a\\b'])('unsafe name %j → 400', async (name) => {
      const { registry, duplicate } = makeRegistry(['researcher']);
      const { service } = make({ registry });
      await expectOrpc(
        service.namePersonality({ sourceId: 'researcher', name }),
        'BAD_REQUEST',
        400,
      );
      expect(duplicate).not.toHaveBeenCalled();
    });

    it('a registry INVALID_INPUT also surfaces as 400', async () => {
      const { registry } = makeRegistry(['researcher']);
      vi.mocked(registry.duplicate).mockRejectedValueOnce(
        new EthosError({ code: 'INVALID_INPUT', cause: 'bad id', action: 'pick another' }),
      );
      const { service } = make({ registry });
      await expectOrpc(
        service.namePersonality({ sourceId: 'researcher', name: 'Sage' }),
        'BAD_REQUEST',
        400,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('funnel', () => {
    function realTracker(storage: InMemoryStorage) {
      let t = 1_000;
      const observability = {
        recordFunnelSetupCompleted: vi.fn(),
        recordFunnelFirstReply: vi.fn(),
        recordFunnelChannelFirstReply: vi.fn(),
      };
      const tracker = new FunnelTracker({
        storage,
        dataDir: DATA_DIR,
        observability: observability as never,
        now: () => (t += 1_000),
      });
      return tracker;
    }

    it('state() on a missing config stamps firstLaunchAt once', async () => {
      const storage = new InMemoryStorage();
      const tracker = realTracker(storage);
      const { service } = make({ funnel: tracker, storage });

      expect((await service.state()).step).toBe('welcome');
      const first = (await tracker.readState())?.firstLaunchAt;
      expect(first).toBeTypeOf('number');
      await service.state();
      await service.probe().catch(() => {});
      expect((await tracker.readState())?.firstLaunchAt).toBe(first);
    });

    it('state() with a config present does not stamp', async () => {
      const storage = new InMemoryStorage();
      const tracker = realTracker(storage);
      const { service } = make({ funnel: tracker, storage, config: done });
      await service.state();
      expect(await tracker.readState()).toBeNull();
    });

    it('complete() forwards keylessPath to the funnel', async () => {
      const storage = new InMemoryStorage();
      const tracker = realTracker(storage);
      const { service } = make({ funnel: tracker, storage, config: null });
      await service.complete({
        provider: 'ollama',
        model: 'llama3.2',
        baseUrl: 'http://127.0.0.1:11434/v1',
        personalityId: 'researcher',
        keylessPath: 'local',
      });
      const state = await tracker.readState();
      expect(state?.keylessPath).toBe('local');
      expect(state?.setupProvider).toBe('ollama');
    });

    it('a funnel failure never fails the RPC', async () => {
      const funnel = {
        recordFirstLaunch: vi.fn(async () => {
          throw new Error('disk full');
        }),
        recordSetupCompleted: vi.fn(async () => {
          throw new Error('disk full');
        }),
      };
      const { service } = make({ funnel });
      await expect(service.state()).resolves.toMatchObject({ step: 'welcome' });
      await expect(
        service.complete({ provider: 'ollama', model: 'm', personalityId: 'researcher' }),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('D11: web-api never installs', () => {
    it('the onboarding service has no child_process / spawn path', async () => {
      const src = await readFile(join(import.meta.dirname, '..', 'onboarding.service.ts'), 'utf8');
      expect(src).not.toMatch(/child_process/);
      expect(src).not.toMatch(/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/);
    });
  });
});
