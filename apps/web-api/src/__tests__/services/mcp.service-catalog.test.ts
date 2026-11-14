import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { LoginSlots, McpDeviceLogin } from '@ethosagent/tools-mcp';
import {
  type McpInstallFlow,
  McpJsonStore,
  type McpManager,
  OAuthIssuerMismatch,
} from '@ethosagent/tools-mcp';
import type { Logger } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { McpService } from '../../services/mcp.service';

describe('McpService.catalog', () => {
  function makeService(): McpService {
    const storage = new InMemoryStorage();
    const mcpManager = {} as unknown as McpManager;
    return new McpService({
      mcpManager,
      personalityUpdater: { get: () => undefined, update: async () => undefined },
      secrets: new InMemorySecretsResolver(),
      mcpJsonStore: new McpJsonStore(storage),
      redirectUri: 'http://localhost/oauth/callback',
    });
  }

  it('returns both preset arrays', () => {
    const catalog = makeService().catalog();
    expect(Array.isArray(catalog.remote)).toBe(true);
    expect(Array.isArray(catalog.local)).toBe(true);
  });

  it('includes linear in remote with its widened fields', () => {
    const linear = makeService()
      .catalog()
      .remote.find((p) => p.name === 'linear');
    expect(linear).toMatchObject({
      name: 'linear',
      label: 'Linear',
      url: 'https://mcp.linear.app/mcp',
      transport: 'streamable-http',
      authType: 'oauth',
      category: 'Productivity',
    });
    expect(linear?.description.length).toBeGreaterThan(0);
  });

  it('includes all four stdio presets in local, each with a category', () => {
    const local = makeService().catalog().local;
    const names = local.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['filesystem', 'git', 'fetch', 'memory']));
    // sqlite was removed from the preset table: archived upstream, Python-only,
    // and the npm package it named has never existed.
    expect(names).not.toContain('sqlite');
    for (const preset of local) {
      expect(preset.category.length).toBeGreaterThan(0);
    }
  });

  it('carries each preset argVars through to the browser', () => {
    const local = makeService().catalog().local;
    for (const preset of local) {
      expect(Array.isArray(preset.argVars)).toBe(true);
    }
    expect(local.find((p) => p.name === 'filesystem')?.argVars).toEqual(['ALLOWED_PATH']);
    expect(local.find((p) => p.name === 'memory')?.argVars).toEqual([]);
  });

  it('orders both arrays deterministically across calls', () => {
    const service = makeService();
    const first = service.catalog();
    const second = service.catalog();
    expect(first.remote.map((p) => p.name)).toEqual(second.remote.map((p) => p.name));
    expect(first.local.map((p) => p.name)).toEqual(second.local.map((p) => p.name));
    expect(first.local.map((p) => p.name)).toEqual([...first.local.map((p) => p.name)].sort());
  });
});

describe('McpService.complete — RFC 9207 iss', () => {
  function makeService() {
    const service = new McpService({
      mcpManager: {} as unknown as McpManager,
      personalityUpdater: { get: () => undefined, update: async () => undefined },
      secrets: new InMemorySecretsResolver(),
      mcpJsonStore: new McpJsonStore(new InMemoryStorage()),
      redirectUri: 'http://default.fallback/oauth/callback',
    });
    const flowComplete = vi.fn(async () => ({ serverName: 'srv' }));
    (service as unknown as { flow: Pick<McpInstallFlow, 'complete'> }).flow = {
      complete: flowComplete as unknown as McpInstallFlow['complete'],
    };
    return { service, flowComplete };
  }

  it('complete forwards iss and maps OAuthIssuerMismatch to issuer_mismatch', async () => {
    const { service, flowComplete } = makeService();

    await expect(
      service.complete({ code: 'c', state: 's', iss: 'https://auth.example.com' }, 's'),
    ).resolves.toEqual({ ok: true, serverName: 'srv' });
    expect(flowComplete).toHaveBeenCalledWith({
      code: 'c',
      state: 's',
      iss: 'https://auth.example.com',
    });

    // Without iss the key is omitted, so behaviour is unchanged for old callers.
    await service.complete({ code: 'c', state: 's' }, 's');
    expect(flowComplete).toHaveBeenLastCalledWith({ code: 'c', state: 's' });

    flowComplete.mockRejectedValueOnce(
      new OAuthIssuerMismatch(
        'https://auth.example.com',
        'https://evil.example',
        'Authorization response came from https://evil.example, expected https://auth.example.com',
      ),
    );
    await expect(
      service.complete({ code: 'c', state: 's', iss: 'https://evil.example' }, 's'),
    ).resolves.toEqual({
      ok: false,
      code: 'issuer_mismatch',
      detail:
        'Authorization response came from https://evil.example, expected https://auth.example.com',
    });
  });
});

describe('McpService device sign-in', () => {
  function makeService() {
    const service = new McpService({
      mcpManager: {} as unknown as McpManager,
      personalityUpdater: { get: () => undefined, update: async () => undefined },
      secrets: new InMemorySecretsResolver(),
      mcpJsonStore: new McpJsonStore(new InMemoryStorage()),
      redirectUri: 'http://default.fallback/oauth/callback',
    });
    const inner = {
      start: vi.fn(),
      status: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    };
    (service as unknown as { deviceLogin: Partial<McpDeviceLogin> }).deviceLogin = inner;
    return { service, inner };
  }

  it('deviceStart returns the code once and status never echoes it', async () => {
    const { service, inner } = makeService();
    inner.start.mockResolvedValue({
      ok: true,
      flowId: 'flow-0123456789abcdef',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.example/device',
      expiresAt: Date.UTC(2026, 9, 18, 7, 5),
      serverName: 'granola',
      serverHost: 'mcp.example',
      authHost: 'auth.example',
      personalityId: 'researcher',
    });
    inner.status.mockReturnValue({ status: 'pending', serverName: 'granola' });

    const started = await service.deviceStart({
      serverName: 'granola',
      personalityId: 'researcher',
    });
    expect(inner.start).toHaveBeenCalledWith({
      serverName: 'granola',
      personalityId: 'researcher',
      surface: 'web',
    });
    expect(started).toMatchObject({
      ok: true,
      userCode: 'ABCD-EFGH',
      expiresAt: '2026-10-18T07:05:00.000Z',
    });
    expect(JSON.stringify(service.deviceStatus('flow-0123456789abcdef'))).not.toContain('ABCD');
  });

  it('device_refused passes the RFC code through', async () => {
    const { service, inner } = makeService();
    inner.start.mockResolvedValue({
      ok: false,
      code: 'device_refused',
      detail: 'unauthorized_client',
    });
    expect(await service.deviceStart({ serverName: 'vercel' })).toEqual({
      ok: false,
      code: 'device_refused',
      detail: 'unauthorized_client',
    });
  });

  it('deviceCancel is idempotent', () => {
    const { service, inner } = makeService();
    expect(service.deviceCancel('flow-0123456789abcdef')).toEqual({ ok: true });
    expect(service.deviceCancel('flow-0123456789abcdef')).toEqual({ ok: true });
    expect(inner.cancel).toHaveBeenCalledTimes(2);
  });
});

describe('McpService audit logger', () => {
  it('hands the host logger to the device login so mcp.oauth.login reaches it', () => {
    const info = vi.fn();
    const logger: Logger = {
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
    };
    const service = new McpService({
      mcpManager: {} as unknown as McpManager,
      personalityUpdater: { get: () => undefined, update: async () => undefined },
      secrets: new InMemorySecretsResolver(),
      mcpJsonStore: new McpJsonStore(new InMemoryStorage()),
      redirectUri: 'http://default.fallback/oauth/callback',
      logger,
    });
    const { slots } = (service as unknown as { deviceLogin: { slots: LoginSlots } }).deviceLogin;
    const reserved = slots.reserve({ serverName: 'demo', surface: 'web', kind: 'device' });
    if (!reserved.ok) throw new Error('reserve failed');
    slots.started(reserved.slot);
    slots.cancel(reserved.slot.flowId);
    expect(info).toHaveBeenCalledWith(
      'mcp.oauth.login',
      expect.objectContaining({ event: 'mcp.oauth.login', outcome: 'started', surface: 'web' }),
    );
  });
});
