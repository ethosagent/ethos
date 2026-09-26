import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage, InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { isEthosError, type SecretsResolver } from '@ethosagent/types';
import { call } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { statusFor } from '../../middleware/error-envelope';
import { ConfigRepository } from '../../repositories/config.repository';
import { adminRouter } from '../../rpc/admin';
import type { RpcContext } from '../../rpc/context';
import { gatherAdminStatus } from '../../services/admin.service';
import { ConfigService } from '../../services/config.service';
import type { ValidateProviderInput } from '../../services/onboarding.service';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Admin RPC namespace — gated by `admin.enabled: true` in config.yaml
// (default false). Disabled → every procedure returns 403 FORBIDDEN;
// enabled → procedures behave normally. HTTP-level via Hono's
// `app.request(...)`, same pattern as auth-and-rpc.test.ts.

const BASE_CONFIG = ['provider: anthropic', 'model: claude-test', 'apiKey: sk-test-1234567890'];

describe('admin RPCs — gated by admin.enabled', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  async function boot(configLines: string[]): Promise<void> {
    await writeFile(join(dir, 'config.yaml'), `${configLines.join('\n')}\n`);
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;
    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    });
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    cookie = setCookie.split(/;\s*/)[0] ?? '';
    expect(cookie).toMatch(/ethos_auth=/);
  }

  async function rpcPost(path: string, input: unknown): Promise<Response> {
    return app.request(`/rpc/admin/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
      },
      body: JSON.stringify({ json: input }),
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-webapi-admin-'));
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('admin disabled (no admin.enabled key) → 403 on every admin procedure', async () => {
    await boot(BASE_CONFIG);
    const calls: Array<[string, unknown]> = [
      ['getStatus', {}],
      ['rotateKey', { provider: 'anthropic', key: 'sk-new' }],
      ['checkProvider', { provider: 'anthropic' }],
      ['testSend', { channel: 'telegram' }],
      ['addMcpServer', { name: 'srv', url: 'https://example.com/mcp', authType: 'none' }],
      ['removeMcpServer', { name: 'srv' }],
    ];
    for (const [path, input] of calls) {
      const res = await rpcPost(path, input);
      expect(res.status, `admin/${path}`).toBe(403);
      const body = (await res.json()) as { json?: { code?: string } };
      expect(body.json?.code, `admin/${path}`).toBe('FORBIDDEN');
    }
  });

  it('admin.enabled: false → still 403', async () => {
    await boot([...BASE_CONFIG, 'admin.enabled: false']);
    const res = await rpcPost('getStatus', {});
    expect(res.status).toBe(403);
  });

  it('admin.enabled: true → getStatus works', async () => {
    await boot([...BASE_CONFIG, 'admin.enabled: true']);
    const res = await rpcPost('getStatus', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      json: { channels: unknown[]; providers: unknown[]; mcpServers: unknown[] };
    };
    expect(Array.isArray(body.json.channels)).toBe(true);
    expect(Array.isArray(body.json.providers)).toBe(true);
    expect(Array.isArray(body.json.mcpServers)).toBe(true);
  });

  it('testSend on an unconfigured channel → honest not-configured error', async () => {
    await boot([...BASE_CONFIG, 'admin.enabled: true']);
    const res = await rpcPost('testSend', { channel: 'telegram' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { ok: boolean; error?: string } };
    expect(body.json.ok).toBe(false);
    expect(body.json.error).toContain('not configured');
  });

  it('testSend on a configured channel → honest no-transport error', async () => {
    await boot([...BASE_CONFIG, 'telegramToken: 1234:ABCDEF', 'admin.enabled: true']);
    const res = await rpcPost('testSend', { channel: 'telegram' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { ok: boolean; error?: string } };
    expect(body.json.ok).toBe(false);
    expect(body.json.error).toContain('No channel transport');
  });
});

describe('admin.checkProvider — resolved key reaches the validator', () => {
  function makeContext(overrides: {
    creds: { apiKey: string; baseUrl?: string } | null;
    onValidate: (input: ValidateProviderInput) => void;
  }): RpcContext {
    const stub = {
      config: {
        adminEnabled: async () => true,
        resolveProviderCredentials: async () => overrides.creds,
      },
      onboarding: {
        validateProvider: async (input: ValidateProviderInput) => {
          overrides.onValidate(input);
          return { ok: true, models: [], error: null, completionTested: true };
        },
      },
    };
    // Cast: the handler only touches `config` and `onboarding`; the full
    // RpcContext would drag in every service for a unit-level test.
    return stub as unknown as RpcContext;
  }

  it('passes the resolved stored key (and baseUrl) to validateProvider', async () => {
    const seen: ValidateProviderInput[] = [];
    const context = makeContext({
      creds: { apiKey: 'sk-resolved-key', baseUrl: 'https://example.com/v1' },
      onValidate: (input) => seen.push(input),
    });
    const result = await call(adminRouter.checkProvider, { provider: 'openai' }, { context });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.apiKey).toBe('sk-resolved-key');
    expect(seen[0]?.baseUrl).toBe('https://example.com/v1');
  });

  it('returns ok:false without probing when the provider is not configured', async () => {
    const seen: ValidateProviderInput[] = [];
    const context = makeContext({ creds: null, onValidate: (input) => seen.push(input) });
    const result = await call(adminRouter.checkProvider, { provider: 'openai' }, { context });
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

// F01 follow-up: rotateKey used to REPLACE the whole chain with one entry. It
// now goes through `ConfigService.rotateProviderKey`, which swaps the key on
// every matching entry (and the top-level key) and keeps everything else.
// Through `call` rather than HTTP: the refusal is an EthosError, which
// routes/rpc.ts turns into `statusFor(code)` — pinned by the last assertion.
describe('admin.rotateKey — one provider key, the rest of the chain untouched', () => {
  const CHAIN = [
    'providers.0.provider: anthropic',
    'providers.1.provider: bedrock',
    'providers.1.region: eu-west-1',
    'providers.1.fooBar: keep-me',
    'providers.2.provider: azure',
    'providers.2.apiVersion: 2024-10-21',
  ];

  async function setup() {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const dataDir = '/data';
    await storage.mkdir(dataDir);
    await storage.write(
      join(dataDir, 'config.yaml'),
      `${[...BASE_CONFIG, ...CHAIN, 'admin.enabled: true'].join('\n')}\n`,
    );
    const config = new ConfigService({
      config: new ConfigRepository({ dataDir, storage, secrets }),
      secrets,
    });
    // Cast: the handler only touches `config`.
    const context = { config } as unknown as RpcContext;
    const read = async () => (await storage.read(join(dataDir, 'config.yaml'))) ?? '';
    return { context, read, secrets };
  }

  it('keeps every other chain line and stores the key in the vault', async () => {
    const { context, read } = await setup();
    const result = await call(
      adminRouter.rotateKey,
      { provider: 'bedrock', key: 'bedrock-rotated-9876543210' },
      { context },
    );
    expect(result.ok).toBe(true);

    const yaml = await read();
    for (const line of CHAIN) expect(yaml).toContain(line);
    expect(yaml).toMatch(/^providers\.1\.apiKey: "\$\{secrets:[^}]+\}"$/m);
    expect(yaml).not.toContain('bedrock-rotated-9876543210');
  });

  it('refuses a provider nothing is configured for with a 400, config untouched', async () => {
    const { context, read } = await setup();
    const before = await read();

    const err = await call(
      adminRouter.rotateKey,
      { provider: 'mistral', key: 'sk-new' },
      { context },
    ).catch((e: unknown) => e);
    expect(isEthosError(err) && err.code).toBe('INVALID_INPUT');
    expect(statusFor('INVALID_INPUT')).toBe(400);
    expect(await read()).toBe(before);
  });
});

// `rotateProviderKey` accepts the top-level provider and its refusal points at
// `admin.getStatus`, so the status has to list it: with fewer than two chain
// entries the runtime runs on the top-level fields (`createLLM`).
describe('admin.getStatus — the effective provider roster', () => {
  function deps(config: unknown) {
    // Cast: `gatherAdminStatus` guards every section it can; `execution` is the
    // one it deliberately does not, so the stub answers that one.
    return {
      config,
      execution: { backendHealth: async () => null },
    } as unknown as Parameters<typeof gatherAdminStatus>[0];
  }

  it('reports the top-level provider when the chain has fewer than two entries', async () => {
    const status = await gatherAdminStatus(
      deps({
        get: async () => ({ provider: 'anthropic', apiKeyPreview: 'sk-…abc1', providers: [] }),
      }),
    );
    expect(status.providers).toEqual([{ id: 'anthropic', name: 'anthropic', hasKey: true }]);
  });

  it('reports the chain when it is what the runtime uses', async () => {
    const status = await gatherAdminStatus(
      deps({
        get: async () => ({
          provider: 'anthropic',
          apiKeyPreview: 'sk-…abc1',
          providers: [
            { provider: 'openai', apiKeyPreview: 'sk-…1234' },
            { provider: 'bedrock', apiKeyPreview: '<unset>' },
          ],
        }),
      }),
    );
    expect(status.providers.map((p) => p.id)).toEqual(['openai', 'bedrock']);
  });
});

describe('ConfigService — adminEnabled + resolveProviderCredentials', () => {
  async function makeService(
    yaml: string,
    secretValues: Record<string, string> = {},
  ): Promise<ConfigService> {
    const storage = new InMemoryStorage();
    const dataDir = '/data';
    const secrets: SecretsResolver = {
      get: async (ref) => secretValues[ref] ?? null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const repo = new ConfigRepository({ dataDir, storage, secrets });
    await storage.mkdir(dataDir);
    await storage.write(join(dataDir, 'config.yaml'), yaml);
    return new ConfigService({ config: repo, secrets });
  }

  it('adminEnabled is false by default and true only with admin.enabled: true', async () => {
    const off = await makeService('provider: anthropic\napiKey: sk-x\n');
    expect(await off.adminEnabled()).toBe(false);

    const on = await makeService('provider: anthropic\napiKey: sk-x\nadmin.enabled: true\n');
    expect(await on.adminEnabled()).toBe(true);
  });

  it('get() reports adminEnabled from config (no longer hardcoded)', async () => {
    const service = await makeService('provider: anthropic\napiKey: sk-x\n');
    expect((await service.get()).adminEnabled).toBe(false);
  });

  it('resolves secret-ref indirection in stored provider keys', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config syntax, not a template
    const service = await makeService('provider: anthropic\napiKey: "${secrets:anthropic/key}"\n', {
      'anthropic/key': 'sk-from-secrets',
    });
    const creds = await service.resolveProviderCredentials('anthropic');
    expect(creds?.apiKey).toBe('sk-from-secrets');
  });

  it('prefers the provider-chain entry over the primary fields', async () => {
    const service = await makeService(
      [
        'provider: anthropic',
        'apiKey: sk-primary',
        'providers.0.provider: openrouter',
        'providers.0.apiKey: sk-chain',
        'providers.0.baseUrl: https://openrouter.ai/api/v1',
      ].join('\n'),
    );
    const creds = await service.resolveProviderCredentials('openrouter');
    expect(creds).toEqual({ apiKey: 'sk-chain', baseUrl: 'https://openrouter.ai/api/v1' });
    const primary = await service.resolveProviderCredentials('anthropic');
    expect(primary?.apiKey).toBe('sk-primary');
  });

  it('returns null for an unconfigured provider', async () => {
    const service = await makeService('provider: anthropic\napiKey: sk-x\n');
    expect(await service.resolveProviderCredentials('ollama')).toBeNull();
  });
});
