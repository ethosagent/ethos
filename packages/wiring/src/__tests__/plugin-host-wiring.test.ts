// Plan plugin-process-isolation §9.5 (D4, D8, D24). The REAL composition root
// (`createAgentLoop`) with `plugins.isolation: host`: a plugin from
// `~/.ethos/plugins/` runs in a real host process spawned by a real
// `PluginHostPool`, and the turn reaches it through a scripted provider (the
// OpenAI-compat prototype is stubbed, so nothing leaves the process).
//
// HOME and ETHOS_STATE_DIR point at a temp dir, so the operator's installed
// plugins are never read.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfigYaml } from '@ethosagent/config';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import { PluginLoader, trustWorkspacePlugin } from '@ethosagent/plugin-loader';
import { FsStorage } from '@ethosagent/storage-fs';
import type { AgentEvent, CompletionChunk, Message, ToolDefinitionLite } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';
import { createPluginHostPool, PluginHostPool } from '../plugin-hosts';

const FIXTURES = join(import.meta.dirname, '../../../../extensions/plugin-host/src/__tests__');
const ECHO_FIXTURE = join(FIXTURES, 'fixtures', 'echo');
const CHILD_ENTRY = join(FIXTURES, 'helpers', 'child-entry.ts');

let home: string;
let dataDir: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-plugin-host-wiring-'));
  dataDir = join(home, '.ethos');
  mkdirSync(join(dataDir, 'plugins'), { recursive: true });
  cpSync(ECHO_FIXTURE, join(dataDir, 'plugins', 'echo'), { recursive: true });
  for (const id of ['granted', 'plain'] as const) {
    const dir = join(dataDir, 'personalities', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'config.yaml'),
      `name: ${id}\ndescription: test\n${id === 'granted' ? 'plugins: echo\n' : ''}`,
    );
    writeFileSync(join(dir, 'SOUL.md'), `I am ${id}.\n`);
    writeFileSync(join(dir, 'toolset.yaml'), '[]\n');
  }
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.ETHOS_STATE_DIR = dataDir;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CONFIG_LINES = [
  'provider: ollama',
  'model: model-a',
  'apiKey: sk-dummy',
  'providers.0.provider: ollama',
  'providers.0.id: local-a',
  'providers.0.model: model-a',
  'providers.0.baseUrl: http://127.0.0.1:9/v1',
  'providers.0.apiKey: sk-dummy',
  'plugins.isolation: host',
];

function config(): WiringConfig {
  return parseConfigYaml(`${CONFIG_LINES.join('\n')}\n`) as WiringConfig;
}

interface Call {
  tools: string[];
  lastMessage: string;
}

/** Scripted provider: calls `echo` once when it is offered, then answers. */
function scriptProvider(): Call[] {
  const calls: Call[] = [];
  vi.spyOn(OpenAICompatProvider.prototype, 'complete').mockImplementation(
    (_messages: Message[], tools: ToolDefinitionLite[]) => {
      const last = JSON.stringify(_messages.at(-1) ?? {});
      calls.push({ tools: tools.map((t) => t.name), lastMessage: last });
      const sawResult = last.includes('TOOL_RESULT');
      return (async function* (): AsyncGenerator<CompletionChunk> {
        if (!sawResult && tools.some((t) => t.name === 'echo')) {
          yield { type: 'tool_use_start', toolCallId: 'c1', toolName: 'echo' };
          yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{"text":"hello-host"}' };
          yield { type: 'done', finishReason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    },
  );
  return calls;
}

function build(extra: { pluginHostPool?: PluginHostPool; childEntry?: string } = {}) {
  return createAgentLoop(config(), {
    dataDir,
    workingDir: home,
    profile: 'web',
    disableDocker: true,
    ...(extra.pluginHostPool ? { pluginHostPool: extra.pluginHostPool } : {}),
    ...(extra.childEntry ? { pluginHostChildEntry: extra.childEntry } : {}),
  });
}

async function turn(
  runtime: Awaited<ReturnType<typeof build>>,
  personalityId: string,
): Promise<AgentEvent[]> {
  await runtime.refreshPersonalities();
  const events: AgentEvent[] = [];
  for await (const e of runtime.loop.run('call the tool', {
    personalityId,
    sessionKey: `cli:${personalityId}-${Math.random()}`,
    roomAudience: 'private',
  })) {
    events.push(e);
  }
  return events;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function newPool(): PluginHostPool {
  return createPluginHostPool({ dataDir, storage: new FsStorage(), childEntry: CHILD_ENTRY });
}

describe('createAgentLoop with plugins.isolation: host', () => {
  it('a hosted tool runs and its result is untrusted-wrapped', async () => {
    const calls = scriptProvider();
    const runtime = await build({ childEntry: CHILD_ENTRY });
    try {
      expect(runtime.toolRegistry.get('echo')?.outputIsUntrusted).toBe(true);
      const events = await turn(runtime, 'granted');

      expect(events.some((e) => e.type === 'error')).toBe(false);
      expect(events.some((e) => e.type === 'tool_end' && e.toolName === 'echo' && e.ok)).toBe(true);
      const followUp = calls.at(-1)?.lastMessage ?? '';
      expect(followUp).toContain('hello-host');
      expect(followUp).toContain('===TOOL_RESULT_START');
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it('a personality without the plugin grant does not see the tool', async () => {
    const calls = scriptProvider();
    const runtime = await build({ childEntry: CHILD_ENTRY });
    try {
      await turn(runtime, 'plain');
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => !c.tools.includes('echo'))).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it('two loops borrowing one pool share one host pid and activate once', async () => {
    // A fresh host home, so the activation log counts only this test's activations.
    rmSync(join(dataDir, 'plugin-hosts'), { recursive: true, force: true });
    const pool = newPool();
    const a = await build({ pluginHostPool: pool });
    const b = await build({ pluginHostPool: pool });
    try {
      const pid = pool.pidOf('echo');
      expect(pid).toBeGreaterThan(0);
      expect(pool.leasesOf('echo')).toBe(2);
      expect(a.toolRegistry.get('echo')).toBeDefined();
      expect(b.toolRegistry.get('echo')).toBeDefined();
      const log = readFileSync(
        join(dataDir, 'plugin-hosts', 'echo', 'home', 'activations.log'),
        'utf-8',
      );
      expect(log).toBe('x');
    } finally {
      await a.dispose();
      await b.dispose();
      await pool.dispose();
    }
  }, 60_000);

  it('loop dispose releases, pool dispose kills, in that order; a borrower never disposes the pool', async () => {
    const poolDispose = vi.spyOn(PluginHostPool.prototype, 'dispose');
    const pool = newPool();
    const runtime = await build({ pluginHostPool: pool });
    const pid = pool.pidOf('echo') as number;
    expect(alive(pid)).toBe(true);

    await runtime.dispose();
    expect(pool.leasesOf('echo')).toBe(0);
    expect(poolDispose).not.toHaveBeenCalled();
    expect(alive(pid)).toBe(true);

    await pool.dispose();
    expect(poolDispose).toHaveBeenCalledTimes(1);
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it('a loop that built its own pool releases its leases before it kills the host', async () => {
    const order: string[] = [];
    const unload = vi.spyOn(PluginLoader.prototype, 'unloadAll').mockImplementation(async () => {
      order.push('plugins');
    });
    vi.spyOn(PluginHostPool.prototype, 'dispose').mockImplementation(async () => {
      order.push('plugin-hosts');
    });
    const runtime = await build({ childEntry: CHILD_ENTRY });
    await runtime.dispose();
    expect(unload).toHaveBeenCalled();
    expect(order.indexOf('plugins')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('plugin-hosts')).toBeGreaterThan(order.indexOf('plugins'));
    // The mocks above skipped the real teardown; stop the host they left behind.
    vi.restoreAllMocks();
  }, 60_000);

  it('a host-configured plugin fails closed when no pool and no child entry exist', async () => {
    const runtime = await build();
    try {
      expect(runtime.toolRegistry.get('echo')).toBeUndefined();
      const failure = runtime.pluginLoader.getFailures().find((f) => f.id === 'echo');
      expect(failure?.error).toContain('plugin host');
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it('first-party @ethosagent/* from node_modules stays in-process', async () => {
    const proj = join(home, 'proj');
    const pkgDir = join(proj, 'node_modules', '@ethosagent', 'fp-tool');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@ethosagent/fp-tool',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
        ethos: { type: 'plugin', id: 'fp-tool', pluginContractMajor: 4 },
      }),
    );
    writeFileSync(
      join(pkgDir, 'index.js'),
      `globalThis.__fpToolImported = true;
export function activate(api) {
  api.registerTool({ name: 'fp_tool', description: 'fp', schema: { type: 'object', properties: {} }, capabilities: {}, async execute() { return { ok: true, value: 'fp' }; } });
}
`,
    );
    await trustWorkspacePlugin(new FsStorage(), join(dataDir, 'plugins'), pkgDir);
    vi.spyOn(process, 'cwd').mockReturnValue(proj);
    const acquire = vi.spyOn(PluginHostPool.prototype, 'acquire');
    const runtime = await build({ childEntry: CHILD_ENTRY });
    try {
      expect(runtime.toolRegistry.get('fp_tool')).toBeDefined();
      expect((globalThis as Record<string, unknown>).__fpToolImported).toBe(true);
      expect(acquire.mock.calls.map((c) => c[0].id)).not.toContain('fp-tool');
    } finally {
      await runtime.dispose();
      delete (globalThis as Record<string, unknown>).__fpToolImported;
    }
  }, 60_000);
});
