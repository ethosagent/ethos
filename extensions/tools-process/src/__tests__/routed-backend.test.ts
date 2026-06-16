import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecChunk, ExecOpts, ExecutionBackend, Tool } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProcessTools } from '../index';
import { loadRegistry } from '../registry';

function makeCtx(workingDir: string) {
  return {
    sessionId: 'test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    personalityId: 'router',
  };
}

function getTool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

interface FakeBackend extends ExecutionBackend {
  lastSessionCmd?: string;
  lastSessionOpts?: ExecOpts;
}

function makeBackend(out: string): FakeBackend {
  const be: FakeBackend = {
    name: 'docker',
    isAvailable: () => Promise.resolve(true),
    exec: (_cmd: string, _opts: ExecOpts) => {
      async function* gen(): AsyncIterable<ExecChunk> {}
      return gen();
    },
    spawnSession: (personalityId: string) => ({
      personalityId,
      exec(cmd: string, opts: ExecOpts = {}): AsyncIterable<ExecChunk> {
        be.lastSessionCmd = cmd;
        be.lastSessionOpts = opts;
        async function* gen(): AsyncIterable<ExecChunk> {
          yield { stream: 'stdout', data: out };
        }
        return gen();
      },
      dispose: () => Promise.resolve(),
    }),
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };
  return be;
}

describe('process_start routed through an execution backend', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ethos-routed-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('routes the command through backend.spawnSession with a clean env (#3) and captures output to the log file', async () => {
    const backend = makeBackend('routed line\n');
    const personality = { id: 'router', name: 'router' } as never;
    const tools = createProcessTools(dataDir, { backend, personality });
    const start = getTool(tools, 'process_start');

    const result = await start.execute({ command: 'echo hi' }, makeCtx('/tmp'));
    expect(result.ok).toBe(true);

    // The session received the command with an empty (clean) env by default.
    expect(backend.lastSessionCmd).toBe('echo hi');
    expect(backend.lastSessionOpts?.env).toEqual({});
    expect(backend.lastSessionOpts?.personality).toBe(personality);

    if (!result.ok) throw new Error('expected ok');
    const { id } = JSON.parse(result.value) as { id: string };

    // Output is written to the same per-process log file spawnDetached uses.
    // Poll briefly: the stream drains on a microtask after process_start returns.
    let logged = '';
    for (let i = 0; i < 50; i++) {
      try {
        logged = readFileSync(join(dataDir, 'processes', id, 'stdout.log'), 'utf-8');
      } catch {
        logged = '';
      }
      if (logged.includes('routed line')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(logged).toContain('routed line');
  });

  it('fires the process_complete hook when the routed stream ends', async () => {
    const backend = makeBackend('done\n');
    const fire = vi.fn().mockResolvedValue(undefined);
    const hookRegistry = {
      fireVoid: fire,
      registerVoid: () => () => {},
      fireModifying: async () => ({}),
      registerModifying: () => () => {},
      fireClaiming: async () => ({ handled: false }),
      registerClaiming: () => () => {},
    } as never;
    const tools = createProcessTools(dataDir, { backend, hookRegistry, personality: undefined });
    const start = getTool(tools, 'process_start');
    const result = await start.execute({ command: 'true' }, makeCtx('/tmp'));
    expect(result.ok).toBe(true);

    for (let i = 0; i < 50 && fire.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fire).toHaveBeenCalledWith('process_complete', expect.objectContaining({ exitCode: 0 }));
  });

  it('enforces the per-personality concurrency cap for routed processes', async () => {
    // A backend whose session stream never ends keeps the first routed entry
    // `running`, so the cap is exercised deterministically.
    const never: ExecutionBackend = {
      name: 'docker',
      isAvailable: () => Promise.resolve(true),
      exec: (_c, _o) => {
        async function* g(): AsyncIterable<ExecChunk> {}
        return g();
      },
      spawnSession: (personalityId: string) => ({
        personalityId,
        exec(): AsyncIterable<ExecChunk> {
          async function* g(): AsyncIterable<ExecChunk> {
            await new Promise<void>(() => {}); // never resolves
          }
          return g();
        },
        dispose: () => Promise.resolve(),
      }),
      mountsFor: () => [],
      dispose: () => Promise.resolve(),
    };
    const tools = createProcessTools(dataDir, {
      backend: never,
      capMax: 1,
      personality: undefined,
    });
    const start = getTool(tools, 'process_start');
    const ctx = makeCtx('/tmp');

    const r1 = await start.execute({ command: 'sleep' }, ctx);
    expect(r1.ok).toBe(true);
    expect(Object.values(loadRegistry(dataDir)).filter((e) => e.status === 'running')).toHaveLength(
      1,
    );

    const r2 = await start.execute({ command: 'sleep' }, ctx);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/PROCESS_CAP_EXCEEDED/);
  });

  it('refuses (not_available) when host exec is forbidden and no backend (F1)', async () => {
    // docker posture + no backend + constitution forbids local → process_start
    // must NOT spawn a detached host process.
    const tools = createProcessTools(dataDir, { hostExecForbidden: true });
    const start = getTool(tools, 'process_start');
    const result = await start.execute({ command: 'echo hi' }, makeCtx('/tmp'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toMatch(/constitution forbids running un-sandboxed/);
    }
    // No registry entry was created (no spawn happened).
    expect(Object.keys(loadRegistry(dataDir))).toHaveLength(0);
  });
});
