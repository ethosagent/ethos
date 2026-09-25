import type { InstalledPluginManifest } from '@ethosagent/plugin-loader';
import { describe, expect, it, vi } from 'vitest';
import { buildCredentialCheck } from '../credential-check';

// openclaw-9.5 item 1 — the wiring-built pre-turn credential check.

function manifest(
  id: string,
  credentials: InstalledPluginManifest['credentials'],
  extra: Partial<InstalledPluginManifest> = {},
): InstalledPluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    source: 'user',
    path: `/plugins/${id}`,
    pluginContractMajor: 1,
    dialect: 'ethos',
    credentials,
    dataSources: [],
    hasWidgets: false,
    status: 'loaded',
    ...extra,
  } as InstalledPluginManifest;
}

function loaderWith(
  manifests: InstalledPluginManifest[],
  vault: Record<string, string>,
  opts: { throwFor?: string; unloaded?: string[] } = {},
) {
  return {
    listManifests: () => manifests,
    isLoaded: (id: string) => !(opts.unloaded ?? []).includes(id),
    getCredentialValue: vi.fn(async (pluginId: string, key: string) => {
      if (opts.throwFor === `${pluginId}/${key}`) throw new Error('vault unreadable');
      return vault[`${pluginId}/${key}`] ?? null;
    }),
  };
}

const SCOPE = (allowedPlugins: string[]) => ({ personalityId: 'ops', allowedPlugins });

describe('buildCredentialCheck', () => {
  it('a required + missing secret is a miss, mapped to api_key', async () => {
    const check = buildCredentialCheck({
      pluginLoader: loaderWith(
        [
          manifest('weather', [
            {
              key: 'API_KEY',
              label: 'Weather API key',
              type: 'secret',
              required: true,
              description: 'From the dashboard',
            },
          ]),
        ],
        {},
      ),
    });
    await expect(check('k', 'msg', SCOPE(['weather']))).resolves.toEqual({
      pluginId: 'weather',
      credentialKey: 'API_KEY',
      kind: 'api_key',
      label: 'Weather API key',
      description: 'From the dashboard',
    });
  });

  it('a required + missing text declaration maps to text', async () => {
    const check = buildCredentialCheck({
      pluginLoader: loaderWith(
        [manifest('crm', [{ key: 'TENANT', label: 'Tenant id', type: 'text', required: true }])],
        {},
      ),
    });
    await expect(check('k', 'msg', SCOPE(['crm']))).resolves.toMatchObject({ kind: 'text' });
  });

  it('an optional missing credential is not a miss', async () => {
    const check = buildCredentialCheck({
      pluginLoader: loaderWith(
        [manifest('weather', [{ key: 'API_KEY', label: 'k', type: 'secret' }])],
        {},
      ),
    });
    await expect(check('k', 'msg', SCOPE(['weather']))).resolves.toBeNull();
  });

  it('a present required credential is not a miss', async () => {
    const check = buildCredentialCheck({
      pluginLoader: loaderWith(
        [manifest('weather', [{ key: 'API_KEY', label: 'k', type: 'secret', required: true }])],
        { 'weather/API_KEY': 'sk-present' },
      ),
    });
    await expect(check('k', 'msg', SCOPE(['weather']))).resolves.toBeNull();
  });

  it('a plugin outside the personality never refuses its turn, and is never read', async () => {
    const loader = loaderWith(
      [manifest('weather', [{ key: 'API_KEY', label: 'k', type: 'secret', required: true }])],
      {},
    );
    const check = buildCredentialCheck({ pluginLoader: loader });
    await expect(check('k', 'msg', SCOPE(['other']))).resolves.toBeNull();
    await expect(check('k', 'msg', SCOPE([]))).resolves.toBeNull();
    expect(loader.getCredentialValue).not.toHaveBeenCalled();
  });

  it('a failed or unloaded plugin is skipped', async () => {
    const decl = [{ key: 'API_KEY', label: 'k', type: 'secret' as const, required: true }];
    const check = buildCredentialCheck({
      pluginLoader: loaderWith(
        [manifest('broken', decl, { status: 'failed' }), manifest('gone', decl)],
        {},
        { unloaded: ['gone'] },
      ),
    });
    await expect(check('k', 'msg', SCOPE(['broken', 'gone']))).resolves.toBeNull();
  });

  it('a vault throw fails open: null plus an observability event, no value logged', async () => {
    const recordError = vi.fn();
    const warn = vi.fn();
    const check = buildCredentialCheck({
      pluginLoader: loaderWith(
        [manifest('weather', [{ key: 'API_KEY', label: 'k', type: 'secret', required: true }])],
        {},
        { throwFor: 'weather/API_KEY' },
      ),
      observability: { recordError },
      logger: { warn },
    });
    await expect(check('k', 'msg', SCOPE(['weather']))).resolves.toBeNull();
    expect(recordError).toHaveBeenCalledWith({
      severity: 'warn',
      code: 'plugin.credential_check_failed',
      cause: 'vault unreadable',
      details: { pluginId: 'weather', credentialKey: 'API_KEY' },
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('a throw on one plugin does not hide a real miss on the next', async () => {
    const decl = [{ key: 'API_KEY', label: 'k', type: 'secret' as const, required: true }];
    const check = buildCredentialCheck({
      pluginLoader: loaderWith(
        [manifest('a', decl), manifest('b', decl)],
        {},
        {
          throwFor: 'a/API_KEY',
        },
      ),
      observability: { recordError: vi.fn() },
    });
    await expect(check('k', 'msg', SCOPE(['a', 'b']))).resolves.toMatchObject({ pluginId: 'b' });
  });
});
