// Plan plugin-process-isolation §4.3. `INVENTORY` classifies every member of
// `EthosPluginApi`; it is typed `Record<keyof EthosPluginApi, ...>`, so a new API
// member fails typecheck here until it is classified (the PARTITION idea of
// packages/core/src/__tests__/tool-transport-hop.test.ts).
//
//   value        answered from the activation handshake
//   as-is        plain data or one request/response, replayed in the parent
//   async        a callback or emitter that became an RPC or a notification
//   unsupported  the plugin fails to load in a host, naming the method (D9)
//
// Each non-unsupported row has an observer below that registers it in a real
// host and watches the parent; each unsupported row has a fixture that must
// fail to load with the method in the error.

import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { SlashCommandContext } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callTool,
  fixtureDir,
  type Harness,
  makeCtx,
  makeHarness,
  waitFor,
} from './helpers/harness';
import { activateInParent, type ParentFixture } from './helpers/parent';

type Class = 'value' | 'as-is' | 'async' | 'unsupported';

const INVENTORY: Record<keyof EthosPluginApi, Class> = {
  pluginId: 'value',
  getBaseUrl: 'value',
  hasSecret: 'value',
  registerTool: 'as-is',
  registerVoidHook: 'async',
  registerModifyingHook: 'async',
  registerInjector: 'async',
  registerToolFilter: 'async',
  registerEvaluator: 'async',
  registerRoute: 'async',
  emit: 'async',
  on: 'async',
  registerPersonality: 'as-is',
  registerOAuthProfile: 'as-is',
  registerPluginPage: 'as-is',
  registerRenderer: 'as-is',
  registerDataSource: 'as-is',
  registerHealthCheck: 'as-is',
  registerMonitor: 'async',
  startMonitor: 'async',
  stopMonitor: 'async',
  notify: 'as-is',
  diagnostics: 'async',
  getSecret: 'as-is',
  setSecret: 'as-is',
  onCredentialUpdate: 'async',
  registerSlashCommand: 'async',
  registerCliSubcommand: 'async',
  registerCommand: 'async',
  registerDocumentExtractor: 'as-is',
  registerContextEngine: 'unsupported',
  registerLLMProvider: 'unsupported',
  registerMemoryProvider: 'unsupported',
  registerStorage: 'unsupported',
  registerExecutionBackend: 'unsupported',
  registerPlatformAdapter: 'unsupported',
  registerSttProvider: 'unsupported',
  registerTtsProvider: 'unsupported',
  registerCustomOAuthFlow: 'unsupported',
  // OAuthConfig has a synchronous `buildAuthUrl` and an `onCallback` function: it is not
  // data and not an RPC. Plan §4.2 lists it as "crosses as-is (data)"; that row is wrong.
  registerOAuth: 'unsupported',
};

const SLOW = 40_000;
let h: Harness;
let p: ParentFixture;
const llmPrompts: string[] = [];
const run = async (name: string, args: unknown = {}): Promise<string> => {
  const lease = await h.pool.acquire({ id: 'rows', dir: fixtureDir('rows') });
  const r = await callTool(lease, name, args);
  lease.release();
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const promptCtx = (platform = 'cli') => ({
  sessionId: 's1',
  sessionKey: 'cli:s1',
  platform,
  model: 'm',
  history: [],
  isDm: true,
  turnNumber: 1,
  meta: {} as Record<string, unknown>,
});

// One observer per row that is not `unsupported`. The test below fails for a row without one.
const OBSERVERS: Partial<Record<keyof EthosPluginApi, () => Promise<void>>> = {
  async pluginId() {
    expect(JSON.parse(await run('rows_value')).pluginId).toBe('rows');
  },
  async getBaseUrl() {
    expect(JSON.parse(await run('rows_value')).baseUrl).toBe('http://base.test');
  },
  async hasSecret() {
    const v = JSON.parse(await run('rows_value'));
    expect([v.hasToken, v.hasNope]).toEqual([true, false]);
  },
  async registerTool() {
    expect(p.tools.get('rows_value')).toBeDefined();
  },
  async registerVoidHook() {
    p.hooks.fireVoid('agent_done', { text: 'done-1' } as never, ['rows']);
    const seen = await (async () => {
      for (let i = 0; i < 50; i++) {
        const got = JSON.parse(await run('rows_received'));
        if (got.includes('done-1')) return got;
        await new Promise((r) => setTimeout(r, 40));
      }
      return [];
    })();
    expect(seen).toContain('done-1');
  },
  async registerModifyingHook() {
    expect(await p.hooks.fireModifying('before_prompt_build', {} as never, ['rows'])).toEqual({
      appendSystem: 'rows',
    });
  },
  async registerInjector() {
    const inj = p.injectors[0];
    expect(inj).toMatchObject({ id: 'rows-injector', priority: 5 });
    expect(inj?.shouldInject).toBeUndefined();
    const ctx = promptCtx();
    expect(await inj?.inject(ctx)).toEqual({
      content: 'hello s1',
      position: 'append',
      section: 'rows',
    });
    expect(ctx.meta).toEqual({ seen: 's1' });
    // shouldInject ran host-side and said no: null.
    expect(await inj?.inject(promptCtx('skip'))).toBeNull();
  },
  async registerToolFilter() {
    const f = p.filters[0];
    const meta = { toolName: 'echo', toolCallId: 'c1' };
    expect(f?.toolName).toBe('echo');
    expect(await f?.before?.({ block: true }, makeCtx(), meta)).toEqual({
      ok: false,
      code: 'execution_failed',
      error: 'blocked by filter',
    });
    expect(await f?.before?.({}, makeCtx(), meta)).toBeNull();
    expect(await f?.after?.({ ok: true, value: 'x' }, makeCtx(), meta)).toEqual({
      ok: true,
      value: 'x!',
    });
  },
  async registerEvaluator() {
    const ev = p.evaluators[0];
    expect(ev?.name).toBe('rows-evaluator');
    const payload = (text: string) => ({ text, sessionId: 's1', turnIndex: 1 });
    expect(ev?.shouldRun(payload('skip'))).toBe(true);
    expect(await ev?.evaluate(payload('skip'), makeCtx())).toEqual({
      pass: true,
      reason: 'skipped',
    });
    expect(await ev?.evaluate(payload('bad'), makeCtx())).toEqual({
      pass: false,
      reason: 'checked',
      score: 1,
    });
  },
  async registerRoute() {
    expect(p.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /rows/echo',
      'GET /rows/bin',
    ]);
    const req = { method: 'POST', path: '/rows/echo', headers: {}, query: {}, body: { a: 1 } };
    expect(await p.routes[0]?.handler(req)).toEqual({
      status: 201,
      body: { echo: { a: 1 } },
      headers: { 'x-rows': '1' },
    });
    const bin = await p.routes[1]?.handler({ ...req, method: 'GET', path: '/rows/bin', body: '' });
    expect(Buffer.isBuffer(bin?.body) ? bin.body.toString() : bin?.body).toBe('bin-data');
  },
  async emit() {
    await run('rows_emit', { event: 'x.out', payload: { n: 1 } });
    expect(p.busLog).toContainEqual(['x.out', { n: 1 }]);
    const before = h.pool.entry('rows')?.stats.droppedBus ?? 0;
    await run('rows_emit_bad');
    await waitFor(() => (h.pool.entry('rows')?.stats.droppedBus ?? 0) > before);
    expect(p.busLog.some(([e]) => e === 'bad.event')).toBe(false);
  },
  async on() {
    await run('rows_on', { event: 'rows.event' });
    p.bus.emit('rows.event', { from: 'parent' });
    for (let i = 0; i < 50; i++) {
      if (
        JSON.parse(await run('rows_received')).some(
          (r: { event?: string }) => r.event === 'rows.event',
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(JSON.parse(await run('rows_received'))).toContainEqual({
      event: 'rows.event',
      payload: { from: 'parent' },
    });
    // A payload that cannot be serialised is dropped and counted, not forwarded.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const before = h.pool.entry('rows')?.stats.droppedBus ?? 0;
    p.bus.emit('rows.event', circular);
    expect(h.pool.entry('rows')?.stats.droppedBus).toBe(before + 1);
  },
  async registerPersonality() {
    expect(p.personalities).toContainEqual({ id: 'rows-persona', name: 'Rows persona' });
  },
  async registerOAuthProfile() {
    expect(p.profiles).toContainEqual({ id: 'rows-profile', flow: { kind: 'authorization_code' } });
  },
  async registerPluginPage() {
    expect(p.registries.pluginPages?.get('rows')).toEqual({ title: 'Rows page', sections: [] });
  },
  async registerRenderer() {
    expect(p.registries.renderers?.get('rows-render')).toEqual({
      type: 'rows-render',
      template: 'table',
    });
  },
  async registerDataSource() {
    const path = p.registries.dataSources?.get('rows')?.get('db');
    expect(path).toBe(`${h.dataDir}/plugin-hosts/rows/home/data.sqlite`);
  },
  async registerHealthCheck() {
    const checks = p.healthChecks();
    expect(checks.map((c) => c.name)).toEqual(['rows-health']);
    expect(await checks[0]?.run()).toEqual({ status: 'ok', message: 'fine' });
  },
  async registerMonitor() {
    expect(await run('rows_start_monitor')).toBe('runs=1');
    await waitFor(() => p.busLog.some(([e]) => e === 'mon.kv'));
    expect(p.notified).toContainEqual({
      pluginId: 'rows',
      opts: { sessionKey: 'cli:mon', message: 'from-monitor' },
    });
    expect(p.busLog).toContainEqual(['mon.event', { token: 'tok-value' }]);
    expect(p.busLog).toContainEqual(['mon.llm', { answer: 'llm-answer' }]);
    expect(p.busLog).toContainEqual(['mon.kv', { v: 'v' }]);
    expect(llmPrompts).toContain('monitor prompt');
    expect(p.diagnostics.getEvents('rows').some((e) => e.message === 'monitor ran')).toBe(true);
    expect(p.plugin).toBeDefined();
    await waitFor(() => h.pool.entry('rows')?.holdsLongLived === true);
  },
  async startMonitor() {
    expect(h.pool.entry('rows')?.holdsLongLived).toBe(true);
  },
  async stopMonitor() {
    expect(await run('rows_stop_monitor')).toBe('stopped');
  },
  async notify() {
    await run('rows_notify');
    expect(p.notified).toContainEqual({
      pluginId: 'rows',
      opts: { sessionKey: 'cli:notify', message: 'hello' },
    });
  },
  async diagnostics() {
    await run('rows_diag');
    await waitFor(() => p.diagnostics.getEvents('rows').some((e) => e.message === 'diag warn'));
    expect(
      p.diagnostics.getMetrics('rows').some((m) => m.name === 'rows.metric' && m.value === 3),
    ).toBe(true);
  },
  async getSecret() {
    expect(await run('rows_get_secret', { key: 'token' })).toBe('tok-value');
  },
  async setSecret() {
    const out = JSON.parse(await run('rows_set_secret', { key: 'fresh', value: 'v1' }));
    expect(p.secrets.values.get('plugins/rows/fresh')).toBe('v1');
    expect(out.has).toBe(true);
  },
  async onCredentialUpdate() {
    // The host's own setSecret fires its handlers host-side; the plugin reports them.
    const out = JSON.parse(await run('rows_set_secret', { key: 'again', value: 'v2' }));
    expect(out.updates).toContain('again');
  },
  async registerSlashCommand() {
    const sent: string[] = [];
    const store = new InMemoryStorage();
    await store.mkdir('/slash');
    await store.write('/slash/path', 'S');
    const ctx: SlashCommandContext = {
      sessionId: 's1',
      platform: 'cli',
      send: async (t) => void sent.push(t),
      storage: store,
    };
    const handler = p.api.getSlashHandler('rows');
    expect(await handler?.('a b', ctx)).toBe('rows:a b:registry=true:storage=S');
    expect(sent).toEqual(['sending']);
  },
  async registerCliSubcommand() {
    const out: string[] = [];
    const err: string[] = [];
    const code = await p.api.getCliSubcommandHandler('rowscli')?.({
      argv: ['a', 'b'],
      cwd: '/',
      stdout: (s) => void out.push(s),
      stderr: (s) => void err.push(s),
    });
    expect([code, out, err]).toEqual([2, ['out-line'], ['err-line']]);
  },
  async registerCommand() {
    const sent: string[] = [];
    const slash = p.api.getSlashHandler('rowscmd');
    expect(
      await slash?.('', { sessionId: 's1', platform: 'cli', send: async (t) => void sent.push(t) }),
    ).toBe('tools-absent=true');
    expect(
      await p.api.getCliSubcommandHandler('rowscmd')?.({
        argv: [],
        cwd: '/',
        stdout: () => {},
        stderr: () => {},
      }),
    ).toBe(0);
  },
  async registerDocumentExtractor() {
    const ex = p.extractors[0];
    expect(ex).toMatchObject({ name: 'rows-extractor', mimeTypes: ['application/x-rows'] });
    expect(await ex?.extract(new TextEncoder().encode('hello'), 'application/x-rows')).toEqual({
      text: 'HELLO',
      format: 'text',
    });
  },
};

const keys = Object.keys(INVENTORY) as Array<keyof EthosPluginApi>;
const observed = keys.filter((k) => INVENTORY[k] !== 'unsupported');
const unsupported = keys.filter((k) => INVENTORY[k] === 'unsupported');

describe('registration inventory: every EthosPluginApi member is classified and exercised', () => {
  beforeAll(async () => {
    h = await makeHarness({
      // The composition root injects the parent's llm factory for monitors (a monitor has no call handle).
      parent: {
        llmFactory: () => ({
          complete: async (prompt) => {
            llmPrompts.push(prompt);
            return 'llm-answer';
          },
        }),
      },
    });
    p = await activateInParent(h, 'rows', 'rows', {
      baseUrl: 'http://base.test',
      secrets: { 'plugins/rows/token': 'tok-value' },
    });
  }, SLOW);
  afterAll(async () => {
    await h?.cleanup();
  });

  it('has an observer for every value, as-is and async row', () => {
    expect(Object.keys(OBSERVERS).sort()).toEqual([...observed].sort());
  });

  it.each(observed)(
    '%s is observed in the parent',
    async (key) => {
      await OBSERVERS[key]?.();
    },
    SLOW,
  );
});

describe('unsupported rows fail the plugin load naming the SDK method (D9)', () => {
  it('lists the nine members of plan §4.2 plus registerOAuth', () => {
    expect(unsupported).toHaveLength(10);
  });

  it.each([...unsupported, 'registerDataSource' as const])(
    '%s',
    async (method) => {
      const local = await makeHarness({
        buildEnv: (ctx) => ({
          PATH: process.env.PATH ?? '',
          HOME: ctx.hostHome,
          TMPDIR: ctx.tmpDir,
          UNSUPPORTED_METHOD: method,
        }),
      });
      try {
        await expect(
          local.pool.acquire({ id: 'unsup', dir: fixtureDir('unsupported') }),
        ).rejects.toThrow(new RegExp(method));
        expect(local.pool.entry('unsup')).toBeUndefined();
      } finally {
        await local.cleanup();
      }
    },
    SLOW,
  );
});
