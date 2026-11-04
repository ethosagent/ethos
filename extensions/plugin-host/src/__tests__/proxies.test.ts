import { DefaultHookRegistry, DefaultToolRegistry } from '@ethosagent/core';
import { PluginApiImpl, type PluginRegistries } from '@ethosagent/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginActivator } from '../activator';
import type { HostLease } from '../pool';
import { createToolProxy } from '../proxies/tool';
import {
  callTool,
  eventsOf,
  fixtureDir,
  type Harness,
  isAlive,
  makeCtx,
  makeHarness,
  waitFor,
} from './helpers/harness';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const SLOW = 30_000;

function parentRegistries(): {
  registries: PluginRegistries;
  tools: DefaultToolRegistry;
  hooks: DefaultHookRegistry;
} {
  const tools = new DefaultToolRegistry();
  const hooks = new DefaultHookRegistry();
  const registries: PluginRegistries = {
    tools,
    hooks,
    injectors: [],
    injectorPluginIds: new Map(),
    personalities: {} as never,
    llmProviders: {} as never,
    memoryProviders: {} as never,
  };
  return { registries, tools, hooks };
}

async function activate(harness: Harness, id: string, fixture: string) {
  const activator = createPluginActivator(harness.pool);
  const plugin = await activator.activate({
    id,
    dir: fixtureDir(fixture),
    entry: '',
    manifest: {},
    tier: 'untrusted',
  });
  const parent = parentRegistries();
  await plugin.activate(new PluginApiImpl(id, parent.registries));
  return { plugin, ...parent };
}

describe('tool proxy', () => {
  it(
    'copies name, schema, toolset and limits; forces untrusted output; drops alwaysInclude',
    async () => {
      h = await makeHarness();
      const { tools } = await activate(h, 'echo', 'echo');
      const echo = tools.get('echo');
      expect(echo).toMatchObject({
        name: 'echo',
        description: 'Echo the text argument',
        toolset: 'fixture',
        outputIsUntrusted: true,
      });
      expect(echo?.alwaysInclude).toBeUndefined();
      expect(tools.getPluginId('echo')).toBe('echo');
      expect(echo?.isAvailable?.()).toBe(true);
      expect(tools.get('echo_unavailable')?.isAvailable?.()).toBe(false);
      expect(await echo?.execute({ text: 'through the proxy' }, makeCtx())).toEqual({
        ok: true,
        value: 'through the proxy',
      });
      expect(await tools.get('echo_throw')?.execute({}, makeCtx())).toEqual({
        ok: false,
        code: 'execution_failed',
        error: 'boom',
      });
    },
    SLOW,
  );

  it('keeps only secret refs inside plugins/<id>/ and reports what it dropped', () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const lease = {
      pluginId: 'acme',
      emitEvent: (c: string, p: Record<string, unknown>) => void events.push([c, p]),
      isToolAvailable: () => true,
    } as unknown as HostLease;
    const tool = createToolProxy(
      {
        kind: 'tool',
        name: 't',
        description: '',
        schema: {},
        available: true,
        capabilities: { secrets: ['plugins/acme/key', 'providers/anthropic/*'] },
      },
      lease,
    );
    expect(tool.capabilities.secrets).toEqual(['plugins/acme/key']);
    expect(events).toEqual([
      [
        'plugin_host.capability_clamped',
        { plugin_id: 'acme', tool: 't', dropped: ['providers/anthropic/*'] },
      ],
    ]);
  });

  it(
    'a tool the plugin is not allowed to see through the personality gate stays gated by plugin id',
    async () => {
      h = await makeHarness();
      const { tools } = await activate(h, 'echo', 'echo');
      expect(
        tools.toDefinitions(undefined, { allowedPlugins: ['other'] }).map((d) => d.name),
      ).not.toContain('echo');
      expect(
        tools.toDefinitions(undefined, { allowedPlugins: ['echo'] }).map((d) => d.name),
      ).toContain('echo');
    },
    SLOW,
  );

  it(
    'deactivate releases the lease but leaves the host to the pool',
    async () => {
      h = await makeHarness();
      const { plugin } = await activate(h, 'echo', 'echo');
      expect(h.pool.leasesOf('echo')).toBe(1);
      const pid = h.pool.pidOf('echo');
      await plugin.deactivate?.();
      expect(h.pool.leasesOf('echo')).toBe(0);
      expect(isAlive(pid)).toBe(true);
    },
    SLOW,
  );

  it(
    'ctx.storage in a hosted tool reaches the parent as ethos/capability.storage (answered by lane C)',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      const result = await callTool(lease, 'echo_storage', { path: '/etc/hostname' });
      // No capability server is wired in this lane, so the parent answers method-not-found.
      expect(result).toMatchObject({ ok: false, code: 'execution_failed' });
      expect(result.ok ? '' : result.error).toMatch(/Method not found: ethos\/capability\.storage/);
    },
    SLOW,
  );
});

describe('hook proxies', () => {
  it(
    'a modifying hook merges inside the host, drops overrideSystem and keeps the rest',
    async () => {
      h = await makeHarness();
      const { hooks } = await activate(h, 'hooks', 'hooks');
      const out = await hooks.fireModifying('before_prompt_build', {} as never, ['hooks']);
      expect(out).toEqual({ appendSystem: 'A', prependSystem: 'P' });
    },
    SLOW,
  );

  it(
    'a hosted throw yields null (fail-open) and a timeout does too, with the host kept alive',
    async () => {
      h = await makeHarness({ hookTimeoutMs: 300 });
      const { hooks } = await activate(h, 'hooks', 'hooks');
      expect(await hooks.fireModifying('before_tool_call', {} as never, ['hooks'])).toEqual({});
      const started = Date.now();
      expect(await hooks.fireModifying('message_sending', {} as never, ['hooks'])).toEqual({});
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(h.pool.entry('hooks')?.stats.timeouts).toBe(1);
      expect(eventsOf(h, 'plugin_host.crashed')).toHaveLength(0);
    },
    SLOW,
  );

  it(
    'the allowedPlugins gate still blocks a hosted plugin that is not granted',
    async () => {
      h = await makeHarness();
      const { hooks } = await activate(h, 'hooks', 'hooks');
      expect(
        await hooks.fireModifying('before_prompt_build', {} as never, ['someone-else']),
      ).toEqual({});
      expect(await hooks.fireModifying('before_prompt_build', {} as never)).toEqual({});
    },
    SLOW,
  );

  it(
    'void hooks return at once and the host sees them in FIFO order',
    async () => {
      h = await makeHarness();
      const { hooks } = await activate(h, 'hooks', 'hooks');
      const lease = await h.pool.acquire({ id: 'hooks', dir: fixtureDir('hooks') });
      for (const text of ['one', 'two', 'three']) {
        await hooks.fireVoid('agent_done', { text } as never, ['hooks']);
      }
      let seen = '';
      await waitFor(() => {
        void callTool(lease, 'hook_log').then((r) => {
          seen = r.ok ? r.value : '';
        });
        return seen === '["one","two","three"]';
      });
      expect(seen).toBe('["one","two","three"]');
    },
    SLOW,
  );

  it('a void queue over the bound drops the oldest and counts it', async () => {
    h = await makeHarness({ mockMode: 'slowhook', voidQueueMax: 3 });
    const lease = await h.pool.acquire({ id: 'm', dir: '/unused' });
    for (let i = 1; i <= 10; i++) lease.fireVoid('agent_done', { i });
    expect(h.pool.entry('m')?.stats.droppedVoid).toBe(6);
  });

  it('void events are dropped, not queued, while the host is down', async () => {
    h = await makeHarness({ mockMode: 'ok' });
    const lease = await h.pool.acquire({ id: 'm', dir: '/unused' });
    await callTool(lease, 't', { die: true });
    lease.fireVoid('agent_done', {});
    expect(h.pool.entry('m')?.stats.droppedVoid).toBe(1);
  });
});
