// Onboarding (`ethos serve` with no config.yaml): the web API is built before
// any agent loop exists. It used to be handed a forwarding stub with no
// `hooks`, and construction crashed registering its `session_start` hook on it
// ("Cannot read properties of undefined (reading 'registerVoid')") — the
// first-run path for every new user. Registering on a stub would not help
// either: those hooks would never reach the loop onboarding later boots. So a
// surface built with no `agentLoop` registers nothing at construction, runs
// every service on a stand-in that delegates to the bound loop
// (lib/pending-loop.ts), and `bindAgentLoop` makes the main-loop registrations
// on the real loop once it exists — released again by `dispose`, which never
// disposes that loop.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentEvent, AgentLoop, DefaultToolRegistry } from '@ethosagent/core';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  AgentSafety,
  CompletionChunk,
  LLMProvider,
  NotificationRouter,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi, WebTokenRepository } from '../index';
import { KanbanService } from '../services/kanban.service';
import { makeStubMemoryBundle, makeStubPersonalityRegistry } from './test-helpers';

/** Every turn asks for `probe` once, then finishes. */
function toolCallingLLM(): LLMProvider {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls % 2 === 1) {
        yield { type: 'tool_use_start', toolCallId: `c-${calls}`, toolName: 'probe' };
        yield { type: 'tool_use_end', toolCallId: `c-${calls}`, inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function noopSafety(): AgentSafety {
  return {
    injection: {
      prelude: '',
      downgradeRejectionMessage: 'downgraded',
      sanitize: (c) => c,
      wrapUntrusted: ({ content }) => ({ content, strippedTokens: 0 }),
      shortPatternCheck: () => ({ containsInstructions: false, hits: [] }),
      c2PatternCheck: () => ({ containsInstructions: false }),
      resolveDowngradedTools: () => new Set(),
    },
    redaction: { redactPii: (t) => t, redactString: (t) => t, detectSecrets: () => [] },
    scopedStorageFactory: (base) => base,
    approvalPosture: { kind: 'ungated', reason: 'onboarding bind test' },
  };
}

function realLoop(session: SQLiteSessionStore): { loop: AgentLoop; probeRuns: () => number } {
  let runs = 0;
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'probe',
    description: 'counts its runs',
    schema: { type: 'object' },
    capabilities: {},
    async execute() {
      runs++;
      return { ok: true, value: 'probed' };
    },
  });
  const loop = new AgentLoop({ llm: toolCallingLLM(), safety: noopSafety(), session, tools });
  return { loop, probeRuns: () => runs };
}

async function drain(loop: AgentLoop, sessionKey: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of loop.run('go', { sessionKey })) events.push(e);
  return events;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let dir: string;
let session: SQLiteSessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ethos-onboarding-bind-'));
  session = new SQLiteSessionStore(':memory:');
});

afterEach(async () => {
  vi.restoreAllMocks();
  session.close();
  await rm(dir, { recursive: true, force: true });
});

/** Onboarding shape: no `agentLoop` — the web API runs on its stand-in. */
function build(overrides: Partial<Parameters<typeof createWebApi>[0]> = {}) {
  return createWebApi({
    dataDir: dir,
    storage: new FsStorage(),
    sessionStore: session,
    memoryBundle: makeStubMemoryBundle(),
    personalities: makeStubPersonalityRegistry(),
    chatDefaults: { model: 'setup-required', provider: 'setup-required' },
    ...overrides,
  });
}

async function rpcCaller(app: ReturnType<typeof createWebApi>['app']) {
  const token = await new WebTokenRepository({
    dataDir: dir,
    storage: new FsStorage(),
  }).getOrCreate();
  const exchange = await app.request(`/auth/exchange?t=${token}`, {
    headers: { origin: 'http://localhost:3000' },
  });
  const cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
  return (path: string, input: unknown) =>
    app.request(`/rpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost:3000' },
      body: JSON.stringify({ json: input }),
    });
}

describe('createWebApi before the agent loop exists (onboarding)', () => {
  it('constructs with no agent loop', async () => {
    const created = build();
    await created.dispose();
  });

  it("bindAgentLoop registers the surface's hooks on the real loop, and dispose takes them off", async () => {
    const isDangerous = vi.fn(async () => null);
    const router: NotificationRouter = {
      route: vi.fn(async () => {}),
      register: vi.fn(),
      deregister: vi.fn(),
    };
    const created = build();
    const { loop, probeRuns } = realLoop(session);

    // The danger check is built from the booted loop, so it arrives with the bind.
    created.bindAgentLoop(loop, { notificationRouter: router, dangerPredicate: isDangerous });
    await drain(loop, 'web:first');

    // The web approval hook ran for the real loop's tool call...
    expect(isDangerous).toHaveBeenCalledTimes(1);
    expect(probeRuns()).toBe(1);
    // ...and the session_start hook put this surface's adapter on the router.
    expect(router.register).toHaveBeenCalledWith('web:first', expect.anything());

    await created.dispose();
    // The adapter it registered comes back off the borrowed router...
    expect(router.deregister).toHaveBeenCalledWith('web:first');

    // ...and nothing it registered on the loop fires any more. The loop itself
    // is still usable: dispose never disposes what it borrowed.
    await drain(loop, 'web:second');
    expect(probeRuns()).toBe(2);
    expect(isDangerous).toHaveBeenCalledTimes(1);
    expect(router.register).toHaveBeenCalledTimes(1);
  });

  it('a flagged tool call on the bound loop routes to the web approval path', async () => {
    const created = build();
    const { loop, probeRuns } = realLoop(session);
    created.bindAgentLoop(loop, { dangerPredicate: async () => 'probe is consequential' });

    const turn = drain(loop, 'web:flagged');
    await waitFor(() => created.pendingApprovalCount() === 1, 'the approval to be pending');
    expect(probeRuns()).toBe(0);

    // Deny it (what shutdown does) — the turn unwinds with the tool refused.
    created.forceSettleApprovals();
    await turn;
    expect(probeRuns()).toBe(0);
    await created.dispose();
  });

  it('runs chat turns on the stand-in: the host boots and binds, the turn reaches the real loop', async () => {
    const { loop, probeRuns } = realLoop(session);
    const created = build({
      bootAgentLoop: async () => {
        created.bindAgentLoop(loop);
      },
    });

    await created.chatService.send({ clientId: 'tab', text: 'hello' });
    await waitFor(() => probeRuns() === 1, 'the turn to run on the real loop');
    await created.dispose();
  });

  it('a non-run RPC (sessions.compact) reaches the bound loop through the stand-in', async () => {
    const { loop } = realLoop(session);
    const compact = vi.spyOn(loop, 'compact');
    const created = build();
    const call = await rpcCaller(created.app);
    const s = await session.createSession({
      key: 'web:compact-me',
      platform: 'web',
      model: 'm',
      provider: 'p',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });

    created.bindAgentLoop(loop);
    const res = await call('sessions/compact', { id: s.id });
    expect(res.status).toBe(200);
    expect(compact).toHaveBeenCalledWith('web:compact-me', expect.anything());
    await created.dispose();
  });

  it("kanban ticket hooks go to the bound loop's registry, and come off on dispose", async () => {
    const detached = vi.fn();
    const original = KanbanService.prototype.useHooks;
    const useHooks = vi.spyOn(KanbanService.prototype, 'useHooks').mockImplementation(function (
      this: KanbanService,
      hooks,
    ) {
      const detach = original.call(this, hooks);
      return () => {
        detached();
        detach();
      };
    });
    const created = build();
    // Nothing to attach to before the loop exists.
    expect(useHooks).not.toHaveBeenCalled();

    const { loop } = realLoop(session);
    created.bindAgentLoop(loop);
    expect(useHooks).toHaveBeenCalledWith(loop.hooks);

    await created.dispose();
    expect(detached).toHaveBeenCalledTimes(1);
  });

  it('refuses a second bind', async () => {
    const created = build();
    created.bindAgentLoop(realLoop(session).loop);
    expect(() => created.bindAgentLoop(realLoop(session).loop)).toThrow(/already/);
    await created.dispose();
  });

  it('refuses to bind when the loop given at construction was already wired', async () => {
    const { loop } = realLoop(session);
    const created = build({ agentLoop: loop });
    expect(() => created.bindAgentLoop(realLoop(session).loop)).toThrow(/already/);
    await created.dispose();
  });
});

describe('bindAgentLoop — lifetime edges', () => {
  it('is a no-op once the surface is disposed: nothing is registered on the late loop', async () => {
    const isDangerous = vi.fn(async () => null);
    const created = build();
    await created.dispose();

    const { loop, probeRuns } = realLoop(session);
    // A boot that finishes after shutdown began must not wire into a released surface.
    expect(() => created.bindAgentLoop(loop, { dangerPredicate: isDangerous })).not.toThrow();
    await drain(loop, 'web:late');
    expect(probeRuns()).toBe(1);
    expect(isDangerous).not.toHaveBeenCalled();
  });

  it('a bind whose wiring throws releases what it registered and leaves the surface bindable', async () => {
    const created = build();
    const broken = realLoop(session).loop;
    const registered: Array<ReturnType<typeof vi.fn>> = [];
    const realRegisterVoid = broken.hooks.registerVoid.bind(broken.hooks);
    vi.spyOn(broken.hooks, 'registerVoid').mockImplementation(((...args: unknown[]) => {
      const off = vi.fn((realRegisterVoid as (...a: unknown[]) => () => void)(...args));
      registered.push(off);
      return off;
    }) as never);
    vi.spyOn(broken.hooks, 'registerModifying').mockImplementation(() => {
      throw new Error('registry refused');
    });

    expect(() => created.bindAgentLoop(broken, { dangerPredicate: async () => null })).toThrow(
      'registry refused',
    );
    // The registrations it had made before the throw came back off...
    expect(registered.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 0));
    for (const off of registered) expect(off).toHaveBeenCalledTimes(1);

    // ...and the retry binds instead of reporting "already wired".
    const { loop, probeRuns } = realLoop(session);
    const isDangerous = vi.fn(async () => null);
    created.bindAgentLoop(loop, { dangerPredicate: isDangerous });
    await drain(loop, 'web:retry');
    expect(probeRuns()).toBe(1);
    expect(isDangerous).toHaveBeenCalledTimes(1);
    await created.dispose();
  });

  it('the returned unbind releases the bind so a later loop can be bound', async () => {
    const created = build();
    const first = realLoop(session);
    const firstCheck = vi.fn(async () => null);
    const unbind = created.bindAgentLoop(first.loop, { dangerPredicate: firstCheck });
    await unbind();
    await drain(first.loop, 'web:unbound');
    expect(firstCheck).not.toHaveBeenCalled();

    const second = realLoop(session);
    const secondCheck = vi.fn(async () => null);
    created.bindAgentLoop(second.loop, { dangerPredicate: secondCheck });
    await drain(second.loop, 'web:rebound');
    expect(secondCheck).toHaveBeenCalledTimes(1);
    await created.dispose();
  });

  it('starts the dashboard refresh scheduler only once a loop is bound', async () => {
    const { DashboardRefreshScheduler } = await import('@ethosagent/dashboard');
    const start = vi.spyOn(DashboardRefreshScheduler.prototype, 'start');
    const stop = vi.spyOn(DashboardRefreshScheduler.prototype, 'stop');
    const created = build({ bootAgentLoop: async () => {} });
    // Unbound: a due prompt panel would boot-and-fail every tick.
    expect(start).not.toHaveBeenCalled();

    created.bindAgentLoop(realLoop(session).loop);
    expect(start).toHaveBeenCalledTimes(1);
    await created.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

// Onboarding used to bind only the loop, its goal pair and the tool registry,
// so every other loop-derived surface stayed at its pre-boot stand-in until the
// operator restarted: MCP answered as the passive manager, the Execution probe
// said no registry was wired, and renderers reported none. Each of those is a
// slot its consumer reads per call or through a stand-in, so `bindAgentLoop`
// installs them too.
describe('bindAgentLoop — the rest of the loop-derived surfaces', () => {
  it('MCP reads the bound manager, not the passive stand-in', async () => {
    const created = build();
    const call = await rpcCaller(created.app);
    const before = await call('mcp/serverTools', { personalityId: 'p', serverName: 'files' });
    expect(((await before.json()) as { json: { available: boolean } }).json.available).toBe(false);

    created.bindAgentLoop(realLoop(session).loop, {
      mcpManager: {
        getToolsForPersonality: async () => [
          { name: 'mcp__files__read', description: 'read', schema: { type: 'object' } },
        ],
      } as never,
    });

    const after = await call('mcp/serverTools', { personalityId: 'p', serverName: 'files' });
    const body = (await after.json()) as { json: { available: boolean; tools: unknown[] } };
    expect(body.json.available).toBe(true);
    expect(body.json.tools).toHaveLength(1);
    await created.dispose();
  });

  it('the Execution probe reaches the bound backend registry', async () => {
    // `probeSsh` only consults the registry once a remote target is configured.
    await writeFile(
      join(dir, 'config.yaml'),
      'provider: anthropic\nmodel: m\napiKey: k\npersonality: operator\nexecution.ssh.host: ssh.invalid\n',
    );
    const created = build();
    const call = await rpcCaller(created.app);
    type Probe = { json: { result: { state: string; error?: string } } };
    const before = (await (await call('execution/probeSsh', {})).json()) as Probe;
    expect(before.json.result.state).toBe('backend_unresolved');
    expect(before.json.result.error).toContain('no execution-backend registry is wired');

    created.bindAgentLoop(realLoop(session).loop, {
      executionBackends: { get: () => undefined, resolve: async () => undefined } as never,
    });

    const after = (await (await call('execution/probeSsh', {})).json()) as Probe;
    expect(after.json.result.error).toContain('no ssh execution backend was built at startup');
    await created.dispose();
  });

  it('personality renderers come from the bound skills injector', async () => {
    const created = build({
      personalities: makeStubPersonalityRegistry([{ id: 'operator', name: 'Operator' } as never]),
    });
    const call = await rpcCaller(created.app);
    const before = (await (await call('personalities/renderers', { id: 'operator' })).json()) as {
      json: { renderers: string[] };
    };
    expect(before.json.renderers).toEqual([]);

    created.bindAgentLoop(realLoop(session).loop, {
      skillsInjector: { resolveRenderers: async () => ['chart'] } as never,
    });

    const after = (await (await call('personalities/renderers', { id: 'operator' })).json()) as {
      json: { renderers: string[] };
    };
    expect(after.json.renderers).toEqual(['chart']);
    await created.dispose();
  });

  it('refreshes the bound loop’s personality registry before a turn', async () => {
    const refreshed = { count: 0 };
    const created = build();
    created.bindAgentLoop(realLoop(session).loop, {
      refreshPersonalities: async () => {
        refreshed.count += 1;
      },
    });

    await created.chatService.send({ clientId: 'tab', text: 'hello' });
    await waitFor(() => refreshed.count > 0, 'the bound refresh to run');
    await created.dispose();
  });
});

// The realtime voice lane's tool host is gated by `before_tool_call`. Before a
// loop is bound the stand-in has no hooks, and the gate was spread away —
// leaving the control channel open with its tools ungated. It is refused
// instead (the audio lane is unaffected). Asserted at the wiring site: opening
// a lane needs a live WebSocket upgrade, which this suite has no harness for.
describe('the realtime control lane without a hook gate', () => {
  it('is refused rather than opened ungated', async () => {
    const src = await readFile(join(import.meta.dirname, '..', 'index.ts'), 'utf8');
    expect(src).toMatch(/const hooks = agentLoop\.hooks;\s*\n\s*if \(!hooks\) return null;/);
    // The gate is passed, never spread-if-present, so it cannot be absent here.
    expect(src).not.toContain('hooks: agentLoop.hooks,');
  });
});
