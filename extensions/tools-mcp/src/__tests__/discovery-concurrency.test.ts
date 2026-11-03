// McpManager discovery concurrency cap (plan hermes-0.22-hardening §5, D11-D14).
// Fake clients count in-flight connect() calls; the manager subclass swaps them
// in through the protected _buildClient / _buildClientWithSecrets seams.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpClient, McpServerConfig } from '../index';
import { DEFAULT_DISCOVERY_CONCURRENCY, McpManager } from '../index';

type Behaviour = 'ok' | 'fail' | 'hang';

interface Probe {
  inFlight: number;
  maxInFlight: number;
  started: string[];
  connectCalls: Map<string, number>;
  behaviour: Map<string, Behaviour>;
  /** Resolvers of hung connects, by server name. */
  hung: Map<string, () => void>;
  /** ms each healthy connect takes (real timers). */
  connectMs: number;
}

function freshProbe(connectMs = 5): Probe {
  return {
    inFlight: 0,
    maxInFlight: 0,
    started: [],
    connectCalls: new Map(),
    behaviour: new Map(),
    hung: new Map(),
    connectMs,
  };
}

/** Module-level because McpManager's constructor calls _buildClient during super(). */
let probe: Probe = freshProbe();

function fakeClient(config: McpServerConfig): McpClient {
  const fake = {
    name: config.name,
    config,
    onToolsChanged: undefined,
    onScopeProbe: undefined,
    enableScopeProbe: false,
    async connect(): Promise<void> {
      probe.started.push(config.name);
      probe.connectCalls.set(config.name, (probe.connectCalls.get(config.name) ?? 0) + 1);
      probe.inFlight++;
      probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
      try {
        const mode = probe.behaviour.get(config.name) ?? 'ok';
        if (mode === 'hang') {
          await new Promise<void>((resolve) => probe.hung.set(config.name, resolve));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, probe.connectMs));
        if (mode === 'fail') throw new Error(`boom ${config.name}`);
      } finally {
        probe.inFlight--;
      }
    },
    async listTools() {
      return [
        {
          name: `tool_${config.name}`,
          description: `tool of ${config.name}`,
          inputSchema: { type: 'object' },
          replaySafe: false,
        },
      ];
    },
    async disconnect(): Promise<void> {},
  };
  return fake as unknown as McpClient;
}

class FakeManager extends McpManager {
  protected override _buildClient(config: McpServerConfig): McpClient {
    return fakeClient(config);
  }
  protected override _buildClientWithSecrets(config: McpServerConfig): McpClient {
    return fakeClient(config);
  }
}

function stdio(name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name, transport: 'stdio', command: 'node', keepaliveSeconds: 0, ...extra };
}

function http(name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name,
    transport: 'streamable-http',
    url: `https://${name}.example.com/mcp`,
    keepaliveSeconds: 0,
    ...extra,
  };
}

const names = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

afterEach(() => {
  vi.useRealTimers();
  probe = freshProbe();
});

describe('McpManager discovery concurrency', () => {
  it('the default cap is four', () => {
    expect(DEFAULT_DISCOVERY_CONCURRENCY).toBe(4);
  });

  it('connect() with ten servers never has more than four connects in flight', async () => {
    probe = freshProbe();
    const manager = new FakeManager(names('s', 10).map((n) => stdio(n)));

    await manager.connect();

    expect(probe.maxInFlight).toBe(4);
    expect(manager.getTools()).toHaveLength(10);
  });

  it('getToolsForPersonality caps OAuth and stdio connects together', async () => {
    probe = freshProbe();
    const manager = new FakeManager([
      ...names('h', 5).map((n) => http(n)),
      ...names('s', 5).map((n) => stdio(n)),
    ]);

    const tools = await manager.getToolsForPersonality('p1');

    expect(probe.maxInFlight).toBe(4);
    expect(tools).toHaveLength(10);
  });

  it('discoveryConcurrency: 1 connects one server at a time', async () => {
    probe = freshProbe();
    const manager = new FakeManager(
      [...names('h', 3).map((n) => http(n)), ...names('s', 3).map((n) => stdio(n))],
      { discoveryConcurrency: 1 },
    );

    const tools = await manager.getToolsForPersonality('p1');

    expect(probe.maxInFlight).toBe(1);
    expect(tools).toHaveLength(6);
  });

  it("a failing connect releases its slot and the other servers' tools are returned", async () => {
    probe = freshProbe();
    probe.behaviour.set('s1', 'fail');
    const manager = new FakeManager(
      names('s', 4).map((n) => stdio(n)),
      {
        discoveryConcurrency: 1,
      },
    );

    const tools = await manager.getToolsForPersonality('p1');

    expect(probe.connectCalls.size).toBe(4);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['mcp__s0__tool_s0', 'mcp__s2__tool_s2', 'mcp__s3__tool_s3'].sort(),
    );
    expect(probe.inFlight).toBe(0);
  });

  it('a hung connect releases its slot after connectTimeoutMs and still resolves to its own outcome', async () => {
    vi.useFakeTimers();
    probe = freshProbe(0);
    probe.behaviour.set('hung', 'hang');
    const manager = new FakeManager(
      [stdio('hung', { connectTimeoutMs: 50 }), stdio('next', { connectTimeoutMs: 50 })],
      { discoveryConcurrency: 1 },
    );

    const pending = manager.getToolsForPersonality('p1');
    await vi.advanceTimersByTimeAsync(10);
    // Slot still held by the hung connect.
    expect(probe.started).toEqual(['hung']);

    await vi.advanceTimersByTimeAsync(50);
    // Slot released by the timer although `hung` has not settled: `next` starts.
    expect(probe.started).toEqual(['hung', 'next']);
    expect(probe.hung.has('hung')).toBe(true);

    // The hung connect then completes; its own outcome (a tool) is still returned.
    probe.hung.get('hung')?.();
    await vi.advanceTimersByTimeAsync(10);
    const tools = await pending;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'mcp__hung__tool_hung',
      'mcp__next__tool_next',
    ]);
  });

  it('a joiner of an in-flight connect takes no slot', async () => {
    probe = freshProbe();
    const manager = new FakeManager([stdio('one')], { discoveryConcurrency: 1 });

    const both = Promise.all([
      manager.getToolsForPersonality('p1', ['one']),
      manager.getToolsForPersonality('p2', ['one']),
    ]);
    const timeout = new Promise<'deadlock'>((resolve) =>
      setTimeout(() => resolve('deadlock'), 2000),
    );
    const result = await Promise.race([both, timeout]);

    expect(result).not.toBe('deadlock');
    expect(probe.connectCalls.get('one')).toBe(1);
    if (result === 'deadlock') return;
    expect(result[0]).toHaveLength(1);
    expect(result[1]).toHaveLength(1);
  });

  it('the tool set with the cap equals the tool set without it', async () => {
    const configs = [...names('h', 4).map((n) => http(n)), ...names('s', 4).map((n) => stdio(n))];

    probe = freshProbe();
    const wide = new FakeManager(configs, { discoveryConcurrency: 16 });
    const wideTools = (await wide.getToolsForPersonality('p1')).map((t) => t.name).sort();

    probe = freshProbe();
    const narrow = new FakeManager(configs, { discoveryConcurrency: 1 });
    const narrowTools = (await narrow.getToolsForPersonality('p1')).map((t) => t.name).sort();

    expect(narrowTools).toEqual(wideTools);
    expect(narrowTools).toHaveLength(8);
  });
});
