// Plan plugin-process-isolation §9.1: the malicious fixture. The parent state
// dir holds a vault with another personality's token, a provider key and
// another plugin's token; the parent env holds a provider key, a dotenv-loaded
// name and SSH_AUTH_SOCK. The fixture's tool reports what it managed to reach.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DefaultHookRegistry, DefaultToolRegistry } from '@ethosagent/core';
import { PluginApiImpl, type PluginRegistries } from '@ethosagent/plugin-sdk';
import {
  defaultAlwaysDeny,
  FileSecretsResolver,
  FsStorage,
  ScopedStorage,
} from '@ethosagent/storage-fs';
import type { Tool, ToolContext } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginActivator } from '../activator';
import { buildHostEnv } from '../env';
import { HOST_ERROR } from '../errors';
import { authorizeSecretRef } from '../secrets';
import { eventsOf, fixtureDir, type Harness, makeCtx, makeHarness } from './helpers/harness';

const SLOW = 30_000;
const ANTHROPIC = 'sk-ant-api03-parent-only-0123456789abcdef';
const OTHER_TOKEN = 'linear-token-of-another-personality';
const VICTIM_TOKEN = 'victim-plugin-token';

const ENV_SEED = {
  ANTHROPIC_API_KEY: ANTHROPIC,
  MAL_DOTENV_VALUE: 'dotenv-loaded-value',
  ETHOS_DOTENV_KEYS: 'MAL_DOTENV_VALUE',
  SSH_AUTH_SOCK: '/tmp/parent-agent.sock',
};

interface Probe {
  ok: boolean;
  value?: unknown;
  error?: string;
}

const savedEnv: Record<string, string | undefined> = {};
let h: Harness;
let tools: DefaultToolRegistry;
let vaultDir: string;
let calls = 0;

function parentCtx(): ToolContext {
  return {
    ...makeCtx(),
    // The call's own ScopedStorage: reach is the data dir, the deny floor applies on top.
    storage: new ScopedStorage(new FsStorage(), {
      read: [h.dataDir],
      write: [h.dataDir],
      alwaysDeny: defaultAlwaysDeny([h.dataDir]),
    }),
  };
}

/** Runs the fixture tool through the PARENT registry, so capabilities are the clamped ones. */
async function run(action: string, arg?: string, ctx: ToolContext = parentCtx()): Promise<unknown> {
  const [out] = await tools.executeParallel(
    [
      {
        toolCallId: `call-${++calls}`,
        name: 'mal_probe',
        args: { action, ...(arg ? { arg } : {}) },
      },
    ],
    ctx,
  );
  const result = out?.result;
  if (!result?.ok) {
    throw new Error(`mal_probe ${action} failed: ${result ? result.error : 'no result'}`);
  }
  const text = result.value;
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as unknown;
}

const dataSecret = (ref: string): string => join(h?.dataDir ?? '', 'secrets', ref);

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_SEED)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  h = await makeHarness();
  vaultDir = join(h.dataDir, 'secrets');
  const vault = new FileSecretsResolver({ dir: vaultDir, storage: new FsStorage() });
  await vault.set('personalities/other/mcp/linear/access_token', OTHER_TOKEN);
  await vault.set('providers/anthropic/apiKey', ANTHROPIC);
  await vault.set('plugins/victim/token', VICTIM_TOKEN);
  await vault.set('plugins/malicious/own', 'own-secret');

  tools = new DefaultToolRegistry({
    secretsBackend: async (ref) => {
      const value = await vault.get(ref);
      if (value === null) throw new Error(`secret '${ref}' is not set`);
      return value;
    },
  });
  // A built-in that exists before any plugin loads.
  tools.register({
    name: 'read_file',
    description: 'built-in',
    schema: { type: 'object', properties: {} },
    capabilities: {},
    execute: async () => ({ ok: true, value: 'builtin' }),
  } satisfies Tool);

  const registries: PluginRegistries = {
    tools,
    hooks: new DefaultHookRegistry(),
    injectors: [],
    injectorPluginIds: new Map(),
    personalities: {} as never,
    llmProviders: {} as never,
    memoryProviders: {} as never,
  };
  const activator = createPluginActivator(h.pool, {
    tools,
    secretKeys: async () => ['own'],
  });
  const plugin = await activator.activate({
    id: 'malicious',
    dir: fixtureDir('malicious'),
    entry: '',
    manifest: {},
    tier: 'untrusted',
  });
  plugin.activate(
    new PluginApiImpl('malicious', registries, {
      secrets: vault,
      storage: new FsStorage(),
      basePath: join(h.dataDir, 'plugins', 'malicious'),
    }),
  );
}, SLOW);

afterAll(async () => {
  await h?.cleanup();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('isolation boundary (plan §9.1)', () => {
  it(
    'api.secrets / api.registries give the vault and the parent registries to nothing',
    async () => {
      const out = (await run('introspect')) as Record<string, unknown>;
      // The registries the plugin sees are the host's own; the parent's built-in is not in them.
      expect(out.parentToolVisible).not.toBe(true);
      // Only this plugin's own key NAMES (D19) come back, rebuilt under its own prefix.
      expect(out.listed).toEqual({ ok: true, value: ['plugins/malicious/own'] });
      const foreign = out.foreign as Probe;
      expect(foreign.ok).toBe(false);
      expect(foreign.error).toContain(HOST_ERROR.secretDenied);
      expect(JSON.stringify(out)).not.toContain(OTHER_TOKEN);
    },
    SLOW,
  );

  it(
    'a plugin reads its OWN secret through the parent PluginApiImpl (positive control)',
    async () => {
      expect(await run('api_secret_get', 'plugins/malicious/own')).toEqual({
        ok: true,
        value: 'own-secret',
      });
      expect(await run('ctx_secret_get', 'plugins/malicious/own')).toEqual({
        ok: true,
        value: 'own-secret',
      });
    },
    SLOW,
  );

  it(
    'secrets.get(personalities/other/mcp/linear/access_token) through the stub -> PLUGIN_HOST_SECRET_DENIED + plugin_host.denied',
    async () => {
      const ref = 'personalities/other/mcp/linear/access_token';
      const deniedFor = (): number =>
        eventsOf(h, 'plugin_host.denied').filter(
          (e) => e.payload.kind === 'secret' && e.payload.ref === ref,
        ).length;
      const before = deniedFor();
      const out = (await run('api_secret_get', ref)) as Probe;
      expect(out.ok).toBe(false);
      expect(out.error).toContain(HOST_ERROR.secretDenied);
      expect(out.error).not.toContain(OTHER_TOKEN);
      expect(deniedFor()).toBe(before + 1);
      expect(
        eventsOf(h, 'plugin_host.denied').find((e) => e.payload.ref === ref)?.payload.plugin_id,
      ).toBe('malicious');
      expect(JSON.stringify(h.events)).not.toContain(OTHER_TOKEN);
    },
    SLOW,
  );

  it(
    "another plugin's plugins/victim/token -> denied",
    async () => {
      const out = (await run('api_secret_get', 'plugins/victim/token')) as Probe;
      expect(out.ok).toBe(false);
      expect(out.error).toContain(HOST_ERROR.secretDenied);
      expect(JSON.stringify(out)).not.toContain(VICTIM_TOKEN);
      // A traversal-shaped ref that starts with the plugin's own prefix is refused too.
      const sneaky = (await run('api_secret_get', 'plugins/malicious/../victim/token')) as Probe;
      expect(sneaky.ok).toBe(false);
      expect(sneaky.error).toContain(HOST_ERROR.secretDenied);
    },
    SLOW,
  );

  it(
    "capabilities.secrets: ['providers/*'] is clamped: ctx.secretsResolver.get('providers/anthropic/apiKey') fails, and a capability_clamped event is recorded",
    async () => {
      const proxy = tools.get('mal_probe');
      expect(proxy?.capabilities.secrets).toEqual(['plugins/malicious/own']);
      expect(proxy?.capabilities.process).toBeUndefined();
      const out = (await run('ctx_secret_get', 'providers/anthropic/apiKey')) as Probe;
      expect(out.ok).toBe(false);
      expect(JSON.stringify(out)).not.toContain(ANTHROPIC);
      const clamped = eventsOf(h, 'plugin_host.capability_clamped');
      expect(clamped.map((e) => e.payload)).toContainEqual({
        plugin_id: 'malicious',
        tool: 'mal_probe',
        capability: 'secrets',
        dropped: ['providers/*', 'providers/anthropic/apiKey'],
      });
      // `process` never reaches the proxy at all: `parseCapabilities` (registration-parse.ts) does not
      // carry it over the wire, and `clampToolCapabilities` removes it if it ever did (proxies.test.ts).
      expect(proxy?.capabilities.process).toBeUndefined();
    },
    SLOW,
  );

  it(
    'process.env has none of ANTHROPIC_API_KEY, the dotenv name or SSH_AUTH_SOCK; HOME is the host home',
    async () => {
      const env = (await run('env')) as Record<string, unknown>;
      expect(env.anthropic).toBeNull();
      expect(env.dotenv).toBeNull();
      expect(env.ssh).toBeNull();
      expect(env.nodeOptions).toBeNull();
      expect(env.marker).toBe('1');
      expect(env.home).toBe(join(h.dataDir, 'plugin-hosts', 'malicious', 'home'));
      expect(JSON.stringify(env)).not.toContain(ANTHROPIC);
      expect(JSON.stringify(env)).not.toContain('dotenv-loaded-value');
      expect(env.keys).not.toContain('ANTHROPIC_API_KEY');
    },
    SLOW,
  );

  it(
    'ctx.storage read of <dataDir>/secrets/... -> a BoundaryError tool error',
    async () => {
      const out = (await run('storage_read', dataSecret('plugins/victim/token'))) as Probe;
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/not permitted/);
      expect(JSON.stringify(out)).not.toContain(VICTIM_TOKEN);
    },
    SLOW,
  );

  it(
    'a capability call on a handle kept after its call returned -> PLUGIN_HOST_HANDLE_REVOKED',
    async () => {
      await run('keep_ctx');
      const out = (await run('use_kept_ctx', join(h.dataDir, 'anything'))) as Probe;
      expect(out.ok).toBe(false);
      expect(out.error).toContain(HOST_ERROR.handleRevoked);
      expect(eventsOf(h, 'plugin_host.denied').some((e) => e.payload.kind === 'handle')).toBe(true);
    },
    SLOW,
  );

  it(
    'a forged response frame for an id the parent never issued is dropped',
    async () => {
      const before = h.pool.entry('malicious')?.connectionStats?.strayResponses ?? 0;
      await run('forge_frame');
      expect(h.pool.entry('malicious')?.connectionStats?.strayResponses).toBe(before + 1);
      // The host was not killed and keeps answering.
      expect((await run('env')) as Record<string, unknown>).toMatchObject({ marker: '1' });
    },
    SLOW,
  );

  it(
    "patching globalThis.fetch in the host leaves the parent's fetch unchanged",
    async () => {
      const parentFetch = globalThis.fetch;
      const out = (await run('patch_fetch')) as Record<string, unknown>;
      expect(out.patched).toBe('patched-in-host');
      expect(globalThis.fetch).toBe(parentFetch);
    },
    SLOW,
  );

  it(
    'LIMITATION (D6) - unsandboxed: a raw readFileSync of the vault file SUCCEEDS',
    async () => {
      // Same uid, plain-text vault file, no sandbox: env scrubbing and the IPC boundary do not stop
      // this. A future sandbox-by-default change must flip THIS test on purpose (sandbox.test.ts has
      // the opposite assertion under `sandbox: auto`).
      const path = dataSecret('personalities/other/mcp/linear/access_token');
      expect(await readFile(path, 'utf8')).toContain(OTHER_TOKEN);
      const out = (await run('raw_read', path)) as Probe;
      expect(out.ok).toBe(true);
      expect(String(out.value)).toContain(OTHER_TOKEN);
    },
    SLOW,
  );
});

describe('a tool named like a built-in is refused at replay', () => {
  it(
    'fails the plugin load naming the tool, records plugin_host.denied kind registration, leaves the built-in alone',
    async () => {
      const local = await makeHarness({
        buildEnv: (ctx) => ({ ...buildHostEnv(ctx), MALICIOUS_SHADOW: '1' }),
      });
      try {
        const parentTools = new DefaultToolRegistry();
        const builtin: Tool = {
          name: 'read_file',
          description: 'built-in',
          schema: { type: 'object', properties: {} },
          capabilities: {},
          execute: async () => ({ ok: true, value: 'builtin' }),
        };
        parentTools.register(builtin);
        const plugin = await createPluginActivator(local.pool, { tools: parentTools }).activate({
          id: 'shadow',
          dir: fixtureDir('malicious'),
          entry: '',
          manifest: {},
          tier: 'untrusted',
        });
        const registries: PluginRegistries = {
          tools: parentTools,
          hooks: new DefaultHookRegistry(),
          injectors: [],
          injectorPluginIds: new Map(),
          personalities: {} as never,
          llmProviders: {} as never,
          memoryProviders: {} as never,
        };
        expect(() => plugin.activate(new PluginApiImpl('shadow', registries))).toThrow(/read_file/);
        expect(parentTools.get('read_file')).toBe(builtin);
        expect(
          eventsOf(local, 'plugin_host.denied').some(
            (e) => e.payload.kind === 'registration' && e.payload.ref === 'read_file',
          ),
        ).toBe(true);
        await plugin.deactivate?.();
      } finally {
        await local.cleanup();
      }
    },
    SLOW,
  );
});

describe('authorizeSecretRef (secrets.ts)', () => {
  it.each([
    ['plugins/a/token', 'get', true],
    ['plugins/a/token', 'set', true],
    ['plugins/a/', 'list', true],
    ['plugins/a/tok', 'list', true],
    ['plugins/b/token', 'get', false],
    ['plugins/ab/token', 'get', false],
    ['providers/anthropic/apiKey', 'get', false],
    ['plugins/a/../b/token', 'get', false],
    ['plugins/a/x/y', 'get', false],
    ['plugins/a/token', 'capability', true],
    ['personalities/other/mcp/linear/access_token', 'capability', false],
  ] as const)('%s (%s) -> %s', (ref, op, allowed) => {
    expect(authorizeSecretRef('a', ref, op)).toBe(allowed);
  });

  it('refuses everything for a plugin id that is not a plain path segment', () => {
    expect(authorizeSecretRef('../x', 'plugins/../x/token', 'get')).toBe(false);
    expect(authorizeSecretRef('', 'plugins//token', 'get')).toBe(false);
  });
});
